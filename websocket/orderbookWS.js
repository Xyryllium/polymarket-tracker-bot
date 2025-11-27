const WebSocket = require("ws");
const { EventEmitter } = require("events");
const { logToFile } = require("../utils/logger");

class OrderbookWebSocketManager extends EventEmitter {
  constructor(apiKey, apiSecret, apiPassphrase) {
    super();
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.apiPassphrase = apiPassphrase;
    this.ws = null;
    this.orderbooks = new Map();
    this.lastTradePrices = new Map();
    this.subscribedAssets = new Set();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.pingInterval = null;
    this.isConnected = false;
    this.stopLossCallback = null;
  }

  connect() {
    if (this.ws && this.isConnected) {
      return;
    }

    const url = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      const wasReconnecting = this.reconnectAttempts > 0;
      this.isConnected = true;
      this.reconnectAttempts = 0;
      if (!wasReconnecting) {
        logToFile("INFO", "WebSocket connected successfully", {
          url: url,
          subscribedAssets: this.subscribedAssets.size,
        });
      }
      this.emit("connected");

      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          try {
            this.ws.send("PING");
          } catch (error) {
            logToFile("WARN", "Failed to send PING", { error: error.message });
          }
        }
      }, 10000);

      setTimeout(() => {
        this.resubscribeAll();
      }, 1000);
    });

    this.ws.on("message", (data) => {
      try {
        const message = data.toString();
        if (message === "PONG" || message.trim() === "PONG") {
          return;
        }

        const parsed = JSON.parse(message);

        if (
          parsed.asset_id &&
          (parsed.bids !== undefined || parsed.asks !== undefined)
        ) {
          this.orderbooks.set(parsed.asset_id, {
            asks: parsed.asks || [],
            bids: parsed.bids || [],
            timestamp: Date.now(),
          });
        } else if (
          parsed.event_type === "last_trade_price" &&
          parsed.asset_id &&
          parsed.price
        ) {
          const price = parseFloat(parsed.price);
          if (!isNaN(price) && price >= 0 && price <= 1) {
            this.lastTradePrices.set(parsed.asset_id, {
              price,
              side: parsed.side || "UNKNOWN",
              size: parseFloat(parsed.size || 0),
              timestamp: parseInt(parsed.timestamp || Date.now()),
            });

            if (
              this.stopLossCallback &&
              typeof this.stopLossCallback === "function"
            ) {
              try {
                this.stopLossCallback(
                  parsed.asset_id,
                  price,
                  parsed.side || "UNKNOWN"
                );
              } catch (error) {
                logToFile("ERROR", "Error in stop-loss callback", {
                  assetId: parsed.asset_id.substring(0, 10) + "...",
                  error: error.message,
                  stack: error.stack,
                });
              }
            }
          }
        } else if (
          parsed.event_type === "price_change" &&
          parsed.price_changes
        ) {
          for (const change of parsed.price_changes) {
            if (change.asset_id && change.best_bid) {
              const bestBid = parseFloat(change.best_bid);
              if (!isNaN(bestBid) && bestBid >= 0 && bestBid <= 1) {
                this.lastTradePrices.set(change.asset_id, {
                  price: bestBid,
                  side: "BID",
                  timestamp: parseInt(parsed.timestamp || Date.now()),
                });
              }
            }
          }
        } else if (parsed.type === "error" || parsed.event_type === "error") {
          logToFile("WARN", "WebSocket error message", { error: parsed });
        }
      } catch (error) {
        const message = data.toString();
        if (message !== "PONG" && message.trim() !== "PONG") {
          logToFile("WARN", "Failed to parse websocket message", {
            error: error.message,
            messagePreview: message.substring(0, 100),
          });
        }
      }
    });

    this.ws.on("error", (error) => {
      logToFile("WARN", "WebSocket error", {
        error: error.message,
        stack: error.stack,
        url: url,
      });
    });

    this.ws.on("close", (code, reason) => {
      this.isConnected = false;
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }

      if (code !== 1006 && code !== 1000) {
        logToFile("WARN", "WebSocket closed unexpectedly", {
          code,
          reason: reason?.toString(),
          reconnectAttempts: this.reconnectAttempts,
          subscribedAssets: this.subscribedAssets.size,
        });
      }

      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = Math.min(
          1000 * Math.pow(2, this.reconnectAttempts),
          30000
        );
        if (this.reconnectAttempts > 2) {
          logToFile("INFO", "Attempting WebSocket reconnection", {
            attempt: this.reconnectAttempts,
            maxAttempts: this.maxReconnectAttempts,
            delayMs: delay,
          });
        }
        setTimeout(() => this.connect(), delay);
      } else {
        logToFile("ERROR", "WebSocket max reconnection attempts reached", {
          maxAttempts: this.maxReconnectAttempts,
          subscribedAssets: this.subscribedAssets.size,
        });
      }
    });
  }

  subscribe(assetId) {
    if (this.subscribedAssets.has(assetId)) {
      return;
    }

    this.subscribedAssets.add(assetId);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        const subscribeMessage = {
          assets_ids: [assetId],
          type: "market",
        };
        this.ws.send(JSON.stringify(subscribeMessage));
        logToFile("INFO", "Subscribed to asset on WebSocket", {
          assetId: assetId.substring(0, 10) + "...",
          totalSubscribed: this.subscribedAssets.size,
        });
      } catch (error) {
        logToFile("WARN", "Failed to send subscription message", {
          assetId: assetId.substring(0, 10) + "...",
          error: error.message,
        });
      }
    }
  }

  resubscribeAll() {
    if (
      this.subscribedAssets.size > 0 &&
      this.ws &&
      this.ws.readyState === WebSocket.OPEN
    ) {
      const subscribeMessage = {
        assets_ids: Array.from(this.subscribedAssets),
        type: "market",
      };
      this.ws.send(JSON.stringify(subscribeMessage));
      if (this.subscribedAssets.size > 0) {
        logToFile("INFO", "Resubscribed to all assets on WebSocket", {
          assetCount: this.subscribedAssets.size,
        });
      }
    }
  }

  getOrderbook(assetId) {
    return this.orderbooks.get(assetId) || null;
  }

  getLastTradePrice(assetId) {
    return this.lastTradePrices.get(assetId) || null;
  }

  unsubscribe(assetId) {
    if (!this.subscribedAssets.has(assetId)) {
      return;
    }

    this.subscribedAssets.delete(assetId);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        const unsubscribeMessage = {
          assets_ids: [assetId],
          type: "market",
          unsubscribe: true,
        };
        this.ws.send(JSON.stringify(unsubscribeMessage));
        logToFile("INFO", "Unsubscribed from asset on WebSocket", {
          assetId: assetId.substring(0, 10) + "...",
          totalSubscribed: this.subscribedAssets.size,
        });
      } catch (error) {
        logToFile("WARN", "Failed to send unsubscribe message", {
          assetId: assetId.substring(0, 10) + "...",
          error: error.message,
        });
      }
    }
  }

  getSubscribedAssets() {
    return Array.from(this.subscribedAssets);
  }

  setStopLossCallback(callback) {
    this.stopLossCallback = callback;
  }

  disconnect() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }
}

module.exports = OrderbookWebSocketManager;
