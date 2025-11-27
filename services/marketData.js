const fetch = require("node-fetch");
const { logToFile } = require("../utils/logger");

async function fetchLatestActivity(walletAddress) {
  const apiUrl = `https://data-api.polymarket.com/activity?user=${walletAddress}&limit=25&offset=0`;
  const response = await fetch(apiUrl, {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Polymarket API returned ${response.status} ${response.statusText}`
    );
  }

  const parsed = await response.json();

  if (!Array.isArray(parsed)) {
    throw new Error("Unexpected API response format.");
  }

  return parsed;
}

async function getTokenIdForOutcome(conditionId, outcome) {
  if (!conditionId || !outcome) {
    return null;
  }

  try {
    const marketUrl = `https://data-api.polymarket.com/markets?conditionId=${conditionId}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(marketUrl, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const markets = await response.json();
      if (Array.isArray(markets) && markets.length > 0) {
        const market = markets[0];

        logToFile("INFO", "Market data retrieved for tokenId lookup", {
          conditionId,
          outcome,
          hasTokens: !!(market.tokens && Array.isArray(market.tokens)),
          hasOutcomes: !!(market.outcomes && Array.isArray(market.outcomes)),
          tokensCount: market.tokens?.length || 0,
          outcomesCount: market.outcomes?.length || 0,
          marketKeys: Object.keys(market),
        });

        if (market.tokens && Array.isArray(market.tokens)) {
          for (const token of market.tokens) {
            const tokenOutcome =
              token.outcome || token.title || token.name || token.label;
            const tokenId = String(
              token.token_id || token.asset_id || token.id || ""
            );

            logToFile("INFO", "Checking token for outcome match", {
              conditionId,
              targetOutcome: outcome,
              tokenOutcome,
              tokenId: tokenId.substring(0, 10) + "...",
              tokenKeys: Object.keys(token),
            });

            if (
              tokenOutcome &&
              tokenOutcome.toLowerCase() === outcome.toLowerCase()
            ) {
              if (tokenId) {
                logToFile("INFO", "Found correct tokenId for outcome", {
                  conditionId,
                  outcome,
                  tokenId: tokenId.substring(0, 10) + "...",
                  fullTokenId: tokenId,
                  source: "tokens array",
                });
                return tokenId;
              }
            }
          }
        }

        if (market.outcomes && Array.isArray(market.outcomes)) {
          for (const outcomeOption of market.outcomes) {
            const outcomeTitle =
              outcomeOption.title ||
              outcomeOption.name ||
              outcomeOption.outcome ||
              outcomeOption.label;
            const tokenId = String(
              outcomeOption.token_id ||
                outcomeOption.asset_id ||
                outcomeOption.id ||
                ""
            );

            logToFile("INFO", "Checking outcome option for match", {
              conditionId,
              targetOutcome: outcome,
              outcomeTitle,
              tokenId: tokenId.substring(0, 10) + "...",
              outcomeKeys: Object.keys(outcomeOption),
            });

            if (
              outcomeTitle &&
              outcomeTitle.toLowerCase() === outcome.toLowerCase()
            ) {
              if (tokenId) {
                logToFile("INFO", "Found correct tokenId from outcomes array", {
                  conditionId,
                  outcome,
                  tokenId: tokenId.substring(0, 10) + "...",
                  fullTokenId: tokenId,
                  source: "outcomes array",
                });
                return tokenId;
              }
            }
          }
        }

        logToFile("WARN", "Could not find matching tokenId for outcome", {
          conditionId,
          targetOutcome: outcome,
          availableTokens:
            market.tokens?.map((t) => ({
              outcome: t.outcome || t.title || t.name || t.label,
              tokenId:
                String(t.token_id || t.asset_id || t.id || "").substring(
                  0,
                  10
                ) + "...",
            })) || [],
          availableOutcomes:
            market.outcomes?.map((o) => ({
              title: o.title || o.name || o.outcome || o.label,
              tokenId:
                String(o.token_id || o.asset_id || o.id || "").substring(
                  0,
                  10
                ) + "...",
            })) || [],
        });
      }
    } else {
      logToFile("WARN", "Market API returned non-OK status", {
        conditionId,
        outcome,
        status: response.status,
        statusText: response.statusText,
      });
    }
  } catch (error) {
    logToFile("WARN", "Failed to fetch market data for tokenId lookup", {
      conditionId,
      outcome,
      error: error.message,
    });
  }

  return null;
}

async function getOppositeOutcomeTokenId(conditionId, currentOutcome) {
  const oppositeOutcome =
    currentOutcome === "Up" ? "Down" : currentOutcome === "Down" ? "Up" : null;

  if (!oppositeOutcome) {
    return null;
  }

  return await getTokenIdForOutcome(conditionId, oppositeOutcome);
}

async function getCurrentMarketPrice(
  tokenId,
  orderbookWS,
  clobClient,
  clobClientReady
) {
  try {
    let orderBook = null;
    let orderBookSource = "none";

    if (orderbookWS) {
      orderbookWS.subscribe(tokenId);
      if (orderbookWS.isConnected) {
        const lastTrade = orderbookWS.getLastTradePrice(tokenId);
        if (lastTrade && Date.now() - lastTrade.timestamp < 30000) {
          return {
            price: lastTrade.price,
            bestBidSize: lastTrade.size || 0,
            side: lastTrade.side,
            source: "websocket_last_trade",
            isLastTrade: true,
          };
        }
      }

      const wsOrderbook = orderbookWS.getOrderbook(tokenId);
      if (wsOrderbook && Date.now() - wsOrderbook.timestamp < 5000) {
        orderBook = {
          asks: wsOrderbook.asks,
          bids: wsOrderbook.bids,
        };
        orderBookSource = "websocket";
        logToFile("INFO", "Using WebSocket orderbook (cached)", {
          tokenId: tokenId.substring(0, 10) + "...",
          age: Date.now() - wsOrderbook.timestamp,
        });
      } else {
        const maxWait = 1000;
        const checkInterval = 100;
        let waited = 0;

        while (waited < maxWait && !orderBook) {
          await new Promise((resolve) => setTimeout(resolve, checkInterval));
          waited += checkInterval;

          const lastTradeCheck = orderbookWS.getLastTradePrice(tokenId);
          if (lastTradeCheck && Date.now() - lastTradeCheck.timestamp < 30000) {
            return {
              price: lastTradeCheck.price,
              bestBidSize: lastTradeCheck.size || 0,
              side: lastTradeCheck.side,
              source: "websocket_last_trade",
              isLastTrade: true,
            };
          }

          const wsOrderbookCheck = orderbookWS.getOrderbook(tokenId);
          if (
            wsOrderbookCheck &&
            Date.now() - wsOrderbookCheck.timestamp < 5000
          ) {
            orderBook = {
              asks: wsOrderbookCheck.asks,
              bids: wsOrderbookCheck.bids,
            };
            orderBookSource = "websocket";
            logToFile("INFO", "Using WebSocket orderbook (after wait)", {
              tokenId: tokenId.substring(0, 10) + "...",
              waitTime: waited,
              age: Date.now() - wsOrderbookCheck.timestamp,
            });
            break;
          }
        }

        if (!orderBook) {
          logToFile(
            "INFO",
            "WebSocket orderbook not available, will use REST",
            {
              tokenId: tokenId.substring(0, 10) + "...",
              waited,
            }
          );
        }
      }
    }

    if (!orderBook && clobClient && clobClientReady) {
      try {
        orderBook = await clobClient.getOrderBook(tokenId);
        orderBookSource = "rest";
      } catch (error) {
        logToFile("WARN", "Failed to get orderbook via REST", {
          tokenId: tokenId.substring(0, 10) + "...",
          error: error.message,
        });
      }
    }

    if (orderBook) {
      const hasBids = orderBook.bids && orderBook.bids.length > 0;
      const hasAsks = orderBook.asks && orderBook.asks.length > 0;
      logToFile("INFO", "Orderbook retrieved", {
        tokenId: tokenId.substring(0, 10) + "...",
        source: orderBookSource,
        hasBids,
        hasAsks,
        bidCount: orderBook.bids?.length || 0,
        askCount: orderBook.asks?.length || 0,
      });
    } else {
      logToFile("WARN", "No orderbook available", {
        tokenId: tokenId.substring(0, 10) + "...",
      });
      return null;
    }

    if (orderbookWS && orderbookWS.isConnected) {
      const lastTrade = orderbookWS.getLastTradePrice(tokenId);
      if (lastTrade && Date.now() - lastTrade.timestamp < 30000) {
        return {
          price: lastTrade.price,
          bestBidSize: lastTrade.size || 0,
          side: lastTrade.side,
          source: "websocket_last_trade",
          isLastTrade: true,
        };
      }
    }

    if (orderBook && orderBook.bids && orderBook.bids.length > 0) {
      const bestBid = orderBook.bids[0];
      if (bestBid && bestBid.price) {
        const price = parseFloat(bestBid.price);
        if (!isNaN(price) && price >= 0 && price <= 1) {
          logToFile("INFO", "Using best bid price", {
            tokenId: tokenId.substring(0, 10) + "...",
            fullTokenId: tokenId,
            price,
            bestBidPrice: bestBid.price,
            bestBidSize: bestBid.size,
            totalBids: orderBook.bids.length,
            source: orderBookSource,
            top3Bids: orderBook.bids
              .slice(0, 3)
              .map((b) => ({ price: b.price, size: b.size })),
          });
          return {
            price,
            bestBidSize: parseFloat(bestBid.size) || 0,
            source: orderBookSource,
            isLastTrade: false,
          };
        } else {
          logToFile("WARN", "Best bid price is invalid", {
            tokenId: tokenId.substring(0, 10) + "...",
            price,
            bestBid,
          });
        }
      }
    }

    if (orderBook && orderBook.asks && orderBook.asks.length > 0) {
      const bestAsk = orderBook.asks[0];
      if (bestAsk && bestAsk.price) {
        const price = parseFloat(bestAsk.price);
        if (!isNaN(price) && price >= 0 && price <= 1) {
          logToFile("INFO", "Using best ask price", {
            tokenId: tokenId.substring(0, 10) + "...",
            price,
            source: orderBookSource,
          });
          return { price, bestBidSize: 0 };
        }
      }
    }

    if (
      orderBook &&
      orderBook.bids &&
      orderBook.asks &&
      orderBook.bids.length > 0 &&
      orderBook.asks.length > 0
    ) {
      const bestBid = parseFloat(orderBook.bids[0].price);
      const bestAsk = parseFloat(orderBook.asks[0].price);
      if (!isNaN(bestBid) && !isNaN(bestAsk) && bestBid >= 0 && bestAsk <= 1) {
        const midPrice = (bestBid + bestAsk) / 2;
        logToFile("INFO", "Using mid price", {
          tokenId: tokenId.substring(0, 10) + "...",
          midPrice,
          bestBid,
          bestAsk,
          source: orderBookSource,
        });
        const bestBidSize = parseFloat(orderBook.bids[0].size) || 0;
        return { price: midPrice, bestBidSize };
      }
    }

    logToFile("WARN", "Orderbook exists but no valid prices found", {
      tokenId: tokenId.substring(0, 10) + "...",
      hasBids: !!(orderBook && orderBook.bids && orderBook.bids.length > 0),
      hasAsks: !!(orderBook && orderBook.asks && orderBook.asks.length > 0),
    });
  } catch (error) {
    logToFile("WARN", "Error getting market price", {
      tokenId: tokenId.substring(0, 10) + "...",
      error: error.message,
    });
  }

  return null;
}

async function getTrackedWalletPosition(tokenId, walletAddress, price) {
  try {
    const positionsUrl = `https://data-api.polymarket.com/positions?user=${walletAddress}`;
    const response = await fetch(positionsUrl, {
      headers: {
        accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (response.ok) {
      const positions = await response.json();
      if (Array.isArray(positions)) {
        for (const pos of positions) {
          const posTokenId =
            pos.token_id || pos.conditionId || pos.tokenID || pos.asset;
          if (posTokenId === tokenId) {
            let shares = pos.size || pos.qty || pos.quantity || 0;

            if (!shares || shares === 0) {
              const value =
                pos.usdc_value || pos.usdcValue || pos.value || pos.cost || 0;
              if (value > 0 && price > 0) {
                shares = value / price;
              }
            }

            logToFile("INFO", "Fetched tracked wallet position", {
              tokenId,
              walletAddress,
              shares,
              value: pos.usdc_value || pos.usdcValue || pos.value,
              price,
            });

            return shares;
          }
        }
      }
    }

    logToFile("WARN", "Could not find tracked wallet position", {
      tokenId,
      walletAddress,
      status: response.status,
    });
    return 0;
  } catch (error) {
    logToFile("ERROR", "Failed to get tracked wallet position", {
      tokenId,
      walletAddress,
      error: error.message,
    });
    return 0;
  }
}

module.exports = {
  fetchLatestActivity,
  getTokenIdForOutcome,
  getOppositeOutcomeTokenId,
  getCurrentMarketPrice,
  getTrackedWalletPosition,
};
