# Analysis Scripts

This folder contains configurable analysis scripts for evaluating wallet trading performance, win rates, and growth projections.

## Scripts

### 1. `analyze-wallet.js` - Unified Wallet Analysis

A comprehensive, configurable script for analyzing any wallet with flexible filtering options.

**Usage:**

```bash
node analyze-wallet.js <wallet-address>

FILTER_MARKET_TYPE=btc FILTER_DATE_IN_TITLE="november 25" node analyze-wallet.js 0x...
```

**Configuration Options:**

Via environment variables or command line:

- `WALLET_ADDRESS` - Wallet address to analyze (or pass as first argument)
- `FILTER_MARKET_TYPE` - Filter by market type: `"btc"`, `"sports"`, or `"all"` (default: `"all"`)
- `FILTER_DATE_IN_TITLE` - Filter by date in title (e.g., `"november 25"`, case-insensitive)
- `FILTER_CONFIDENCE_MIN` - Minimum entry price/confidence (e.g., `0.6`)
- `FILTER_CONFIDENCE_MAX` - Maximum entry price/confidence (e.g., `0.8`)
- `FILTER_TRADE_TYPE` - Filter by trade type: `"buy"`, `"sell"`, or `"all"` (default: `"all"`)
- `MAX_OFFSET` - Maximum positions to fetch (default: `2000`)
- `SAVE_OUTPUT` - Whether to save JSON output (default: `true`)
- `OUTPUT_FILE` - Output file name (default: `wallet-analysis.json`)

**Examples:**

```bash
FILTER_MARKET_TYPE=btc node analyze-wallet.js 0x39a0f9df3f89f3d931180fab33bae58a8a9d9981

# Analyze BTC trades with November 25 in title
FILTER_MARKET_TYPE=btc FILTER_DATE_IN_TITLE="november 25" node analyze-wallet.js 0x...

# Analyze 60-80% confidence range only
FILTER_CONFIDENCE_MIN=0.6 FILTER_CONFIDENCE_MAX=0.8 node analyze-wallet.js 0x...

# Analyze sports trades (non-BTC)
FILTER_MARKET_TYPE=sports node analyze-wallet.js 0x...
```

**Output:**

- Console output with statistics, win rate, PnL, and confidence breakdown
- Optional JSON file with detailed analysis results

### 2. `compute-growth.js` - Growth Projection Calculator

Computes account growth projections based on trading statistics.

**Usage:**

```bash
# Using default configuration
node compute-growth.js

# Using analysis results from analyze-wallet.js
node compute-growth.js wallet-analysis.json
```

**Configuration Options:**

Via environment variables:

- `INITIAL_BALANCE` - Starting account balance (default: `500`)
- `AUTO_TRADE_AMOUNT_USD` - Base trade amount (default: `5`)
- `ADD_HIGH_CONFIDENCE_SIZE_USD` - High-confidence add size (default: `2`)
- `MAX_BET_PER_MARKET_USD` - Max bet per market (default: `20`)
- `USE_HALF_SIZE` - Use half-size initial trades (default: `true`)
- `WIN_RATE_60_80` - Win rate for 60-80% confidence (default: `0.846`)
- `WIN_RATE_80_90` - Win rate for 80-90% confidence (default: `0.90`)
- `TRADES_PER_DAY` - Expected trades per day (default: `17`)

**Output:**

- Growth projections for 1 week, 1 month, 3 months, and 6 months
- Statistics including expected balance, ROI, and win rate
- Single simulation example

## Quick Start

1. **Analyze a wallet:**

   ```bash
   cd analysis
   node analyze-wallet.js 0xYourWalletAddress
   ```

2. **Analyze with filters:**

   ```bash
   FILTER_MARKET_TYPE=btc FILTER_CONFIDENCE_MIN=0.6 FILTER_CONFIDENCE_MAX=0.8 \
     node analyze-wallet.js 0xYourWalletAddress
   ```

3. **Compute growth projections:**

   ```bash
   # Using default config
   node compute-growth.js

   # Using analysis results
   node compute-growth.js wallet-analysis.json
   ```

## Notes

- **Environment Configuration**: The scripts automatically use the `.env` file from the project root (same as your services). You don't need a separate `.env` file in the analysis folder.
- Scripts fetch data from Polymarket Data API
- Rate limiting is handled automatically (200ms delay between requests)
- Output files are saved in the analysis folder
- JSON output files from previous analyses are kept for reference but not required
