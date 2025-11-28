# Polymarket Discord Bot

Discord bot that tracks Polymarket wallet activity and can automatically copy trades. Monitors wallet addresses via the Polymarket Data API and sends Discord notifications for new trades. Supports auto-trading, paper trading, and position management.

## Features

- **Wallet Tracking**: Monitor any Polymarket wallet address for BUY/SELL trades
- **Copy Trading**: Automatically copy trades from tracked wallets with configurable filters
- **Paper Trading**: Test strategies without real money
- **Position Management**: Track positions, set per-market limits, and total exposure caps
- **Dynamic Sizing**: Adjusts bet sizes based on tracked wallet trade size and confidence levels
- **WebSocket Support**: Real-time orderbook data for faster execution
- **Analysis Tools**: Scripts for win rate analysis and growth projections (see `analysis/` folder)

## Quick Start

1. **Install dependencies**:

   ```bash
   npm install
   ```

2. **Create `.env` file** by copying `env.example`:

   ```bash
   cp env.example .env
   ```

   Then edit `.env` and fill in your configuration values (see `env.example` for full list of options).

3. **Start the bot**:

   ```bash
   npm start
   ```

4. **In Discord**, type `!start` (or `!start <wallet_address>`) to begin monitoring

## Commands

- `!start` - Start monitoring default wallet
- `!start <address>` - Monitor specific wallet
- `!stop` - Stop monitoring
- `!buy <tokenId> <price> <size>` - Place buy order
- `!sell <tokenId> <price> <size>` - Place sell order
- `!balance` - Check USDC balance
- `!paperbalance` - Check paper trading balance
- `!paperreset` - Reset paper trading state

## Configuration

### Core Settings

- `AUTO_TRADE_ENABLED` - Enable auto-trading (default: `false`)
- `COPY_TRADE_ENABLED` - Enable copy trading (default: `true`)
- `AUTO_TRADE_FILTER` - Comma-separated keywords to filter markets (e.g., `BTC,ETH`)
- `AUTO_TRADE_AMOUNT_USD` - Base bet size for small trades (default: `1`)
- `MAX_ORDER_VALUE_USD` - Max bet size when copying large trades (default: `10`)
- `MAX_BET_AMOUNT_PER_MARKET_USD` - Per-market position limit (default: `0` = unlimited)
- `MAX_POSITIONS` - Maximum number of concurrent positions (default: `20`)
- `MAX_TOTAL_EXPOSURE_USD` - Total exposure limit across all positions (default: `0` = unlimited)

### Trading Strategy

- `OPTIMAL_CONFIDENCE_MIN` - Minimum entry price for optimal range (default: `0.6`)
- `OPTIMAL_CONFIDENCE_MAX` - Maximum entry price for optimal range (default: `0.7`)
- `USE_OPTIMAL_CONFIDENCE_FILTER` - Filter trades below optimal minimum (default: `false`)
- `OPTIMAL_CONFIDENCE_BET_MULTIPLIER` - Bet multiplier for optimal range trades (default: `1.5`)
- `ADD_HIGH_CONFIDENCE_ENABLED` - Enable high-confidence adds (80-90%+) (default: `false`)
- `ADD_HIGH_CONFIDENCE_SIZE_USD` - Additional bet size for high-confidence adds (default: `2`)

### Paper Trading

- `PAPER_TRADING_ENABLED` - Enable paper trading mode (default: `false`)
- `PAPER_TRADING_INITIAL_BALANCE` - Starting balance for paper trading (default: `200`)

### WebSocket (Optional)

- `POLY_WS_API_KEY` - WebSocket API key
- `POLY_WS_API_SECRET` - WebSocket API secret
- `POLY_WS_API_PASSPHRASE` - WebSocket API passphrase

## Project Structure

```
├── services/
│   ├── polling.js          # Main polling loop
│   ├── polling/            # Refactored polling modules
│   │   ├── state.js        # State management
│   │   ├── tradeProcessor.js  # Trade filtering/validation
│   │   ├── autoTrader.js   # Auto-trading logic
│   │   ├── discordEmbeds.js   # Discord message formatting
│   │   └── cleanup.js      # Cleanup tasks
│   ├── marketData.js      # Market data fetching
│   ├── orders.js          # Order placement
│   ├── positions.js       # Position tracking
│   └── paperTrading.js    # Paper trading logic
├── analysis/              # Analysis scripts
│   ├── analyze-wallet.js  # Wallet analysis (configurable)
│   └── compute-growth.js  # Growth projections
└── utils/                 # Utilities
```

## Known Issues

### Stop-Loss Functionality

⚠️ **Stop-loss has known issues and may not work reliably:**

- WebSocket-based stop-loss requires market filter matching and may miss triggers
- Real trading stop-loss uses polling which can be slow to react
- Stop-loss positions may not persist correctly across bot restarts

**Recommendation**: Use stop-loss with caution. Consider manual position management for critical trades.

### Cloudflare Blocking (Cloud Deployment)

⚠️ **When deployed to cloud services, Cloudflare may block API requests:**

- Cloud hosting providers (AWS, Heroku, Railway, etc.) may have IP addresses that are flagged by Cloudflare
- API requests to Polymarket endpoints may be blocked or rate-limited
- This can cause the bot to fail to fetch market data or place orders

**Recommendation**:

- **Use the bot on a local machine** to avoid Cloudflare blocking issues entirely
- Consider using a proxy service or VPN for API requests if cloud deployment is necessary
- Use a dedicated server with a static IP address
- Monitor API response codes and implement retry logic with exponential backoff
- For production deployments, consider using a residential proxy or rotating IP addresses

### Dynamic Sizing

⚠️ **Dynamic sizing may still be faulty and is currently for testing:**

- Bet size adjustments based on tracked wallet trade size may not work correctly
- Confidence-based sizing multipliers may not be applied as expected
- Use with caution and verify bet sizes before enabling in production

**Recommendation**: Test dynamic sizing thoroughly in paper trading mode before using with real funds.

### Other Issues

- Limit orders in auto-trading are not fully implemented (only market orders work)
- Some edge cases in position limit checking may allow exceeding limits
- Paper trading balance may drift due to rounding errors over time

## Development

The codebase has been refactored to improve modularity:

- `polling.js` was split into focused modules in `services/polling/`
- Analysis scripts consolidated into configurable tools

## License

ISC
