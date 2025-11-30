require("dotenv").config();

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const fetch = require("node-fetch");
const { ClobClient } = require("@polymarket/clob-client");
const { Wallet } = require("@ethersproject/wallet");
const { JsonRpcProvider } = require("@ethersproject/providers");
const { Contract } = require("@ethersproject/contracts");
const { OrderType } = require("@polymarket/clob-client");

const {
  POLL_INTERVAL_MS,
  DISCORD_TOKEN,
  START_COMMAND,
  STOP_COMMAND,
  BUY_COMMAND,
  SELL_COMMAND,
  BALANCE_COMMAND,
  PAPER_BALANCE_COMMAND,
  PAPER_RESET_COMMAND,
  PAPER_CLOSE_COMMAND,
  ALERT_ROLE_ID,
  POLYMARKET_PRIVATE_KEY,
  POLYMARKET_FUNDER,
  POLYMARKET_SIGNATURE_TYPE,
  POLYGON_RPC,
  USDC_ADDRESS,
  CLOB_EXCHANGE_ADDRESS,
  USDC_ABI,
  PAPER_TRADING_ENABLED,
  PAPER_TRADING_INITIAL_BALANCE,
  POLY_WS_API_KEY,
  POLY_WS_API_SECRET,
  POLY_WS_API_PASSPHRASE,
} = require("./config");

const { logToFile } = require("./utils/logger");
const OrderbookWebSocketManager = require("./websocket/orderbookWS");
const {
  getPaperTradingBalance,
  resetPaperTrading,
  getPaperTradingState,
  savePaperTradingState,
} = require("./services/paperTrading");
const {
  getTokenIdForOutcome,
  getCurrentMarketPrice,
} = require("./services/marketData");
const { placeBuyOrder, placeSellOrder } = require("./services/orders");
const {
  startPolling,
  stopPolling,
  getActiveChannel,
} = require("./services/polling");
const {
  getTrackedPositions,
  setClobClient,
  setSigner,
  setCurrentWallet,
} = require("./services/positions");

if (!DISCORD_TOKEN) {
  throw new Error("Missing DISCORD_TOKEN in environment variables.");
}

if (!Number.isFinite(POLL_INTERVAL_MS) || POLL_INTERVAL_MS < 500) {
  throw new Error(
    "POLL_INTERVAL_MS must be a number >= 500 (500ms minimum for rate limit safety)."
  );
}

let clobClient = null;
let clobClientReady = false;
let provider = null;
let signer = null;
let orderbookWS = null;

if (POLYMARKET_PRIVATE_KEY) {
  provider = new JsonRpcProvider(POLYGON_RPC);
  signer = new Wallet(POLYMARKET_PRIVATE_KEY, provider);
  (async () => {
    try {
      const host = "https://clob.polymarket.com";
      const chainId = 137;

      const credsPromise = new ClobClient(host, chainId, signer).deriveApiKey();
      const rawCreds = await credsPromise;

      const creds = {
        key: rawCreds.apiKey || rawCreds.key,
        secret: rawCreds.secret,
        passphrase: rawCreds.passphrase,
      };

      if (POLYMARKET_FUNDER) {
        clobClient = new ClobClient(
          host,
          chainId,
          signer,
          creds,
          POLYMARKET_SIGNATURE_TYPE,
          POLYMARKET_FUNDER
        );
      } else {
        clobClient = new ClobClient(host, chainId, signer, creds, 0);
      }

      clobClientReady = true;
      setClobClient(clobClient, clobClientReady);
      setSigner(signer);

      logToFile("INFO", "CLOB client initialized successfully", {
        apiKeySet: true,
        hasFunder: !!POLYMARKET_FUNDER,
      });

      if (POLY_WS_API_KEY && POLY_WS_API_SECRET && POLY_WS_API_PASSPHRASE) {
        orderbookWS = new OrderbookWebSocketManager(
          POLY_WS_API_KEY,
          POLY_WS_API_SECRET,
          POLY_WS_API_PASSPHRASE
        );

        const {
          handleWebSocketStopLoss,
        } = require("./services/websocketStopLoss");
        orderbookWS.setStopLossCallback((tokenId, price, side) => {
          handleWebSocketStopLoss(
            tokenId,
            price,
            side,
            clobClient,
            clobClientReady,
            getActiveChannel(),
            orderbookWS
          );
        });

        orderbookWS.connect();
        logToFile("INFO", "WebSocket orderbook manager initialized", {});

        const {
          loadStopLossPositions,
          getCurrentPositions,
          setStopLossPosition,
        } = require("./services/positions");
        const {
          STOP_LOSS_WEBSOCKET_MARKET_FILTER,
          STOP_LOSS_ENABLED,
          STOP_LOSS_PERCENTAGE,
          PAPER_TRADING_ENABLED,
        } = require("./config");
        orderbookWS.on("connected", async () => {
          setTimeout(async () => {
            const tokenIds = loadStopLossPositions();
            if (tokenIds.length > 0) {
              logToFile(
                "INFO",
                "Restoring WebSocket subscriptions for stop-loss positions",
                {
                  count: tokenIds.length,
                  filter: STOP_LOSS_WEBSOCKET_MARKET_FILTER.join(", "),
                }
              );
              for (const tokenId of tokenIds) {
                orderbookWS.subscribe(tokenId);
              }
            }

            if (
              STOP_LOSS_ENABLED &&
              !PAPER_TRADING_ENABLED &&
              clobClient &&
              clobClientReady
            ) {
              try {
                const positions = await getCurrentPositions();
                if (positions.length > 0) {
                  logToFile("DEBUG", "Sample position structure from API", {
                    positionIndex: 0,
                    allKeys: Object.keys(positions[0]),
                    fullPosition: JSON.stringify(
                      positions[0],
                      null,
                      2
                    ).substring(0, 1000),
                  });
                }

                logToFile(
                  "INFO",
                  "Checking current positions for stop-loss registration on startup",
                  {
                    totalPositions: positions.length,
                    samplePosition:
                      positions.length > 0
                        ? {
                            keys: Object.keys(positions[0]),
                            sampleData: {
                              token_id: positions[0].token_id
                                ? String(positions[0].token_id).length > 10
                                  ? String(positions[0].token_id).substring(
                                      0,
                                      10
                                    ) + "..."
                                  : String(positions[0].token_id)
                                : null,
                              tokenId: positions[0].tokenId
                                ? String(positions[0].tokenId).length > 10
                                  ? String(positions[0].tokenId).substring(
                                      0,
                                      10
                                    ) + "..."
                                  : String(positions[0].tokenId)
                                : null,
                              tokenID: positions[0].tokenID
                                ? String(positions[0].tokenID).length > 10
                                  ? String(positions[0].tokenID).substring(
                                      0,
                                      10
                                    ) + "..."
                                  : String(positions[0].tokenID)
                                : null,
                              asset: positions[0].asset
                                ? String(positions[0].asset).length > 10
                                  ? String(positions[0].asset).substring(
                                      0,
                                      10
                                    ) + "..."
                                  : String(positions[0].asset)
                                : null,
                              asset_id: positions[0].asset_id
                                ? String(positions[0].asset_id).length > 10
                                  ? String(positions[0].asset_id).substring(
                                      0,
                                      10
                                    ) + "..."
                                  : String(positions[0].asset_id)
                                : null,
                              title: positions[0].title,
                              market: positions[0].market,
                              question: positions[0].question,
                              slug: positions[0].slug,
                              conditionId: positions[0].conditionId,
                              condition_id: positions[0].condition_id,
                            },
                          }
                        : null,
                  }
                );

                let registeredCount = 0;
                let checkedCount = 0;
                let skippedNoTokenId = 0;
                for (const pos of positions) {
                  const tokenId =
                    pos.token_id ||
                    pos.tokenId ||
                    pos.tokenID ||
                    pos.asset ||
                    pos.asset_id ||
                    (pos.asset && typeof pos.asset === "string"
                      ? pos.asset
                      : null);
                  if (!tokenId) {
                    skippedNoTokenId++;
                    logToFile("DEBUG", "Position missing tokenId, skipping", {
                      positionKeys: Object.keys(pos),
                      hasToken_id: !!pos.token_id,
                      hasTokenId: !!pos.tokenId,
                      hasTokenID: !!pos.tokenID,
                      hasAsset: !!pos.asset,
                      hasAsset_id: !!pos.asset_id,
                      assetType: typeof pos.asset,
                      assetValue: pos.asset,
                    });
                    continue;
                  }

                  checkedCount++;

                  if (tokenIds.includes(tokenId)) {
                    logToFile(
                      "DEBUG",
                      "Position already registered, skipping",
                      {
                        tokenId: tokenId.substring(0, 10) + "...",
                      }
                    );
                    continue;
                  }

                  let title = pos.title || pos.market || pos.question || "";
                  let slug = pos.slug || "";
                  let conditionId = pos.conditionId || pos.condition_id || null;
                  let outcome = pos.outcome || pos.outcome_title || null;

                  if (
                    (!title || !conditionId) &&
                    clobClient &&
                    clobClientReady
                  ) {
                    try {
                      const marketUrl = `https://data-api.polymarket.com/markets?tokenId=${tokenId}`;
                      const response = await fetch(marketUrl, {
                        headers: { Accept: "application/json" },
                      });

                      if (response.ok) {
                        const markets = await response.json();
                        if (Array.isArray(markets) && markets.length > 0) {
                          const market = markets[0];
                          if (!title)
                            title =
                              market.question ||
                              market.title ||
                              market.market ||
                              "";
                          if (!slug) slug = market.slug || "";
                          if (!conditionId)
                            conditionId = market.conditionId || null;
                          if (
                            !outcome &&
                            market.tokens &&
                            Array.isArray(market.tokens)
                          ) {
                            for (const token of market.tokens) {
                              const tokenIdStr = String(
                                token.token_id ||
                                  token.asset_id ||
                                  token.id ||
                                  ""
                              );
                              if (tokenIdStr === String(tokenId)) {
                                outcome =
                                  token.outcome ||
                                  token.title ||
                                  token.name ||
                                  null;
                                break;
                              }
                            }
                          }
                        }
                      }
                    } catch (fetchError) {
                      logToFile(
                        "WARN",
                        "Failed to fetch market info for position",
                        {
                          tokenId: tokenId.substring(0, 10) + "...",
                          error: fetchError.message,
                        }
                      );
                    }
                  }
                  logToFile(
                    "DEBUG",
                    "Checking position for stop-loss registration",
                    {
                      tokenId: tokenId.substring(0, 10) + "...",
                      hasTitle: !!title,
                      title: title.substring(0, 50) || "N/A",
                      hasSlug: !!slug,
                      slug: slug.substring(0, 50) || "N/A",
                      hasConditionId: !!conditionId,
                      conditionId: conditionId
                        ? conditionId.substring(0, 10) + "..."
                        : "N/A",
                      hasOutcome: !!outcome,
                      outcome: outcome || "N/A",
                      positionKeys: Object.keys(pos),
                    }
                  );

                  const matchesFilter = STOP_LOSS_WEBSOCKET_MARKET_FILTER.some(
                    (filter) => {
                      if (filter.startsWith("0x") && conditionId) {
                        return (
                          conditionId.toLowerCase() === filter.toLowerCase()
                        );
                      }
                      const keyword = filter.toLowerCase();
                      const titleMatch =
                        title && title.toLowerCase().includes(keyword);
                      const slugMatch =
                        slug && slug.toLowerCase().includes(keyword);
                      return titleMatch || slugMatch;
                    }
                  );

                  logToFile("DEBUG", "Position filter check result", {
                    tokenId: tokenId.substring(0, 10) + "...",
                    matchesFilter,
                    filter: STOP_LOSS_WEBSOCKET_MARKET_FILTER.join(", "),
                    title: title.substring(0, 50) || "N/A",
                    slug: slug.substring(0, 50) || "N/A",
                  });

                  if (matchesFilter) {
                    try {
                      const entryPrice =
                        pos.avg_price ||
                        pos.avgPrice ||
                        pos.price ||
                        pos.last_price ||
                        null;
                      const shares = pos.shares || pos.size || 0;

                      if (entryPrice && shares > 0) {
                        const stopLossPrice =
                          entryPrice * (1 - STOP_LOSS_PERCENTAGE / 100);
                        setStopLossPosition(
                          tokenId,
                          entryPrice,
                          shares,
                          stopLossPrice,
                          {
                            market: title || slug || "Unknown",
                            conditionId: conditionId || null,
                            outcome: outcome || null,
                          }
                        );

                        orderbookWS.subscribe(tokenId);
                        registeredCount++;

                        logToFile(
                          "INFO",
                          "Registered stop-loss for existing BTC position on startup",
                          {
                            tokenId: tokenId.substring(0, 10) + "...",
                            market: title || slug || "Unknown",
                            entryPrice,
                            shares,
                            stopLossPrice,
                            conditionId: conditionId
                              ? conditionId.substring(0, 10) + "..."
                              : null,
                          }
                        );
                      } else {
                        logToFile(
                          "WARN",
                          "Skipping position - missing entry price or shares",
                          {
                            tokenId: tokenId.substring(0, 10) + "...",
                            hasEntryPrice: !!entryPrice,
                            shares,
                          }
                        );
                      }
                    } catch (error) {
                      logToFile(
                        "ERROR",
                        "Error registering stop-loss for existing position",
                        {
                          tokenId: tokenId.substring(0, 10) + "...",
                          error: error.message,
                        }
                      );
                    }
                  }
                }

                logToFile(
                  "INFO",
                  "Finished checking current positions for stop-loss registration",
                  {
                    totalPositions: positions.length,
                    checkedPositions: checkedCount,
                    skippedNoTokenId,
                    registeredCount,
                    filter: STOP_LOSS_WEBSOCKET_MARKET_FILTER.join(", "),
                  }
                );

                if (registeredCount > 0) {
                  logToFile(
                    "INFO",
                    "Registered stop-loss for existing positions on startup",
                    {
                      count: registeredCount,
                      filter: STOP_LOSS_WEBSOCKET_MARKET_FILTER.join(", "),
                    }
                  );
                } else if (checkedCount > 0) {
                  logToFile(
                    "INFO",
                    "No positions matched the filter or were missing required data",
                    {
                      checkedCount,
                      filter: STOP_LOSS_WEBSOCKET_MARKET_FILTER.join(", "),
                    }
                  );
                }
              } catch (error) {
                logToFile(
                  "ERROR",
                  "Error checking current positions for stop-loss on startup",
                  {
                    error: error.message,
                    stack: error.stack,
                  }
                );
              }
            }
          }, 2000);
        });
      } else {
        logToFile(
          "WARN",
          "WebSocket API credentials not set. Using REST API for orderbook data."
        );
      }
    } catch (error) {
      logToFile("ERROR", "Failed to initialize CLOB client", {
        error: error.message,
        stack: error.stack,
      });
      clobClient = null;
      clobClientReady = false;
    }
  })();
} else {
  logToFile(
    "WARN",
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

client.once("clientReady", async () => {
  logToFile("INFO", "Discord bot ready", { botTag: client.user.tag });
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
    const trackedPositions = getTrackedPositions();
    await startPolling(
      message.channel,
      walletAddress,
      clobClient,
      clobClientReady,
      orderbookWS,
      trackedPositions,
      provider,
      signer
    );
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
      const response = await placeBuyOrder(
        tokenId,
        price,
        size,
        orderTypeEnum,
        clobClient,
        clobClientReady
      );

      if (response && response.success) {
        await message.channel.send(
          `✅ BUY order placed successfully!\n` +
            `Order ID: ${response.orderId || "N/A"}\n` +
            `Status: ${response.status || "unknown"}\n` +
            (response.orderHashes?.length > 0
              ? `Matched: ${response.orderHashes.length} order(s)`
              : "")
        );
      } else {
        await message.channel.send(
          `❌ Order failed: ${
            response?.errorMsg || response?.error || "Unknown error"
          }`
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
        orderTypeEnum,
        clobClient,
        clobClientReady
      );

      if (response && response.success) {
        await message.channel.send(
          `✅ SELL order placed successfully!\n` +
            `Order ID: ${response.orderId || "N/A"}\n` +
            `Status: ${response.status || "unknown"}\n` +
            (response.orderHashes?.length > 0
              ? `Matched: ${response.orderHashes.length} order(s)`
              : "")
        );
      } else {
        await message.channel.send(
          `❌ Order failed: ${
            response?.errorMsg || response?.error || "Unknown error"
          }`
        );
      }
    } catch (error) {
      await message.channel.send(`❌ Error: ${error.message}`);
    }
  } else if (contentLower === BALANCE_COMMAND.toLowerCase()) {
    if (!POLYMARKET_PRIVATE_KEY || !provider || !signer) {
      await message.channel.send(
        "❌ CLOB client not configured. POLYMARKET_PRIVATE_KEY is required."
      );
      return;
    }

    try {
      await message.channel.send("Checking balance and allowance...");
      const walletAddress = POLYMARKET_FUNDER || signer.address;
      const usdcContract = new Contract(USDC_ADDRESS, USDC_ABI, provider);
      const decimals = await usdcContract.decimals();
      const balance = await usdcContract.balanceOf(walletAddress);
      const allowance = await usdcContract.allowance(
        walletAddress,
        CLOB_EXCHANGE_ADDRESS
      );

      const balanceFormatted = (Number(balance) / 10 ** decimals).toFixed(2);
      let allowanceFormatted;
      if (Number(allowance) > 1e20) {
        allowanceFormatted = "Unlimited (Max Approval)";
      } else {
        allowanceFormatted = (Number(allowance) / 10 ** decimals).toFixed(2);
      }

      let messageText = `💰 **Balance & Allowance Check**\n\n`;

      messageText += `**EOA Address** (derived from your private key):\n\`${signer.address}\`\n`;
      const eoaBalance = await usdcContract.balanceOf(signer.address);
      const eoaBalanceFormatted = (Number(eoaBalance) / 10 ** decimals).toFixed(
        2
      );
      messageText += `- USDC Balance: $${eoaBalanceFormatted}\n`;
      const eoaAllowance = await usdcContract.allowance(
        signer.address,
        CLOB_EXCHANGE_ADDRESS
      );
      let eoaAllowanceFormatted;
      if (Number(eoaAllowance) > 1e20) {
        eoaAllowanceFormatted = "Unlimited";
      } else {
        eoaAllowanceFormatted = (Number(eoaAllowance) / 10 ** decimals).toFixed(
          2
        );
      }
      messageText += `- Allowance (CLOB): $${eoaAllowanceFormatted}\n\n`;

      if (POLYMARKET_FUNDER) {
        messageText += `**Proxy Wallet** (POLYMARKET_FUNDER - shown on your Polymarket profile):\n\`${POLYMARKET_FUNDER}\`\n`;
        messageText += `- USDC Balance: $${balanceFormatted}\n`;
        messageText += `- Allowance (CLOB): $${allowanceFormatted}\n\n`;
        messageText += `ℹ️ **Why addresses are different:**\n`;
        messageText += `- Your private key controls the EOA: \`${signer.address}\`\n`;
        messageText += `- Polymarket uses a proxy wallet: \`${POLYMARKET_FUNDER}\`\n`;
        messageText += `- Your Polymarket profile shows the proxy wallet address\n`;
        messageText += `- Trading happens through the proxy wallet (this is where your $253.50 is)\n`;
        messageText += `- This is normal and expected when using email/magic link login\n\n`;
      } else {
        messageText += `ℹ️ **Direct EOA Trading**\n`;
        messageText += `No proxy wallet configured. Using EOA directly.\n\n`;
      }

      if (Number(allowance) === 0) {
        messageText += `❌ **NO ALLOWANCE SET**\n`;
        messageText += `You need to approve the CLOB contract to spend USDC.\n\n`;
        messageText += `**To approve:**\n`;
        messageText += `1. Go to https://polymarket.com\n`;
        messageText += `2. Connect your wallet\n`;
        messageText += `3. Place a test order (this will trigger approval)\n`;
        messageText += `OR use a tool like MetaMask to approve:\n`;
        messageText += `- Token: USDC (${USDC_ADDRESS})\n`;
        messageText += `- Spender: ${CLOB_EXCHANGE_ADDRESS}\n`;
        messageText += `- Amount: Max (or a large amount like 1000000)\n`;
      } else if (Number(allowance) < Number(balance)) {
        messageText += `⚠️ **Allowance is less than balance**\n`;
        messageText += `You may need to increase your allowance.\n`;
      } else {
        messageText += `✅ **Allowance is sufficient**\n`;
      }

      if (Number(balance) === 0) {
        messageText += `\n❌ **NO USDC BALANCE**\n`;
        messageText += `Fund your wallet with USDC on Polygon.\n`;
      }

      await message.channel.send(messageText);
      logToFile("INFO", "Balance check completed", {
        walletAddress,
        balance: balanceFormatted,
        allowance: allowanceFormatted,
        hasFunder: !!POLYMARKET_FUNDER,
      });
    } catch (error) {
      logToFile("ERROR", "Balance check failed", {
        error: error.message,
        stack: error.stack,
      });
      await message.channel.send(`❌ Error checking balance: ${error.message}`);
    }
  } else if (contentLower === PAPER_BALANCE_COMMAND.toLowerCase()) {
    if (!PAPER_TRADING_ENABLED) {
      await message.channel.send(
        "❌ Paper trading is not enabled. Set `PAPER_TRADING_ENABLED=true` in your `.env` file."
      );
      return;
    }

    try {
      const balance = getPaperTradingBalance();
      const paperTradingState = getPaperTradingState();

      const positionsWithLinks = [];
      const positionEntries = Object.entries(balance.positions);

      for (let i = 0; i < positionEntries.length; i++) {
        const [tokenId, pos] = positionEntries[i];

        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }

        try {
          const shortTokenId =
            tokenId.length > 20
              ? tokenId.substring(0, 10) +
                "..." +
                tokenId.substring(tokenId.length - 6)
              : tokenId;

          let marketLink = null;
          let marketTitle = pos.market || "Unknown";

          try {
            const identifier = pos.conditionId || tokenId;
            if (identifier) {
              if (pos.conditionId) {
                const marketUrl = `https://data-api.polymarket.com/markets?conditionId=${pos.conditionId}`;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);

                const response = await fetch(marketUrl, {
                  headers: { Accept: "application/json" },
                  signal: controller.signal,
                });
                clearTimeout(timeoutId);

                if (response.ok) {
                  const markets = await response.json();
                  if (Array.isArray(markets) && markets.length > 0) {
                    const market = markets[0];
                    if (!pos.outcome) {
                      logToFile(
                        "INFO",
                        "Market API response - checking for outcome",
                        {
                          tokenId: shortTokenId,
                          marketKeys: Object.keys(market),
                          hasTokens: !!market.tokens,
                          hasOutcomes: !!market.outcomes,
                          tokensType: Array.isArray(market.tokens)
                            ? "array"
                            : typeof market.tokens,
                          outcomesType: Array.isArray(market.outcomes)
                            ? "array"
                            : typeof market.outcomes,
                        }
                      );
                    }

                    const eventSlug = market.eventSlug;
                    const slug = market.slug || market.id;
                    if (eventSlug) {
                      marketLink = `https://polymarket.com/event/${eventSlug}`;
                      marketTitle =
                        market.question ||
                        market.title ||
                        market.market ||
                        marketTitle;
                    } else if (slug) {
                      marketLink = `https://polymarket.com/market/${slug}`;
                      marketTitle =
                        market.question ||
                        market.title ||
                        market.market ||
                        marketTitle;
                    } else {
                      logToFile("WARN", "No slug found in market response", {
                        tokenId: shortTokenId,
                        marketFields: Object.keys(market),
                      });
                    }

                    if (!pos.outcome) {
                      if (market.tokens && Array.isArray(market.tokens)) {
                        for (const token of market.tokens) {
                          const tokenIdStr = String(
                            token.token_id || token.asset_id || token.id || ""
                          );
                          if (tokenIdStr === String(tokenId)) {
                            pos.outcome =
                              token.outcome ||
                              token.title ||
                              token.name ||
                              token.label;
                            if (pos.outcome) {
                              paperTradingState.positions[tokenId].outcome =
                                pos.outcome;
                              savePaperTradingState();
                              logToFile(
                                "INFO",
                                "Found outcome from tokens array",
                                {
                                  tokenId: shortTokenId,
                                  outcome: pos.outcome,
                                }
                              );
                              break;
                            }
                          }
                        }
                      }

                      if (
                        !pos.outcome &&
                        market.outcomes &&
                        Array.isArray(market.outcomes)
                      ) {
                        for (const outcomeOption of market.outcomes) {
                          const outcomeTitle =
                            outcomeOption.title ||
                            outcomeOption.name ||
                            outcomeOption.outcome ||
                            outcomeOption.label;
                          const outcomeTokenId = String(
                            outcomeOption.token_id ||
                              outcomeOption.asset_id ||
                              outcomeOption.id ||
                              ""
                          );
                          if (outcomeTokenId === String(tokenId)) {
                            pos.outcome =
                              outcomeOption.title ||
                              outcomeOption.name ||
                              outcomeOption.outcome ||
                              outcomeOption.label;
                            if (pos.outcome) {
                              paperTradingState.positions[tokenId].outcome =
                                pos.outcome;
                              savePaperTradingState();
                              logToFile(
                                "INFO",
                                "Found outcome from outcomes array",
                                {
                                  tokenId: shortTokenId,
                                  outcome: pos.outcome,
                                }
                              );
                              break;
                            }
                          }
                        }
                      }

                      if (!pos.outcome && clobClient && clobClientReady) {
                        try {
                          const tokenInfo = await clobClient.getTokenInfo(
                            tokenId
                          );
                          if (tokenInfo && tokenInfo.outcome) {
                            pos.outcome = tokenInfo.outcome;
                            paperTradingState.positions[tokenId].outcome =
                              pos.outcome;
                            savePaperTradingState();
                            logToFile("INFO", "Found outcome from CLOB API", {
                              tokenId: shortTokenId,
                              outcome: pos.outcome,
                            });
                          }
                        } catch (error) {}
                      }
                    }
                  }
                }
              }

              if (!marketLink) {
                const assetUrl = `https://data-api.polymarket.com/markets?tokenId=${tokenId}`;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);

                const assetResponse = await fetch(assetUrl, {
                  headers: { Accept: "application/json" },
                  signal: controller.signal,
                });
                clearTimeout(timeoutId);

                if (assetResponse.ok) {
                  const assetMarkets = await assetResponse.json();
                  if (Array.isArray(assetMarkets) && assetMarkets.length > 0) {
                    const market = assetMarkets[0];
                    const eventSlug = market.eventSlug;
                    const slug = market.slug || market.id;
                    if (eventSlug) {
                      marketLink = `https://polymarket.com/event/${eventSlug}`;
                      marketTitle =
                        market.question ||
                        market.title ||
                        market.market ||
                        marketTitle;
                    } else if (slug) {
                      marketLink = `https://polymarket.com/market/${slug}`;
                      marketTitle =
                        market.question ||
                        market.title ||
                        market.market ||
                        marketTitle;
                    }

                    if (
                      !pos.outcome &&
                      market.outcomes &&
                      Array.isArray(market.outcomes)
                    ) {
                      for (const outcomeOption of market.outcomes) {
                        if (
                          outcomeOption.token_id === tokenId ||
                          outcomeOption.asset_id === tokenId
                        ) {
                          pos.outcome =
                            outcomeOption.title ||
                            outcomeOption.name ||
                            outcomeOption.outcome;
                          paperTradingState.positions[tokenId].outcome =
                            pos.outcome;
                          savePaperTradingState();
                          break;
                        }
                      }
                    }

                    if (
                      !pos.outcome &&
                      market.tokens &&
                      Array.isArray(market.tokens)
                    ) {
                      for (const token of market.tokens) {
                        if (
                          token.token_id === tokenId ||
                          token.asset_id === tokenId
                        ) {
                          pos.outcome =
                            token.outcome || token.title || token.name;
                          if (pos.outcome) {
                            paperTradingState.positions[tokenId].outcome =
                              pos.outcome;
                            savePaperTradingState();
                          }
                          break;
                        }
                      }
                    }
                  }
                }
              }

              if (!marketLink) {
                const searchTitle = encodeURIComponent(marketTitle);
                marketLink = `https://polymarket.com/search?q=${searchTitle}`;
              }
            }
          } catch (error) {
            logToFile("WARN", "Failed to fetch market info for position", {
              tokenId,
              conditionId: pos.conditionId,
              error: error.message,
            });
            if (!marketLink) {
              const searchTitle = encodeURIComponent(marketTitle);
              marketLink = `https://polymarket.com/search?q=${searchTitle}`;
            }
          }

          const outcomeText = pos.outcome ? ` - ${pos.outcome}` : "";
          const positionText = `${pos.shares.toFixed(
            2
          )} shares @ $${pos.avgPrice.toFixed(4)} ($${pos.entryValue.toFixed(
            2
          )})${outcomeText}`;

          let finalLink = marketLink;
          if (!finalLink) {
            const searchTitle = encodeURIComponent(marketTitle);
            finalLink = `https://polymarket.com/search?q=${searchTitle}`;
          }

          const result = {
            shortTokenId,
            positionText,
            link: finalLink,
            title: marketTitle,
            fullTokenId: tokenId,
            outcome: pos.outcome,
          };

          positionsWithLinks.push(result);
        } catch (error) {
          logToFile("WARN", "Failed to process position", {
            tokenId: tokenId.substring(0, 10) + "...",
            error: error.message,
          });

          const shortTokenId =
            tokenId.length > 20
              ? tokenId.substring(0, 10) +
                "..." +
                tokenId.substring(tokenId.length - 6)
              : tokenId;

          const outcomeText = pos.outcome ? ` - ${pos.outcome}` : "";
          const positionText = `${pos.shares.toFixed(
            2
          )} shares @ $${pos.avgPrice.toFixed(4)} ($${pos.entryValue.toFixed(
            2
          )})${outcomeText}`;

          positionsWithLinks.push({
            shortTokenId,
            positionText,
            link: null,
            title: pos.market || "Unknown",
            fullTokenId: tokenId,
            outcome: pos.outcome,
          });
        }
      }

      const positionsList = positionsWithLinks
        .map((pos) => {
          const marketDisplay = pos.link
            ? `[${pos.title}](${pos.link})`
            : pos.title;
          return `**${pos.shortTokenId}**: ${pos.positionText} - ${marketDisplay}`;
        })
        .join("\n");

      const closedTrades = paperTradingState.tradeHistory.filter(
        (trade) =>
          (trade.side === "MANUAL_CLOSE" ||
            trade.side === "SETTLEMENT" ||
            trade.side === "STOP_LOSS") &&
          trade.pnl !== undefined
      );
      const wins = closedTrades.filter((trade) => trade.pnl > 0).length;
      const losses = closedTrades.filter((trade) => trade.pnl < 0).length;
      const stopLossTrades = closedTrades.filter(
        (trade) => trade.side === "STOP_LOSS"
      ).length;
      const totalClosed = wins + losses;
      const winrate =
        totalClosed > 0 ? ((wins / totalClosed) * 100).toFixed(2) : "0.00";

      const embed = {
        title: "📝 Paper Trading Balance",
        color: 0x0099ff,
        fields: [
          {
            name: "💰 Available Balance",
            value: `$${balance.balance.toFixed(2)}`,
            inline: true,
          },
          {
            name: "📊 Total Positions",
            value: `${balance.totalPositions}`,
            inline: true,
          },
          {
            name: "💵 Total Exposure",
            value: `$${balance.totalExposure.toFixed(2)}`,
            inline: true,
          },
          {
            name: "📈 Total Value",
            value: `$${balance.totalValue.toFixed(2)}`,
            inline: true,
          },
          {
            name: "💚 Realized PnL",
            value: `$${
              balance.realizedPnL >= 0 ? "+" : ""
            }${balance.realizedPnL.toFixed(2)}`,
            inline: true,
          },
          {
            name: "📊 Return %",
            value: `${(
              ((balance.totalValue - PAPER_TRADING_INITIAL_BALANCE) /
                PAPER_TRADING_INITIAL_BALANCE) *
              100
            ).toFixed(2)}%`,
            inline: true,
          },
          {
            name: "🎯 Winrate",
            value: `${winrate}% (${wins}W/${losses}L${
              stopLossTrades > 0 ? `/${stopLossTrades}SL` : ""
            })`,
            inline: true,
          },
        ],
        timestamp: new Date().toISOString(),
      };

      if (positionsList) {
        const MAX_FIELD_LENGTH = 1024;
        let positionsValue = positionsList;
        let displayedCount = positionsWithLinks.length;

        if (positionsList.length > MAX_FIELD_LENGTH) {
          const truncationMessage = `\n\n*... and X more position(s)*`;
          const maxLength = MAX_FIELD_LENGTH - truncationMessage.length;

          let truncated = positionsList.substring(0, maxLength);
          const lastNewline = truncated.lastIndexOf("\n");
          if (lastNewline > 0) {
            truncated = truncated.substring(0, lastNewline);
            displayedCount = (truncated.match(/\*\*/g) || []).length / 2;
          }

          const remainingCount = balance.totalPositions - displayedCount;
          positionsValue =
            truncated + `\n\n*... and ${remainingCount} more position(s)*`;
        }

        embed.fields.push({
          name: "📋 Open Positions",
          value: positionsValue || "None",
          inline: false,
        });
      }

      let retries = 3;
      let sent = false;

      while (retries > 0 && !sent) {
        try {
          await Promise.race([
            message.channel.send({ embeds: [embed] }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Discord send timeout")), 10000)
            ),
          ]);
          sent = true;
        } catch (error) {
          retries--;
          if (retries === 0) {
            logToFile(
              "ERROR",
              "Failed to send paper balance message after retries",
              {
                error: error.message,
                code: error.code,
              }
            );
            try {
              const closedTrades = paperTradingState.tradeHistory.filter(
                (trade) =>
                  (trade.side === "MANUAL_CLOSE" ||
                    trade.side === "SETTLEMENT" ||
                    trade.side === "STOP_LOSS") &&
                  trade.pnl !== undefined
              );
              const wins = closedTrades.filter((trade) => trade.pnl > 0).length;
              const losses = closedTrades.filter(
                (trade) => trade.pnl < 0
              ).length;
              const stopLossTrades = closedTrades.filter(
                (trade) => trade.side === "STOP_LOSS"
              ).length;
              const totalClosed = wins + losses;
              const winrate =
                totalClosed > 0
                  ? ((wins / totalClosed) * 100).toFixed(2)
                  : "0.00";

              await message.channel.send(
                `📝 Paper Trading Balance\n` +
                  `💰 Balance: $${balance.balance.toFixed(2)}\n` +
                  `📊 Positions: ${balance.totalPositions}\n` +
                  `💵 Exposure: $${balance.totalExposure.toFixed(2)}\n` +
                  `💚 PnL: $${
                    balance.realizedPnL >= 0 ? "+" : ""
                  }${balance.realizedPnL.toFixed(2)}\n` +
                  `🎯 Winrate: ${winrate}% (${wins}W/${losses}L${
                    stopLossTrades > 0 ? `/${stopLossTrades}SL` : ""
                  })\n` +
                  `\n*Full details unavailable due to connection timeout*`
              );
            } catch (fallbackError) {
              logToFile("ERROR", "Failed to send fallback message", {
                error: fallbackError.message,
              });
            }
          } else {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      }

      logToFile("INFO", "Paper balance check completed", {
        balance: balance.balance,
        positions: balance.totalPositions,
        realizedPnL: balance.realizedPnL,
      });
    } catch (error) {
      logToFile("ERROR", "Paper balance check failed", {
        error: error.message,
        stack: error.stack,
      });
      await message.channel.send(
        `❌ Error checking paper balance: ${error.message}`
      );
    }
  } else if (contentLower === PAPER_RESET_COMMAND.toLowerCase()) {
    if (!PAPER_TRADING_ENABLED) {
      await message.channel.send(
        "❌ Paper trading is not enabled. Set `PAPER_TRADING_ENABLED=true` in your `.env` file."
      );
      return;
    }

    try {
      resetPaperTrading();
      await message.channel.send({
        embeds: [
          {
            title: "🔄 Paper Trading Reset",
            description: `Paper trading state has been reset to initial balance of $${PAPER_TRADING_INITIAL_BALANCE}.`,
            color: 0x00aa00,
            fields: [
              {
                name: "New Balance",
                value: `$${PAPER_TRADING_INITIAL_BALANCE.toFixed(2)}`,
                inline: true,
              },
              {
                name: "Positions",
                value: "0",
                inline: true,
              },
              {
                name: "Realized PnL",
                value: "$0.00",
                inline: true,
              },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      });

      logToFile("INFO", "Paper trading reset by user", {
        newBalance: PAPER_TRADING_INITIAL_BALANCE,
      });
    } catch (error) {
      logToFile("ERROR", "Paper trading reset failed", {
        error: error.message,
        stack: error.stack,
      });
      await message.channel.send(
        `❌ Error resetting paper trading: ${error.message}`
      );
    }
  } else if (contentLower.startsWith(PAPER_CLOSE_COMMAND.toLowerCase())) {
    if (!PAPER_TRADING_ENABLED) {
      await message.channel.send(
        "❌ Paper trading is not enabled. Set `PAPER_TRADING_ENABLED=true` in your `.env` file."
      );
      return;
    }

    const parts = content.split(/\s+/);
    if (parts.length < 2) {
      await message.channel.send(
        `Usage: ${PAPER_CLOSE_COMMAND} <tokenId> [win|loss]\n` +
          `Example: ${PAPER_CLOSE_COMMAND} 8938294144631453...\n` +
          `Example: ${PAPER_CLOSE_COMMAND} 8938294144631453... win\n` +
          `Example: ${PAPER_CLOSE_COMMAND} 8938294144631453... loss\n` +
          `You can use the shortened tokenId from !paperbalance\n` +
          `If market price can't be retrieved, specify "win" (settle at $1.00) or "loss" (settle at $0.00)`
      );
      return;
    }

    const identifier = parts[1];
    const outcomeOverride = parts[2]?.toLowerCase();

    try {
      const paperTradingState = getPaperTradingState();
      let positionEntry = null;
      let fullTokenId = null;

      if (paperTradingState.positions[identifier]) {
        positionEntry = [identifier, paperTradingState.positions[identifier]];
        fullTokenId = identifier;
      } else {
        for (const [tokenId, pos] of Object.entries(
          paperTradingState.positions
        )) {
          const shortTokenId =
            tokenId.length > 20
              ? tokenId.substring(0, 10) +
                "..." +
                tokenId.substring(tokenId.length - 6)
              : tokenId;

          if (
            tokenId.includes(identifier) ||
            shortTokenId.includes(identifier)
          ) {
            positionEntry = [tokenId, pos];
            fullTokenId = tokenId;
            break;
          }
        }
      }

      if (!positionEntry) {
        await message.channel.send(
          `❌ Position not found. Use \`${PAPER_BALANCE_COMMAND}\` to see your open positions.`
        );
        return;
      }

      const [tokenId, position] = positionEntry;

      let tokenIdToCheck = tokenId;

      if (position.conditionId && position.outcome) {
        logToFile("INFO", "Verifying tokenId for manual close", {
          storedTokenId: tokenId.substring(0, 10) + "...",
          conditionId: position.conditionId,
          outcome: position.outcome,
        });

        const correctTokenId = await getTokenIdForOutcome(
          position.conditionId,
          position.outcome
        );

        if (correctTokenId && correctTokenId !== tokenId) {
          logToFile(
            "WARN",
            "TokenId mismatch in manual close - using correct tokenId",
            {
              storedTokenId: tokenId.substring(0, 10) + "...",
              correctTokenId: correctTokenId.substring(0, 10) + "...",
              market: position.market,
              outcome: position.outcome,
            }
          );
          tokenIdToCheck = correctTokenId;
        } else if (correctTokenId === tokenId) {
          logToFile("INFO", "TokenId verified for manual close", {
            tokenId: tokenId.substring(0, 10) + "...",
            outcome: position.outcome,
          });
        } else if (!correctTokenId) {
          logToFile("WARN", "Could not verify tokenId - using stored tokenId", {
            tokenId: tokenId.substring(0, 10) + "...",
            conditionId: position.conditionId,
            outcome: position.outcome,
          });
        }
      } else {
        logToFile(
          "WARN",
          "Missing conditionId or outcome for tokenId verification",
          {
            tokenId: tokenId.substring(0, 10) + "...",
            hasConditionId: !!position.conditionId,
            hasOutcome: !!position.outcome,
          }
        );
      }

      let settlementPrice = null;
      let priceSource = "market";

      if (outcomeOverride === "win") {
        settlementPrice = 1.0;
        priceSource = "manual (win)";
        logToFile("INFO", "Using manual win settlement (override)", {
          tokenId: tokenId.substring(0, 10) + "...",
          market: position.market,
          outcome: position.outcome,
        });
      } else if (outcomeOverride === "loss") {
        settlementPrice = 0.0;
        priceSource = "manual (loss)";
        logToFile("INFO", "Using manual loss settlement (override)", {
          tokenId: tokenId.substring(0, 10) + "...",
          market: position.market,
          outcome: position.outcome,
        });
      } else {
        await message.channel.send(
          `🔍 Getting current market price for position...`
        );

        const priceResult = await getCurrentMarketPrice(
          tokenIdToCheck,
          orderbookWS,
          clobClient,
          clobClientReady
        );

        if (
          priceResult === null ||
          priceResult.price === undefined ||
          isNaN(priceResult.price)
        ) {
          await message.channel.send(
            `❌ Could not get current market price. The market may be closed or inactive.\n` +
              `💡 Tip: You can manually close as win or loss:\n` +
              `   ${PAPER_CLOSE_COMMAND} ${identifier} win  (settles at $1.00)\n` +
              `   ${PAPER_CLOSE_COMMAND} ${identifier} loss (settles at $0.00)`
          );
          return;
        } else {
          const currentPrice = priceResult.price;

          settlementPrice = currentPrice;
          priceSource = "market";
        }
      }
      const pnl = position.shares * (settlementPrice - position.avgPrice);
      const proceeds = position.shares * settlementPrice;

      const updatedState = getPaperTradingState();
      updatedState.balance += proceeds;
      updatedState.realizedPnL += pnl;

      updatedState.tradeHistory.push({
        timestamp: Date.now(),
        side: "MANUAL_CLOSE",
        tokenId,
        shares: position.shares,
        price: settlementPrice,
        value: proceeds,
        pnl: pnl,
        market: position.market,
      });

      delete updatedState.positions[tokenId];
      require("./services/paperTrading").setPaperTradingState(updatedState);

      await message.channel.send({
        embeds: [
          {
            title: "✅ Position Manually Closed",
            description: priceSource.includes("manual")
              ? `Position in "${position.market}" has been closed as ${
                  outcomeOverride === "win" ? "WIN" : "LOSS"
                }.`
              : `Position in "${position.market}" has been closed at current market price.`,
            color: pnl >= 0 ? 0x00aa00 : 0xaa0000,
            fields: [
              {
                name: "Shares",
                value: `${position.shares.toFixed(2)}`,
                inline: true,
              },
              {
                name: "Entry Price",
                value: `$${position.avgPrice.toFixed(4)}`,
                inline: true,
              },
              {
                name: "Close Price",
                value: `$${settlementPrice.toFixed(4)} (${(
                  settlementPrice * 100
                ).toFixed(2)}¢)\n*${priceSource}*`,
                inline: true,
              },
              {
                name: "Proceeds",
                value: `$${proceeds.toFixed(2)}`,
                inline: true,
              },
              {
                name: "PnL",
                value: `$${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
                inline: true,
              },
              {
                name: "New Balance",
                value: `$${updatedState.balance.toFixed(2)}`,
                inline: true,
              },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      });

      logToFile("INFO", "Paper position manually closed", {
        tokenId,
        market: position.market,
        shares: position.shares,
        entryPrice: position.avgPrice,
        closePrice: settlementPrice,
        pnl,
        proceeds,
      });
    } catch (error) {
      logToFile("ERROR", "Failed to close paper position", {
        error: error.message,
        stack: error.stack,
        identifier,
      });
      await message.channel.send(`❌ Error closing position: ${error.message}`);
    }
  }
});

client.on("error", (error) => {
  console.error("Discord client error:", error);
});

client.login(DISCORD_TOKEN);
