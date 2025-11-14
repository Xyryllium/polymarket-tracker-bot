require("dotenv").config();

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const fetch = require("node-fetch");

const WALLET = "0x0f37cb80dee49d55b5f6d9e595d52591d6371410";
const API_URL = `https://data-api.polymarket.com/activity?user=${WALLET}&limit=25&offset=0`;

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 15000);
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const COMMAND_PREFIX = process.env.COMMAND_PREFIX ?? "!";
const START_COMMAND = `${COMMAND_PREFIX}start`;
const STOP_COMMAND = `${COMMAND_PREFIX}stop`;
const ALERT_ROLE_ID = process.env.ALERT_ROLE_ID;

if (!DISCORD_TOKEN) {
  throw new Error("Missing DISCORD_TOKEN in environment variables.");
}

if (!Number.isFinite(POLL_INTERVAL_MS) || POLL_INTERVAL_MS < 5000) {
  throw new Error("POLL_INTERVAL_MS must be a number >= 5000.");
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
let isPolling = false;
let pollTimeout = null;
let activeChannel = null;

async function fetchLatestActivity() {
  const response = await fetch(API_URL, {
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

    const activities = await fetchLatestActivity();

    const buyTrades = activities.filter(
      (item) =>
        item?.type === "TRADE" &&
        String(item?.side).toUpperCase() === "BUY" &&
        item?.transactionHash
    );

    if (!isInitialized) {
      buyTrades.forEach((trade) => seenHashes.add(trade.transactionHash));
      isInitialized = true;
      return;
    }

    const newTrades = buyTrades.filter(
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
      } = trade;

      const time = new Date(timestamp * 1000).toISOString();
      const mention = ALERT_ROLE_ID ? `<@&${ALERT_ROLE_ID}> ` : "";
      const message = [
        `**New Polymarket BUY**`,
        `Market: ${title ?? slug ?? "Unknown market"}`,
        `Outcome: ${outcome ?? "Unknown"} @ ${price ?? "N/A"}`,
        `Size: ${size ?? "?"} shares (~${usdcSize ?? "?"} USDC)`,
        `When: ${time}`,
        `Tx: https://polygonscan.com/tx/${transactionHash}`,
        eventSlug
          ? `Market page: https://polymarket.com/market/${eventSlug}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");

      try {
        await activeChannel.send({ content: `${mention}${message}` });
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

async function startPolling(channel) {
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

  activeChannel = channel;
  isPolling = true;
  isInitialized = false;

  await channel.send(
    `Starting Polymarket monitoring with interval ${POLL_INTERVAL_MS / 1000}s.`
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

  const content = message.content.trim().toLowerCase();

  if (content === START_COMMAND.toLowerCase()) {
    await startPolling(message.channel);
  } else if (content === STOP_COMMAND.toLowerCase()) {
    await stopPolling(message.channel);
  }
});

client.on("error", (error) => {
  console.error("Discord client error:", error);
});

client.login(DISCORD_TOKEN);
