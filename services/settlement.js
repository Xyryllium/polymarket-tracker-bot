const fetch = require("node-fetch");
const {
  PAPER_TRADING_ENABLED,
  STOP_LOSS_ENABLED,
  STOP_LOSS_PERCENTAGE,
  STOP_LOSS_CHECK_INTERVAL_MS,
  STOP_LOSS_MIN_TIME_SINCE_ENTRY_MS,
} = require("../config");
const { getStopLossOrder } = require("./positions");
const { logToFile } = require("../utils/logger");
const {
  getPaperTradingState,
  setPaperTradingState,
  paperSell,
} = require("./paperTrading");
const {
  getTokenIdForOutcome,
  getOppositeOutcomeTokenId,
  getCurrentMarketPrice,
} = require("./marketData");
const {
  hasRecentBuyForOutcome,
  getRecentBuyTradesForOutcome,
} = require("./positions");

async function checkStopLossForRealPositions(
  activeChannel,
  orderbookWS,
  clobClient,
  clobClientReady,
  getCurrentPositions,
  placeMarketSellOrder,
  provider,
  signer
) {
  if (!STOP_LOSS_ENABLED || !clobClient || !clobClientReady || !activeChannel) {
    return;
  }

  try {
    const positions = await getCurrentPositions();
    if (!Array.isArray(positions) || positions.length === 0) {
      return;
    }

    const now = Date.now();
    const stopLossThreshold = STOP_LOSS_PERCENTAGE / 100;

    for (const pos of positions) {
      const tokenId = pos.token_id || pos.conditionId || pos.tokenID;
      if (!tokenId) continue;
      const existingStopLossOrder = getStopLossOrder(tokenId);
      if (existingStopLossOrder) {
        logToFile(
          "INFO",
          "Skipping stop-loss check - limit order already placed",
          {
            tokenId: tokenId.substring(0, 10) + "...",
            orderId: existingStopLossOrder.orderId,
            stopLossPrice: existingStopLossOrder.stopLossPrice,
            note: "Stop-loss limit order is active on exchange. No need to check prices continuously.",
          }
        );
        continue;
      }

      const lastChecked = pos.lastChecked || 0;
      const checkInterval = Math.min(STOP_LOSS_CHECK_INTERVAL_MS, 300000);
      if (now - lastChecked < checkInterval) {
        continue;
      }

      try {
        const priceResult = await getCurrentMarketPrice(
          tokenId,
          orderbookWS,
          clobClient,
          clobClientReady
        );

        if (
          !priceResult ||
          priceResult.price === undefined ||
          isNaN(priceResult.price) ||
          priceResult.price < 0 ||
          priceResult.price > 1
        ) {
          continue;
        }

        const currentPrice = priceResult.price;
        const entryPrice =
          pos.avgPrice || pos.price || pos.cost / (pos.shares || 1);
        const shares = pos.shares || pos.size || 0;

        if (entryPrice <= 0 || shares <= 0) {
          continue;
        }

        const lossPercentage = ((entryPrice - currentPrice) / entryPrice) * 100;
        const stopLossPrice = entryPrice * (1 - stopLossThreshold);

        if (
          currentPrice <= stopLossPrice &&
          lossPercentage >= STOP_LOSS_PERCENTAGE
        ) {
          logToFile("WARN", "Stop-loss triggered for real position", {
            tokenId: tokenId.substring(0, 10) + "...",
            entryPrice,
            currentPrice,
            lossPercentage: lossPercentage.toFixed(2),
            shares,
            stopLossThreshold: STOP_LOSS_PERCENTAGE,
          });

          try {
            const stopLossPrice = entryPrice * (1 - stopLossThreshold);

            const { placeSellOrder } = require("./orders");
            const sellResult = await placeSellOrder(
              tokenId,
              stopLossPrice,
              shares,
              "GTC",
              clobClient,
              clobClientReady
            );

            if (sellResult && !sellResult.error) {
              if (sellResult.orderId) {
                const { setStopLossOrder } = require("./positions");
                setStopLossOrder(
                  tokenId,
                  sellResult.orderId,
                  stopLossPrice,
                  entryPrice,
                  shares
                );
              }
              await activeChannel.send({
                embeds: [
                  {
                    title: "🛑 Stop-Loss Triggered (Real Trading)",
                    description: `Position hit stop-loss threshold (${lossPercentage.toFixed(
                      1
                    )}% loss). Limit order placed at stop-loss price.`,
                    color: 0xff6600,
                    fields: [
                      {
                        name: "Shares Sold",
                        value: `${shares.toFixed(2)}`,
                        inline: true,
                      },
                      {
                        name: "Entry Price",
                        value: `$${entryPrice.toFixed(4)} (${(
                          entryPrice * 100
                        ).toFixed(1)}¢)`,
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
                        name: "Current Market",
                        value: `$${currentPrice.toFixed(4)} (${(
                          currentPrice * 100
                        ).toFixed(2)}¢)`,
                        inline: true,
                      },
                      {
                        name: "Loss %",
                        value: `${lossPercentage.toFixed(1)}%`,
                        inline: true,
                      },
                      {
                        name: "Order Type",
                        value: "Limit Order",
                        inline: true,
                      },
                      {
                        name: "Order ID",
                        value: sellResult.orderId || "Pending",
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  },
                ],
              });

              logToFile("INFO", "Real position stop-loss executed", {
                tokenId,
                entryPrice,
                exitPrice: stopLossPrice,
                lossPercentage,
                shares,
                orderId: sellResult.orderId,
              });
            } else {
              logToFile(
                "ERROR",
                "Failed to execute stop-loss sell for real position",
                {
                  tokenId,
                  error: sellResult?.error || "Unknown error",
                }
              );
            }
          } catch (sellError) {
            logToFile("ERROR", "Exception executing stop-loss sell", {
              tokenId,
              error: sellError.message,
            });
          }
        }
      } catch (error) {
        logToFile("WARN", "Failed to check stop-loss for position", {
          tokenId,
          error: error.message,
        });
      }
    }
  } catch (error) {
    logToFile("ERROR", "Failed to check stop-loss for real positions", {
      error: error.message,
    });
  }
}

async function checkAndSettleResolvedMarkets(
  activeChannel,
  orderbookWS,
  clobClient,
  clobClientReady
) {
  if (!PAPER_TRADING_ENABLED || !activeChannel) {
    return;
  }

  const paperTradingState = getPaperTradingState();
  const now = Date.now();
  const positionsToCheck = Object.entries(paperTradingState.positions);

  const checkInterval = STOP_LOSS_ENABLED
    ? Math.min(STOP_LOSS_CHECK_INTERVAL_MS, 300000)
    : 300000;

  for (const [tokenId, position] of positionsToCheck) {
    if (position.lastChecked && now - position.lastChecked < checkInterval) {
      continue;
    }

    try {
      if (!position.conditionId || !position.outcome) {
        logToFile(
          "WARN",
          "Missing conditionId or outcome - skipping stop-loss check",
          {
            tokenId: tokenId.substring(0, 10) + "...",
            hasConditionId: !!position.conditionId,
            hasOutcome: !!position.outcome,
            note: "Cannot verify correct outcome tokenId - skipping stop-loss to avoid checking wrong token",
          }
        );
        continue;
      }

      logToFile("INFO", "Verifying tokenId for stop-loss check", {
        storedTokenId: tokenId.substring(0, 10) + "...",
        conditionId: position.conditionId,
        outcome: position.outcome,
        market: position.market,
      });

      let correctTokenId = await getTokenIdForOutcome(
        position.conditionId,
        position.outcome
      );

      let tokenIdToCheck = correctTokenId || tokenId;
      let tokenIdVerified = !!correctTokenId;

      if (!correctTokenId) {
        logToFile(
          "WARN",
          "Could not verify tokenId via API - will use stored tokenId and verify via WebSocket side field",
          {
            storedTokenId: tokenId.substring(0, 10) + "...",
            conditionId: position.conditionId,
            outcome: position.outcome,
            market: position.market,
            note: "Market API returned 404. Will use stored tokenId and verify using WebSocket last_trade_price side field.",
          }
        );
      } else if (correctTokenId !== tokenId) {
        logToFile(
          "WARN",
          "TokenId mismatch - using correct tokenId for outcome",
          {
            storedTokenId: tokenId.substring(0, 10) + "...",
            correctTokenId: correctTokenId.substring(0, 10) + "...",
            market: position.market,
            outcome: position.outcome,
            note: "Stored tokenId doesn't match outcome - using correct tokenId from market data",
          }
        );
      } else {
        logToFile("INFO", "TokenId verified - matches outcome", {
          tokenId: tokenId.substring(0, 10) + "...",
          outcome: position.outcome,
        });
      }

      logToFile("INFO", "Checking price for paper position", {
        tokenId: tokenIdToCheck.substring(0, 10) + "...",
        fullTokenId: tokenIdToCheck,
        market: position.market,
        outcome: position.outcome,
        entryPrice: position.avgPrice,
      });

      const priceResult = await getCurrentMarketPrice(
        tokenIdToCheck,
        orderbookWS,
        clobClient,
        clobClientReady
      );

      if (
        priceResult !== null &&
        priceResult.price !== undefined &&
        !isNaN(priceResult.price) &&
        priceResult.price >= 0 &&
        priceResult.price <= 1
      ) {
        const currentPrice = priceResult.price;
        const bestBidSize = priceResult.bestBidSize || 0;
        const lastTradeSide = priceResult.side || null;
        const isFromWebSocket = priceResult.source === "websocket_last_trade";

        if (isFromWebSocket && lastTradeSide) {
          const entryPrice = position.avgPrice || 0;
          const isWinningFromWebSocket =
            (position.outcome === "Up" &&
              currentPrice > entryPrice &&
              currentPrice > 0.5) ||
            (position.outcome === "Down" &&
              currentPrice > entryPrice &&
              currentPrice > 0.5);

          if (isWinningFromWebSocket) {
            logToFile(
              "INFO",
              "Skipping stop-loss - WebSocket data shows position is winning",
              {
                tokenId: tokenIdToCheck.substring(0, 10) + "...",
                market: position.market,
                outcome: position.outcome,
                entryPrice,
                currentPrice,
                lastTradeSide,
                note: "WebSocket last_trade_price indicates position is winning. Skipping stop-loss to avoid false trigger.",
              }
            );
            continue;
          }
        }

        if (!tokenIdVerified && position.conditionId) {
          const entryPrice = position.avgPrice || 0;
          const oppositeOutcome =
            position.outcome === "Up"
              ? "Down"
              : position.outcome === "Down"
              ? "Up"
              : null;

          if (oppositeOutcome) {
            logToFile(
              "INFO",
              "Checking opposite outcome buys for stop-loss verification",
              {
                tokenId: tokenIdToCheck.substring(0, 10) + "...",
                market: position.market,
                conditionId: position.conditionId
                  ? position.conditionId.substring(0, 10) + "..."
                  : "MISSING",
                outcome: position.outcome,
                oppositeOutcome,
                note: "Using position's conditionId to look up opposite outcome buys. If conditionId is wrong, we'll check wrong market.",
              }
            );

            const oppositeBuyTrades = getRecentBuyTradesForOutcome(
              position.conditionId,
              oppositeOutcome
            );

            if (oppositeBuyTrades.length > 0) {
              const recentOppositeBuys = oppositeBuyTrades
                .filter((trade) => trade.timestamp > Date.now() - 5 * 60 * 1000)
                .sort((a, b) => b.timestamp - a.timestamp);

              const oppositeBoughtAboveEntry = recentOppositeBuys.some(
                (trade) => trade.price && trade.price > entryPrice
              );

              const ourOutcomeAtVeryLowPrice = currentPrice < 0.1;
              const oppositeWasBoughtRecently = recentOppositeBuys.length > 0;
              const oppositeWasEverBought = oppositeBuyTrades.length > 0;
              const oppositeBoughtAtLowPrices = recentOppositeBuys.some(
                (trade) =>
                  trade.price && trade.price < entryPrice && trade.price < 0.3
              );

              if (
                oppositeBoughtAtLowPrices &&
                ourOutcomeAtVeryLowPrice &&
                currentPrice < 0.1 &&
                !oppositeBoughtAboveEntry
              ) {
                logToFile(
                  "INFO",
                  "Copy wallet bought opposite outcome at low prices - possible wrong token",
                  {
                    tokenId: tokenIdToCheck.substring(0, 10) + "...",
                    market: position.market,
                    outcome: position.outcome,
                    oppositeOutcome,
                    oppositeBuyCount: oppositeBuyTrades.length,
                    recentOppositeBuys: recentOppositeBuys.length,
                    oppositeBuyPrices: recentOppositeBuys
                      .filter((t) => t.price)
                      .map((t) => t.price),
                    conditionId: position.conditionId.substring(0, 10) + "...",
                    currentPrice,
                    entryPrice,
                    oppositeBoughtAboveEntry,
                    oppositeBoughtAtLowPrices,
                    ourOutcomeAtVeryLowPrice,
                    note: "Copy wallet bought opposite outcome at low prices and our outcome is at very low price. This might indicate wrong token (both losing). Skipping stop-loss to avoid false trigger.",
                  }
                );
                continue;
              }

              if (oppositeBoughtAboveEntry) {
                logToFile(
                  "INFO",
                  "Copy wallet bought opposite outcome above entry - opposite is winning, our position is losing",
                  {
                    tokenId: tokenIdToCheck.substring(0, 10) + "...",
                    market: position.market,
                    outcome: position.outcome,
                    oppositeOutcome,
                    oppositeBuyCount: oppositeBuyTrades.length,
                    recentOppositeBuys: recentOppositeBuys.length,
                    oppositeBuyPrices: recentOppositeBuys
                      .filter((t) => t.price)
                      .map((t) => t.price),
                    conditionId: position.conditionId.substring(0, 10) + "...",
                    currentPrice,
                    entryPrice,
                    oppositeBoughtAboveEntry,
                    note: "Copy wallet bought opposite outcome above our entry price. Opposite is winning, our position is losing. Proceeding with stop-loss check.",
                  }
                );
              }

              logToFile(
                "INFO",
                "Copy wallet bought opposite outcome - will verify via price check",
                {
                  tokenId: tokenIdToCheck.substring(0, 10) + "...",
                  market: position.market,
                  outcome: position.outcome,
                  oppositeOutcome,
                  oppositeBuyCount: oppositeBuyTrades.length,
                  recentOppositeBuys: recentOppositeBuys.length,
                  oppositeBuyPrices: recentOppositeBuys
                    .filter((t) => t.price)
                    .map((t) => t.price),
                  conditionId: position.conditionId.substring(0, 10) + "...",
                  currentPrice,
                  entryPrice,
                  note: "Copy wallet has recent buy activity for opposite outcome. Will verify via opposite outcome price check.",
                }
              );
            }
          }

          try {
            const oppositeOutcome =
              position.outcome === "Up"
                ? "Down"
                : position.outcome === "Down"
                ? "Up"
                : null;

            if (oppositeOutcome) {
              const oppositeTokenId = await getOppositeOutcomeTokenId(
                position.conditionId,
                position.outcome
              );

              if (oppositeTokenId) {
                const oppositePriceResult = await getCurrentMarketPrice(
                  oppositeTokenId,
                  orderbookWS,
                  clobClient,
                  clobClientReady
                );

                if (
                  oppositePriceResult &&
                  oppositePriceResult.price !== undefined
                ) {
                  const oppositePrice = oppositePriceResult.price;
                  const oppositeIsAboveEntry = oppositePrice > entryPrice;
                  const ourPriceIsAboveEntry = currentPrice > entryPrice;

                  const oppositeIsWinning =
                    oppositePrice > entryPrice && oppositePrice > 0.5;
                  const weAppearWinning =
                    currentPrice > entryPrice && currentPrice > 0.5;

                  const oppositeIsLosing =
                    oppositePrice < entryPrice && oppositePrice < 0.5;
                  const weAppearLosing =
                    currentPrice < entryPrice && currentPrice < 0.5;

                  const seemsWrongToken =
                    (oppositeIsWinning && weAppearWinning) ||
                    (oppositeIsLosing && weAppearLosing);

                  if (seemsWrongToken) {
                    logToFile(
                      "WARN",
                      "Price verification failed - opposite outcome check suggests wrong token",
                      {
                        tokenId: tokenIdToCheck.substring(0, 10) + "...",
                        market: position.market,
                        outcome: position.outcome,
                        entryPrice,
                        currentPrice,
                        oppositeOutcome,
                        oppositePrice,
                        oppositeTokenId:
                          oppositeTokenId.substring(0, 10) + "...",
                        oppositeIsWinning,
                        weAppearWinning,
                        oppositeIsLosing,
                        weAppearLosing,
                        note: "Opposite outcome price suggests we're checking the wrong token. Skipping stop-loss to avoid false trigger.",
                      }
                    );
                    continue;
                  } else {
                    logToFile(
                      "INFO",
                      "Price verified via opposite outcome check",
                      {
                        tokenId: tokenIdToCheck.substring(0, 10) + "...",
                        market: position.market,
                        outcome: position.outcome,
                        entryPrice,
                        currentPrice,
                        oppositeOutcome,
                        oppositePrice,
                        oppositeIsWinning,
                        weAppearWinning,
                        note: "Opposite outcome price confirms we're checking the correct token.",
                      }
                    );
                  }
                }
              }
            }
          } catch (error) {
            logToFile(
              "WARN",
              "Error checking opposite outcome for verification",
              {
                tokenId: tokenIdToCheck.substring(0, 10) + "...",
                market: position.market,
                outcome: position.outcome,
                error: error.message,
                note: "Will proceed with price consistency check instead",
              }
            );

            const priceSeemsWrong =
              (position.outcome === "Up" &&
                currentPrice < 0.1 &&
                entryPrice > 0.5) ||
              (position.outcome === "Down" &&
                currentPrice < 0.1 &&
                entryPrice > 0.5) ||
              (position.outcome === "Up" &&
                currentPrice > 0.9 &&
                entryPrice < 0.5) ||
              (position.outcome === "Down" &&
                currentPrice > 0.9 &&
                entryPrice < 0.5);

            if (priceSeemsWrong) {
              logToFile(
                "WARN",
                "Price seems inconsistent with outcome - possible wrong token",
                {
                  tokenId: tokenIdToCheck.substring(0, 10) + "...",
                  market: position.market,
                  outcome: position.outcome,
                  currentPrice,
                  entryPrice,
                  lastTradeSide,
                  isFromWebSocket,
                  note: "Price suggests we might be checking wrong outcome. Skipping stop-loss to avoid false trigger.",
                }
              );
              continue;
            }
          }
        }

        logToFile("INFO", "Checking position price", {
          tokenId: tokenId.substring(0, 10) + "...",
          tokenIdToCheck: tokenIdToCheck.substring(0, 10) + "...",
          market: position.market,
          outcome: position.outcome,
          currentPrice,
          bestBidSize,
          lastTradeSide,
          entryPrice: position.avgPrice,
          tokenIdVerified,
          note: tokenIdVerified
            ? "Using verified tokenId for correct outcome"
            : "Using stored tokenId - verified via price consistency check",
        });

        const entryPrice = position.avgPrice || 0;
        position.lastChecked = now;

        const isActuallyWinning =
          (position.outcome === "Up" &&
            currentPrice > entryPrice &&
            currentPrice > 0.5) ||
          (position.outcome === "Down" &&
            currentPrice > entryPrice &&
            currentPrice > 0.5) ||
          currentPrice > 0.9;

        if (isActuallyWinning) {
          logToFile("INFO", "Skipping stop-loss - position is winning", {
            tokenId: tokenIdToCheck.substring(0, 10) + "...",
            market: position.market,
            outcome: position.outcome,
            entryPrice,
            currentPrice,
            lastTradeSide,
            isFromWebSocket,
            note: "Position is winning based on current price. Skipping stop-loss.",
          });
          continue;
        }

        const lossPercentage =
          entryPrice > 0 ? ((entryPrice - currentPrice) / entryPrice) * 100 : 0;

        if (STOP_LOSS_ENABLED && entryPrice > 0 && !position.stopLossPending) {
          const entryTimestamp =
            position.entryTimestamp || position.lastChecked || now;
          const timeSinceEntry = now - entryTimestamp;

          if (timeSinceEntry < STOP_LOSS_MIN_TIME_SINCE_ENTRY_MS) {
            logToFile(
              "INFO",
              "Skipping stop-loss - minimum time since entry not met",
              {
                tokenId: tokenIdToCheck.substring(0, 10) + "...",
                market: position.market,
                outcome: position.outcome,
                entryPrice,
                currentPrice,
                timeSinceEntryMs: timeSinceEntry,
                minTimeSinceEntryMs: STOP_LOSS_MIN_TIME_SINCE_ENTRY_MS,
                note: `Position entered ${Math.round(
                  timeSinceEntry / 1000
                )}s ago. Minimum ${Math.round(
                  STOP_LOSS_MIN_TIME_SINCE_ENTRY_MS / 1000
                )}s required before stop-loss can trigger.`,
              }
            );
            continue;
          }

          const priceToCheck = currentPrice;
          const stopLossThreshold = STOP_LOSS_PERCENTAGE;

          const isWinning = priceToCheck > 0.9 || priceToCheck >= entryPrice;
          const isSignificantLoss =
            priceToCheck < entryPrice && lossPercentage >= stopLossThreshold;

          logToFile("INFO", "Checking stop-loss for position", {
            tokenId: tokenId.substring(0, 10) + "...",
            correctTokenId: tokenIdToCheck.substring(0, 10) + "...",
            market: position.market,
            outcome: position.outcome,
            entryPrice,
            currentPrice: priceToCheck,
            lastTradeSide,
            lossPercentage: lossPercentage.toFixed(2),
            stopLossThreshold,
            isWinning,
            isSignificantLoss,
            willTrigger: isSignificantLoss && !isWinning,
            note:
              "Using verified tokenId for correct outcome - checking " +
              position.outcome +
              " price",
          });

          if (isSignificantLoss && !isWinning) {
            const stopLossPrice = entryPrice * (1 - stopLossThreshold / 100);
            let actualSellPrice = stopLossPrice;
            let isResolved = false;
            let settlementPrice = null;

            if (position.conditionId) {
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
                    isResolved =
                      market.resolved ||
                      market.status === "Resolved" ||
                      market.status === "Closed";
                    const finalPrice =
                      market.outcomePrices?.[0] || market.resolvedPrice || null;

                    if (
                      isResolved &&
                      finalPrice !== null &&
                      finalPrice !== undefined
                    ) {
                      settlementPrice =
                        typeof finalPrice === "number"
                          ? finalPrice
                          : parseFloat(finalPrice);
                      if (
                        !isNaN(settlementPrice) &&
                        settlementPrice >= 0 &&
                        settlementPrice <= 1
                      ) {
                        actualSellPrice = settlementPrice;
                        logToFile(
                          "INFO",
                          "Market resolved - using settlement price for stop-loss",
                          {
                            tokenId: tokenId.substring(0, 10) + "...",
                            market: position.market,
                            outcome: position.outcome,
                            stopLossPrice,
                            settlementPrice,
                            actualSellPrice,
                            note: "Market already resolved - using settlement price instead of stop-loss price",
                          }
                        );
                      }
                    }
                  }
                }
              } catch (error) {
                logToFile(
                  "WARN",
                  "Error checking market resolution for stop-loss",
                  {
                    tokenId: tokenId.substring(0, 10) + "...",
                    error: error.message,
                    note: "Will use stop-loss price",
                  }
                );
              }
            }

            position.stopLossPending = true;
            setPaperTradingState(paperTradingState);

            logToFile("WARN", "Stop-loss triggered for paper position", {
              tokenId: tokenId.substring(0, 10) + "...",
              market: position.market,
              outcome: position.outcome,
              entryPrice,
              currentPrice: priceToCheck,
              stopLossPrice,
              actualSellPrice,
              isResolved,
              settlementPrice,
              orderType: isResolved
                ? "SETTLEMENT (market resolved)"
                : "LIMIT (at stop-loss price)",
              lossPercentage: lossPercentage.toFixed(2),
              stopLossThreshold,
              note: isResolved
                ? "Market resolved - using settlement price instead of stop-loss price"
                : "Placing limit order at stop-loss price",
            });
            const sharesBeforeSell = position.shares;

            const sellResult = await paperSell(
              tokenId,
              sharesBeforeSell,
              actualSellPrice,
              position.market
            );

            if (sellResult && !sellResult.error) {
              const sharesSold = sellResult.shares || sharesBeforeSell;
              const proceeds =
                sellResult.proceeds || sharesSold * actualSellPrice;
              const pnl =
                sellResult.pnl || (actualSellPrice - entryPrice) * sharesSold;

              const tradeHistory = paperTradingState.tradeHistory;
              const lastTrade = tradeHistory[tradeHistory.length - 1];
              if (
                lastTrade &&
                lastTrade.tokenId === tokenId &&
                lastTrade.side === "SELL"
              ) {
                lastTrade.side = "STOP_LOSS";
                lastTrade.stopLossTriggered = true;
                lastTrade.lossPercentage = lossPercentage;
              }

              await activeChannel.send({
                embeds: [
                  {
                    title: isResolved
                      ? "🛑 Stop-Loss Triggered (Market Resolved)"
                      : "🛑 Stop-Loss Triggered",
                    description: isResolved
                      ? `Position in "${
                          position.market
                        }" hit stop-loss threshold, but market was already resolved. Position settled at market resolution price ($${settlementPrice.toFixed(
                          4
                        )}) instead of stop-loss price.`
                      : `Position in "${
                          position.market
                        }" hit stop-loss threshold (${lossPercentage.toFixed(
                          1
                        )}% loss). Position automatically sold at stop-loss price.`,
                    color: 0xff6600,
                    fields: [
                      {
                        name: "Shares Sold",
                        value: `${sharesSold.toFixed(2)}`,
                        inline: true,
                      },
                      {
                        name: "Entry Price",
                        value: `$${entryPrice.toFixed(4)} (${(
                          entryPrice * 100
                        ).toFixed(1)}¢)`,
                        inline: true,
                      },
                      {
                        name: "Exit Price",
                        value: `$${actualSellPrice.toFixed(4)} (${(
                          actualSellPrice * 100
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
                        name: "Order Type",
                        value: isResolved
                          ? "Settlement (Market Resolved)"
                          : "Limit Order",
                        inline: true,
                      },
                      {
                        name: isResolved ? "Settlement Price" : "Loss %",
                        value: isResolved
                          ? `$${settlementPrice.toFixed(4)} (${(
                              settlementPrice * 100
                            ).toFixed(2)}¢)`
                          : `${lossPercentage.toFixed(1)}%`,
                        inline: true,
                      },
                      {
                        name: "Proceeds",
                        value: `$${proceeds.toFixed(2)}`,
                        inline: true,
                      },
                      {
                        name: "PnL",
                        value: `$${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
                        inline: true,
                      },
                      {
                        name: "New Balance",
                        value: `$${
                          sellResult.balance ||
                          paperTradingState.balance.toFixed(2)
                        }`,
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  },
                ],
              });

              logToFile("INFO", "Paper position stop-loss executed", {
                tokenId,
                market: position.market,
                shares: position.shares,
                entryPrice,
                exitPrice: stopLossPrice,
                lossPercentage,
                pnl,
                proceeds,
              });

              delete paperTradingState.positions[tokenId];
              setPaperTradingState(paperTradingState);
              continue;
            } else {
              logToFile("ERROR", "Failed to execute stop-loss sell", {
                tokenId,
                error: sellResult?.error || "Unknown error",
              });
            }
          }
        }
      }
    } catch (error) {
      logToFile("WARN", "Failed to check orderbook price", {
        tokenId,
        error: error.message,
      });
    }

    if (position.conditionId) {
      try {
        const marketUrl = `https://data-api.polymarket.com/markets?conditionId=${position.conditionId}`;
        const response = await fetch(marketUrl, {
          headers: {
            accept: "application/json",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
        });

        if (response.ok) {
          const markets = await response.json();
          if (Array.isArray(markets) && markets.length > 0) {
            const market = markets[0];
            const resolved =
              market.resolved ||
              market.status === "Resolved" ||
              market.status === "Closed";
            const finalPrice =
              market.outcomePrices?.[0] || market.resolvedPrice || null;

            position.lastChecked = now;

            if (resolved && finalPrice !== null && finalPrice !== undefined) {
              const settlementPrice =
                typeof finalPrice === "number"
                  ? finalPrice
                  : parseFloat(finalPrice);
              if (
                !isNaN(settlementPrice) &&
                settlementPrice >= 0 &&
                settlementPrice <= 1
              ) {
                const pnl =
                  position.shares * (settlementPrice - position.avgPrice);
                const proceeds = position.shares * settlementPrice;

                paperTradingState.balance += proceeds;
                paperTradingState.realizedPnL += pnl;

                paperTradingState.tradeHistory.push({
                  timestamp: Date.now(),
                  side: "SETTLEMENT",
                  tokenId,
                  shares: position.shares,
                  price: settlementPrice,
                  value: proceeds,
                  pnl: pnl,
                  market: position.market,
                });

                await activeChannel.send({
                  embeds: [
                    {
                      title: "✅ Market Resolved - Paper Position Settled",
                      description: `Market "${position.market}" has been resolved and position settled automatically.`,
                      color: pnl >= 0 ? 0x00aa00 : 0xaa0000,
                      fields: [
                        {
                          name: "Shares",
                          value: `${position.shares.toFixed(2)}`,
                          inline: true,
                        },
                        {
                          name: "Entry Price",
                          value: `$${position.avgPrice.toFixed(4)}`,
                          inline: true,
                        },
                        {
                          name: "Settlement Price",
                          value: `$${settlementPrice.toFixed(4)}`,
                          inline: true,
                        },
                        {
                          name: "Proceeds",
                          value: `$${proceeds.toFixed(2)}`,
                          inline: true,
                        },
                        {
                          name: "PnL",
                          value: `$${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
                          inline: true,
                        },
                        {
                          name: "New Balance",
                          value: `$${paperTradingState.balance.toFixed(2)}`,
                          inline: true,
                        },
                      ],
                      timestamp: new Date().toISOString(),
                    },
                  ],
                });

                logToFile(
                  "INFO",
                  "Paper position settled due to market resolution",
                  {
                    tokenId,
                    market: position.market,
                    shares: position.shares,
                    entryPrice: position.avgPrice,
                    settlementPrice,
                    pnl,
                    proceeds,
                  }
                );

                delete paperTradingState.positions[tokenId];
                setPaperTradingState(paperTradingState);
              }
            }
          }
        }
      } catch (error) {
        logToFile("WARN", "Failed to check market resolution status", {
          tokenId,
          conditionId: position.conditionId,
          error: error.message,
        });
      }
    }
  }
}

module.exports = {
  checkAndSettleResolvedMarkets,
  checkStopLossForRealPositions,
};
