const {
  POLL_INTERVAL_MS,
  DEFAULT_WALLET,
  SEND_TRADES_ONLY,
  SEND_ACTIVITY_HISTORY,
  ALERT_ROLE_ID,
  AUTO_TRADE_ENABLED,
  COPY_TRADE_ENABLED,
  COPY_SELL_ORDERS,
  AUTO_TRADE_FILTER,
  AUTO_TRADE_USE_MARKET,
  AUTO_TRADE_AMOUNT_USD,
  PAPER_TRADING_ENABLED,
  MIN_TRACKED_TRADE_SIZE_USD,
  MIN_TRACKED_CONFIDENCE_LEVEL,
  OPTIMAL_CONFIDENCE_MIN,
  OPTIMAL_CONFIDENCE_MAX,
  USE_OPTIMAL_CONFIDENCE_FILTER,
  OPTIMAL_CONFIDENCE_BET_MULTIPLIER,
  HIGH_CONFIDENCE_THRESHOLD_USD,
  LOW_CONFIDENCE_THRESHOLD_USD,
  MAX_BET_AMOUNT_PER_MARKET_USD,
  MAX_ORDER_VALUE_USD,
  MAX_POSITIONS,
  MAX_TOTAL_EXPOSURE_USD,
  ADD_HIGH_CONFIDENCE_ENABLED,
  ADD_HIGH_CONFIDENCE_MIN,
  ADD_HIGH_CONFIDENCE_MAX,
  ADD_HIGH_CONFIDENCE_SIZE_USD,
  USE_HALF_SIZE_INITIAL_TRADES,
  START_COMMAND,
  STOP_COMMAND,
} = require("../config");
const { logToFile } = require("../utils/logger");
const {
  isValidWalletAddress,
  matchesAutoTradeFilter,
} = require("../utils/helpers");
const {
  fetchLatestActivity,
  getTrackedWalletPosition,
} = require("./marketData");
const {
  getPositionValueForToken,
  checkPositionLimits,
  setTrackedPosition,
  deleteTrackedPosition,
  hasHighConfidenceAddBeenPlaced,
  markHighConfidenceAddPlaced,
  hasInitialTradeBeenPlaced,
  markInitialTradePlaced,
  recordBuyTrade,
} = require("./positions");
const { paperBuy, paperSell, getPaperTradingState } = require("./paperTrading");
const {
  placeBuyOrder,
  placeSellOrder,
  placeMarketBuyOrder,
  placeMarketSellOrder,
} = require("./orders");
const {
  setStopLossOrder,
  getStopLossOrder,
  deleteStopLossOrder,
  setStopLossPosition, // For WebSocket monitoring
} = require("./positions");
const {
  STOP_LOSS_ENABLED,
  STOP_LOSS_PERCENTAGE,
  STOP_LOSS_WEBSOCKET_MARKET_FILTER,
} = require("../config");
const {
  checkAndSettleResolvedMarkets,
  checkStopLossForRealPositions,
} = require("./settlement");
const { getCurrentPositions } = require("./positions");

let isPolling = false;
let pollTimeout = null;
let activeChannel = null;
let currentWallet = null;
let isInitialized = false;
const seenHashes = new Set();

function getPollingState() {
  return {
    isPolling,
    pollTimeout,
    activeChannel,
    currentWallet,
    isInitialized,
    seenHashes: new Set(seenHashes),
  };
}

function setPollingState(state) {
  isPolling = state.isPolling;
  pollTimeout = state.pollTimeout;
  activeChannel = state.activeChannel;
  currentWallet = state.currentWallet;
  isInitialized = state.isInitialized;
  if (state.seenHashes) {
    seenHashes.clear();
    state.seenHashes.forEach((hash) => seenHashes.add(hash));
  }
}

function clearPollTimeout() {
  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }
}

function setPollTimeout(timeout) {
  pollTimeout = timeout;
}

async function pollOnce(
  clobClient,
  clobClientReady,
  orderbookWS,
  trackedPositions
) {
  try {
    if (!activeChannel) {
      return;
    }

    // TODO: Still bugged on active hourly event changes - need to rework logic
    if (STOP_LOSS_ENABLED && !PAPER_TRADING_ENABLED && orderbookWS) {
      try {
        const {
          getAllStopLossPositions,
          deleteStopLossPosition,
        } = require("./positions");
        const allPositions = getAllStopLossPositions();

        if (allPositions.size > 0) {
          const activities = await fetchLatestActivity(currentWallet);
          const recentTrades = activities.filter(
            (item) =>
              item?.type === "TRADE" &&
              (String(item?.side).toUpperCase() === "BUY" ||
                String(item?.side).toUpperCase() === "SELL") &&
              item?.conditionId
          );

          logToFile("DEBUG", "Proactive hourly event cleanup check", {
            monitoredPositions: allPositions.size,
            recentTradesWithConditionId: recentTrades.length,
            positionDetails: Array.from(allPositions.entries()).map(
              ([tokenId, pos]) => ({
                tokenId: tokenId.substring(0, 10) + "...",
                conditionId: pos.conditionId
                  ? pos.conditionId.substring(0, 10) + "..."
                  : null,
                market: pos.market,
              })
            ),
          });

          const marketTypeToConditionIds = new Map();
          for (const trade of recentTrades) {
            const { title, slug, conditionId, timestamp } = trade;
            if (!conditionId) continue;

            const marketTypeMatch = (title || slug || "").match(/^([^-]+)/);
            const marketType = marketTypeMatch
              ? marketTypeMatch[1].trim()
              : null;

            if (marketType) {
              if (!marketTypeToConditionIds.has(marketType)) {
                marketTypeToConditionIds.set(marketType, new Map());
              }
              const conditionIdMap = marketTypeToConditionIds.get(marketType);
              const existing = conditionIdMap.get(conditionId);
              if (
                !existing ||
                (timestamp &&
                  existing.timestamp &&
                  timestamp > existing.timestamp)
              ) {
                conditionIdMap.set(conditionId, {
                  conditionId,
                  timestamp: timestamp || 0,
                });
              }
            }
          }

          for (const [tokenId, position] of allPositions.entries()) {
            if (!position.conditionId || !position.market) continue;
            const marketTypeMatch = position.market.match(/^([^-]+)/);
            const marketType = marketTypeMatch
              ? marketTypeMatch[1].trim()
              : null;

            if (marketType) {
              const conditionIdMap = marketTypeToConditionIds.get(marketType);
              if (conditionIdMap && conditionIdMap.size > 0) {
                const storedConditionId = position.conditionId
                  ? position.conditionId.toLowerCase()
                  : null;

                const hasDifferentConditionId = Array.from(
                  conditionIdMap.keys()
                ).some((cid) => cid.toLowerCase() !== storedConditionId);

                if (hasDifferentConditionId) {
                  let latestEvent = null;
                  for (const event of conditionIdMap.values()) {
                    if (event.conditionId.toLowerCase() !== storedConditionId) {
                      if (
                        !latestEvent ||
                        (event.timestamp &&
                          latestEvent.timestamp &&
                          event.timestamp > latestEvent.timestamp)
                      ) {
                        latestEvent = event;
                      }
                    }
                  }

                  if (latestEvent) {
                    logToFile(
                      "INFO",
                      "Cleaning up old hourly event subscription - detected new event in recent trades",
                      {
                        oldTokenId: tokenId.substring(0, 10) + "...",
                        oldConditionId:
                          position.conditionId.substring(0, 10) + "...",
                        newConditionId:
                          latestEvent.conditionId.substring(0, 10) + "...",
                        marketType,
                      }
                    );
                    orderbookWS.unsubscribe(tokenId);
                    deleteStopLossPosition(tokenId);
                  } else {
                    logToFile("DEBUG", "No latest event found for cleanup", {
                      tokenId: tokenId.substring(0, 10) + "...",
                      positionConditionId: position.conditionId
                        ? position.conditionId.substring(0, 10) + "..."
                        : null,
                      marketType,
                      conditionIdsInMap: Array.from(conditionIdMap.keys()).map(
                        (cid) => cid.substring(0, 10) + "..."
                      ),
                    });
                  }
                } else {
                  logToFile(
                    "DEBUG",
                    "No different conditionId found for market type",
                    {
                      tokenId: tokenId.substring(0, 10) + "...",
                      positionConditionId: position.conditionId
                        ? position.conditionId.substring(0, 10) + "..."
                        : null,
                      marketType,
                      conditionIdsInMap: Array.from(conditionIdMap.keys()).map(
                        (cid) => cid.substring(0, 10) + "..."
                      ),
                    }
                  );
                }
              } else {
                logToFile("DEBUG", "No conditionId map found for market type", {
                  tokenId: tokenId.substring(0, 10) + "...",
                  marketType,
                  availableMarketTypes: Array.from(
                    marketTypeToConditionIds.keys()
                  ),
                });
              }
            } else {
              logToFile(
                "DEBUG",
                "Could not extract market type from position",
                {
                  tokenId: tokenId.substring(0, 10) + "...",
                  market: position.market,
                }
              );
            }
          }
        } else {
          logToFile("DEBUG", "No stop-loss positions to check for cleanup", {});
        }
      } catch (cleanupError) {
        logToFile("ERROR", "Error during proactive hourly event cleanup", {
          error: cleanupError.message,
          stack: cleanupError.stack,
        });
      }
    }

    const activities = await fetchLatestActivity(currentWallet);

    const trades = SEND_TRADES_ONLY
      ? activities.filter(
          (item) =>
            item?.type === "TRADE" &&
            (String(item?.side).toUpperCase() === "BUY" ||
              String(item?.side).toUpperCase() === "SELL") &&
            item?.transactionHash
        )
      : activities.filter(
          (item) =>
            item?.type === "TRADE" &&
            (String(item?.side).toUpperCase() === "BUY" ||
              String(item?.side).toUpperCase() === "SELL")
        );

    if (!isInitialized) {
      trades.forEach((trade) => {
        seenHashes.add(trade.transactionHash);
      });
      isInitialized = true;
      return;
    }

    const newTrades = trades.filter(
      (trade) => !seenHashes.has(trade.transactionHash)
    );

    if (newTrades.length === 0) {
      return;
    }

    if (!activeChannel?.isTextBased()) {
      console.error("Active channel is missing or not text-based.");
      return;
    }

    const paperTradingState = getPaperTradingState();

    for (const trade of newTrades.reverse()) {
      seenHashes.add(trade.transactionHash);

      const {
        title,
        price,
        size,
        usdcSize,
        timestamp,
        transactionHash,
        outcome,
        eventSlug,
        slug,
        side,
        conditionId,
        asset,
        orderType,
        type,
        fillType,
        isMarketOrder,
        marketOrder,
      } = trade;

      const tradeSide = String(side).toUpperCase();
      const priceInCents = price != null ? Math.round(price * 100) : null;
      const formattedPrice = priceInCents != null ? `${priceInCents}¢` : "N/A";
      const discordTimestamp = timestamp != null ? `<t:${timestamp}:f>` : "N/A";

      let detectedOrderType = "UNKNOWN";
      if (orderType) {
        detectedOrderType = String(orderType).toUpperCase();
      } else if (fillType) {
        detectedOrderType = String(fillType).toUpperCase();
      } else if (isMarketOrder !== undefined) {
        detectedOrderType = isMarketOrder ? "MARKET" : "LIMIT";
      } else if (marketOrder !== undefined) {
        detectedOrderType = marketOrder ? "MARKET" : "LIMIT";
      }

      const mention = ALERT_ROLE_ID ? `<@&${ALERT_ROLE_ID}>` : "";
      const orderTypeDisplay =
        detectedOrderType !== "UNKNOWN" ? ` (${detectedOrderType})` : "";
      const embedColor =
        tradeSide === "BUY"
          ? 0x00aa00
          : tradeSide === "SELL"
          ? 0xaa0000
          : 0x808080;

      const embed = {
        title: `New Polymarket ${tradeSide}${orderTypeDisplay}`,
        color: embedColor,
        fields: [
          {
            name: "Market",
            value: title ?? slug ?? "Unknown market",
            inline: false,
          },
          {
            name: "Outcome",
            value: `${outcome ?? "Unknown"} @ ${formattedPrice}`,
            inline: true,
          },
          {
            name: "Size",
            value: `${size ?? "?"} shares (~${usdcSize ?? "?"} USDC)`,
            inline: true,
          },
        ],
        timestamp: timestamp
          ? new Date(timestamp * 1000).toISOString()
          : undefined,
        footer: {
          text: "Polymarket Trade",
        },
      };

      if (transactionHash) {
        embed.fields.push({
          name: "Transaction",
          value: `[View on PolygonScan](https://polygonscan.com/tx/${transactionHash})`,
          inline: false,
        });
      }

      if (eventSlug) {
        embed.fields.push({
          name: "Market Page",
          value: `[View Market](https://polymarket.com/market/${eventSlug})`,
          inline: false,
        });
      }

      try {
        if (SEND_ACTIVITY_HISTORY) {
          await activeChannel.send({
            content: mention || undefined,
            embeds: [embed],
          });
        }

        logToFile("INFO", "Trade detected", {
          tradeSide,
          market: title || slug,
          outcome,
          price,
          size,
          conditionId,
          transactionHash,
          orderType: detectedOrderType,
          allTradeFields: Object.keys(trade),
        });
        if (
          tradeSide === "BUY" &&
          conditionId &&
          asset &&
          outcome &&
          PAPER_TRADING_ENABLED
        ) {
          recordBuyTrade(conditionId, asset, outcome, price);
        }

        const trackedTradeSize = usdcSize || 0;
        const tradePrice = price || 0;
        const meetsMinTradeSize =
          MIN_TRACKED_TRADE_SIZE_USD === 0 ||
          trackedTradeSize >= MIN_TRACKED_TRADE_SIZE_USD;

        const isOptimalConfidenceRange =
          tradePrice >= OPTIMAL_CONFIDENCE_MIN &&
          tradePrice <= OPTIMAL_CONFIDENCE_MAX;
        const meetsOptimalConfidenceFilter =
          !USE_OPTIMAL_CONFIDENCE_FILTER ||
          tradePrice >= OPTIMAL_CONFIDENCE_MIN;

        let effectiveMinConfidence = MIN_TRACKED_CONFIDENCE_LEVEL;
        if (USE_OPTIMAL_CONFIDENCE_FILTER) {
          effectiveMinConfidence = 0;
        }
        const meetsMinConfidence =
          effectiveMinConfidence === 0 || tradePrice >= effectiveMinConfidence;

        const canCopySellOrder = tradeSide !== "SELL" || COPY_SELL_ORDERS;

        const canAutoTrade =
          AUTO_TRADE_ENABLED &&
          COPY_TRADE_ENABLED &&
          conditionId &&
          canCopySellOrder &&
          matchesAutoTradeFilter(trade) &&
          meetsMinTradeSize &&
          meetsMinConfidence &&
          meetsOptimalConfidenceFilter &&
          (PAPER_TRADING_ENABLED || (clobClient && clobClientReady));

        if (!canAutoTrade && AUTO_TRADE_ENABLED && conditionId) {
          const skipReasons = [];
          if (!COPY_TRADE_ENABLED) {
            skipReasons.push(
              "copy trading disabled (COPY_TRADE_ENABLED=false)"
            );
          }
          if (!matchesAutoTradeFilter(trade)) {
            skipReasons.push("filter mismatch");
          }
          if (!meetsMinTradeSize) {
            skipReasons.push(
              `trade size $${trackedTradeSize.toFixed(
                2
              )} < min $${MIN_TRACKED_TRADE_SIZE_USD}`
            );
          }
          if (!meetsMinConfidence && !USE_OPTIMAL_CONFIDENCE_FILTER) {
            skipReasons.push(
              `confidence ${(tradePrice * 100).toFixed(1)}% < min ${(
                effectiveMinConfidence * 100
              ).toFixed(1)}%`
            );
          }
          if (!canCopySellOrder) {
            skipReasons.push("SELL orders disabled (COPY_SELL_ORDERS=false)");
          }
          if (!meetsOptimalConfidenceFilter) {
            skipReasons.push(
              `confidence ${(tradePrice * 100).toFixed(
                1
              )}% below optimal minimum ${(
                OPTIMAL_CONFIDENCE_MIN * 100
              ).toFixed(0)}% (trades above ${(
                OPTIMAL_CONFIDENCE_MAX * 100
              ).toFixed(0)}% are still traded)`
            );
          }
          if (!PAPER_TRADING_ENABLED && (!clobClient || !clobClientReady)) {
            skipReasons.push("clobClient not ready");
          }
          if (skipReasons.length > 0) {
            logToFile("INFO", "Auto-trade skipped", {
              conditionId,
              market: title || slug,
              reasons: skipReasons,
              tradeSize: trackedTradeSize,
              confidence: tradePrice,
              paperTradingEnabled: PAPER_TRADING_ENABLED,
              clobClientReady: clobClient && clobClientReady,
            });
          }
        }

        if (canAutoTrade) {
          if (!asset) {
            logToFile(
              "WARN",
              "Missing asset tokenId - cannot determine specific outcome token",
              {
                conditionId,
                market: title || slug,
                outcome,
                note: "Falling back to conditionId, but this may cause issues with orderbook lookups",
              }
            );
          }
          const tokenId = asset || conditionId;
          const orderPrice = price;
          const MIN_ORDER_VALUE_USD = AUTO_TRADE_AMOUNT_USD;

          if (
            tokenId &&
            tradeSide === "BUY" &&
            MAX_BET_AMOUNT_PER_MARKET_USD > 0
          ) {
            let currentPositionValue = 0;
            if (PAPER_TRADING_ENABLED) {
              const paperPos = paperTradingState.positions[tokenId];
              if (paperPos) {
                currentPositionValue = paperPos.entryValue || 0;
              }
            } else {
              currentPositionValue = await getPositionValueForToken(tokenId);
            }

            const maxBetAmount =
              MAX_BET_AMOUNT_PER_MARKET_USD > 0
                ? MAX_BET_AMOUNT_PER_MARKET_USD
                : MAX_ORDER_VALUE_USD;

            if (currentPositionValue >= maxBetAmount) {
              logToFile(
                "INFO",
                "Auto-trade skipped: Position already at max bet amount (early check)",
                {
                  conditionId,
                  tokenId,
                  market: title || slug,
                  currentPositionValue,
                  maxBetAmount,
                }
              );
              await activeChannel.send({
                embeds: [
                  {
                    title: "⏸️ Auto-trade Skipped",
                    description: `Market "${
                      title || slug
                    }" already at max bet amount per position.`,
                    color: 0xffaa00,
                    fields: [
                      {
                        name: "Current Position",
                        value: `$${currentPositionValue.toFixed(2)}`,
                        inline: true,
                      },
                      {
                        name: "Max Bet Amount",
                        value: `$${maxBetAmount.toFixed(2)}`,
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  },
                ],
              });
              continue;
            }
          }

          const trackedShareSize = size || 0;
          let orderSize = 0;
          let orderValue = 0;
          let confidenceLevel = "MEDIUM";

          const isHighConfidenceAdd =
            ADD_HIGH_CONFIDENCE_ENABLED &&
            tradePrice >= ADD_HIGH_CONFIDENCE_MIN &&
            tradePrice <= ADD_HIGH_CONFIDENCE_MAX;

          if (tradeSide === "BUY" && !isHighConfidenceAdd) {
            if (hasInitialTradeBeenPlaced(tokenId)) {
              logToFile(
                "INFO",
                "Auto-trade skipped: Already placed initial trade for this market, skipping 60-80% trade to leave room for high-confidence add",
                {
                  conditionId,
                  tokenId,
                  market: title || slug,
                  outcome,
                  tradePrice: tradePrice * 100,
                  confidenceRange: "60-80%",
                }
              );
              await activeChannel.send({
                embeds: [
                  {
                    title: "⏸️ Auto-trade Skipped",
                    description: `Already placed initial trade for this market. Skipping 60-80% trade to leave room for high-confidence add (80-90%+).`,
                    color: 0xffaa00,
                    fields: [
                      {
                        name: "Market",
                        value: title || slug || "Unknown",
                        inline: false,
                      },
                      {
                        name: "Outcome",
                        value: outcome || "Unknown",
                        inline: true,
                      },
                      {
                        name: "Trade Confidence",
                        value: `${(tradePrice * 100).toFixed(1)}%`,
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  },
                ],
              });
              continue;
            }
          }

          if (tradeSide === "BUY") {
            const optimalMultiplier = isOptimalConfidenceRange
              ? OPTIMAL_CONFIDENCE_BET_MULTIPLIER
              : 1.0;

            const maxBetAmount =
              MAX_BET_AMOUNT_PER_MARKET_USD > 0
                ? MAX_BET_AMOUNT_PER_MARKET_USD
                : MAX_ORDER_VALUE_USD;

            if (isHighConfidenceAdd) {
              const {
                hasHighConfidenceAddBeenPlaced,
                markHighConfidenceAddPlaced,
              } = require("./positions");

              if (hasHighConfidenceAddBeenPlaced(tokenId)) {
                logToFile(
                  "INFO",
                  "High-confidence add skipped: Already placed one for this market",
                  {
                    tokenId,
                    conditionId,
                    market: title || slug,
                    outcome,
                    tradePrice: tradePrice * 100,
                    isHighConfidenceAdd: true,
                  }
                );
                await activeChannel.send({
                  embeds: [
                    {
                      title: "⏸️ High-Confidence Add Skipped",
                      description: `Already placed one high-confidence add (80-90%+) for this market. Only one allowed per market.`,
                      color: 0xffaa00,
                      fields: [
                        {
                          name: "Market",
                          value: title || slug || "Unknown",
                          inline: false,
                        },
                        {
                          name: "Outcome",
                          value: outcome || "Unknown",
                          inline: true,
                        },
                        {
                          name: "Trade Confidence",
                          value: `${(tradePrice * 100).toFixed(1)}%`,
                          inline: true,
                        },
                      ],
                      timestamp: new Date().toISOString(),
                    },
                  ],
                });
                continue;
              }

              confidenceLevel = "HIGH CONFIDENCE ADD (80-90%+)";

              let currentPositionValue = 0;
              if (PAPER_TRADING_ENABLED) {
                const paperPos = paperTradingState.positions[tokenId];
                if (paperPos) {
                  currentPositionValue = paperPos.entryValue || 0;
                }
              } else {
                currentPositionValue = await getPositionValueForToken(tokenId);
              }

              const remainingAmount = Math.max(
                0,
                maxBetAmount - currentPositionValue
              );

              const highConfidenceMinOrder = Math.min(
                ADD_HIGH_CONFIDENCE_SIZE_USD,
                1
              );

              if (remainingAmount < highConfidenceMinOrder) {
                logToFile(
                  "INFO",
                  "High-confidence add skipped: Insufficient room",
                  {
                    tradePrice: tradePrice * 100,
                    confidenceLevel,
                    addSize: ADD_HIGH_CONFIDENCE_SIZE_USD,
                    currentPositionValue,
                    maxBetAmount,
                    remainingAmount,
                    minOrderValue: highConfidenceMinOrder,
                    isHighConfidenceAdd: true,
                  }
                );
                orderValue = 0;
                orderSize = 0;
              } else {
                orderValue = Math.min(
                  ADD_HIGH_CONFIDENCE_SIZE_USD,
                  remainingAmount
                );
                orderSize = orderPrice > 0 ? orderValue / orderPrice : 0;

                logToFile(
                  "INFO",
                  "High-confidence add trade detected (80-90%+)",
                  {
                    tradePrice: tradePrice * 100,
                    confidenceLevel,
                    addSize: ADD_HIGH_CONFIDENCE_SIZE_USD,
                    currentPositionValue,
                    maxBetAmount,
                    remainingAmount,
                    ourBetSize: orderValue,
                    isHighConfidenceAdd: true,
                  }
                );
              }
            } else {
              orderValue = AUTO_TRADE_AMOUNT_USD;

              if (isOptimalConfidenceRange) {
                orderValue = orderValue * optimalMultiplier;
                confidenceLevel = isOptimalConfidenceRange
                  ? "HIGH SIZE (OPTIMAL PRICE RANGE)"
                  : "HIGH SIZE";
              } else if (trackedTradeSize >= HIGH_CONFIDENCE_THRESHOLD_USD) {
                confidenceLevel = "HIGH SIZE";
              } else if (trackedTradeSize <= LOW_CONFIDENCE_THRESHOLD_USD) {
                confidenceLevel = "LOW SIZE";
              } else {
                confidenceLevel = "MEDIUM SIZE";
              }

              orderValue = Math.min(orderValue, maxBetAmount);

              if (USE_HALF_SIZE_INITIAL_TRADES) {
                orderValue = orderValue / 2;
                confidenceLevel += " (HALF-SIZE)";
              }

              orderSize = orderPrice > 0 ? orderValue / orderPrice : 0;
              logToFile("INFO", "Initial trade detected (60-80%)", {
                trackedTradeSize,
                confidenceLevel,
                isOptimalRange: isOptimalConfidenceRange,
                optimalMultiplier,
                ourBetSize: orderValue,
                maxBetAmount,
                autoTradeAmount: AUTO_TRADE_AMOUNT_USD,
                halfSizeEnabled: USE_HALF_SIZE_INITIAL_TRADES,
              });
            }
          } else if (tradeSide === "SELL") {
            const currentPositionValue = await getPositionValueForToken(
              tokenId
            );
            const currentPositionShares =
              currentPositionValue > 0 && orderPrice > 0
                ? currentPositionValue / orderPrice
                : 0;

            if (currentPositionValue <= 0 || currentPositionShares <= 0) {
              logToFile("WARN", "Cannot auto-sell: No position to sell", {
                tokenId,
                trackedShareSize,
                trackedTradeSize,
              });
              await activeChannel.send({
                embeds: [
                  {
                    title: "⏸️ Auto-trade Skipped",
                    description:
                      "Cannot sell: You don't have a position in this market.",
                    color: 0xffaa00,
                    timestamp: new Date().toISOString(),
                  },
                ],
              });
              continue;
            }

            let trackedSellShares = 0;
            if (trackedShareSize > 0) {
              trackedSellShares = trackedShareSize;
            } else if (trackedTradeSize > 0 && orderPrice > 0) {
              trackedSellShares = trackedTradeSize / orderPrice;
            }

            if (trackedSellShares > 0) {
              const trackedWalletCurrentShares = await getTrackedWalletPosition(
                tokenId,
                currentWallet,
                orderPrice
              );

              const trackedWalletTotalShares =
                trackedWalletCurrentShares + trackedSellShares;

              if (trackedWalletTotalShares > 0) {
                const sellPercentage =
                  trackedSellShares / trackedWalletTotalShares;

                orderSize = currentPositionShares * sellPercentage;
                orderValue = orderSize * orderPrice;

                if (orderValue < MIN_ORDER_VALUE_USD && orderPrice > 0) {
                  orderSize = MIN_ORDER_VALUE_USD / orderPrice;
                  orderValue = MIN_ORDER_VALUE_USD;
                }

                orderSize = Math.min(orderSize, currentPositionShares);
                orderValue = orderSize * orderPrice;

                logToFile(
                  "INFO",
                  "SELL order: Calculating sell percentage from tracked wallet",
                  {
                    trackedWalletCurrentShares,
                    trackedWalletTotalShares,
                    trackedSellShares,
                    sellPercentage: sellPercentage * 100,
                    ourPositionShares: currentPositionShares,
                    ourPositionValue: currentPositionValue,
                    ourSellSize: orderSize,
                    ourSellValue: orderValue,
                    ourSellPercentage:
                      (orderSize / currentPositionShares) * 100,
                  }
                );
              } else {
                logToFile(
                  "WARN",
                  "SELL order: Could not determine tracked wallet total position",
                  {
                    trackedWalletCurrentShares,
                    trackedSellShares,
                    ourPositionShares: currentPositionShares,
                  }
                );
              }
            }

            if (orderSize === 0 && orderValue === 0) {
              if (trackedShareSize > 0) {
                orderSize = Math.min(trackedShareSize, currentPositionShares);
                orderValue = orderSize * orderPrice;
                logToFile(
                  "WARN",
                  "SELL order: Could not fetch tracked wallet position, copying sell size directly",
                  {
                    trackedShareSize,
                    ourPositionShares: currentPositionShares,
                    ourSellSize: orderSize,
                    ourSellValue: orderValue,
                  }
                );
              } else if (trackedTradeSize > 0 && orderPrice > 0) {
                orderSize = Math.min(
                  trackedTradeSize / orderPrice,
                  currentPositionShares
                );
                orderValue = orderSize * orderPrice;
              } else {
                orderValue = MIN_ORDER_VALUE_USD;
                orderSize = Math.min(
                  orderValue / orderPrice,
                  currentPositionShares
                );
                orderValue = orderSize * orderPrice;
              }
            }
          }

          if (
            tokenId &&
            tradeSide === "BUY" &&
            MAX_BET_AMOUNT_PER_MARKET_USD > 0
          ) {
            let currentPositionValue = 0;
            if (PAPER_TRADING_ENABLED) {
              const paperPos = paperTradingState.positions[tokenId];
              if (paperPos) {
                currentPositionValue = paperPos.entryValue || 0;
              }
            } else {
              currentPositionValue = await getPositionValueForToken(tokenId);
            }

            const maxBetAmount =
              MAX_BET_AMOUNT_PER_MARKET_USD > 0
                ? MAX_BET_AMOUNT_PER_MARKET_USD
                : MAX_ORDER_VALUE_USD;
            const remainingAmount = Math.max(
              0,
              maxBetAmount - currentPositionValue
            );

            if (remainingAmount === 0) {
              logToFile(
                "INFO",
                "Auto-trade skipped: Position already at max bet amount",
                {
                  conditionId,
                  tokenId,
                  market: title || slug,
                  currentPositionValue,
                  maxBetAmount,
                  orderValue,
                  orderSize,
                }
              );
              await activeChannel.send({
                embeds: [
                  {
                    title: "⏸️ Auto-trade Skipped",
                    description: `Market "${
                      title || slug
                    }" already at max bet amount per position.`,
                    color: 0xffaa00,
                    fields: [
                      {
                        name: "Current Position",
                        value: `$${currentPositionValue.toFixed(2)}`,
                        inline: true,
                      },
                      {
                        name: "Max Bet Amount",
                        value: `$${maxBetAmount.toFixed(2)}`,
                        inline: true,
                      },
                      {
                        name: "Proposed Trade",
                        value: `$${orderValue.toFixed(2)} (${orderSize.toFixed(
                          2
                        )} shares)`,
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  },
                ],
              });
              continue;
            } else if (orderValue > remainingAmount) {
              const originalOrderSize = orderSize;
              const originalOrderValue = orderValue;
              orderSize = orderPrice > 0 ? remainingAmount / orderPrice : 0;
              orderValue = orderSize * orderPrice;

              if (orderValue < MIN_ORDER_VALUE_USD && orderPrice > 0) {
                const minOrderValue = MIN_ORDER_VALUE_USD;
                if (currentPositionValue + minOrderValue > maxBetAmount) {
                  logToFile(
                    "INFO",
                    "Auto-trade skipped: Capped order below minimum and minimum would exceed max bet amount",
                    {
                      conditionId,
                      tokenId,
                      market: title || slug,
                      currentPositionValue,
                      maxBetAmount,
                      cappedOrderValue: orderValue,
                      minOrderValue,
                      wouldExceed: currentPositionValue + minOrderValue,
                    }
                  );
                  await activeChannel.send({
                    embeds: [
                      {
                        title: "⏸️ Auto-trade Skipped",
                        description: `Cannot place trade: minimum order size ($${minOrderValue}) would exceed max bet amount per position.`,
                        color: 0xffaa00,
                        fields: [
                          {
                            name: "Current Position",
                            value: `$${currentPositionValue.toFixed(2)}`,
                            inline: true,
                          },
                          {
                            name: "Max Bet Amount",
                            value: `$${maxBetAmount.toFixed(2)}`,
                            inline: true,
                          },
                          {
                            name: "Capped Trade",
                            value: `$${orderValue.toFixed(
                              2
                            )} (below $${minOrderValue} minimum)`,
                            inline: false,
                          },
                          {
                            name: "Minimum Order",
                            value: `$${minOrderValue.toFixed(
                              2
                            )} (would exceed limit)`,
                            inline: false,
                          },
                        ],
                        timestamp: new Date().toISOString(),
                      },
                    ],
                  });
                  continue;
                } else {
                  orderSize = MIN_ORDER_VALUE_USD / orderPrice;
                  orderValue = MIN_ORDER_VALUE_USD;
                  logToFile(
                    "WARN",
                    "Capped order below minimum, adjusted to minimum (within limit)",
                    {
                      conditionId,
                      tokenId,
                      market: title || slug,
                      currentPositionValue,
                      maxBetAmount,
                      cappedOrderValue: orderSize * orderPrice,
                      adjustedOrderValue: orderValue,
                      minValue: MIN_ORDER_VALUE_USD,
                    }
                  );
                }
              }

              logToFile(
                "INFO",
                "Auto-trade size capped to avoid exceeding max bet amount per position",
                {
                  conditionId,
                  tokenId,
                  market: title || slug,
                  currentPositionValue,
                  maxBetAmount,
                  originalOrderSize,
                  originalOrderValue,
                  cappedOrderSize: orderSize,
                  cappedOrderValue: orderValue,
                }
              );
              await activeChannel.send({
                embeds: [
                  {
                    title: "⚠️ Trade Size Capped",
                    description: `Trade size reduced to avoid exceeding max bet amount per position.`,
                    color: 0xffaa00,
                    fields: [
                      {
                        name: "Current Position",
                        value: `$${currentPositionValue.toFixed(2)}`,
                        inline: true,
                      },
                      {
                        name: "Max Bet Amount",
                        value: `$${maxBetAmount.toFixed(2)}`,
                        inline: true,
                      },
                      {
                        name: "Original Trade",
                        value: `$${originalOrderValue.toFixed(
                          2
                        )} (${originalOrderSize.toFixed(2)} shares)`,
                        inline: false,
                      },
                      {
                        name: "Capped Trade",
                        value: `$${orderValue.toFixed(2)} (${orderSize.toFixed(
                          2
                        )} shares)`,
                        inline: false,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  },
                ],
              });
            }
          }

          if (
            orderValue < MIN_ORDER_VALUE_USD &&
            orderPrice > 0 &&
            !isHighConfidenceAdd
          ) {
            if (
              tradeSide === "BUY" &&
              tokenId &&
              MAX_BET_AMOUNT_PER_MARKET_USD > 0
            ) {
              let currentPositionValue = 0;
              if (PAPER_TRADING_ENABLED) {
                const paperPos = paperTradingState.positions[tokenId];
                if (paperPos) {
                  currentPositionValue = paperPos.entryValue || 0;
                }
              } else {
                currentPositionValue = await getPositionValueForToken(tokenId);
              }

              const maxBetAmount =
                MAX_BET_AMOUNT_PER_MARKET_USD > 0
                  ? MAX_BET_AMOUNT_PER_MARKET_USD
                  : MAX_ORDER_VALUE_USD;

              const effectiveMinOrderValue = USE_HALF_SIZE_INITIAL_TRADES
                ? MIN_ORDER_VALUE_USD / 2
                : MIN_ORDER_VALUE_USD;

              if (
                currentPositionValue + effectiveMinOrderValue >
                maxBetAmount
              ) {
                logToFile(
                  "INFO",
                  "Auto-trade skipped: Order below minimum and minimum would exceed max bet amount",
                  {
                    conditionId,
                    tokenId,
                    market: title || slug,
                    currentPositionValue,
                    maxBetAmount,
                    orderValue,
                    minOrderValue: effectiveMinOrderValue,
                    wouldExceed: currentPositionValue + effectiveMinOrderValue,
                  }
                );
                await activeChannel.send({
                  embeds: [
                    {
                      title: "⏸️ Auto-trade Skipped",
                      description: `Cannot place trade: minimum order size ($${effectiveMinOrderValue.toFixed(
                        2
                      )}) would exceed max bet amount per position.`,
                      color: 0xffaa00,
                      fields: [
                        {
                          name: "Current Position",
                          value: `$${currentPositionValue.toFixed(2)}`,
                          inline: true,
                        },
                        {
                          name: "Max Bet Amount",
                          value: `$${maxBetAmount.toFixed(2)}`,
                          inline: true,
                        },
                        {
                          name: "Order Value",
                          value: `$${orderValue.toFixed(
                            2
                          )} (below $${effectiveMinOrderValue.toFixed(
                            2
                          )} minimum)`,
                          inline: false,
                        },
                        {
                          name: "Minimum Order",
                          value: `$${effectiveMinOrderValue.toFixed(
                            2
                          )} (would exceed limit)`,
                          inline: false,
                        },
                      ],
                      timestamp: new Date().toISOString(),
                    },
                  ],
                });
                continue;
              } else {
                if (orderValue < effectiveMinOrderValue) {
                  const originalOrderSize = orderSize;
                  const originalOrderValue = orderSize * orderPrice;
                  orderSize = effectiveMinOrderValue / orderPrice;
                  orderValue = effectiveMinOrderValue;
                  logToFile(
                    "WARN",
                    "Order value below minimum, adjusted to minimum (within max bet limit)",
                    {
                      conditionId,
                      tokenId,
                      market: title || slug,
                      currentPositionValue,
                      maxBetAmount,
                      originalOrderSize,
                      originalOrderValue,
                      adjustedOrderSize: orderSize,
                      adjustedOrderValue: orderValue,
                      minValue: effectiveMinOrderValue,
                      standardMinValue: MIN_ORDER_VALUE_USD,
                      halfSizeEnabled: USE_HALF_SIZE_INITIAL_TRADES,
                      orderPrice,
                    }
                  );
                  await activeChannel.send({
                    embeds: [
                      {
                        title: "⚠️ Order Value Adjusted",
                        description: `Order value was below minimum of $${effectiveMinOrderValue.toFixed(
                          2
                        )}${
                          USE_HALF_SIZE_INITIAL_TRADES
                            ? " (half-size minimum)"
                            : ""
                        }. Adjusted to minimum (within max bet limit).`,
                        color: 0xffaa00,
                        fields: [
                          {
                            name: "Original Order",
                            value: `$${originalOrderValue.toFixed(2)}`,
                            inline: true,
                          },
                          {
                            name: "Adjusted Order",
                            value: `$${orderValue.toFixed(
                              2
                            )} (${orderSize.toFixed(2)} shares)`,
                            inline: true,
                          },
                          {
                            name: "Position After Trade",
                            value: `$${(
                              currentPositionValue + orderValue
                            ).toFixed(2)} / $${maxBetAmount.toFixed(2)}`,
                            inline: true,
                          },
                        ],
                        timestamp: new Date().toISOString(),
                      },
                    ],
                  });
                } else {
                  logToFile("INFO", "Order value meets minimum requirement", {
                    orderValue,
                    effectiveMinOrderValue,
                    halfSizeEnabled: USE_HALF_SIZE_INITIAL_TRADES,
                  });
                }
              }
            } else {
              const originalOrderSize = orderSize;
              orderSize = MIN_ORDER_VALUE_USD / orderPrice;
              orderValue = MIN_ORDER_VALUE_USD;
              logToFile("WARN", "Order value below minimum, increasing to $1", {
                originalOrderSize,
                originalOrderValue: originalOrderSize * orderPrice,
                adjustedOrderSize: orderSize,
                minValue: MIN_ORDER_VALUE_USD,
                orderPrice,
              });
              await activeChannel.send({
                embeds: [
                  {
                    title: "⚠️ Order Value Adjusted",
                    description: `Order value was below minimum of $${MIN_ORDER_VALUE_USD}.`,
                    color: 0xffaa00,
                    fields: [
                      {
                        name: "Adjusted Order",
                        value: `$${orderValue.toFixed(2)} (${orderSize.toFixed(
                          2
                        )} shares)`,
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  },
                ],
              });
            }
          }

          orderSize = Math.round(orderSize * 100) / 100;
          orderValue = orderSize * orderPrice;

          if (isHighConfidenceAdd && orderValue === 0) {
            logToFile(
              "INFO",
              "High-confidence add skipped: No room for minimum order",
              {
                conditionId,
                market: title || slug,
                outcome,
                tradePrice: tradePrice * 100,
              }
            );
            continue;
          }

          const proposedTradeValue = orderValue;

          if (isHighConfidenceAdd && tokenId && tradeSide === "BUY") {
            let currentPositionValue = 0;
            if (PAPER_TRADING_ENABLED) {
              const paperPos = paperTradingState.positions[tokenId];
              if (paperPos) {
                currentPositionValue = paperPos.entryValue || 0;
              }
            } else {
              currentPositionValue = await getPositionValueForToken(tokenId);
            }

            const maxBetAmount =
              MAX_BET_AMOUNT_PER_MARKET_USD > 0
                ? MAX_BET_AMOUNT_PER_MARKET_USD
                : MAX_ORDER_VALUE_USD;

            const remainingAmount = Math.max(
              0,
              maxBetAmount - currentPositionValue
            );

            logToFile(
              "INFO",
              "High-confidence add position cap check (before order)",
              {
                tokenId: tokenId.substring(0, 20) + "...",
                conditionId,
                market: title || slug,
                currentPositionValue,
                maxBetAmount,
                remainingAmount,
                proposedTradeValue,
                wouldExceed: proposedTradeValue > remainingAmount,
                isHighConfidenceAdd: true,
              }
            );

            if (proposedTradeValue > remainingAmount) {
              if (remainingAmount < 1) {
                logToFile(
                  "WARN",
                  "High-confidence add skipped: Insufficient room at order placement time",
                  {
                    tokenId,
                    conditionId,
                    market: title || slug,
                    currentPositionValue,
                    maxBetAmount,
                    remainingAmount,
                    proposedTradeValue,
                    isHighConfidenceAdd: true,
                  }
                );
                continue;
              }

              orderValue = remainingAmount;
              orderSize = orderPrice > 0 ? orderValue / orderPrice : 0;

              logToFile(
                "WARN",
                "High-confidence add adjusted: Position cap would be exceeded",
                {
                  tokenId,
                  conditionId,
                  market: title || slug,
                  originalProposedValue: proposedTradeValue,
                  adjustedOrderValue: orderValue,
                  currentPositionValue,
                  maxBetAmount,
                  remainingAmount,
                  isHighConfidenceAdd: true,
                }
              );
            }
          }

          const positionCheck = await checkPositionLimits(
            orderValue,
            tradeSide,
            tokenId
          );
          if (!positionCheck.allowed) {
            logToFile("WARN", "Auto-trade skipped: Position limit reached", {
              conditionId,
              market: title || slug,
              reason: positionCheck.reason,
              ...positionCheck,
            });

            const limitEmbed = {
              title: "⏸️ Auto-trade Skipped",
              description: positionCheck.message,
              color: 0xffaa00,
              fields: [],
              timestamp: new Date().toISOString(),
            };

            if (positionCheck.reason === "position_count") {
              limitEmbed.fields.push(
                {
                  name: "Current Positions",
                  value: `${positionCheck.currentPositions}/${positionCheck.maxPositions}`,
                  inline: true,
                },
                {
                  name: "Proposed Trade",
                  value: `$${proposedTradeValue.toFixed(2)}`,
                  inline: true,
                }
              );
            } else if (positionCheck.reason === "total_exposure") {
              limitEmbed.fields.push(
                {
                  name: "Current Exposure",
                  value: `$${positionCheck.currentExposure.toFixed(2)}`,
                  inline: true,
                },
                {
                  name: "Proposed Trade",
                  value: `$${proposedTradeValue.toFixed(2)}`,
                  inline: true,
                },
                {
                  name: "Would Exceed Limit",
                  value: `$${positionCheck.newTotalExposure.toFixed(
                    2
                  )} > $${positionCheck.maxExposure.toFixed(2)}`,
                  inline: false,
                }
              );
            } else if (positionCheck.reason === "per_market_cap") {
              limitEmbed.fields.push(
                {
                  name: "Current Position Value",
                  value: `$${positionCheck.currentPositionValue.toFixed(2)}`,
                  inline: true,
                },
                {
                  name: "Proposed Trade",
                  value: `$${proposedTradeValue.toFixed(2)}`,
                  inline: true,
                },
                {
                  name: "Would Exceed Limit",
                  value: `$${positionCheck.newPositionValue.toFixed(
                    2
                  )} > $${positionCheck.maxBetAmount.toFixed(2)}`,
                  inline: false,
                }
              );
            }

            await activeChannel.send({
              embeds: [limitEmbed],
            });
            continue;
          }

          try {
            if (!price || price <= 0) {
              logToFile("WARN", "Cannot auto-trade: Invalid price", { price });
              await activeChannel.send({
                embeds: [
                  {
                    title: "⚠️ Cannot Auto-trade",
                    description: `Invalid price (${price}). Skipping trade.`,
                    color: 0xffaa00,
                    timestamp: new Date().toISOString(),
                  },
                ],
              });
              return;
            }

            if (!tokenId) {
              logToFile(
                "WARN",
                "Cannot auto-trade: No tokenId (asset) in trade",
                {
                  conditionId,
                  asset,
                  tradeFields: Object.keys(trade),
                }
              );
              await activeChannel.send({
                embeds: [
                  {
                    title: "⚠️ Cannot Auto-trade",
                    description:
                      "No token ID found in trade data. Skipping trade.",
                    color: 0xffaa00,
                    timestamp: new Date().toISOString(),
                  },
                ],
              });
              return;
            }

            const useMarketOrder =
              AUTO_TRADE_USE_MARKET || detectedOrderType === "MARKET";

            const dynamicAmount = orderValue;

            if (useMarketOrder) {
              if (tradeSide === "BUY") {
                if (PAPER_TRADING_ENABLED) {
                  logToFile("INFO", "Paper trading: Attempting BUY", {
                    tokenId,
                    dynamicAmount,
                    orderPrice,
                    market: title || slug || "Unknown",
                    orderSize,
                    orderValue,
                  });

                  const paperResult = await paperBuy(
                    tokenId,
                    dynamicAmount,
                    orderPrice,
                    title || slug || "Unknown",
                    conditionId,
                    null,
                    outcome
                  );

                  if (paperResult && paperResult.error) {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "❌ Paper Trade FAILED",
                          description: paperResult.error,
                          color: 0xaa0000,
                          fields: [
                            {
                              name: "Mode",
                              value: "📝 Paper Trading",
                              inline: true,
                            },
                          ],
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                    continue;
                  }

                  if (paperResult && paperResult.success) {
                    setTrackedPosition(tokenId, {
                      usdcValue: orderValue,
                      timestamp: Date.now(),
                    });

                    if (isHighConfidenceAdd) {
                      markHighConfidenceAddPlaced(tokenId);
                    } else {
                      markInitialTradePlaced(tokenId);
                    }

                    const buyEmbed = {
                      title: isHighConfidenceAdd
                        ? "✅ Paper Trade: MARKET BUY (HIGH CONFIDENCE ADD 80-90%+)"
                        : isOptimalConfidenceRange
                        ? "✅ Paper Trade: MARKET BUY (OPTIMAL RANGE)"
                        : "✅ Paper Trade: MARKET BUY",
                      description: `$${orderValue.toFixed(
                        2
                      )} (${orderSize.toFixed(2)} shares) @ market price${
                        isHighConfidenceAdd
                          ? `\n\n🔥 **High-confidence add at ${(
                              tradePrice * 100
                            ).toFixed(0)}% - Adding to winning outcome!**`
                          : isOptimalConfidenceRange
                          ? "\n\n🎯 **In optimal confidence range (60-70¢) - 85% win rate!**"
                          : ""
                      }`,
                      color: isHighConfidenceAdd
                        ? 0xff6600
                        : isOptimalConfidenceRange
                        ? 0x00ff00
                        : 0x00aa00,
                      fields: [
                        {
                          name: "Market",
                          value: title || slug || "Unknown market",
                          inline: false,
                        },
                        {
                          name: "Outcome",
                          value: outcome ?? "Unknown",
                          inline: true,
                        },
                        {
                          name: "Mode",
                          value: "📝 Paper Trading",
                          inline: true,
                        },
                        {
                          name: "Confidence",
                          value: confidenceLevel,
                          inline: true,
                        },
                        {
                          name: "Entry Price",
                          value: `${(tradePrice * 100).toFixed(2)}¢${
                            isHighConfidenceAdd
                              ? " 🔥"
                              : isOptimalConfidenceRange
                              ? " 🎯"
                              : ""
                          }`,
                          inline: true,
                        },
                        {
                          name: "Tracked Trade",
                          value: `$${trackedTradeSize.toFixed(2)}`,
                          inline: true,
                        },
                        {
                          name: "Paper Balance",
                          value: `$${paperResult.balance.toFixed(2)}`,
                          inline: true,
                        },
                      ],
                      timestamp: new Date().toISOString(),
                    };

                    if (
                      positionCheck.allowed &&
                      positionCheck.currentPositions !== undefined
                    ) {
                      buyEmbed.fields.push({
                        name: "Positions After Trade",
                        value: `${
                          positionCheck.currentPositions + 1
                        }/${MAX_POSITIONS}`,
                        inline: true,
                      });
                    }

                    await activeChannel.send({
                      embeds: [buyEmbed],
                    });
                    continue;
                  }
                }

                if (PAPER_TRADING_ENABLED) {
                  logToFile(
                    "ERROR",
                    "Attempted real trade while paper trading is enabled - this should not happen",
                    {
                      tokenId,
                      tradeSide: "BUY",
                      orderValue: dynamicAmount,
                    }
                  );
                  continue;
                }

                const orderResponse = await placeMarketBuyOrder(
                  tokenId,
                  dynamicAmount,
                  orderPrice,
                  clobClient,
                  clobClientReady,
                  orderbookWS
                );

                if (orderResponse && orderResponse.error) {
                  const errorMsg = orderResponse.error;
                  if (
                    errorMsg.includes("balance") ||
                    errorMsg.includes("allowance")
                  ) {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "❌ Auto-trade FAILED",
                          description: errorMsg,
                          color: 0xaa0000,
                          fields: [
                            {
                              name: "Action Required",
                              value: `1. Fund your wallet with USDC on Polygon (at least $${orderValue.toFixed(
                                2
                              )})\n2. If using a proxy wallet, approve the CLOB contract to spend USDC`,
                              inline: false,
                            },
                          ],
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                  } else if (
                    errorMsg.includes("orderbook") &&
                    errorMsg.includes("does not exist")
                  ) {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "⚠️ Auto-trade SKIPPED",
                          description:
                            "Orderbook does not exist for this market. The market may be closed, expired, or inactive.",
                          color: 0xffaa00,
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                  } else {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "❌ Auto-placed MARKET BUY Order FAILED",
                          description: errorMsg,
                          color: 0xaa0000,
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                  }
                } else if (orderResponse && orderResponse.success !== false) {
                  setTrackedPosition(tokenId, {
                    usdcValue: orderValue,
                    timestamp: Date.now(),
                  });

                  if (isHighConfidenceAdd) {
                    markHighConfidenceAddPlaced(tokenId);
                  } else {
                    markInitialTradePlaced(tokenId);
                  }

                  const buyEmbed = {
                    title: isHighConfidenceAdd
                      ? "✅ Auto-placed MARKET BUY Order (HIGH CONFIDENCE ADD 80-90%+)"
                      : isOptimalConfidenceRange
                      ? "✅ Auto-placed MARKET BUY Order (OPTIMAL RANGE)"
                      : "✅ Auto-placed MARKET BUY Order",
                    description: `$${orderValue.toFixed(
                      2
                    )} (${orderSize.toFixed(2)} shares) @ market price${
                      isHighConfidenceAdd
                        ? `\n\n🔥 **High-confidence add at ${(
                            tradePrice * 100
                          ).toFixed(0)}% - Adding to winning outcome!**`
                        : isOptimalConfidenceRange
                        ? "\n\n🎯 **In optimal confidence range (60-70¢) - 85% win rate!**"
                        : ""
                    }`,
                    color: isHighConfidenceAdd
                      ? 0xff6600
                      : isOptimalConfidenceRange
                      ? 0x00ff00
                      : 0x00aa00,
                    fields: [
                      {
                        name: "Market",
                        value: title || slug || "Unknown market",
                        inline: false,
                      },
                      {
                        name: "Outcome",
                        value: outcome ?? "Unknown",
                        inline: true,
                      },
                      {
                        name: "Status",
                        value: "Success",
                        inline: true,
                      },
                      {
                        name: "Confidence",
                        value: confidenceLevel,
                        inline: true,
                      },
                      {
                        name: "Entry Price",
                        value: `${(tradePrice * 100).toFixed(2)}¢${
                          isOptimalConfidenceRange ? " 🎯" : ""
                        }`,
                        inline: true,
                      },
                      {
                        name: "Tracked Trade",
                        value: `$${trackedTradeSize.toFixed(2)}`,
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  };

                  if (
                    positionCheck.allowed &&
                    positionCheck.currentPositions !== undefined
                  ) {
                    buyEmbed.fields.push({
                      name: "Positions After Trade",
                      value: `${
                        positionCheck.currentPositions + 1
                      }/${MAX_POSITIONS}`,
                      inline: true,
                    });
                    if (positionCheck.newTotalExposure) {
                      buyEmbed.fields.push({
                        name: "Total Exposure",
                        value: `$${positionCheck.newTotalExposure.toFixed(2)}${
                          MAX_TOTAL_EXPOSURE_USD > 0
                            ? ` / $${MAX_TOTAL_EXPOSURE_USD.toFixed(2)}`
                            : ""
                        }`,
                        inline: true,
                      });
                    }
                  }

                  await activeChannel.send({
                    embeds: [buyEmbed],
                  });
                } else {
                  setTrackedPosition(tokenId, {
                    usdcValue: orderValue,
                    timestamp: Date.now(),
                  });
                  const buyEmbedNoStatus = {
                    title: isHighConfidenceAdd
                      ? "✅ Auto-placed MARKET BUY Order (HIGH CONFIDENCE ADD 80-90%+)"
                      : isOptimalConfidenceRange
                      ? "✅ Auto-placed MARKET BUY Order (OPTIMAL RANGE)"
                      : "✅ Auto-placed MARKET BUY Order",
                    description: `$${orderValue.toFixed(
                      2
                    )} (${orderSize.toFixed(2)} shares) @ market price${
                      isHighConfidenceAdd
                        ? `\n\n🔥 **High-confidence add at ${(
                            tradePrice * 100
                          ).toFixed(0)}% - Adding to winning outcome!**`
                        : isOptimalConfidenceRange
                        ? "\n\n🎯 **In optimal confidence range (60-70¢) - 85% win rate!**"
                        : ""
                    }`,
                    color: isHighConfidenceAdd
                      ? 0xff6600
                      : isOptimalConfidenceRange
                      ? 0x00ff00
                      : 0x00aa00,
                    fields: [
                      {
                        name: "Market",
                        value: title || slug || "Unknown market",
                        inline: false,
                      },
                      {
                        name: "Outcome",
                        value: outcome ?? "Unknown",
                        inline: true,
                      },
                      {
                        name: "Confidence",
                        value: confidenceLevel,
                        inline: true,
                      },
                      {
                        name: "Entry Price",
                        value: `${(tradePrice * 100).toFixed(2)}¢${
                          isHighConfidenceAdd
                            ? " 🔥"
                            : isOptimalConfidenceRange
                            ? " 🎯"
                            : ""
                        }`,
                        inline: true,
                      },
                      {
                        name: "Tracked Trade",
                        value: `$${trackedTradeSize.toFixed(2)}`,
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  };

                  if (
                    positionCheck.allowed &&
                    positionCheck.currentPositions !== undefined
                  ) {
                    buyEmbedNoStatus.fields.push({
                      name: "Positions After Trade",
                      value: `${
                        positionCheck.currentPositions + 1
                      }/${MAX_POSITIONS}`,
                      inline: true,
                    });
                    if (positionCheck.newTotalExposure) {
                      buyEmbedNoStatus.fields.push({
                        name: "Total Exposure",
                        value: `$${positionCheck.newTotalExposure.toFixed(2)}${
                          MAX_TOTAL_EXPOSURE_USD > 0
                            ? ` / $${MAX_TOTAL_EXPOSURE_USD.toFixed(2)}`
                            : ""
                        }`,
                        inline: true,
                      });
                    }
                  }

                  await activeChannel.send({
                    embeds: [buyEmbedNoStatus],
                  });
                }
              } else if (tradeSide === "SELL") {
                if (PAPER_TRADING_ENABLED) {
                  const paperResult = await paperSell(
                    tokenId,
                    orderSize,
                    orderPrice,
                    title || slug || "Unknown"
                  );

                  if (paperResult && paperResult.error) {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "❌ Paper Trade FAILED",
                          description: paperResult.error,
                          color: 0xaa0000,
                          fields: [
                            {
                              name: "Mode",
                              value: "📝 Paper Trading",
                              inline: true,
                            },
                          ],
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                    continue;
                  }

                  if (paperResult && paperResult.success) {
                    deleteTrackedPosition(tokenId);
                    const sellEmbed = {
                      title: "✅ Paper Trade: MARKET SELL",
                      description: `$${orderValue.toFixed(
                        2
                      )} (${orderSize.toFixed(2)} shares) @ market price`,
                      color: 0xaa0000,
                      fields: [
                        {
                          name: "Market",
                          value: title || slug || "Unknown market",
                          inline: false,
                        },
                        {
                          name: "Outcome",
                          value: outcome ?? "Unknown",
                          inline: true,
                        },
                        {
                          name: "Mode",
                          value: "📝 Paper Trading",
                          inline: true,
                        },
                        {
                          name: "PnL",
                          value: `$${
                            paperResult.pnl >= 0 ? "+" : ""
                          }${paperResult.pnl.toFixed(2)}`,
                          inline: true,
                        },
                        {
                          name: "Paper Balance",
                          value: `$${paperResult.balance.toFixed(2)}`,
                          inline: true,
                        },
                      ],
                      timestamp: new Date().toISOString(),
                    };

                    if (
                      positionCheck.allowed &&
                      positionCheck.currentPositions !== undefined
                    ) {
                      const positionsAfter = Math.max(
                        0,
                        positionCheck.currentPositions - 1
                      );
                      sellEmbed.fields.push({
                        name: "Positions After Trade",
                        value: `${positionsAfter}/${MAX_POSITIONS}`,
                        inline: true,
                      });
                    }

                    await activeChannel.send({
                      embeds: [sellEmbed],
                    });
                    continue;
                  }
                }

                if (PAPER_TRADING_ENABLED) {
                  logToFile(
                    "ERROR",
                    "Attempted real trade while paper trading is enabled - this should not happen",
                    {
                      tokenId,
                      tradeSide: "SELL",
                      orderSize,
                      orderValue,
                    }
                  );
                  continue;
                }

                const orderResponse = await placeMarketSellOrder(
                  tokenId,
                  orderSize,
                  orderPrice,
                  clobClient,
                  clobClientReady,
                  orderbookWS,
                  null,
                  null
                );

                if (orderResponse && orderResponse.error) {
                  const errorMsg = orderResponse.error;
                  if (
                    errorMsg.includes("balance") ||
                    errorMsg.includes("allowance")
                  ) {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "❌ Auto-trade SELL FAILED",
                          description: errorMsg,
                          color: 0xaa0000,
                          fields: [
                            {
                              name: "Note",
                              value:
                                "For SELL orders, you need to own the shares (tokens) you're trying to sell.\n\nYou don't have enough shares of this token to place a SELL order. Auto-trading SELL orders is skipped when you don't own the shares.",
                              inline: false,
                            },
                          ],
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                    logToFile(
                      "WARN",
                      "Skipping SELL auto-trade - user doesn't own enough shares",
                      {
                        tokenId,
                        orderSize,
                        orderPrice,
                        error: errorMsg,
                      }
                    );
                  } else {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "❌ Auto-placed MARKET SELL Order FAILED",
                          description: errorMsg,
                          color: 0xaa0000,
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                  }
                } else if (orderResponse && orderResponse.success !== false) {
                  deleteTrackedPosition(tokenId);
                  const sellEmbed = {
                    title: "✅ Auto-placed MARKET SELL Order",
                    description: `$${orderValue.toFixed(
                      2
                    )} (${orderSize.toFixed(2)} shares) @ market price`,
                    color: 0xaa0000,
                    fields: [
                      {
                        name: "Market",
                        value: title || slug || "Unknown market",
                        inline: false,
                      },
                      {
                        name: "Outcome",
                        value: outcome ?? "Unknown",
                        inline: true,
                      },
                      {
                        name: "Status",
                        value: "Success",
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  };

                  if (
                    positionCheck.allowed &&
                    positionCheck.currentPositions !== undefined
                  ) {
                    const positionsAfter = Math.max(
                      0,
                      positionCheck.currentPositions - 1
                    );
                    sellEmbed.fields.push({
                      name: "Positions After Trade",
                      value: `${positionsAfter}/${MAX_POSITIONS}`,
                      inline: true,
                    });
                    if (positionCheck.currentExposure !== undefined) {
                      const exposureAfter = Math.max(
                        0,
                        positionCheck.currentExposure - orderValue
                      );
                      sellEmbed.fields.push({
                        name: "Total Exposure",
                        value: `$${exposureAfter.toFixed(2)}${
                          MAX_TOTAL_EXPOSURE_USD > 0
                            ? ` / $${MAX_TOTAL_EXPOSURE_USD.toFixed(2)}`
                            : ""
                        }`,
                        inline: true,
                      });
                    }
                  }

                  await activeChannel.send({
                    embeds: [sellEmbed],
                  });
                } else {
                  deleteTrackedPosition(tokenId);
                  const sellEmbedNoStatus = {
                    title: "✅ Auto-placed MARKET SELL Order",
                    description: `$${orderValue.toFixed(
                      2
                    )} (${orderSize.toFixed(2)} shares) @ market price`,
                    color: 0xaa0000,
                    fields: [
                      {
                        name: "Market",
                        value: title || slug || "Unknown market",
                        inline: false,
                      },
                      {
                        name: "Outcome",
                        value: outcome ?? "Unknown",
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  };

                  if (
                    positionCheck.allowed &&
                    positionCheck.currentPositions !== undefined
                  ) {
                    const positionsAfter = Math.max(
                      0,
                      positionCheck.currentPositions - 1
                    );
                    sellEmbedNoStatus.fields.push({
                      name: "Positions After Trade",
                      value: `${positionsAfter}/${MAX_POSITIONS}`,
                      inline: true,
                    });
                    if (positionCheck.currentExposure !== undefined) {
                      const exposureAfter = Math.max(
                        0,
                        positionCheck.currentExposure - orderValue
                      );
                      sellEmbedNoStatus.fields.push({
                        name: "Total Exposure",
                        value: `$${exposureAfter.toFixed(2)}${
                          MAX_TOTAL_EXPOSURE_USD > 0
                            ? ` / $${MAX_TOTAL_EXPOSURE_USD.toFixed(2)}`
                            : ""
                        }`,
                        inline: true,
                      });
                    }
                  }

                  await activeChannel.send({
                    embeds: [sellEmbedNoStatus],
                  });
                }
              }
            } else {
              const MIN_ORDER_SIZE = 5;

              if (orderSize < MIN_ORDER_SIZE && orderPrice > 0) {
                const originalOrderSize = orderSize;
                const originalOrderValue = orderValue;
                orderSize = MIN_ORDER_SIZE;
                orderValue = orderSize * orderPrice;

                if (
                  tradeSide === "BUY" &&
                  MAX_BET_AMOUNT_PER_MARKET_USD > 0 &&
                  tokenId
                ) {
                  let currentPositionValue = 0;
                  if (PAPER_TRADING_ENABLED) {
                    const paperPos = paperTradingState.positions[tokenId];
                    if (paperPos) {
                      currentPositionValue = paperPos.entryValue || 0;
                    }
                  } else {
                    currentPositionValue = await getPositionValueForToken(
                      tokenId
                    );
                  }

                  // Use MAX_BET_AMOUNT_PER_MARKET_USD if set, otherwise fall back to MAX_ORDER_VALUE_USD
                  const maxBetAmount =
                    MAX_BET_AMOUNT_PER_MARKET_USD > 0
                      ? MAX_BET_AMOUNT_PER_MARKET_USD
                      : MAX_ORDER_VALUE_USD;
                  const remainingAmount = Math.max(
                    0,
                    maxBetAmount - currentPositionValue
                  );

                  if (orderValue > remainingAmount && remainingAmount > 0) {
                    orderSize =
                      orderPrice > 0
                        ? remainingAmount / orderPrice
                        : MIN_ORDER_SIZE;
                    orderValue = orderSize * orderPrice;
                    if (orderSize < MIN_ORDER_SIZE) {
                      logToFile(
                        "WARN",
                        "Cannot meet minimum 5 shares after max bet cap, skipping",
                        {
                          originalOrderSize,
                          originalOrderValue,
                          remainingAmount,
                          calculatedSize: orderSize,
                          minSize: MIN_ORDER_SIZE,
                        }
                      );
                      await activeChannel.send({
                        embeds: [
                          {
                            title: "⏸️ Auto-trade Skipped",
                            description: `Cannot meet Polymarket's minimum 5 shares after applying max bet per position limit.`,
                            color: 0xffaa00,
                            fields: [
                              {
                                name: "Remaining Amount",
                                value: `$${remainingAmount.toFixed(2)}`,
                                inline: true,
                              },
                              {
                                name: "Min Shares Required",
                                value: `${MIN_ORDER_SIZE} shares`,
                                inline: true,
                              },
                            ],
                            timestamp: new Date().toISOString(),
                          },
                        ],
                      });
                      continue;
                    }
                  } else if (remainingAmount === 0) {
                    continue;
                  }
                }

                logToFile(
                  "WARN",
                  "Order size below Polymarket minimum, increasing to 5 shares",
                  {
                    originalOrderSize,
                    originalOrderValue,
                    adjustedOrderSize: orderSize,
                    adjustedOrderValue: orderValue,
                    minSize: MIN_ORDER_SIZE,
                    orderPrice,
                  }
                );
                await activeChannel.send({
                  embeds: [
                    {
                      title: "⚠️ Order Size Adjusted",
                      description: `Order size below Polymarket's minimum of ${MIN_ORDER_SIZE} shares.`,
                      color: 0xffaa00,
                      fields: [
                        {
                          name: "Original",
                          value: `${originalOrderSize.toFixed(
                            2
                          )} shares ($${originalOrderValue.toFixed(2)})`,
                          inline: false,
                        },
                        {
                          name: "Adjusted",
                          value: `${orderSize.toFixed(
                            2
                          )} shares ($${orderValue.toFixed(2)})`,
                          inline: false,
                        },
                      ],
                      timestamp: new Date().toISOString(),
                    },
                  ],
                });
              }

              orderSize = Math.round(orderSize * 100) / 100;
              orderValue = orderSize * orderPrice;

              if (tradeSide === "BUY") {
                if (PAPER_TRADING_ENABLED) {
                  const paperResult = await paperBuy(
                    tokenId,
                    orderValue,
                    orderPrice,
                    title || slug || "Unknown",
                    conditionId,
                    null,
                    outcome
                  );

                  if (paperResult && paperResult.error) {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "❌ Paper Trade FAILED",
                          description: paperResult.error,
                          color: 0xaa0000,
                          fields: [
                            {
                              name: "Mode",
                              value: "📝 Paper Trading",
                              inline: true,
                            },
                          ],
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                    continue;
                  }

                  if (paperResult && paperResult.success) {
                    setTrackedPosition(tokenId, {
                      usdcValue: orderValue,
                      timestamp: Date.now(),
                    });
                    const limitBuyEmbed = {
                      title: "✅ Paper Trade: LIMIT BUY",
                      description: `$${orderValue.toFixed(
                        2
                      )} (${orderSize.toFixed(2)} shares @ ${orderPrice})`,
                      color: 0x00aa00,
                      fields: [
                        {
                          name: "Market",
                          value: title || slug || "Unknown market",
                          inline: false,
                        },
                        {
                          name: "Outcome",
                          value: outcome ?? "Unknown",
                          inline: true,
                        },
                        {
                          name: "Mode",
                          value: "📝 Paper Trading",
                          inline: true,
                        },
                        {
                          name: "Confidence",
                          value: confidenceLevel,
                          inline: true,
                        },
                        {
                          name: "Tracked Trade",
                          value: `$${trackedTradeSize.toFixed(2)}`,
                          inline: true,
                        },
                        {
                          name: "Paper Balance",
                          value: `$${paperResult.balance.toFixed(2)}`,
                          inline: true,
                        },
                      ],
                      timestamp: new Date().toISOString(),
                    };

                    if (
                      positionCheck.allowed &&
                      positionCheck.currentPositions !== undefined
                    ) {
                      limitBuyEmbed.fields.push({
                        name: "Positions After Trade",
                        value: `${
                          positionCheck.currentPositions + 1
                        }/${MAX_POSITIONS}`,
                        inline: true,
                      });
                    }

                    await activeChannel.send({
                      embeds: [limitBuyEmbed],
                    });
                    continue;
                  }
                }

                if (PAPER_TRADING_ENABLED) {
                  logToFile(
                    "ERROR",
                    "Attempted real trade while paper trading is enabled - this should not happen",
                    {
                      tokenId,
                      tradeSide: "BUY",
                      orderSize,
                      orderValue,
                    }
                  );
                  continue;
                }

                const orderResponse = await placeBuyOrder(
                  tokenId,
                  orderPrice,
                  orderSize,
                  require("@polymarket/clob-client").OrderType.GTC,
                  clobClient,
                  clobClientReady
                );

                logToFile("INFO", "Buy order response received", {
                  tokenId: tokenId.substring(0, 10) + "...",
                  hasResponse: !!orderResponse,
                  hasError: !!(orderResponse && orderResponse.error),
                  hasSuccess: !!(
                    orderResponse && orderResponse.success !== false
                  ),
                  hasOrderId: !!(orderResponse && orderResponse.orderId),
                  orderId: orderResponse?.orderId,
                });

                if (orderResponse && orderResponse.error) {
                  const errorMsg = orderResponse.error;
                  if (
                    errorMsg.includes("balance") ||
                    errorMsg.includes("allowance")
                  ) {
                    await activeChannel.send(
                      `❌ Auto-trade FAILED: ${errorMsg}\n\n**Action Required:**\n1. Fund your wallet with USDC on Polygon (at least $${(
                        orderSize * orderPrice
                      ).toFixed(
                        2
                      )})\n2. If using a proxy wallet, approve the CLOB contract to spend USDC`
                    );
                  } else {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "❌ Auto-placed LIMIT BUY Order FAILED",
                          description: errorMsg,
                          color: 0xaa0000,
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                  }
                } else if (orderResponse && orderResponse.success !== false) {
                  setTrackedPosition(tokenId, {
                    usdcValue: orderValue,
                    timestamp: Date.now(),
                  });
                  const limitBuyEmbedWithStatus = {
                    title: "✅ Auto-placed LIMIT BUY Order",
                    description: `$${orderValue.toFixed(
                      2
                    )} (${orderSize.toFixed(2)} shares @ ${orderPrice})`,
                    color: 0x00aa00,
                    fields: [
                      {
                        name: "Market",
                        value: title || slug || "Unknown market",
                        inline: false,
                      },
                      {
                        name: "Outcome",
                        value: outcome ?? "Unknown",
                        inline: true,
                      },
                      {
                        name: "Status",
                        value: "Success",
                        inline: true,
                      },
                      {
                        name: "Confidence",
                        value: confidenceLevel,
                        inline: true,
                      },
                      {
                        name: "Tracked Trade",
                        value: `$${trackedTradeSize.toFixed(2)}`,
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  };

                  if (
                    positionCheck.allowed &&
                    positionCheck.currentPositions !== undefined
                  ) {
                    limitBuyEmbedWithStatus.fields.push({
                      name: "Positions After Trade",
                      value: `${
                        positionCheck.currentPositions + 1
                      }/${MAX_POSITIONS}`,
                      inline: true,
                    });
                    if (positionCheck.newTotalExposure) {
                      limitBuyEmbedWithStatus.fields.push({
                        name: "Total Exposure",
                        value: `$${positionCheck.newTotalExposure.toFixed(2)}${
                          MAX_TOTAL_EXPOSURE_USD > 0
                            ? ` / $${MAX_TOTAL_EXPOSURE_USD.toFixed(2)}`
                            : ""
                        }`,
                        inline: true,
                      });
                    }
                  }

                  await activeChannel.send({
                    embeds: [limitBuyEmbedWithStatus],
                  });

                  if (STOP_LOSS_ENABLED && !PAPER_TRADING_ENABLED) {
                    const matchesFilter =
                      STOP_LOSS_WEBSOCKET_MARKET_FILTER.some((filter) => {
                        if (filter.startsWith("0x") && conditionId) {
                          return (
                            conditionId.toLowerCase() === filter.toLowerCase()
                          );
                        }

                        const keyword = filter.toLowerCase();
                        return (
                          (title && title.toLowerCase().includes(keyword)) ||
                          (slug && slug.toLowerCase().includes(keyword))
                        );
                      });

                    if (matchesFilter) {
                      try {
                        const stopLossPrice =
                          orderPrice * (1 - STOP_LOSS_PERCENTAGE / 100);

                        if (orderbookWS && conditionId) {
                          const {
                            getAllStopLossPositions,
                            deleteStopLossPosition,
                          } = require("./positions");
                          const allPositions = getAllStopLossPositions();
                          const marketTypeMatch = (title || slug || "").match(
                            /^([^-]+)/
                          );
                          const marketType = marketTypeMatch
                            ? marketTypeMatch[1].trim()
                            : null;

                          if (marketType) {
                            for (const [
                              oldTokenId,
                              oldPosition,
                            ] of allPositions.entries()) {
                              if (
                                oldPosition.conditionId &&
                                oldPosition.conditionId !== conditionId &&
                                oldPosition.market &&
                                oldPosition.market.includes(marketType)
                              ) {
                                logToFile(
                                  "INFO",
                                  "Cleaning up old hourly event subscription - new event started",
                                  {
                                    oldTokenId:
                                      oldTokenId.substring(0, 10) + "...",
                                    oldConditionId:
                                      oldPosition.conditionId.substring(0, 10) +
                                      "...",
                                    newConditionId:
                                      conditionId.substring(0, 10) + "...",
                                    marketType,
                                  }
                                );
                                orderbookWS.unsubscribe(oldTokenId);
                                deleteStopLossPosition(oldTokenId);
                              }
                            }
                          }
                        }

                        setStopLossPosition(
                          tokenId,
                          orderPrice,
                          orderSize,
                          stopLossPrice,
                          {
                            market: title || slug || "Unknown",
                            conditionId: conditionId || null,
                            outcome: outcome || null,
                          }
                        );

                        if (orderbookWS) {
                          orderbookWS.subscribe(tokenId);
                        }

                        logToFile(
                          "INFO",
                          "Position registered for WebSocket stop-loss monitoring",
                          {
                            tokenId: tokenId.substring(0, 10) + "...",
                            market: title || slug,
                            entryPrice: orderPrice,
                            shares: orderSize,
                            stopLossPrice,
                            filter:
                              STOP_LOSS_WEBSOCKET_MARKET_FILTER.join(", "),
                          }
                        );

                        await activeChannel.send({
                          embeds: [
                            {
                              title: "🛑 Stop-Loss Monitoring Active",
                              description: `Position will be sold via market order when price drops to stop-loss (${STOP_LOSS_PERCENTAGE}% below entry)`,
                              color: 0xff6600,
                              fields: [
                                {
                                  name: "Market",
                                  value: title || slug || "Unknown",
                                  inline: false,
                                },
                                {
                                  name: "Entry Price",
                                  value: `$${orderPrice.toFixed(4)} (${(
                                    orderPrice * 100
                                  ).toFixed(2)}¢)`,
                                  inline: true,
                                },
                                {
                                  name: "Stop-Loss Price",
                                  value: `$${stopLossPrice.toFixed(4)} (${(
                                    stopLossPrice * 100
                                  ).toFixed(2)}¢)`,
                                  inline: true,
                                },
                                {
                                  name: "Shares",
                                  value: `${orderSize.toFixed(2)}`,
                                  inline: true,
                                },
                                {
                                  name: "Method",
                                  value: "WebSocket + Market Order",
                                  inline: true,
                                },
                              ],
                              timestamp: new Date().toISOString(),
                            },
                          ],
                        });
                      } catch (stopLossError) {
                        logToFile(
                          "ERROR",
                          "Error registering position for stop-loss monitoring",
                          {
                            tokenId: tokenId.substring(0, 10) + "...",
                            error: stopLossError.message,
                            stack: stopLossError.stack,
                          }
                        );
                      }
                    } else {
                      logToFile(
                        "INFO",
                        "Skipping WebSocket stop-loss registration - market does not match filter",
                        {
                          tokenId: tokenId.substring(0, 10) + "...",
                          market: title || slug || "Unknown",
                          filter: STOP_LOSS_WEBSOCKET_MARKET_FILTER.join(", "),
                        }
                      );
                    }
                  }
                } else {
                  setTrackedPosition(tokenId, {
                    usdcValue: orderValue,
                    timestamp: Date.now(),
                  });
                  const limitBuyEmbedNoStatus = {
                    title: "✅ Auto-placed LIMIT BUY Order",
                    description: `$${orderValue.toFixed(
                      2
                    )} (${orderSize.toFixed(2)} shares @ ${orderPrice})`,
                    color: 0x00aa00,
                    fields: [
                      {
                        name: "Market",
                        value: title || slug || "Unknown market",
                        inline: false,
                      },
                      {
                        name: "Outcome",
                        value: outcome ?? "Unknown",
                        inline: true,
                      },
                      {
                        name: "Confidence",
                        value: confidenceLevel,
                        inline: true,
                      },
                      {
                        name: "Tracked Trade",
                        value: `$${trackedTradeSize.toFixed(2)}`,
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  };

                  if (
                    positionCheck.allowed &&
                    positionCheck.currentPositions !== undefined
                  ) {
                    limitBuyEmbedNoStatus.fields.push({
                      name: "Positions After Trade",
                      value: `${
                        positionCheck.currentPositions + 1
                      }/${MAX_POSITIONS}`,
                      inline: true,
                    });
                    if (positionCheck.newTotalExposure) {
                      limitBuyEmbedNoStatus.fields.push({
                        name: "Total Exposure",
                        value: `$${positionCheck.newTotalExposure.toFixed(2)}${
                          MAX_TOTAL_EXPOSURE_USD > 0
                            ? ` / $${MAX_TOTAL_EXPOSURE_USD.toFixed(2)}`
                            : ""
                        }`,
                        inline: true,
                      });
                    }
                  }

                  await activeChannel.send({
                    embeds: [limitBuyEmbedNoStatus],
                  });
                }
              } else if (tradeSide === "SELL") {
                if (PAPER_TRADING_ENABLED) {
                  const paperResult = await paperSell(
                    tokenId,
                    orderSize,
                    orderPrice,
                    title || slug || "Unknown"
                  );

                  if (paperResult && paperResult.error) {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "❌ Paper Trade FAILED",
                          description: paperResult.error,
                          color: 0xaa0000,
                          fields: [
                            {
                              name: "Mode",
                              value: "📝 Paper Trading",
                              inline: true,
                            },
                          ],
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                    continue;
                  }

                  if (paperResult && paperResult.success) {
                    deleteTrackedPosition(tokenId);
                    const limitSellEmbed = {
                      title: "✅ Paper Trade: LIMIT SELL",
                      description: `$${orderValue.toFixed(
                        2
                      )} (${orderSize.toFixed(2)} shares @ ${orderPrice})`,
                      color: 0xaa0000,
                      fields: [
                        {
                          name: "Market",
                          value: title || slug || "Unknown market",
                          inline: false,
                        },
                        {
                          name: "Outcome",
                          value: outcome ?? "Unknown",
                          inline: true,
                        },
                        {
                          name: "Mode",
                          value: "📝 Paper Trading",
                          inline: true,
                        },
                        {
                          name: "PnL",
                          value: `$${
                            paperResult.pnl >= 0 ? "+" : ""
                          }${paperResult.pnl.toFixed(2)}`,
                          inline: true,
                        },
                        {
                          name: "Paper Balance",
                          value: `$${paperResult.balance.toFixed(2)}`,
                          inline: true,
                        },
                      ],
                      timestamp: new Date().toISOString(),
                    };

                    if (
                      positionCheck.allowed &&
                      positionCheck.currentPositions !== undefined
                    ) {
                      const positionsAfter = Math.max(
                        0,
                        positionCheck.currentPositions - 1
                      );
                      limitSellEmbed.fields.push({
                        name: "Positions After Trade",
                        value: `${positionsAfter}/${MAX_POSITIONS}`,
                        inline: true,
                      });
                    }

                    await activeChannel.send({
                      embeds: [limitSellEmbed],
                    });
                    continue;
                  }
                }

                if (PAPER_TRADING_ENABLED) {
                  logToFile(
                    "ERROR",
                    "Attempted real trade while paper trading is enabled - this should not happen",
                    {
                      tokenId,
                      tradeSide: "SELL",
                      orderSize,
                      orderValue,
                    }
                  );
                  continue;
                }

                const orderResponse = await placeSellOrder(
                  tokenId,
                  orderPrice,
                  orderSize,
                  require("@polymarket/clob-client").OrderType.GTC,
                  clobClient,
                  clobClientReady
                );
                if (orderResponse && orderResponse.error) {
                  const errorMsg = orderResponse.error;
                  if (
                    errorMsg.includes("balance") ||
                    errorMsg.includes("allowance")
                  ) {
                    await activeChannel.send(
                      `❌ Auto-trade FAILED: ${errorMsg}\n\n**Action Required:**\n1. Fund your wallet with USDC on Polygon\n2. If using a proxy wallet, approve the CLOB contract to spend USDC`
                    );
                  } else if (
                    errorMsg.includes("orderbook") &&
                    errorMsg.includes("does not exist")
                  ) {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "⚠️ Auto-trade SKIPPED",
                          description:
                            "Orderbook does not exist for this market. The market may be closed, expired, or inactive.",
                          color: 0xffaa00,
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                  } else {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "❌ Auto-placed LIMIT SELL Order FAILED",
                          description: errorMsg,
                          color: 0xaa0000,
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                  }
                } else if (orderResponse && orderResponse.success !== false) {
                  deleteTrackedPosition(tokenId);
                  const limitSellEmbed = {
                    title: "✅ Auto-placed LIMIT SELL Order",
                    description: `$${orderValue.toFixed(
                      2
                    )} (${orderSize.toFixed(2)} shares @ ${orderPrice})`,
                    color: 0xaa0000,
                    fields: [
                      {
                        name: "Market",
                        value: title || slug || "Unknown market",
                        inline: false,
                      },
                      {
                        name: "Outcome",
                        value: outcome ?? "Unknown",
                        inline: true,
                      },
                      {
                        name: "Status",
                        value: "Success",
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  };

                  if (
                    positionCheck.allowed &&
                    positionCheck.currentPositions !== undefined
                  ) {
                    const positionsAfter = Math.max(
                      0,
                      positionCheck.currentPositions - 1
                    );
                    limitSellEmbed.fields.push({
                      name: "Positions After Trade",
                      value: `${positionsAfter}/${MAX_POSITIONS}`,
                      inline: true,
                    });
                    if (positionCheck.currentExposure !== undefined) {
                      const exposureAfter = Math.max(
                        0,
                        positionCheck.currentExposure - orderValue
                      );
                      limitSellEmbed.fields.push({
                        name: "Total Exposure",
                        value: `$${exposureAfter.toFixed(2)}${
                          MAX_TOTAL_EXPOSURE_USD > 0
                            ? ` / $${MAX_TOTAL_EXPOSURE_USD.toFixed(2)}`
                            : ""
                        }`,
                        inline: true,
                      });
                    }
                  }

                  await activeChannel.send({
                    embeds: [limitSellEmbed],
                  });
                } else {
                  deleteTrackedPosition(tokenId);
                  const limitSellEmbedNoStatus = {
                    title: "✅ Auto-placed LIMIT SELL Order",
                    description: `$${orderValue.toFixed(
                      2
                    )} (${orderSize.toFixed(2)} shares @ ${orderPrice})`,
                    color: 0xaa0000,
                    fields: [
                      {
                        name: "Market",
                        value: title || slug || "Unknown market",
                        inline: false,
                      },
                      {
                        name: "Outcome",
                        value: outcome ?? "Unknown",
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  };

                  if (
                    positionCheck.allowed &&
                    positionCheck.currentPositions !== undefined
                  ) {
                    const positionsAfter = Math.max(
                      0,
                      positionCheck.currentPositions - 1
                    );
                    limitSellEmbedNoStatus.fields.push({
                      name: "Positions After Trade",
                      value: `${positionsAfter}/${MAX_POSITIONS}`,
                      inline: true,
                    });
                    if (positionCheck.currentExposure !== undefined) {
                      const exposureAfter = Math.max(
                        0,
                        positionCheck.currentExposure - orderValue
                      );
                      limitSellEmbedNoStatus.fields.push({
                        name: "Total Exposure",
                        value: `$${exposureAfter.toFixed(2)}${
                          MAX_TOTAL_EXPOSURE_USD > 0
                            ? ` / $${MAX_TOTAL_EXPOSURE_USD.toFixed(2)}`
                            : ""
                        }`,
                        inline: true,
                      });
                    }
                  }

                  await activeChannel.send({
                    embeds: [limitSellEmbedNoStatus],
                  });
                }
              }
            }
          } catch (tradeError) {
            logToFile("ERROR", "Auto-trade error", {
              error: tradeError.message,
              stack: tradeError.stack,
              tradeSide,
              tokenId: conditionId,
              price,
            });
            await activeChannel.send({
              embeds: [
                {
                  title: "⚠️ Auto-trade Failed",
                  description: tradeError.message,
                  color: 0xffaa00,
                  timestamp: new Date().toISOString(),
                },
              ],
            });
          }
        } else {
          const skipReason = !AUTO_TRADE_ENABLED
            ? "AUTO_TRADE_ENABLED is false"
            : !COPY_TRADE_ENABLED
            ? "COPY_TRADE_ENABLED is false (copy trading disabled)"
            : !clobClient
            ? "CLOB client not initialized"
            : !clobClientReady
            ? "CLOB client not ready (API credentials not set)"
            : !conditionId
            ? "No conditionId in trade"
            : !matchesAutoTradeFilter(trade)
            ? `Trade does not match filter "${AUTO_TRADE_FILTER}"`
            : "Unknown reason";

          if (
            AUTO_TRADE_ENABLED &&
            clobClient &&
            clobClientReady &&
            conditionId &&
            !matchesAutoTradeFilter(trade)
          ) {
            console.log(
              `Auto-trade skipped: Trade does not match filter "${AUTO_TRADE_FILTER}"`
            );
          }
        }
      } catch (error) {
        console.error("Failed to send message to Discord", error);
      }
    }
  } catch (error) {
    console.error("Polling error:", error.message);
  }
}

async function runPollLoop(
  clobClient,
  clobClientReady,
  orderbookWS,
  trackedPositions,
  provider,
  signer
) {
  await pollOnce(clobClient, clobClientReady, orderbookWS, trackedPositions);

  if (orderbookWS && !PAPER_TRADING_ENABLED) {
    try {
      const {
        getAllStopLossPositions,
        deleteStopLossPosition,
      } = require("./positions");
      const stopLossPositions = getAllStopLossPositions();

      if (stopLossPositions && stopLossPositions.size > 0) {
        const positionsToCheck = Array.from(stopLossPositions.entries());
        for (const [tokenId, position] of positionsToCheck) {
          if (!position.conditionId) continue;

          try {
            const marketUrl = `https://data-api.polymarket.com/markets?conditionId=${position.conditionId}`;
            const marketResponse = await fetch(marketUrl, {
              headers: {
                Accept: "application/json",
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              },
            });

            if (marketResponse.ok) {
              const markets = await marketResponse.json();
              if (Array.isArray(markets) && markets.length > 0) {
                const market = markets[0];
                const isResolved =
                  market.resolved ||
                  market.status === "Resolved" ||
                  market.status === "Closed";

                if (isResolved) {
                  logToFile(
                    "INFO",
                    "Market resolved - cleaning up WebSocket subscription",
                    {
                      tokenId: tokenId.substring(0, 10) + "...",
                      conditionId:
                        position.conditionId.substring(0, 10) + "...",
                      market: position.market,
                    }
                  );
                  orderbookWS.unsubscribe(tokenId);
                  deleteStopLossPosition(tokenId);
                }
              }
            }
          } catch (error) {
            logToFile("WARN", "Error checking market resolution for cleanup", {
              tokenId: tokenId.substring(0, 10) + "...",
              error: error.message,
            });
          }
        }
      }
    } catch (error) {
      logToFile("ERROR", "Failed to clean up WebSocket subscriptions", {
        error: error.message,
      });
    }
  }

  if (PAPER_TRADING_ENABLED && isPolling) {
    try {
      await checkAndSettleResolvedMarkets(
        activeChannel,
        orderbookWS,
        clobClient,
        clobClientReady
      );

      if (!PAPER_TRADING_ENABLED) {
        await checkStopLossForRealPositions(
          activeChannel,
          orderbookWS,
          clobClient,
          clobClientReady,
          getCurrentPositions,
          placeMarketSellOrder,
          provider,
          signer
        );
      }
    } catch (error) {
      logToFile("ERROR", "Failed to check resolved markets or stop-loss", {
        error: error.message,
      });
    }
  }

  if (isPolling) {
    scheduleNextPoll(
      clobClient,
      clobClientReady,
      orderbookWS,
      trackedPositions,
      provider,
      signer
    );
  }
}

function scheduleNextPoll(
  clobClient,
  clobClientReady,
  orderbookWS,
  trackedPositions,
  provider,
  signer
) {
  pollTimeout = setTimeout(
    () =>
      runPollLoop(
        clobClient,
        clobClientReady,
        orderbookWS,
        trackedPositions,
        provider,
        signer
      ),
    POLL_INTERVAL_MS
  );
}

async function startPolling(
  channel,
  walletAddress,
  clobClient,
  clobClientReady,
  orderbookWS,
  trackedPositions,
  provider,
  signer
) {
  if (isPolling) {
    if (activeChannel?.id === channel.id) {
      await channel.send("Polling is already running in this channel.");
      return;
    }

    const previousChannelId = activeChannel?.id;
    await channel.send(
      previousChannelId
        ? `Switching monitoring from <#${previousChannelId}> to this channel.`
        : "Switching monitoring to this channel."
    );
  }

  if (!channel.isTextBased()) {
    await channel.send("Cannot start monitoring: channel is not text-based.");
    return;
  }

  const walletToUse = walletAddress || DEFAULT_WALLET;

  if (!isValidWalletAddress(walletToUse)) {
    await channel.send(
      `Invalid wallet address: ${walletToUse}. Please provide a valid Ethereum address (0x followed by 40 hex characters).`
    );
    return;
  }

  currentWallet = walletToUse;
  activeChannel = channel;
  isPolling = true;
  isInitialized = false;
  seenHashes.clear();

  const walletDisplay =
    walletToUse === DEFAULT_WALLET
      ? `default wallet (${DEFAULT_WALLET})`
      : walletToUse;

  await channel.send(
    `Starting Polymarket monitoring for ${walletDisplay} with interval ${
      POLL_INTERVAL_MS / 1000
    }s.`
  );

  if (MAX_BET_AMOUNT_PER_MARKET_USD > 0 && clobClientReady) {
    try {
      const positions = await getCurrentPositions();
      const positionsByToken = new Map();

      for (const pos of positions) {
        const tokenId = pos.token_id || pos.conditionId || pos.tokenID;
        if (tokenId) {
          const value =
            pos.usdc_value || pos.usdcValue || pos.value || pos.cost || 0;
          if (positionsByToken.has(tokenId)) {
            positionsByToken.set(
              tokenId,
              positionsByToken.get(tokenId) +
                (typeof value === "number" ? value : 0)
            );
          } else {
            positionsByToken.set(
              tokenId,
              typeof value === "number" ? value : 0
            );
          }
        }
      }

      const cappedPositions = [];
      for (const [tokenId, totalValue] of positionsByToken.entries()) {
        if (totalValue >= MAX_BET_AMOUNT_PER_MARKET_USD) {
          cappedPositions.push({ tokenId, totalValue });
        }
      }

      if (cappedPositions.length > 0) {
        logToFile(
          "WARN",
          "Existing positions at or above max bet amount on startup",
          {
            count: cappedPositions.length,
            maxBetAmount: MAX_BET_AMOUNT_PER_MARKET_USD,
            positions: cappedPositions.map((p) => ({
              tokenId: p.tokenId.substring(0, 10) + "...",
              value: p.totalValue,
            })),
          }
        );
        await channel.send({
          embeds: [
            {
              title: "⚠️ Position Cap Check (Startup)",
              description: `Found ${cappedPositions.length} position(s) already at or above max bet amount ($${MAX_BET_AMOUNT_PER_MARKET_USD}). These markets will be skipped for new trades.`,
              color: 0xffaa00,
              fields: cappedPositions.slice(0, 10).map((p) => ({
                name: "Position",
                value: `$${p.totalValue.toFixed(
                  2
                )} / $${MAX_BET_AMOUNT_PER_MARKET_USD.toFixed(2)}`,
                inline: true,
              })),
              footer:
                cappedPositions.length > 10
                  ? { text: `...and ${cappedPositions.length - 10} more` }
                  : undefined,
              timestamp: new Date().toISOString(),
            },
          ],
        });
      } else {
        logToFile(
          "INFO",
          "Startup position cap check: All positions below max bet amount",
          {
            totalPositions: positionsByToken.size,
            maxBetAmount: MAX_BET_AMOUNT_PER_MARKET_USD,
          }
        );
      }
    } catch (error) {
      logToFile("ERROR", "Failed to check positions on startup", {
        error: error.message,
        stack: error.stack,
      });
    }
  }

  await pollOnce(clobClient, clobClientReady, orderbookWS, trackedPositions);
  scheduleNextPoll(
    clobClient,
    clobClientReady,
    orderbookWS,
    trackedPositions,
    provider,
    signer
  );
}

async function stopPolling(channel) {
  if (!isPolling) {
    await channel.send("Polling is not currently running.");
    return;
  }

  if (activeChannel?.id && activeChannel.id !== channel.id) {
    await channel.send(
      `Monitoring is currently active in <#${activeChannel?.id}>. Run ${STOP_COMMAND} there or use ${START_COMMAND} here to move it.`
    );
    return;
  }

  clearPollTimeout();
  isPolling = false;
  activeChannel = null;
  await channel.send("Stopped Polymarket monitoring.");
}

function getActiveChannel() {
  return activeChannel;
}

function getCurrentWallet() {
  return currentWallet;
}

function getIsPolling() {
  return isPolling;
}

module.exports = {
  pollOnce,
  runPollLoop,
  scheduleNextPoll,
  startPolling,
  stopPolling,
  getPollingState,
  setPollingState,
  clearPollTimeout,
  setPollTimeout,
  getActiveChannel,
  getCurrentWallet,
  getIsPolling,
};
