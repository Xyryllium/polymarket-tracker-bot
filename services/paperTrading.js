const fs = require("fs");
const {
  PAPER_TRADING_ENABLED,
  PAPER_TRADING_INITIAL_BALANCE,
  PAPER_TRADING_STATE_FILE,
  MAX_BET_AMOUNT_PER_MARKET_USD,
} = require("../config");
const { logToFile } = require("../utils/logger");

let paperTradingState = {
  balance: PAPER_TRADING_INITIAL_BALANCE,
  positions: {},
  tradeHistory: [],
  totalPnL: 0,
  realizedPnL: 0,
};

function loadPaperTradingState() {
  try {
    if (fs.existsSync(PAPER_TRADING_STATE_FILE)) {
      const data = fs.readFileSync(PAPER_TRADING_STATE_FILE, "utf8");
      const saved = JSON.parse(data);
      paperTradingState = {
        ...paperTradingState,
        ...saved,
        positions: saved.positions || {},
        tradeHistory: saved.tradeHistory || [],
      };
      logToFile("INFO", "Loaded paper trading state from file", {
        balance: paperTradingState.balance,
        positions: Object.keys(paperTradingState.positions).length,
      });
    }
  } catch (error) {
    logToFile("WARN", "Could not load paper trading state", {
      error: error.message,
    });
  }
}

function savePaperTradingState() {
  try {
    fs.writeFileSync(
      PAPER_TRADING_STATE_FILE,
      JSON.stringify(paperTradingState, null, 2),
      "utf8"
    );
  } catch (error) {
    logToFile("ERROR", "Failed to save paper trading state", {
      error: error.message,
    });
  }
}

async function paperBuy(
  tokenId,
  amount,
  price,
  market,
  conditionId = null,
  endDate = null,
  outcome = null
) {
  if (!PAPER_TRADING_ENABLED) {
    return null;
  }

  let cost = amount;

  if (MAX_BET_AMOUNT_PER_MARKET_USD > 0) {
    const existingPos = paperTradingState.positions[tokenId];
    const currentPositionValue = existingPos ? existingPos.entryValue || 0 : 0;
    const maxBetAmount = MAX_BET_AMOUNT_PER_MARKET_USD;
    const remainingAmount = Math.max(0, maxBetAmount - currentPositionValue);

    if (remainingAmount === 0) {
      return {
        error: `Position already at max bet amount of $${maxBetAmount.toFixed(
          2
        )}. Cannot add more.`,
      };
    }

    if (cost > remainingAmount) {
      cost = remainingAmount;
      logToFile("INFO", "Paper trade capped to max bet amount", {
        tokenId,
        originalAmount: amount,
        cappedAmount: cost,
        currentPositionValue,
        maxBetAmount,
        remainingAmount,
      });
    }
  }

  const shares = price > 0 ? cost / price : 0;

  if (paperTradingState.balance < cost) {
    return {
      error: `Insufficient balance: $${cost.toFixed(
        2
      )} required, but only $${paperTradingState.balance.toFixed(
        2
      )} available.`,
    };
  }

  paperTradingState.balance -= cost;

  const pos = paperTradingState.positions[tokenId];
  if (pos) {
    const totalShares = pos.shares + shares;
    const totalCost = pos.entryValue + cost;
    pos.shares = totalShares;
    pos.avgPrice = totalCost / totalShares;
    pos.entryValue = totalCost;
    if (!pos.conditionId && conditionId) {
      pos.conditionId = conditionId;
    }
    if (!pos.endDate && endDate) {
      pos.endDate = endDate;
    }
    if (!pos.outcome && outcome) {
      pos.outcome = outcome;
    }
    if (!pos.entryTimestamp) {
      pos.entryTimestamp = Date.now();
    }
    pos.lastChecked = Date.now();
  } else {
    paperTradingState.positions[tokenId] = {
      shares,
      avgPrice: price,
      entryValue: cost,
      market: market || "Unknown",
      conditionId: conditionId || null,
      endDate: endDate || null,
      outcome: outcome || null,
      lastChecked: Date.now(),
      entryTimestamp: Date.now(),
    };
  }

  if (pos && !pos.entryTimestamp) {
    pos.entryTimestamp = Date.now();
  }

  paperTradingState.tradeHistory.push({
    timestamp: Date.now(),
    side: "BUY",
    tokenId,
    shares,
    price,
    value: cost,
    market: market || "Unknown",
  });

  if (paperTradingState.tradeHistory.length > 1000) {
    paperTradingState.tradeHistory =
      paperTradingState.tradeHistory.slice(-1000);
  }

  savePaperTradingState();

  logToFile("INFO", "Paper BUY executed", {
    tokenId,
    shares,
    price,
    cost,
    balance: paperTradingState.balance,
  });

  return {
    success: true,
    shares,
    price,
    cost,
    balance: paperTradingState.balance,
  };
}

async function paperSell(tokenId, shares, price, market) {
  if (!PAPER_TRADING_ENABLED) {
    return null;
  }

  const position = paperTradingState.positions[tokenId];
  if (!position || position.shares <= 0) {
    return {
      error: `No position found for token ${tokenId}.`,
    };
  }

  const sharesToSell = Math.min(shares, position.shares);
  const proceeds = sharesToSell * price;

  const avgCost = position.avgPrice;
  const pnl = (price - avgCost) * sharesToSell;
  const realizedPnl = pnl;

  paperTradingState.balance += proceeds;

  position.shares -= sharesToSell;
  position.entryValue -= sharesToSell * avgCost;

  if (position.shares <= 0.001) {
    delete paperTradingState.positions[tokenId];
  }

  paperTradingState.realizedPnL += realizedPnl;

  paperTradingState.tradeHistory.push({
    timestamp: Date.now(),
    side: "SELL",
    tokenId,
    shares: sharesToSell,
    price,
    value: proceeds,
    pnl: realizedPnl,
    market: market || position.market || "Unknown",
  });

  if (paperTradingState.tradeHistory.length > 1000) {
    paperTradingState.tradeHistory =
      paperTradingState.tradeHistory.slice(-1000);
  }

  savePaperTradingState();

  logToFile("INFO", "Paper SELL executed", {
    tokenId,
    shares: sharesToSell,
    price,
    proceeds,
    pnl: realizedPnl,
    balance: paperTradingState.balance,
  });

  return {
    success: true,
    shares: sharesToSell,
    price,
    proceeds,
    pnl: realizedPnl,
    balance: paperTradingState.balance,
  };
}

function getPaperTradingBalance() {
  const totalPositions = Object.keys(paperTradingState.positions).length;
  let totalExposure = 0;
  for (const pos of Object.values(paperTradingState.positions)) {
    totalExposure += pos.entryValue;
  }

  let wins = 0;
  let losses = 0;
  let stopLosses = 0;
  paperTradingState.tradeHistory.forEach((trade) => {
    if (
      (trade.side === "MANUAL_CLOSE" || trade.side === "STOP_LOSS") &&
      trade.pnl !== undefined
    ) {
      if (trade.side === "STOP_LOSS") {
        stopLosses++;
      }
      if (trade.pnl > 0) {
        wins++;
      } else if (trade.pnl < 0) {
        losses++;
      }
    }
  });

  const totalClosedTrades = wins + losses;
  const winRate = totalClosedTrades > 0 ? (wins / totalClosedTrades) * 100 : 0;

  return {
    balance: paperTradingState.balance,
    realizedPnL: paperTradingState.realizedPnL,
    totalPositions,
    totalExposure,
    positions: paperTradingState.positions,
    totalValue: paperTradingState.balance + totalExposure,
    winRate,
    wins,
    losses,
    stopLosses,
  };
}

function resetPaperTrading() {
  paperTradingState = {
    balance: PAPER_TRADING_INITIAL_BALANCE,
    positions: {},
    tradeHistory: [],
    totalPnL: 0,
    realizedPnL: 0,
  };
  savePaperTradingState();
  logToFile("INFO", "Paper trading state reset", {
    newBalance: PAPER_TRADING_INITIAL_BALANCE,
  });
}

function getPaperTradingState() {
  return paperTradingState;
}

function setPaperTradingState(newState) {
  paperTradingState = newState;
  savePaperTradingState();
}

loadPaperTradingState();

module.exports = {
  paperBuy,
  paperSell,
  getPaperTradingBalance,
  resetPaperTrading,
  getPaperTradingState,
  setPaperTradingState,
  savePaperTradingState,
};
