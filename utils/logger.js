const fs = require("fs");
const path = require("path");

function getLogFile() {
  const isTest =
    process.env.NODE_ENV === "test" ||
    process.env.npm_lifecycle_event === "test" ||
    process.argv.some((arg) => arg.includes("test"));

  const filename = isTest ? "bot.test.log" : "bot.production.log";
  return path.join(__dirname, "..", filename);
}

function logToFile(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    data,
  };
  const logLine = `[${timestamp}] [${level}] ${message}${
    data ? ` | Data: ${JSON.stringify(data)}` : ""
  }\n`;

  const logFile = getLogFile();

  try {
    fs.appendFileSync(logFile, logLine);
  } catch (error) {
    console.error("Failed to write to log file:", error.message);
  }

  if (level === "ERROR") {
    console.error(`[${level}] ${message}`, data || "");
  } else if (level === "WARN") {
    console.warn(`[${level}] ${message}`, data || "");
  } else {
    console.log(`[${level}] ${message}`, data || "");
  }
}

function getWebSocketLogFile() {
  const isTest =
    process.env.NODE_ENV === "test" ||
    process.env.npm_lifecycle_event === "test" ||
    process.argv.some((arg) => arg.includes("test"));

  const filename = isTest ? "websocket.test.log" : "websocket.production.log";
  return path.join(__dirname, "..", filename);
}

function logWebSocketToFile(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] ${message}${
    data ? ` | Data: ${JSON.stringify(data)}` : ""
  }\n`;

  const wsLogFile = getWebSocketLogFile();

  try {
    fs.appendFileSync(wsLogFile, logLine);
  } catch (error) {
    console.error("Failed to write to WebSocket log file:", error.message);
  }

  if (level === "ERROR") {
    console.error(`[WS] [${level}] ${message}`, data || "");
  } else if (level === "WARN") {
    console.warn(`[WS] [${level}] ${message}`, data || "");
  } else {
    console.log(`[WS] [${level}] ${message}`, data || "");
  }
}

function getTradeLogFile() {
  const isTest =
    process.env.NODE_ENV === "test" ||
    process.env.npm_lifecycle_event === "test" ||
    process.argv.some((arg) => arg.includes("test"));

  const filename = isTest ? "trades.test.log" : "trades.production.log";
  return path.join(__dirname, "..", filename);
}

function logTradeToFile(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] ${message}${
    data ? ` | Data: ${JSON.stringify(data)}` : ""
  }\n`;

  const tradeLogFile = getTradeLogFile();

  try {
    fs.appendFileSync(tradeLogFile, logLine);
  } catch (error) {
    console.error("Failed to write to trade log file:", error.message);
  }

  if (level === "ERROR") {
    console.error(`[TRADE] [${level}] ${message}`, data || "");
  } else if (level === "WARN") {
    console.warn(`[TRADE] [${level}] ${message}`, data || "");
  } else {
    console.log(`[TRADE] [${level}] ${message}`, data || "");
  }
}

try {
  const logFile = getLogFile();
  const wsLogFile = getWebSocketLogFile();
  const tradeLogFile = getTradeLogFile();

  if (fs.existsSync(logFile)) {
    fs.writeFileSync(logFile, "");
  }
  if (fs.existsSync(wsLogFile)) {
    fs.writeFileSync(wsLogFile, "");
  }
  if (fs.existsSync(tradeLogFile)) {
    fs.writeFileSync(tradeLogFile, "");
  }
} catch (error) {
  console.error("Failed to clear log files:", error.message);
}

module.exports = { logToFile, logWebSocketToFile, logTradeToFile };
