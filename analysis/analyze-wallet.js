const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const fetch = require("node-fetch");
const fs = require("fs");

const WALLET_ADDRESS =
  process.argv[2] ||
  process.env.WALLET_ADDRESS ||
  "0xd9e0aaca471f489be338fd0f91a26e8669a805f2";
const BASE_URL = "https://data-api.polymarket.com/closed-positions";
const LIMIT = 25;
const MAX_OFFSET = parseInt(process.env.MAX_OFFSET) || 2000;
const REQUEST_DELAY_MS = 200;

const CONFIG = {
  marketType: (process.env.FILTER_MARKET_TYPE || "all").toLowerCase(),
  dateInTitle: process.env.FILTER_DATE_IN_TITLE
    ? process.env.FILTER_DATE_IN_TITLE.toLowerCase()
    : null,
  timeframe: process.env.FILTER_TIMEFRAME
    ? process.env.FILTER_TIMEFRAME.toLowerCase()
    : null,
  direction: process.env.FILTER_DIRECTION
    ? process.env.FILTER_DIRECTION.toLowerCase()
    : null,
  confidenceMin: parseFloat(process.env.FILTER_CONFIDENCE_MIN) || null,
  confidenceMax: parseFloat(process.env.FILTER_CONFIDENCE_MAX) || null,
  tradeType: (process.env.FILTER_TRADE_TYPE || "all").toLowerCase(),
  saveOutput: process.env.SAVE_OUTPUT !== "false",
  outputFile: process.env.OUTPUT_FILE || "wallet-analysis.json",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchClosedPositions(offset) {
  const params = new URLSearchParams({
    user: WALLET_ADDRESS,
    sortBy: "timestamp",
    sortDirection: "DESC",
    limit: LIMIT.toString(),
    offset: offset.toString(),
  });
  const url = `${BASE_URL}?${params.toString()}`;

  let retries = 3;
  while (retries > 0) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });

      if (response.status === 429) {
        console.log(`  Rate limited at offset ${offset}, waiting...`);
        await sleep(1000);
        retries--;
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      if (retries === 1) {
        throw error;
      }
      console.log(
        `  Error at offset ${offset}, retrying... (${error.message})`
      );
      await sleep(1000);
      retries--;
    }
  }
}

function matchesMarketType(position) {
  if (CONFIG.marketType === "all") return true;

  const title = (position.title || "").toLowerCase();
  const slug = (position.slug || "").toLowerCase();
  const market = (position.market || "").toLowerCase();

  if (CONFIG.marketType === "btc") {
    return (
      title.includes("bitcoin") ||
      title.includes("btc") ||
      slug.includes("bitcoin") ||
      slug.includes("btc") ||
      market.includes("bitcoin") ||
      market.includes("btc")
    );
  }

  if (CONFIG.marketType === "sports") {
    const isBtc =
      title.includes("bitcoin") ||
      title.includes("btc") ||
      slug.includes("bitcoin") ||
      slug.includes("btc");
    return !isBtc;
  }

  return true;
}

function matchesDateInTitle(position) {
  if (!CONFIG.dateInTitle) return true;

  const title = (position.title || "").toLowerCase();
  const slug = (position.slug || "").toLowerCase();
  const searchTerm = CONFIG.dateInTitle.toLowerCase();

  return (
    title.includes(searchTerm) ||
    slug.includes(searchTerm.replace(/\s+/g, "-")) ||
    slug.includes(searchTerm.replace(/\s+/g, ""))
  );
}

function matchesTimeframe(position) {
  if (!CONFIG.timeframe) return true;

  const title = (position.title || "").toLowerCase();
  const slug = (position.slug || "").toLowerCase();
  const searchTerm = CONFIG.timeframe.toLowerCase();

  return (
    title.includes(searchTerm) ||
    slug.includes(searchTerm) ||
    title.includes(searchTerm.replace("m", " m")) ||
    slug.includes(searchTerm.replace("m", " m"))
  );
}

function matchesDirection(position) {
  if (!CONFIG.direction) return true;

  const title = (position.title || "").toLowerCase();
  const slug = (position.slug || "").toLowerCase();
  const searchTerm = CONFIG.direction.toLowerCase();

  if (searchTerm === "up") {
    return (
      title.includes(" up") ||
      title.includes("up?") ||
      slug.includes("-up") ||
      slug.includes("up-") ||
      title.includes(" go up") ||
      title.includes("rise")
    );
  } else if (searchTerm === "down") {
    return (
      title.includes(" down") ||
      title.includes("down?") ||
      slug.includes("-down") ||
      slug.includes("down-") ||
      title.includes(" go down") ||
      title.includes("fall") ||
      title.includes("drop")
    );
  }

  return true;
}

function matchesConfidenceRange(position) {
  if (CONFIG.confidenceMin === null && CONFIG.confidenceMax === null)
    return true;

  const avgPrice = position.avgPrice;
  if (avgPrice === undefined || avgPrice === null) return false;

  if (CONFIG.confidenceMin !== null && avgPrice < CONFIG.confidenceMin)
    return false;
  if (CONFIG.confidenceMax !== null && avgPrice >= CONFIG.confidenceMax)
    return false;

  return true;
}

function matchesTradeType(position) {
  if (CONFIG.tradeType === "all") return true;
  return true;
}

function filterPosition(position) {
  return (
    matchesMarketType(position) &&
    matchesDateInTitle(position) &&
    matchesTimeframe(position) &&
    matchesDirection(position) &&
    matchesConfidenceRange(position) &&
    matchesTradeType(position)
  );
}

function calculateStats(positions) {
  const positionsWithPnl = positions.filter(
    (p) => p.realizedPnl !== undefined && p.realizedPnl !== null
  );

  const wins = positionsWithPnl.filter((p) => p.realizedPnl > 0);
  const losses = positionsWithPnl.filter((p) => p.realizedPnl < 0);
  const breakevens = positionsWithPnl.filter((p) => p.realizedPnl === 0);

  const totalPnl = positionsWithPnl.reduce(
    (sum, p) => sum + (p.realizedPnl || 0),
    0
  );
  const totalBought = positionsWithPnl.reduce(
    (sum, p) => sum + (p.totalBought || 0),
    0
  );

  const winRate =
    positionsWithPnl.length > 0
      ? (wins.length / positionsWithPnl.length) * 100
      : 0;
  const avgPnl =
    positionsWithPnl.length > 0 ? totalPnl / positionsWithPnl.length : 0;
  const avgWin =
    wins.length > 0
      ? wins.reduce((sum, p) => sum + p.realizedPnl, 0) / wins.length
      : 0;
  const avgLoss =
    losses.length > 0
      ? losses.reduce((sum, p) => sum + p.realizedPnl, 0) / losses.length
      : 0;
  const roi = totalBought > 0 ? (totalPnl / totalBought) * 100 : 0;

  const totalWins = wins.reduce((sum, p) => sum + p.realizedPnl, 0);
  const totalLosses = Math.abs(
    losses.reduce((sum, p) => sum + p.realizedPnl, 0)
  );
  const profitFactor =
    totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;

  return {
    total: positionsWithPnl.length,
    wins: wins.length,
    losses: losses.length,
    breakevens: breakevens.length,
    winRate,
    totalPnl,
    avgPnl,
    avgWin,
    avgLoss,
    totalBought,
    roi,
    profitFactor,
    positions: positionsWithPnl,
  };
}

function analyzeByConfidence(positions) {
  const ranges = [
    { label: "0.00-0.20 (Very Low)", min: 0, max: 0.2 },
    { label: "0.20-0.40 (Low)", min: 0.2, max: 0.4 },
    { label: "0.40-0.60 (Medium)", min: 0.4, max: 0.6 },
    { label: "0.60-0.80 (High)", min: 0.6, max: 0.8 },
    { label: "0.80-1.00 (Very High)", min: 0.8, max: 1.0 },
  ];

  return ranges
    .map((range) => {
      const inRange = positions.filter(
        (p) =>
          p.avgPrice !== undefined &&
          p.avgPrice !== null &&
          p.avgPrice >= range.min &&
          p.avgPrice < range.max &&
          p.realizedPnl !== undefined &&
          p.realizedPnl !== null
      );

      if (inRange.length === 0) return null;

      const rangeWins = inRange.filter((p) => p.realizedPnl > 0);
      const rangeWinRate = (rangeWins.length / inRange.length) * 100;
      const rangePnl = inRange.reduce(
        (sum, p) => sum + (p.realizedPnl || 0),
        0
      );
      const rangeAvgPnl = rangePnl / inRange.length;

      return {
        range: range.label,
        min: range.min,
        max: range.max,
        count: inRange.length,
        wins: rangeWins.length,
        losses: inRange.length - rangeWins.length,
        winRate: rangeWinRate,
        totalPnl: rangePnl,
        avgPnl: rangeAvgPnl,
      };
    })
    .filter((r) => r !== null);
}

function analyzeDailyByConfidence(positions) {
  const ranges = [
    { label: "0.00-0.20 (Very Low)", min: 0, max: 0.2 },
    { label: "0.20-0.40 (Low)", min: 0.2, max: 0.4 },
    { label: "0.40-0.60 (Medium)", min: 0.4, max: 0.6 },
    { label: "0.60-0.80 (High)", min: 0.6, max: 0.8 },
    { label: "0.80-1.00 (Very High)", min: 0.8, max: 1.0 },
  ];

  const positionsByDate = {};

  positions.forEach((p) => {
    if (!p.timestamp || p.realizedPnl === undefined || p.realizedPnl === null) {
      return;
    }

    const date = new Date(p.timestamp * 1000);
    const dateKey = date.toISOString().split("T")[0];

    if (!positionsByDate[dateKey]) {
      positionsByDate[dateKey] = [];
    }
    positionsByDate[dateKey].push(p);
  });

  const dailyBreakdown = Object.keys(positionsByDate)
    .sort()
    .reverse()
    .map((date) => {
      const dayPositions = positionsByDate[date];
      const dayStats = calculateStats(dayPositions);

      const confidenceBreakdown = ranges
        .map((range) => {
          const inRange = dayPositions.filter(
            (p) =>
              p.avgPrice !== undefined &&
              p.avgPrice !== null &&
              p.avgPrice >= range.min &&
              p.avgPrice < range.max &&
              p.realizedPnl !== undefined &&
              p.realizedPnl !== null
          );

          if (inRange.length === 0) return null;

          const rangeWins = inRange.filter((p) => p.realizedPnl > 0);
          const rangeWinRate = (rangeWins.length / inRange.length) * 100;
          const rangePnl = inRange.reduce(
            (sum, p) => sum + (p.realizedPnl || 0),
            0
          );
          const rangeAvgPnl = rangePnl / inRange.length;

          return {
            range: range.label,
            min: range.min,
            max: range.max,
            count: inRange.length,
            wins: rangeWins.length,
            losses: inRange.length - rangeWins.length,
            winRate: rangeWinRate,
            totalPnl: rangePnl,
            avgPnl: rangeAvgPnl,
          };
        })
        .filter((r) => r !== null);

      return {
        date,
        totalTrades: dayStats.total,
        totalPnl: dayStats.totalPnl,
        winRate: dayStats.winRate,
        confidenceBreakdown,
      };
    });

  return dailyBreakdown;
}

async function main() {
  console.log("=".repeat(70));
  console.log("WALLET TRADING ANALYSIS");
  console.log(`Wallet: ${WALLET_ADDRESS}`);
  console.log("=".repeat(70));

  console.log("\nActive Filters:");
  console.log(`Market Type:     ${CONFIG.marketType}`);
  console.log(`Date in Title:   ${CONFIG.dateInTitle || "none"}`);
  console.log(`Timeframe:       ${CONFIG.timeframe || "none"}`);
  console.log(`Direction:       ${CONFIG.direction || "none"}`);
  console.log(
    `Confidence:      ${
      CONFIG.confidenceMin !== null ? CONFIG.confidenceMin : "any"
    } - ${CONFIG.confidenceMax !== null ? CONFIG.confidenceMax : "any"}`
  );
  console.log(`Trade Type:      ${CONFIG.tradeType}`);

  console.log("\nFetching closed positions...");
  const allPositions = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore && offset < MAX_OFFSET) {
    try {
      const data = await fetchClosedPositions(offset);

      if (!Array.isArray(data) || data.length === 0) {
        hasMore = false;
        break;
      }

      allPositions.push(...data);
      console.log(
        `Fetched ${data.length} positions (total: ${allPositions.length})`
      );

      if (data.length < LIMIT) {
        hasMore = false;
      } else {
        offset += LIMIT;
        await sleep(REQUEST_DELAY_MS);
      }
    } catch (error) {
      console.error(`Error fetching at offset ${offset}: ${error.message}`);
      hasMore = false;
    }
  }

  console.log(`\nTotal positions fetched: ${allPositions.length}`);

  const filteredPositions = allPositions.filter(filterPosition);
  console.log(
    `\nFiltered Positions: ${filteredPositions.length} (${(
      (filteredPositions.length / allPositions.length) *
      100
    ).toFixed(1)}% of total)`
  );

  if (filteredPositions.length === 0) {
    console.log("\nNo positions match the specified filters.");
    return;
  }

  const stats = calculateStats(filteredPositions);

  console.log(`\nTRADING STATISTICS:`);
  console.log(`Total Positions:        ${stats.total}`);
  console.log(
    `Wins:                   ${stats.wins} (${stats.winRate.toFixed(2)}%)`
  );
  console.log(
    `Losses:                 ${stats.losses} (${(
      (stats.losses / stats.total) *
      100
    ).toFixed(2)}%)`
  );
  console.log(`Breakevens:             ${stats.breakevens}`);
  console.log(`Win Rate:               ${stats.winRate.toFixed(2)}%`);
  console.log(`Total PnL:              $${stats.totalPnl.toFixed(2)}`);
  console.log(`Average PnL:            $${stats.avgPnl.toFixed(2)}`);
  console.log(`Average Win:            $${stats.avgWin.toFixed(2)}`);
  console.log(`Average Loss:           $${stats.avgLoss.toFixed(2)}`);
  console.log(`Total Invested:         $${stats.totalBought.toFixed(2)}`);
  console.log(`ROI:                    ${stats.roi.toFixed(2)}%`);
  console.log(`Profit Factor:          ${stats.profitFactor.toFixed(2)}`);

  const confidenceBreakdown = analyzeByConfidence(stats.positions);
  if (confidenceBreakdown.length > 0) {
    console.log(`\nPerformance by Entry Price (Confidence Level):`);
    confidenceBreakdown.forEach((range) => {
      console.log(
        `  ${range.range.padEnd(25)} ${range.count
          .toString()
          .padStart(4)} trades | ` +
          `Win Rate: ${range.winRate.toFixed(1)}% | ` +
          `Avg PnL: $${range.avgPnl.toFixed(2)} | ` +
          `Total: $${range.totalPnl.toFixed(2)}`
      );
    });
  }

  const dailyByConfidence = analyzeDailyByConfidence(stats.positions);
  if (dailyByConfidence.length > 0) {
    console.log(`\nDaily Performance by Confidence (showing last 10 days):`);
    dailyByConfidence.slice(0, 10).forEach((day) => {
      console.log(
        `\n  ${day.date}: ${
          day.totalTrades
        } trades | PnL: $${day.totalPnl.toFixed(
          2
        )} | Win Rate: ${day.winRate.toFixed(1)}%`
      );
      if (day.confidenceBreakdown.length > 0) {
        day.confidenceBreakdown.forEach((range) => {
          console.log(
            `  ${range.range.padEnd(25)} ${range.count
              .toString()
              .padStart(4)} trades | ` +
              `Win Rate: ${range.winRate.toFixed(1)}% | ` +
              `PnL: $${range.totalPnl.toFixed(2)}`
          );
        });
      }
    });
    if (dailyByConfidence.length > 10) {
      console.log(`  ... and ${dailyByConfidence.length - 10} more days`);
    }
  }

  if (stats.positions.length > 0) {
    console.log(`\nSample Trades (first 10):`);
    stats.positions.slice(0, 10).forEach((p, i) => {
      const pnl =
        p.realizedPnl !== undefined && p.realizedPnl !== null
          ? `$${p.realizedPnl.toFixed(2)}`
          : "N/A";
      const outcome =
        p.realizedPnl > 0 ? "WIN" : p.realizedPnl < 0 ? "LOSS" : "BREAKEVEN";
      const title = (p.title || "No title").substring(0, 50);
      console.log(`  ${i + 1}. ${outcome} | ${pnl} | ${title}...`);
    });
  }

  if (CONFIG.saveOutput) {
    const output = {
      wallet: WALLET_ADDRESS,
      analyzedAt: new Date().toISOString(),
      filters: {
        marketType: CONFIG.marketType,
        dateInTitle: CONFIG.dateInTitle,
        timeframe: CONFIG.timeframe,
        direction: CONFIG.direction,
        confidenceMin: CONFIG.confidenceMin,
        confidenceMax: CONFIG.confidenceMax,
        tradeType: CONFIG.tradeType,
      },
      statistics: {
        totalPositions: stats.total,
        wins: stats.wins,
        losses: stats.losses,
        breakevens: stats.breakevens,
        winRate: stats.winRate,
        totalPnl: stats.totalPnl,
        avgPnl: stats.avgPnl,
        avgWin: stats.avgWin,
        avgLoss: stats.avgLoss,
        totalBought: stats.totalBought,
        roi: stats.roi,
        profitFactor: stats.profitFactor,
      },
      confidenceBreakdown,
      dailyByConfidence,
    };

    fs.writeFileSync(CONFIG.outputFile, JSON.stringify(output, null, 2));
    console.log(`\nResults saved to ${CONFIG.outputFile}`);
  }
}

main().catch(console.error);
