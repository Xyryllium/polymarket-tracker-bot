const {
  STOP_LOSS_ENABLED,
  STOP_LOSS_PERCENTAGE,
  STOP_LOSS_MIN_TIME_SINCE_ENTRY_MS,
  STOP_LOSS_WEBSOCKET_MARKET_FILTER,
  PAPER_TRADING_ENABLED,
} = require("../config");
const { logToFile } = require("../utils/logger");
const { getStopLossPosition, deleteStopLossPosition } = require("./positions");
const { placeMarketSellOrder } = require("./orders");

async function handleWebSocketStopLoss(
  tokenId,
  currentPrice,
  side,
  clobClient,
  clobClientReady,
  activeChannel,
  orderbookWS
) {
  if (!STOP_LOSS_ENABLED || PAPER_TRADING_ENABLED) {
    return; // Only for real trading
  }

  if (!clobClient || !clobClientReady) {
    return;
  }

  try {
    const stopLossPosition = getStopLossPosition(tokenId);
    if (!stopLossPosition) {
      return;
    }
    const matchesFilter = STOP_LOSS_WEBSOCKET_MARKET_FILTER.some((filter) => {
      if (filter.startsWith("0x") && stopLossPosition.conditionId) {
        return (
          stopLossPosition.conditionId.toLowerCase() === filter.toLowerCase()
        );
      }
      if (stopLossPosition.market) {
        return stopLossPosition.market
          .toLowerCase()
          .includes(filter.toLowerCase());
      }
      return false;
    });

    if (!matchesFilter) {
      deleteStopLossPosition(tokenId);
      if (orderbookWS) {
        orderbookWS.unsubscribe(tokenId);
        logToFile(
          "INFO",
          "Unsubscribed from WebSocket - position no longer matches filter",
          {
            tokenId: tokenId.substring(0, 10) + "...",
          }
        );
      }
      logToFile(
        "WARN",
        "Removed position from stop-loss monitoring - no longer matches filter",
        {
          tokenId: tokenId.substring(0, 10) + "...",
          market: stopLossPosition.market,
          filter: STOP_LOSS_WEBSOCKET_MARKET_FILTER.join(", "),
        }
      );
      return;
    }

    const { entryPrice, shares, entryTimestamp, stopLossPrice } =
      stopLossPosition;

    const now = Date.now();
    if (
      entryTimestamp &&
      now - entryTimestamp < STOP_LOSS_MIN_TIME_SINCE_ENTRY_MS
    ) {
      return;
    }

    if (currentPrice > stopLossPrice) {
      return;
    }

    const lossPercentage = ((entryPrice - currentPrice) / entryPrice) * 100;

    if (lossPercentage < STOP_LOSS_PERCENTAGE) {
      return;
    }

    logToFile("WARN", "WebSocket stop-loss triggered", {
      tokenId: tokenId.substring(0, 10) + "...",
      entryPrice,
      currentPrice,
      stopLossPrice,
      lossPercentage: lossPercentage.toFixed(2),
      shares,
      side,
    });

    try {
      const sellResult = await placeMarketSellOrder(
        tokenId,
        shares,
        clobClient,
        clobClientReady
      );

      if (sellResult && sellResult.error) {
        logToFile("ERROR", "Failed to execute stop-loss market sell", {
          tokenId: tokenId.substring(0, 10) + "...",
          error: sellResult.error,
        });
        return;
      }

      deleteStopLossPosition(tokenId);
      if (orderbookWS) {
        orderbookWS.unsubscribe(tokenId);
        logToFile(
          "INFO",
          "Unsubscribed from WebSocket after stop-loss execution",
          {
            tokenId: tokenId.substring(0, 10) + "...",
          }
        );
      }

      logToFile("INFO", "Stop-loss market sell executed", {
        tokenId: tokenId.substring(0, 10) + "...",
        entryPrice,
        exitPrice: currentPrice,
        shares,
        lossPercentage: lossPercentage.toFixed(2),
        orderId: sellResult?.orderId,
      });

      if (activeChannel) {
        await activeChannel.send({
          embeds: [
            {
              title: "🛑 Stop-Loss Triggered (WebSocket)",
              description: `Position automatically sold via market order`,
              color: 0xff0000,
              fields: [
                {
                  name: "Entry Price",
                  value: `$${entryPrice.toFixed(4)} (${(
                    entryPrice * 100
                  ).toFixed(2)}¢)`,
                  inline: true,
                },
                {
                  name: "Exit Price",
                  value: `$${currentPrice.toFixed(4)} (${(
                    currentPrice * 100
                  ).toFixed(2)}¢)`,
                  inline: true,
                },
                {
                  name: "Loss %",
                  value: `${lossPercentage.toFixed(2)}%`,
                  inline: true,
                },
                {
                  name: "Shares",
                  value: `${shares.toFixed(2)}`,
                  inline: true,
                },
                {
                  name: "Order Type",
                  value: "Market Order",
                  inline: true,
                },
                {
                  name: "Order ID",
                  value: sellResult?.orderId || "Pending",
                  inline: true,
                },
              ],
              timestamp: new Date().toISOString(),
            },
          ],
        });
      }
    } catch (error) {
      logToFile("ERROR", "Error executing stop-loss market sell", {
        tokenId: tokenId.substring(0, 10) + "...",
        error: error.message,
        stack: error.stack,
      });
    }
  } catch (error) {
    logToFile("ERROR", "Error in WebSocket stop-loss handler", {
      tokenId: tokenId.substring(0, 10) + "...",
      error: error.message,
      stack: error.stack,
    });
  }
}

module.exports = {
  handleWebSocketStopLoss,
};
