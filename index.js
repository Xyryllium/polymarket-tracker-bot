require("dotenv").config();

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const fetch = require("node-fetch");
const { ClobClient } = require("@polymarket/clob-client");
const { Wallet } = require("@ethersproject/wallet");
const { Side, OrderType } = require("@polymarket/clob-client");

const DEFAULT_WALLET = "0x0f37cb80dee49d55b5f6d9e595d52591d6371410";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 15000);
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const COMMAND_PREFIX = process.env.COMMAND_PREFIX ?? "!";
const START_COMMAND = `${COMMAND_PREFIX}start`;
const STOP_COMMAND = `${COMMAND_PREFIX}stop`;
const BUY_COMMAND = `${COMMAND_PREFIX}buy`;
const SELL_COMMAND = `${COMMAND_PREFIX}sell`;
const ALERT_ROLE_ID = process.env.ALERT_ROLE_ID;

const POLYMARKET_PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY;
const POLYMARKET_FUNDER = process.env.POLYMARKET_FUNDER;
const POLYMARKET_SIGNATURE_TYPE = Number(
  process.env.POLYMARKET_SIGNATURE_TYPE ?? 1
);
const AUTO_TRADE_ENABLED = process.env.AUTO_TRADE_ENABLED === "true";
const AUTO_TRADE_FILTER = process.env.AUTO_TRADE_FILTER;
const AUTO_TRADE_AMOUNT_USD = Number(process.env.AUTO_TRADE_AMOUNT_USD ?? 1);
const AUTO_TRADE_USE_MARKET = process.env.AUTO_TRADE_USE_MARKET === "true";

if (!DISCORD_TOKEN) {
  throw new Error("Missing DISCORD_TOKEN in environment variables.");
}

if (!Number.isFinite(POLL_INTERVAL_MS) || POLL_INTERVAL_MS < 5000) {
  throw new Error("POLL_INTERVAL_MS must be a number >= 5000.");
}

let clobClient = null;
let clobClientReady = false;
if (POLYMARKET_PRIVATE_KEY) {
  (async () => {
    try {
      const host = "https://clob.polymarket.com";
      const chainId = 137;
      const signer = new Wallet(POLYMARKET_PRIVATE_KEY);

      if (POLYMARKET_FUNDER) {
        clobClient = new ClobClient(host, chainId, signer, {
          signatureType: POLYMARKET_SIGNATURE_TYPE,
          funder: POLYMARKET_FUNDER,
        });
      } else {
        clobClient = new ClobClient(host, chainId, signer);
      }

      const apiKey = await clobClient.deriveApiKey();
      clobClient.setApiCreds(apiKey);
      clobClientReady = true;
      console.log("CLOB client initialized successfully");
    } catch (error) {
      console.error("Failed to initialize CLOB client:", error.message);
      console.warn("Order placement features will be disabled");
      clobClient = null;
      clobClientReady = false;
    }
  })();
} else {
  console.warn(
    "POLYMARKET_PRIVATE_KEY not set. Order placement features disabled."
  );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

let isInitialized = false;
const seenHashes = new Set();
const seenMarketOutcomes = new Set();
let isPolling = false;
let pollTimeout = null;
let activeChannel = null;
let currentWallet = DEFAULT_WALLET;

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

function scheduleNextPoll() {
  pollTimeout = setTimeout(runPollLoop, POLL_INTERVAL_MS);
}

async function pollOnce() {
  try {
    if (!activeChannel) {
      return;
    }

    const activities = await fetchLatestActivity(currentWallet);

    const trades = activities.filter(
      (item) =>
        item?.type === "TRADE" &&
        (String(item?.side).toUpperCase() === "BUY" ||
          String(item?.side).toUpperCase() === "SELL") &&
        item?.transactionHash
    );

    if (!isInitialized) {
      trades.forEach((trade) => {
        seenHashes.add(trade.transactionHash);
        if (trade.conditionId && trade.outcome) {
          seenMarketOutcomes.add(`${trade.conditionId}:${trade.outcome}`);
        }
      });
      isInitialized = true;
      return;
    }

    const newTrades = trades.filter(
      (trade) => !seenHashes.has(trade.transactionHash)
    );

    if (newTrades.length === 0) {
      return;
    }

    if (!activeChannel?.isTextBased()) {
      console.error("Active channel is missing or not text-based.");
      return;
    }

    for (const trade of newTrades.reverse()) {
      seenHashes.add(trade.transactionHash);

      const marketOutcomeKey =
        trade.conditionId && trade.outcome
          ? `${trade.conditionId}:${trade.outcome}`
          : null;

      if (marketOutcomeKey && seenMarketOutcomes.has(marketOutcomeKey)) {
        continue;
      }

      if (marketOutcomeKey) {
        seenMarketOutcomes.add(marketOutcomeKey);
      }

      const {
        title,
        price,
        size,
        usdcSize,
        timestamp,
        transactionHash,
        outcome,
        eventSlug,
        slug,
        side,
        conditionId,
      } = trade;

      const tradeSide = String(side).toUpperCase();
      const priceInCents = price != null ? Math.round(price * 100) : null;
      const formattedPrice = priceInCents != null ? `${priceInCents}¢` : "N/A";
      const discordTimestamp = timestamp != null ? `<t:${timestamp}:f>` : "N/A";

      const mention = ALERT_ROLE_ID ? `<@&${ALERT_ROLE_ID}> ` : "";
      const message = [
        `**New Polymarket ${tradeSide}**`,
        `Market: ${title ?? slug ?? "Unknown market"}`,
        `Outcome: ${outcome ?? "Unknown"} @ ${formattedPrice}`,
        `Size: ${size ?? "?"} shares (~${usdcSize ?? "?"} USDC)`,
        `When: ${discordTimestamp}`,
        `Tx: https://polygonscan.com/tx/${transactionHash}`,
        eventSlug
          ? `Market page: https://polymarket.com/market/${eventSlug}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");

      try {
        await activeChannel.send({ content: `${mention}${message}` });

        if (
          AUTO_TRADE_ENABLED &&
          clobClient &&
          clobClientReady &&
          conditionId &&
          matchesAutoTradeFilter(trade)
        ) {
          try {
            if (!price || price <= 0) {
              await activeChannel.send(
                `⚠️ Cannot auto-trade: Invalid price (${price}). Skipping trade.`
              );
              return;
            }

            const tokenId = conditionId;
            const orderPrice = price;

            if (AUTO_TRADE_USE_MARKET) {
              if (tradeSide === "BUY") {
                const orderResponse = await placeMarketBuyOrder(
                  tokenId,
                  AUTO_TRADE_AMOUNT_USD,
                  orderPrice
                );
                await activeChannel.send(
                  `✅ Auto-placed MARKET BUY order: $${AUTO_TRADE_AMOUNT_USD} @ market price: ${
                    orderResponse.success
                      ? "Success"
                      : orderResponse.errorMsg || "Unknown error"
                  }`
                );
              } else if (tradeSide === "SELL") {
                const orderSize = AUTO_TRADE_AMOUNT_USD / orderPrice;
                const orderResponse = await placeMarketSellOrder(
                  tokenId,
                  orderSize,
                  orderPrice
                );
                await activeChannel.send(
                  `✅ Auto-placed MARKET SELL order: $${AUTO_TRADE_AMOUNT_USD} (${orderSize.toFixed(
                    2
                  )} shares) @ market price: ${
                    orderResponse.success
                      ? "Success"
                      : orderResponse.errorMsg || "Unknown error"
                  }`
                );
              }
            } else {
              let orderSize = AUTO_TRADE_AMOUNT_USD / orderPrice;
              orderSize = Math.max(orderSize, 0.01);
              orderSize = Math.round(orderSize * 100) / 100;

              if (tradeSide === "BUY") {
                const orderResponse = await placeBuyOrder(
                  tokenId,
                  orderPrice,
                  orderSize
                );
                await activeChannel.send(
                  `✅ Auto-placed LIMIT BUY order: $${AUTO_TRADE_AMOUNT_USD} (${orderSize} shares @ ${orderPrice}): ${
                    orderResponse.success
                      ? "Success"
                      : orderResponse.errorMsg || "Unknown error"
                  }`
                );
              } else if (tradeSide === "SELL") {
                const orderResponse = await placeSellOrder(
                  tokenId,
                  orderPrice,
                  orderSize
                );
                await activeChannel.send(
                  `✅ Auto-placed LIMIT SELL order: $${AUTO_TRADE_AMOUNT_USD} (${orderSize} shares @ ${orderPrice}): ${
                    orderResponse.success
                      ? "Success"
                      : orderResponse.errorMsg || "Unknown error"
                  }`
                );
              }
            }
          } catch (tradeError) {
            console.error("Auto-trade error:", tradeError.message);
            await activeChannel.send(
              `⚠️ Auto-trade failed: ${tradeError.message}`
            );
          }
        } else if (
          AUTO_TRADE_ENABLED &&
          clobClient &&
          clobClientReady &&
          conditionId &&
          !matchesAutoTradeFilter(trade)
        ) {
          console.log(
            `Auto-trade skipped: Trade does not match filter "${AUTO_TRADE_FILTER}"`
          );
        }
      } catch (error) {
        console.error("Failed to send message to Discord", error);
      }
    }
  } catch (error) {
    console.error("Polling error:", error.message);
  }
}

async function runPollLoop() {
  await pollOnce();
  if (isPolling) {
    scheduleNextPoll();
  }
}

function isValidWalletAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function matchesAutoTradeFilter(trade) {
  if (!AUTO_TRADE_FILTER) {
    return true;
  }

  const keywords = AUTO_TRADE_FILTER.split(",").map((k) =>
    k.trim().toLowerCase()
  );
  const searchText = [trade.title, trade.slug, trade.eventSlug, trade.outcome]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return keywords.some((keyword) => searchText.includes(keyword));
}

async function placeBuyOrder(tokenId, price, size, orderType = OrderType.GTC) {
  if (!clobClient || !clobClientReady) {
    throw new Error(
      "CLOB client not initialized or API credentials not set. Please wait for initialization to complete."
    );
  }

  try {
    const order = await clobClient.createOrder({
      tokenID: tokenId,
      price: price,
      side: Side.BUY,
      size: size,
      feeRateBps: 0,
      nonce: Date.now(),
    });

    const response = await clobClient.postOrder(order, orderType);
    return response;
  } catch (error) {
    throw new Error(`Failed to place buy order: ${error.message}`);
  }
}

async function placeSellOrder(tokenId, price, size, orderType = OrderType.GTC) {
  if (!clobClient || !clobClientReady) {
    throw new Error(
      "CLOB client not initialized or API credentials not set. Please wait for initialization to complete."
    );
  }

  try {
    const order = await clobClient.createOrder({
      tokenID: tokenId,
      price: price,
      side: Side.SELL,
      size: size,
      feeRateBps: 0,
      nonce: Date.now(),
    });

    const response = await clobClient.postOrder(order, orderType);
    return response;
  } catch (error) {
    throw new Error(`Failed to place sell order: ${error.message}`);
  }
}

async function placeMarketBuyOrder(tokenId, amount, price) {
  if (!clobClient || !clobClientReady) {
    throw new Error(
      "CLOB client not initialized or API credentials not set. Please wait for initialization to complete."
    );
  }

  try {
    const order = await clobClient.createMarketOrder({
      side: Side.BUY,
      tokenID: tokenId,
      amount: amount,
      feeRateBps: 0,
      nonce: Date.now(),
      price: price,
    });

    const response = await clobClient.postOrder(order, OrderType.FOK);
    return response;
  } catch (error) {
    throw new Error(`Failed to place market buy order: ${error.message}`);
  }
}

async function placeMarketSellOrder(tokenId, amount, price) {
  if (!clobClient || !clobClientReady) {
    throw new Error(
      "CLOB client not initialized or API credentials not set. Please wait for initialization to complete."
    );
  }

  try {
    const order = await clobClient.createMarketOrder({
      side: Side.SELL,
      tokenID: tokenId,
      amount: amount,
      feeRateBps: 0,
      nonce: Date.now(),
      price: price,
    });

    const response = await clobClient.postOrder(order, OrderType.FOK);
    return response;
  } catch (error) {
    throw new Error(`Failed to place market sell order: ${error.message}`);
  }
}

async function startPolling(channel, walletAddress = null) {
  if (isPolling) {
    if (activeChannel?.id === channel.id) {
      await channel.send("Polling is already running in this channel.");
      return;
    }

    const previousChannelId = activeChannel?.id;
    await channel.send(
      previousChannelId
        ? `Switching monitoring from <#${previousChannelId}> to this channel.`
        : "Switching monitoring to this channel."
    );
  }

  if (!channel.isTextBased()) {
    await channel.send("Cannot start monitoring: channel is not text-based.");
    return;
  }

  const walletToUse = walletAddress || DEFAULT_WALLET;

  if (!isValidWalletAddress(walletToUse)) {
    await channel.send(
      `Invalid wallet address: ${walletToUse}. Please provide a valid Ethereum address (0x followed by 40 hex characters).`
    );
    return;
  }

  currentWallet = walletToUse;
  activeChannel = channel;
  isPolling = true;
  isInitialized = false;
  seenMarketOutcomes.clear();

  const walletDisplay =
    walletToUse === DEFAULT_WALLET
      ? `default wallet (${DEFAULT_WALLET})`
      : walletToUse;

  await channel.send(
    `Starting Polymarket monitoring for ${walletDisplay} with interval ${
      POLL_INTERVAL_MS / 1000
    }s.`
  );

  await pollOnce();
  scheduleNextPoll();
}

async function stopPolling(channel) {
  if (!isPolling) {
    await channel.send("Polling is not currently running.");
    return;
  }

  if (activeChannel?.id && activeChannel.id !== channel.id) {
    await channel.send(
      `Monitoring is currently active in <#${activeChannel?.id}>. Run ${STOP_COMMAND} there or use ${START_COMMAND} here to move it.`
    );
    return;
  }

  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }

  isPolling = false;
  activeChannel = null;
  await channel.send("Stopped Polymarket monitoring.");
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(
    `Ready for commands. Type ${START_COMMAND} in any text channel the bot can access to begin monitoring.`
  );
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) {
    return;
  }

  const content = message.content.trim();
  const contentLower = content.toLowerCase();

  if (contentLower.startsWith(START_COMMAND.toLowerCase())) {
    const parts = content.split(/\s+/);
    const walletAddress = parts.length > 1 ? parts[1] : null;
    await startPolling(message.channel, walletAddress);
  } else if (contentLower === STOP_COMMAND.toLowerCase()) {
    await stopPolling(message.channel);
  } else if (contentLower.startsWith(BUY_COMMAND.toLowerCase())) {
    const parts = content.split(/\s+/);
    if (parts.length < 4) {
      await message.channel.send(
        `Usage: ${BUY_COMMAND} <tokenId> <price> <size> [orderType]\n` +
          `Example: ${BUY_COMMAND} 71321045679252212594626385532706912750332728571942532289631379312455583992563 0.5 100 GTC\n` +
          `Order types: GTC (Good-Til-Cancelled), GTD (Good-Til-Date), FOK (Fill-Or-Kill)`
      );
      return;
    }

    const tokenId = parts[1];
    const price = parseFloat(parts[2]);
    const size = parseFloat(parts[3]);
    const orderType = parts[4]?.toUpperCase() || "GTC";

    if (isNaN(price) || isNaN(size) || price <= 0 || size <= 0) {
      await message.channel.send(
        "Invalid price or size. Both must be positive numbers."
      );
      return;
    }

    const validOrderTypes = ["GTC", "GTD", "FOK"];
    if (!validOrderTypes.includes(orderType)) {
      await message.channel.send(
        `Invalid order type. Use: ${validOrderTypes.join(", ")}`
      );
      return;
    }

    try {
      await message.channel.send(
        `Placing BUY order for ${size} shares at ${price}...`
      );
      const orderTypeEnum = OrderType[orderType];
      const response = await placeBuyOrder(tokenId, price, size, orderTypeEnum);

      if (response.success) {
        await message.channel.send(
          `✅ BUY order placed successfully!\n` +
            `Order ID: ${response.orderId}\n` +
            `Status: ${response.status || "unknown"}\n` +
            (response.orderHashes?.length > 0
              ? `Matched: ${response.orderHashes.length} order(s)`
              : "")
        );
      } else {
        await message.channel.send(
          `❌ Order failed: ${response.errorMsg || "Unknown error"}`
        );
      }
    } catch (error) {
      await message.channel.send(`❌ Error: ${error.message}`);
    }
  } else if (contentLower.startsWith(SELL_COMMAND.toLowerCase())) {
    const parts = content.split(/\s+/);
    if (parts.length < 4) {
      await message.channel.send(
        `Usage: ${SELL_COMMAND} <tokenId> <price> <size> [orderType]\n` +
          `Example: ${SELL_COMMAND} 71321045679252212594626385532706912750332728571942532289631379312455583992563 0.5 100 GTC\n` +
          `Order types: GTC (Good-Til-Cancelled), GTD (Good-Til-Date), FOK (Fill-Or-Kill)`
      );
      return;
    }

    const tokenId = parts[1];
    const price = parseFloat(parts[2]);
    const size = parseFloat(parts[3]);
    const orderType = parts[4]?.toUpperCase() || "GTC";

    if (isNaN(price) || isNaN(size) || price <= 0 || size <= 0) {
      await message.channel.send(
        "Invalid price or size. Both must be positive numbers."
      );
      return;
    }

    const validOrderTypes = ["GTC", "GTD", "FOK"];
    if (!validOrderTypes.includes(orderType)) {
      await message.channel.send(
        `Invalid order type. Use: ${validOrderTypes.join(", ")}`
      );
      return;
    }

    try {
      await message.channel.send(
        `Placing SELL order for ${size} shares at ${price}...`
      );
      const orderTypeEnum = OrderType[orderType];
      const response = await placeSellOrder(
        tokenId,
        price,
        size,
        orderTypeEnum
      );

      if (response.success) {
        await message.channel.send(
          `✅ SELL order placed successfully!\n` +
            `Order ID: ${response.orderId}\n` +
            `Status: ${response.status || "unknown"}\n` +
            (response.orderHashes?.length > 0
              ? `Matched: ${response.orderHashes.length} order(s)`
              : "")
        );
      } else {
        await message.channel.send(
          `❌ Order failed: ${response.errorMsg || "Unknown error"}`
        );
      }
    } catch (error) {
      await message.channel.send(`❌ Error: ${error.message}`);
    }
  }
});

client.on("error", (error) => {
  console.error("Discord client error:", error);
});

client.login(DISCORD_TOKEN);
