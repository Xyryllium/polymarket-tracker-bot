const { logToFile } = require("../../utils/logger");
const { fetchLatestActivity } = require("../marketData");

async function cleanupHourlyEvents(
  orderbookWS,
  currentWallet,
  getAllStopLossPositions,
  deleteStopLossPosition
) {
  if (!orderbookWS || !currentWallet) {
    return;
  }

  try {
    const allPositions = getAllStopLossPositions();

    if (allPositions.size === 0) {
      return;
    }

    const activities = await fetchLatestActivity(currentWallet);
    const recentTrades = activities.filter(
      (item) =>
        item?.type === "TRADE" &&
        (String(item?.side).toUpperCase() === "BUY" ||
          String(item?.side).toUpperCase() === "SELL") &&
        item?.conditionId
    );

    const marketTypeToConditionIds = new Map();
    for (const trade of recentTrades) {
      const { title, slug, conditionId, timestamp } = trade;
      if (!conditionId) continue;

      const marketTypeMatch = (title || slug || "").match(/^([^-]+)/);
      const marketType = marketTypeMatch ? marketTypeMatch[1].trim() : null;

      if (marketType) {
        if (!marketTypeToConditionIds.has(marketType)) {
          marketTypeToConditionIds.set(marketType, new Map());
        }
        const conditionIdMap = marketTypeToConditionIds.get(marketType);
        const existing = conditionIdMap.get(conditionId);
        if (
          !existing ||
          (timestamp && existing.timestamp && timestamp > existing.timestamp)
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
      const marketType = marketTypeMatch ? marketTypeMatch[1].trim() : null;

      if (!marketType) {
        continue;
      }

      const conditionIdMap = marketTypeToConditionIds.get(marketType);
      if (!conditionIdMap || conditionIdMap.size === 0) {
        continue;
      }

      const storedConditionId = position.conditionId
        ? position.conditionId.toLowerCase()
        : null;

      const hasDifferentConditionId = Array.from(conditionIdMap.keys()).some(
        (cid) => cid.toLowerCase() !== storedConditionId
      );

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
          const MIN_POSITION_AGE_MS = 10 * 60 * 1000;
          const positionAge = position.entryTimestamp
            ? Date.now() - position.entryTimestamp
            : Infinity;

          if (positionAge < MIN_POSITION_AGE_MS) {
            // Skip cleanup for positions created within last 10 minutes
          } else {
            logToFile(
              "INFO",
              "Cleaning up old hourly event subscription - detected new event in recent trades",
              {
                oldTokenId: tokenId.substring(0, 10) + "...",
                oldConditionId: position.conditionId.substring(0, 10) + "...",
                newConditionId:
                  latestEvent.conditionId.substring(0, 10) + "...",
                marketType,
                positionAgeMs: positionAge,
              }
            );
            orderbookWS.unsubscribe(tokenId);
            deleteStopLossPosition(tokenId);
          }
        }
      }
    }
  } catch (cleanupError) {
    logToFile("ERROR", "Error during proactive hourly event cleanup", {
      error: cleanupError.message,
      stack: cleanupError.stack,
    });
  }
}

module.exports = {
  cleanupHourlyEvents,
};
