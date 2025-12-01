const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const fs = require("fs");

let CONFIG = {
  initialBalance: parseFloat(process.env.INITIAL_BALANCE) || 500,
  autoTradeAmount: parseFloat(process.env.AUTO_TRADE_AMOUNT_USD) || 5,
  addHighConfidenceSize:
    parseFloat(process.env.ADD_HIGH_CONFIDENCE_SIZE_USD) || 2,
  maxBetPerMarket: parseFloat(process.env.MAX_BET_PER_MARKET_USD) || 20,
  useHalfSize: process.env.USE_HALF_SIZE !== "false",
  winRate60_80: parseFloat(process.env.WIN_RATE_60_80) || 0.846,
  winRate80_90: parseFloat(process.env.WIN_RATE_80_90) || 0.9,
  tradesPerDay: parseFloat(process.env.TRADES_PER_DAY) || 17,
};

const analysisFile = process.argv[2];
if (analysisFile && fs.existsSync(analysisFile)) {
  try {
    const analysis = JSON.parse(fs.readFileSync(analysisFile, "utf8"));
    if (analysis.statistics) {
      const stats = analysis.statistics;
      if (stats.winRate) {
        CONFIG.winRate60_80 = stats.winRate / 100;
      }
      if (stats.avgPnl) {
        CONFIG.avgPnl = stats.avgPnl;
      }
      if (stats.avgWin) {
        CONFIG.avgWin = stats.avgWin;
      }
      if (stats.avgLoss) {
        CONFIG.avgLoss = stats.avgLoss;
      }
      console.log(` Loaded statistics from ${analysisFile}`);
      console.log(`   Win Rate: ${(CONFIG.winRate60_80 * 100).toFixed(1)}%`);
      if (CONFIG.avgPnl) {
        console.log(`   Avg PnL: $${CONFIG.avgPnl.toFixed(2)}`);
      }
    }
  } catch (error) {
    console.log(` Could not load analysis file: ${error.message}`);
  }
}

function calculateScaledPnL(
  positionSize,
  originalAvgPnL = 339.82,
  originalSize = 2500
) {
  const scaleFactor = positionSize / originalSize;
  return originalAvgPnL * scaleFactor;
}

function calculateWinLoss(positionSize, winRate, avgPnL) {
  const winLossRatio = 1.5;
  const avgWin = avgPnL / (winRate - (1 - winRate) / winLossRatio);
  const avgLoss = -avgWin / winLossRatio;
  return { avgWin, avgLoss };
}

function simulateTrading(days, config) {
  const {
    initialBalance,
    autoTradeAmount,
    addHighConfidenceSize,
    useHalfSize,
    winRate60_80,
    winRate80_90,
    tradesPerDay,
  } = config;

  const initialTradeSize = useHalfSize ? autoTradeAmount / 2 : autoTradeAmount;

  let avgPnl = config.avgPnl;
  if (!avgPnl) {
    avgPnl = calculateScaledPnL(initialTradeSize);
  }

  let { avgWin, avgLoss } =
    config.avgWin && config.avgLoss
      ? { avgWin: config.avgWin, avgLoss: config.avgLoss }
      : calculateWinLoss(initialTradeSize, winRate60_80, avgPnl);

  let balance = initialBalance;
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;

  for (let day = 1; day <= days; day++) {
    const tradesToday = Math.floor(tradesPerDay);
    for (let trade = 0; trade < tradesToday; trade++) {
      totalTrades++;

      const isHighConfidence = Math.random() < 0.3;
      const winRate = isHighConfidence ? winRate80_90 : winRate60_80;
      const tradeSize = isHighConfidence
        ? addHighConfidenceSize
        : initialTradeSize;

      const scaledAvgWin = avgWin * (tradeSize / initialTradeSize);
      const scaledAvgLoss = avgLoss * (tradeSize / initialTradeSize);

      const isWin = Math.random() < winRate;
      const pnl = isWin ? scaledAvgWin : scaledAvgLoss;

      balance += pnl;
      if (isWin) wins++;
      else losses++;

      if (balance < 0) balance = 0;
    }
  }

  return {
    finalBalance: balance,
    totalTrades,
    wins,
    losses,
    winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
    totalPnL: balance - initialBalance,
    roi: ((balance - initialBalance) / initialBalance) * 100,
  };
}

function runSimulations(days, config, numSimulations = 100) {
  const results = [];
  for (let i = 0; i < numSimulations; i++) {
    results.push(simulateTrading(days, config));
  }

  const balances = results.map((r) => r.finalBalance);
  const pnls = results.map((r) => r.totalPnL);
  const winRates = results.map((r) => r.winRate);

  balances.sort((a, b) => a - b);
  pnls.sort((a, b) => a - b);
  winRates.sort((a, b) => a - b);

  return {
    avgBalance: balances.reduce((a, b) => a + b, 0) / balances.length,
    medianBalance: balances[Math.floor(balances.length / 2)],
    p25Balance: balances[Math.floor(balances.length * 0.25)],
    p75Balance: balances[Math.floor(balances.length * 0.75)],
    avgPnL: pnls.reduce((a, b) => a + b, 0) / pnls.length,
    medianPnL: pnls[Math.floor(pnls.length / 2)],
    avgWinRate: winRates.reduce((a, b) => a + b, 0) / winRates.length,
    results,
  };
}

function main() {
  console.log("=".repeat(70));
  console.log("GROWTH PROJECTION CALCULATOR");
  console.log("=".repeat(70));

  console.log("\n Configuration:");
  console.log(`  Initial Balance:        $${CONFIG.initialBalance}`);
  console.log(`  Auto Trade Amount:       $${CONFIG.autoTradeAmount}`);
  console.log(`  Add High Conf Size:       $${CONFIG.addHighConfidenceSize}`);
  console.log(`  Max Bet Per Market:      $${CONFIG.maxBetPerMarket}`);
  console.log(`  Use Half Size:          ${CONFIG.useHalfSize}`);
  console.log(
    `  Initial Trade Size:     $${
      CONFIG.useHalfSize ? CONFIG.autoTradeAmount / 2 : CONFIG.autoTradeAmount
    }`
  );
  console.log(
    `  60-80% Win Rate:         ${(CONFIG.winRate60_80 * 100).toFixed(1)}%`
  );
  console.log(
    `  80-90%+ Win Rate:        ${(CONFIG.winRate80_90 * 100).toFixed(1)}%`
  );
  console.log(`  Trades Per Day:          ${CONFIG.tradesPerDay}`);

  const periods = [
    { days: 7, label: "1 Week" },
    { days: 30, label: "1 Month" },
    { days: 90, label: "3 Months" },
    { days: 180, label: "6 Months" },
  ];

  console.log("\n Growth Projections (100 simulations):");
  console.log("=".repeat(70));

  periods.forEach((period) => {
    const stats = runSimulations(period.days, CONFIG, 100);
    const roi =
      ((stats.avgBalance - CONFIG.initialBalance) / CONFIG.initialBalance) *
      100;

    console.log(`\n${period.label}:`);
    console.log(`  Expected Balance:       $${stats.avgBalance.toFixed(2)}`);
    console.log(`  Median Balance:         $${stats.medianBalance.toFixed(2)}`);
    console.log(`  25th Percentile:       $${stats.p25Balance.toFixed(2)}`);
    console.log(`  75th Percentile:       $${stats.p75Balance.toFixed(2)}`);
    console.log(`  Expected PnL:          $${stats.avgPnL.toFixed(2)}`);
    console.log(`  Expected ROI:          ${roi.toFixed(2)}%`);
    console.log(`  Avg Win Rate:           ${stats.avgWinRate.toFixed(1)}%`);
  });

  console.log("\n Single Simulation Example (6 months):");
  const example = simulateTrading(180, CONFIG);
  console.log(`  Final Balance:          $${example.finalBalance.toFixed(2)}`);
  console.log(`  Total Trades:           ${example.totalTrades}`);
  console.log(
    `  Wins:                   ${example.wins} (${example.winRate.toFixed(1)}%)`
  );
  console.log(`  Losses:                 ${example.losses}`);
  console.log(`  Total PnL:              $${example.totalPnL.toFixed(2)}`);
  console.log(`  ROI:                    ${example.roi.toFixed(2)}%`);
}

main();
