const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const {
  PAPER_TRADING_ENABLED,
  MAX_POSITIONS,
  MAX_TOTAL_EXPOSURE_USD,
  MAX_BET_AMOUNT_PER_MARKET_USD,
  POLYMARKET_FUNDER,
} = require("../config");
const { logToFile } = require("../utils/logger");
const {
  getPaperTradingBalance,
  getPaperTradingState,
} = require("./paperTrading");

const STOP_LOSS_POSITIONS_FILE = path.join(
  __dirname,
  "..",
  "stop-loss-positions.json"
);

let trackedPositions = new Map();
let stopLossOrders = new Map();
let stopLossPositions = new Map();
let clobClient = null;
let clobClientReady = false;
let signer = null;
let currentWallet = null;
let highConfidenceAddsPlaced = new Map();
let initialTradesPlaced = new Map();
let recentBuyTrades = new Map();
const BUY_TRADE_TTL_MS = 30 * 60 * 1000;

function hasHighConfidenceAddBeenPlaced(tokenId) {
  return highConfidenceAddsPlaced.has(tokenId);
}

function markHighConfidenceAddPlaced(tokenId) {
  highConfidenceAddsPlaced.set(tokenId, true);
}

function hasInitialTradeBeenPlaced(tokenId) {
  return initialTradesPlaced.has(tokenId);
}

function markInitialTradePlaced(tokenId) {
  initialTradesPlaced.set(tokenId, true);
}

function setClobClient(client, ready) {
  clobClient = client;
  clobClientReady = ready;
}

function getClobClient() {
  return { clobClient, clobClientReady };
}

function setSigner(signerInstance) {
  signer = signerInstance;
}

function getSigner() {
  return signer;
}

function setCurrentWallet(wallet) {
  currentWallet = wallet;
}

function getTrackedPositions() {
  return trackedPositions;
}

function setTrackedPosition(tokenId, data) {
  trackedPositions.set(tokenId, data);
}

function deleteTrackedPosition(tokenId) {
  trackedPositions.delete(tokenId);
}

function setStopLossOrder(tokenId, orderId, stopLossPrice, entryPrice, shares) {
  stopLossOrders.set(tokenId, {
    orderId,
    stopLossPrice,
    entryPrice,
    shares,
    timestamp: Date.now(),
  });
  logToFile("INFO", "Stop-loss order tracked", {
    tokenId: tokenId.substring(0, 10) + "...",
    orderId,
    stopLossPrice,
    entryPrice,
    shares,
  });
}

function getStopLossOrder(tokenId) {
  return stopLossOrders.get(tokenId);
}

function deleteStopLossOrder(tokenId) {
  const deleted = stopLossOrders.delete(tokenId);
  if (deleted) {
    logToFile("INFO", "Stop-loss order removed from tracking", {
      tokenId: tokenId.substring(0, 10) + "...",
    });
  }
  return deleted;
}

function getAllStopLossOrders() {
  return stopLossOrders;
}

function setStopLossPosition(
  tokenId,
  entryPrice,
  shares,
  stopLossPrice,
  marketInfo = {}
) {
  stopLossPositions.set(tokenId, {
    entryPrice,
    shares,
    entryTimestamp: Date.now(),
    stopLossPrice,
    market: marketInfo.market || null,
    conditionId: marketInfo.conditionId || null,
    outcome: marketInfo.outcome || null,
  });

  saveStopLossPositions();

  logToFile("INFO", "Stop-loss position registered for WebSocket monitoring", {
    tokenId: tokenId.substring(0, 10) + "...",
    entryPrice,
    shares,
    stopLossPrice,
    market: marketInfo.market,
  });
}

function getStopLossPosition(tokenId) {
  return stopLossPositions.get(tokenId);
}

function deleteStopLossPosition(tokenId) {
  const deleted = stopLossPositions.delete(tokenId);
  if (deleted) {
    saveStopLossPositions();
    logToFile("INFO", "Stop-loss position removed from monitoring", {
      tokenId: tokenId.substring(0, 10) + "...",
    });
  }
  return deleted;
}

function getAllStopLossPositions() {
  return stopLossPositions;
}

function saveStopLossPositions() {
  try {
    const positionsArray = Array.from(stopLossPositions.entries()).map(
      ([tokenId, data]) => ({
        tokenId,
        ...data,
      })
    );
    fs.writeFileSync(
      STOP_LOSS_POSITIONS_FILE,
      JSON.stringify(positionsArray, null, 2)
    );
  } catch (error) {
    logToFile("ERROR", "Failed to save stop-loss positions", {
      error: error.message,
    });
  }
}

function loadStopLossPositions() {
  try {
    if (fs.existsSync(STOP_LOSS_POSITIONS_FILE)) {
      const data = fs.readFileSync(STOP_LOSS_POSITIONS_FILE, "utf8");
      const positionsArray = JSON.parse(data);

      stopLossPositions.clear();
      for (const pos of positionsArray) {
        const { tokenId, ...rest } = pos;
        stopLossPositions.set(tokenId, rest);
      }

      logToFile("INFO", "Loaded stop-loss positions from file", {
        count: stopLossPositions.size,
      });

      return Array.from(stopLossPositions.keys());
    }
  } catch (error) {
    logToFile("ERROR", "Failed to load stop-loss positions", {
      error: error.message,
    });
  }
  return [];
}

async function getCurrentPositions() {
  try {
    if (clobClient && clobClientReady) {
      try {
        if (typeof clobClient.getPositions === "function") {
          const positions = await clobClient.getPositions();
          if (Array.isArray(positions)) {
            logToFile("INFO", "Fetched positions from CLOB API", {
              count: positions.length,
            });
            return positions;
          }
        }
      } catch (error) {
        logToFile("WARN", "Could not fetch positions from CLOB API", {
          error: error.message,
        });
      }

      try {
        const walletAddress =
          POLYMARKET_FUNDER || signer?.address || currentWallet;
        if (walletAddress) {
          const positionsUrl = `https://data-api.polymarket.com/positions?user=${walletAddress}`;
          const response = await fetch(positionsUrl, {
            headers: {
              accept: "application/json",
            },
          });

          if (response.ok) {
            const positions = await response.json();
            if (Array.isArray(positions)) {
              logToFile("INFO", "Fetched positions from Data API", {
                count: positions.length,
              });
              return positions;
            }
          }
        }
      } catch (error) {
        logToFile("WARN", "Could not fetch positions from Data API", {
          error: error.message,
        });
      }
    }

    const positions = [];
    for (const [tokenId, data] of trackedPositions.entries()) {
      positions.push({
        token_id: tokenId,
        usdc_value: data.usdcValue,
        timestamp: data.timestamp,
      });
    }
    logToFile("INFO", "Using tracked positions (fallback)", {
      count: positions.length,
    });
    return positions;
  } catch (error) {
    logToFile("ERROR", "Failed to get current positions", {
      error: error.message,
    });
    return [];
  }
}

async function getPositionValueForToken(tokenId) {
  try {
    let totalValue = 0;
    const trackedPosition = trackedPositions.get(tokenId);
    if (trackedPosition) {
      totalValue += trackedPosition.usdcValue || 0;
    }

    const positions = await getCurrentPositions();
    for (const pos of positions) {
      const posTokenId = pos.token_id || pos.conditionId || pos.tokenID;
      if (posTokenId === tokenId) {
        const value =
          pos.usdc_value || pos.usdcValue || pos.value || pos.cost || 0;
        if (typeof value === "number" && value > 0) {
          totalValue += value;
        }
      }
    }

    return totalValue;
  } catch (error) {
    logToFile("ERROR", "Failed to get position value for token", {
      tokenId,
      error: error.message,
    });
    return 0;
  }
}

async function checkPositionLimits(
  proposedTradeValue,
  tradeSide = "BUY",
  tokenId = null
) {
  if (tokenId && MAX_BET_AMOUNT_PER_MARKET_USD > 0 && tradeSide === "BUY") {
    const currentPositionValue = await getPositionValueForToken(tokenId);
    const newPositionValue = currentPositionValue + proposedTradeValue;

    if (newPositionValue >= MAX_BET_AMOUNT_PER_MARKET_USD) {
      return {
        allowed: false,
        reason: "per_market_cap",
        currentPositionValue,
        proposedTradeValue,
        newPositionValue,
        maxBetAmount: MAX_BET_AMOUNT_PER_MARKET_USD,
        message: `Per-market position cap would be exceeded: $${newPositionValue.toFixed(
          2
        )} > $${MAX_BET_AMOUNT_PER_MARKET_USD.toFixed(
          2
        )} (Current: $${currentPositionValue.toFixed(2)}).`,
      };
    }
  }

  if (PAPER_TRADING_ENABLED) {
    const paperBalance = getPaperTradingBalance();
    const positionCount = paperBalance.totalPositions;
    const totalExposure = paperBalance.totalExposure;

    if (tokenId && MAX_BET_AMOUNT_PER_MARKET_USD > 0 && tradeSide === "BUY") {
      const paperTradingState = getPaperTradingState();
      const paperPos = paperTradingState.positions[tokenId];
      const currentPositionValue = paperPos ? paperPos.entryValue || 0 : 0;
      const newPositionValue = currentPositionValue + proposedTradeValue;

      if (newPositionValue >= MAX_BET_AMOUNT_PER_MARKET_USD) {
        return {
          allowed: false,
          reason: "per_market_cap",
          currentPositionValue,
          proposedTradeValue,
          newPositionValue,
          maxBetAmount: MAX_BET_AMOUNT_PER_MARKET_USD,
          message: `Per-market position cap would be exceeded: $${newPositionValue.toFixed(
            2
          )} > $${MAX_BET_AMOUNT_PER_MARKET_USD.toFixed(
            2
          )} (Current: $${currentPositionValue.toFixed(2)}). Paper Trading.`,
        };
      }
    }

    const newTotalExposure =
      tradeSide === "SELL"
        ? Math.max(0, totalExposure - proposedTradeValue)
        : totalExposure + proposedTradeValue;

    if (tradeSide === "BUY" && positionCount >= MAX_POSITIONS) {
      return {
        allowed: false,
        reason: "position_count",
        currentPositions: positionCount,
        maxPositions: MAX_POSITIONS,
        message: `Maximum position limit reached: ${positionCount}/${MAX_POSITIONS} positions open (Paper Trading).`,
      };
    }

    if (MAX_TOTAL_EXPOSURE_USD > 0) {
      if (tradeSide === "BUY" && newTotalExposure > MAX_TOTAL_EXPOSURE_USD) {
        return {
          allowed: false,
          reason: "total_exposure",
          currentExposure: totalExposure,
          proposedTradeValue,
          newTotalExposure,
          maxExposure: MAX_TOTAL_EXPOSURE_USD,
          message: `Total exposure limit would be exceeded: $${newTotalExposure.toFixed(
            2
          )} > $${MAX_TOTAL_EXPOSURE_USD.toFixed(
            2
          )} (Current: $${totalExposure.toFixed(2)}). Paper Trading.`,
        };
      }
    }

    return {
      allowed: true,
      currentPositions: positionCount,
      currentExposure: totalExposure,
      newTotalExposure,
    };
  }

  const positions = await getCurrentPositions();

  const uniquePositions = new Set();
  let totalExposure = 0;

  for (const pos of positions) {
    const posTokenId = pos.token_id || pos.conditionId || pos.tokenID;
    if (posTokenId) {
      uniquePositions.add(posTokenId);
      const value =
        pos.usdc_value ||
        pos.usdcValue ||
        pos.value ||
        pos.cost ||
        proposedTradeValue;
      if (typeof value === "number" && value > 0) {
        totalExposure += value;
      }
    }
  }

  const positionCount = uniquePositions.size;

  const newTotalExposure =
    tradeSide === "SELL"
      ? Math.max(0, totalExposure - proposedTradeValue)
      : totalExposure + proposedTradeValue;

  if (tradeSide === "BUY" && positionCount >= MAX_POSITIONS) {
    return {
      allowed: false,
      reason: "position_count",
      currentPositions: positionCount,
      maxPositions: MAX_POSITIONS,
      message: `Maximum position limit reached: ${positionCount}/${MAX_POSITIONS} positions open.`,
    };
  }

  if (MAX_TOTAL_EXPOSURE_USD > 0) {
    if (tradeSide === "BUY" && newTotalExposure > MAX_TOTAL_EXPOSURE_USD) {
      return {
        allowed: false,
        reason: "total_exposure",
        currentExposure: totalExposure,
        proposedTradeValue,
        newTotalExposure,
        maxExposure: MAX_TOTAL_EXPOSURE_USD,
        message: `Total exposure limit would be exceeded: $${newTotalExposure.toFixed(
          2
        )} > $${MAX_TOTAL_EXPOSURE_USD.toFixed(
          2
        )} (Current: $${totalExposure.toFixed(2)}).`,
      };
    }
  }

  return {
    allowed: true,
    currentPositions: positionCount,
    currentExposure: totalExposure,
    newTotalExposure,
  };
}

function recordBuyTrade(conditionId, tokenId, outcome, price) {
  if (!conditionId || !tokenId || !outcome) {
    return;
  }

  const now = Date.now();
  if (!recentBuyTrades.has(conditionId)) {
    recentBuyTrades.set(conditionId, []);
  }

  const trades = recentBuyTrades.get(conditionId);
  trades.push({
    tokenId,
    outcome,
    price: price || null,
    timestamp: now,
  });

  const cutoff = now - BUY_TRADE_TTL_MS;
  const filtered = trades.filter((trade) => trade.timestamp > cutoff);
  recentBuyTrades.set(conditionId, filtered);

  logToFile("INFO", "Recorded buy trade for stop-loss verification", {
    conditionId: conditionId.substring(0, 10) + "...",
    tokenId: tokenId.substring(0, 10) + "...",
    outcome,
    totalTradesForMarket: filtered.length,
  });
}

function getRecentBuyTrades(conditionId) {
  if (!conditionId) {
    return [];
  }

  const now = Date.now();
  const cutoff = now - BUY_TRADE_TTL_MS;
  const trades = recentBuyTrades.get(conditionId) || [];

  const recent = trades.filter((trade) => trade.timestamp > cutoff);
  if (recent.length < trades.length) {
    recentBuyTrades.set(conditionId, recent);
  }

  return recent;
}

function hasRecentBuyForOutcome(conditionId, outcome) {
  const trades = getRecentBuyTrades(conditionId);
  return trades.some(
    (trade) =>
      trade.outcome && trade.outcome.toLowerCase() === outcome.toLowerCase()
  );
}

function getRecentBuyTradesForOutcome(conditionId, outcome) {
  const trades = getRecentBuyTrades(conditionId);
  return trades.filter(
    (trade) =>
      trade.outcome && trade.outcome.toLowerCase() === outcome.toLowerCase()
  );
}

module.exports = {
  setStopLossOrder,
  getStopLossOrder,
  deleteStopLossOrder,
  getAllStopLossOrders,
  setStopLossPosition,
  getStopLossPosition,
  deleteStopLossPosition,
  getAllStopLossPositions,
  loadStopLossPositions,
  getCurrentPositions,
  getPositionValueForToken,
  checkPositionLimits,
  getTrackedPositions,
  setTrackedPosition,
  deleteTrackedPosition,
  hasHighConfidenceAddBeenPlaced,
  markHighConfidenceAddPlaced,
  hasInitialTradeBeenPlaced,
  markInitialTradePlaced,
  setClobClient,
  getClobClient,
  setSigner,
  getSigner,
  setCurrentWallet,
  recordBuyTrade,
  getRecentBuyTrades,
  hasRecentBuyForOutcome,
  getRecentBuyTradesForOutcome,
};
