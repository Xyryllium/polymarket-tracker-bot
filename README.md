# Polymarket Wallet Activity Discord Bot

This bot polls the Polymarket Data API for wallet addresses and posts notifications in Discord whenever new **BUY** or **SELL** trades are detected. The polling cadence stays well under the documented rate limit of 200 requests per 10 seconds (1,200 requests per minute) for the public Data API ([Polymarket docs](https://docs.polymarket.com/quickstart/introduction/rate-limits?utm_source=openai)).

## Setup

1. Create a Discord bot in the [Discord Developer Portal](https://discord.com/developers/applications), add it to your server, and copy the bot token.
2. Clone or copy this project and install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file in the project root:
   ```bash
   DISCORD_TOKEN=your-bot-token
   POLL_INTERVAL_MS=15000
   COMMAND_PREFIX=!
   ```
   - `POLL_INTERVAL_MS` defaults to 15000 (15 seconds) if omitted. Do not set it below 5000 to avoid spamming the API.
   - `COMMAND_PREFIX` defaults to `!` if omitted.
   - In the Discord Developer Portal, enable the **Message Content Intent** so the bot can detect channel commands.
4. Start the bot:
   ```bash
   npm start
   ```

## How It Works

- The bot polls `https://data-api.polymarket.com/activity` for the specified wallet and filters entries with `type === "TRADE"` and `side === "BUY"` or `side === "SELL"`.
- Post `!start` (or your configured prefix) in any text channel the bot can read to begin polling with the default wallet address.
- Post `!start <wallet_address>` to monitor a specific wallet address (e.g., `!start 0x2005d16a84ceefa912d4e380cd32e7ff827875ea`).
- Post `!stop` to pause polling. Only one channel is monitored at a time, and new `!start` commands will move it.
- Trade hashes are cached in-memory so each Discord notification is only sent once per process run.
- Markets are cached by `conditionId` to prevent duplicate notifications for the same market, even if there are multiple trades.
- On the first poll after starting, the cache is seeded but no messages are emitted; only _new_ trades trigger messages.
- Each message includes the trade type (BUY/SELL), market title, selected outcome, price, notional size in shares and USDC, timestamp, Polygonscan link, and Polymarket market link.

## Commands

- `!start` - Starts monitoring with the default wallet address (`0x0f37cb80dee49d55b5f6d9e595d52591d6371410`)
- `!start <wallet_address>` - Starts monitoring for a specific wallet address (must be a valid Ethereum address)
- `!stop` - Stops monitoring

## Notes

- Restarting the bot will reset the in-memory cache. During startup it suppresses notifications for the most recent 25 activities (the API response size) to prevent duplicate alerts.
- The bot prevents duplicate notifications for the same market by caching market `conditionId` values. If multiple trades occur for the same market, only the first one will trigger a notification.
- For longer history or persistence across restarts, extend the bot to store transaction hashes in a database or file.
- Consider running the bot with a process manager like `pm2` or `systemd` for reliability.
