const { Side, OrderType } = require("@polymarket/clob-client");
const { Contract } = require("@ethersproject/contracts");
const {
  MAX_CLOUDFLARE_RETRIES,
  CLOUDFLARE_RETRY_DELAY_MS,
  MAX_ORDER_VALUE_USD,
  POLYMARKET_FUNDER,
  CLOB_EXCHANGE_ADDRESS,
} = require("../config");
const { logToFile, logTradeToFile } = require("../utils/logger");
const { isCloudflareBlock } = require("../utils/helpers");

let orderNonce = 0;

function setOrderNonce(nonce) {
  orderNonce = nonce;
}

function getOrderNonce() {
  return orderNonce;
}

function incrementOrderNonce() {
  orderNonce = orderNonce + 1;
  return orderNonce;
}

async function placeBuyOrder(
  tokenId,
  price,
  size,
  orderType,
  clobClient,
  clobClientReady
) {
  if (!clobClient || !clobClientReady) {
    const error =
      "CLOB client not initialized or API credentials not set. Please wait for initialization to complete.";
    logToFile("ERROR", "placeBuyOrder failed", { error, tokenId, price, size });
    throw new Error(error);
  }

  try {
    let response;
    let lastError = null;
    let order = null;

    for (let attempt = 1; attempt <= MAX_CLOUDFLARE_RETRIES; attempt++) {
      try {
        if (attempt > 1) {
          const delay = CLOUDFLARE_RETRY_DELAY_MS * attempt;
          logToFile(
            "INFO",
            `Retrying buy order (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              delayMs: delay,
              tokenId,
            }
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        order = await clobClient.createOrder({
          tokenID: tokenId,
          price: price,
          side: Side.BUY,
          size: size,
          feeRateBps: 0,
          nonce: orderNonce,
        });

        response = await clobClient.postOrder(order, orderType);

        if (
          response &&
          response.error &&
          response.error.includes("invalid nonce")
        ) {
          logToFile(
            "WARN",
            `Invalid nonce in response, will retry with fresh nonce (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              tokenId,
              failedNonce: orderNonce,
              attempt,
            }
          );
          if (attempt < MAX_CLOUDFLARE_RETRIES) {
            order = await clobClient.createOrder({
              tokenID: tokenId,
              price: price,
              side: Side.BUY,
              size: size,
              feeRateBps: 0,
              nonce: orderNonce,
            });
            continue;
          } else {
            throw new Error(
              `Invalid nonce after ${MAX_CLOUDFLARE_RETRIES} attempts. The API may be rejecting all nonces. Please check your API credentials or contact Polymarket support.`
            );
          }
        }

        if (response && response.error) {
          throw new Error(response.error);
        }

        break;
      } catch (postError) {
        lastError = postError;
        const errorMsg = postError?.message || String(postError);
        const responseError =
          postError?.response?.error || postError?.error || errorMsg;

        if (
          responseError &&
          (responseError.includes("invalid nonce") ||
            errorMsg.includes("invalid nonce"))
        ) {
          logToFile(
            "WARN",
            `Invalid nonce detected, incrementing nonce (attempt ${attempt})`,
            {
              tokenId,
              failedNonce: orderNonce,
              attempt,
            }
          );
          if (attempt < MAX_CLOUDFLARE_RETRIES) {
            order = await clobClient.createOrder({
              tokenID: tokenId,
              price: price,
              side: Side.BUY,
              size: size,
              feeRateBps: 0,
              nonce: orderNonce,
            });
            continue;
          } else {
            throw new Error(
              `Invalid nonce after ${MAX_CLOUDFLARE_RETRIES} attempts. Please restart the bot.`
            );
          }
        }

        if (
          postError &&
          postError.message &&
          isCloudflareBlock(postError.message)
        ) {
          logToFile(
            "WARN",
            `Cloudflare block detected (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              tokenId,
              price,
              size,
              attempt,
              errorMessage: postError.message.substring(0, 200),
            }
          );

          if (attempt === MAX_CLOUDFLARE_RETRIES) {
            const errorMsg =
              "Cloudflare is blocking CLOB API requests. Your server IP may be flagged. The Data API works, but order placement is blocked. Please contact Polymarket support or try from a different network.";
            logToFile("ERROR", "Cloudflare block - max retries reached", {
              tokenId,
              price,
              size,
            });
            throw new Error(errorMsg);
          }
          continue;
        }
        throw postError;
      }
    }

    if (!response && lastError) {
      throw lastError;
    }

    if (isCloudflareBlock(response)) {
      const errorMsg =
        "Cloudflare is blocking requests. Your server IP may be flagged. Please try again later or contact Polymarket support.";
      logToFile("ERROR", "Cloudflare block detected (from response)", {
        tokenId,
        price,
        size,
        responseType: typeof response,
        responsePreview:
          typeof response === "string"
            ? response.substring(0, 200)
            : JSON.stringify(response).substring(0, 200),
      });
      throw new Error(errorMsg);
    }

    return response;
  } catch (error) {
    if (error.message && error.message.includes("Cloudflare")) {
      throw error;
    }
    if (error.message && isCloudflareBlock(error.message)) {
      const errorMsg =
        "Cloudflare is blocking requests. Your server IP may be flagged. Please try again later or contact Polymarket support.";
      logToFile("ERROR", "Cloudflare block detected (from catch)", {
        tokenId,
        price,
        size,
        errorMessage: error.message.substring(0, 200),
      });
      throw new Error(errorMsg);
    }
    logToFile("ERROR", "Failed to place buy order", {
      error: error.message,
      stack: error.stack,
      tokenId,
      price,
      size,
    });
    throw new Error(`Failed to place buy order: ${error.message}`);
  }
}

async function placeSellOrder(
  tokenId,
  price,
  size,
  orderType,
  clobClient,
  clobClientReady
) {
  if (!clobClient || !clobClientReady) {
    const error =
      "CLOB client not initialized or API credentials not set. Please wait for initialization to complete.";
    logToFile("ERROR", "placeSellOrder failed", {
      error,
      tokenId,
      price,
      size,
    });
    throw new Error(error);
  }

  try {
    let response;
    let lastError = null;
    let order = null;

    for (let attempt = 1; attempt <= MAX_CLOUDFLARE_RETRIES; attempt++) {
      try {
        if (attempt > 1) {
          const delay = CLOUDFLARE_RETRY_DELAY_MS * attempt;
          logToFile(
            "INFO",
            `Retrying sell order (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              delayMs: delay,
              tokenId: tokenId.substring(0, 10) + "...",
            }
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        order = await clobClient.createOrder({
          tokenID: tokenId,
          price: price,
          side: Side.SELL,
          size: size,
          feeRateBps: 0,
          nonce: 0,
        });

        try {
          response = await clobClient.postOrder(order, orderType);
        } catch (postError) {
          if (
            postError &&
            postError.message &&
            isCloudflareBlock(postError.message)
          ) {
            const errorMsg =
              "Cloudflare is blocking requests. Your server IP may be flagged. Please try again later or contact Polymarket support.";
            logToFile("ERROR", "Cloudflare block detected (from error)", {
              tokenId,
              price,
              size,
              errorMessage: postError.message.substring(0, 200),
            });
            throw new Error(errorMsg);
          }
          throw postError;
        }

        if (isCloudflareBlock(response)) {
          const errorMsg =
            "Cloudflare is blocking requests. Your server IP may be flagged. Please try again later or contact Polymarket support.";
          logToFile("ERROR", "Cloudflare block detected (from response)", {
            tokenId,
            price,
            size,
            responseType: typeof response,
            responsePreview:
              typeof response === "string"
                ? response.substring(0, 200)
                : JSON.stringify(response).substring(0, 200),
          });
          throw new Error(errorMsg);
        }

        if (
          response &&
          response.error &&
          response.error.includes("invalid nonce")
        ) {
          logToFile(
            "WARN",
            `Invalid nonce in response, will retry (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              tokenId: tokenId.substring(0, 10) + "...",
              attempt,
            }
          );
          if (attempt < MAX_CLOUDFLARE_RETRIES) {
            order = await clobClient.createOrder({
              tokenID: tokenId,
              price: price,
              side: Side.SELL,
              size: size,
              feeRateBps: 0,
              nonce: 0,
            });
            continue;
          } else {
            throw new Error(
              `Invalid nonce after ${MAX_CLOUDFLARE_RETRIES} attempts. The API may be rejecting all nonces. Please check your API credentials or contact Polymarket support.`
            );
          }
        }

        return response;
      } catch (error) {
        lastError = error;
        const errorMsg = error.message || String(error);
        const responseError =
          error.response?.data?.error || error.response?.data?.message || "";

        if (
          responseError.includes("invalid nonce") ||
          errorMsg.includes("invalid nonce")
        ) {
          logToFile(
            "WARN",
            `Invalid nonce detected, retrying (attempt ${attempt})`,
            {
              tokenId: tokenId.substring(0, 10) + "...",
              attempt,
            }
          );
          if (attempt < MAX_CLOUDFLARE_RETRIES) {
            order = await clobClient.createOrder({
              tokenID: tokenId,
              price: price,
              side: Side.SELL,
              size: size,
              feeRateBps: 0,
              nonce: 0,
            });
            continue;
          } else {
            throw new Error(
              `Invalid nonce after ${MAX_CLOUDFLARE_RETRIES} attempts. Please restart the bot.`
            );
          }
        }

        if (error.message && error.message.includes("Cloudflare")) {
          throw error;
        }
        if (error.message && isCloudflareBlock(error.message)) {
          const errorMsg =
            "Cloudflare is blocking requests. Your server IP may be flagged. Please try again later or contact Polymarket support.";
          logToFile("ERROR", "Cloudflare block detected (from catch)", {
            tokenId,
            price,
            size,
            errorMessage: error.message.substring(0, 200),
          });
          throw new Error(errorMsg);
        }

        if (attempt < MAX_CLOUDFLARE_RETRIES) {
          continue;
        }

        throw error;
      }
    }

    if (lastError) {
      if (
        lastError.message &&
        (lastError.message.includes("invalid nonce") ||
          String(lastError).includes("invalid nonce"))
      ) {
        throw new Error(
          `Invalid nonce after ${MAX_CLOUDFLARE_RETRIES} attempts. The API may be rejecting all nonces. Please check your API credentials or contact Polymarket support.`
        );
      }
      throw lastError;
    }

    throw new Error("Failed to place sell order after all retries");
  } catch (error) {
    if (error.message && error.message.includes("Cloudflare")) {
      throw error;
    }
    if (error.message && isCloudflareBlock(error.message)) {
      const errorMsg =
        "Cloudflare is blocking requests. Your server IP may be flagged. Please try again later or contact Polymarket support.";
      logToFile("ERROR", "Cloudflare block detected (from catch)", {
        tokenId,
        price,
        size,
        errorMessage: error.message.substring(0, 200),
      });
      throw new Error(errorMsg);
    }
    logToFile("ERROR", "Failed to place sell order", {
      error: error.message,
      stack: error.stack,
      tokenId,
      price,
      size,
    });
    throw new Error(`Failed to place sell order: ${error.message}`);
  }
}

async function placeMarketBuyOrder(
  tokenId,
  amount,
  estimatedPrice,
  clobClient,
  clobClientReady,
  orderbookWS
) {
  if (!clobClient || !clobClientReady) {
    const error =
      "CLOB client not initialized or API credentials not set. Please wait for initialization to complete.";
    logToFile("ERROR", "placeMarketBuyOrder failed", {
      error,
      tokenId,
      amount,
      estimatedPrice,
    });
    throw new Error(error);
  }

  try {
    const MIN_ORDER_VALUE_USD = 1;

    let orderAmount = Math.max(amount, MIN_ORDER_VALUE_USD);
    orderAmount = Math.min(orderAmount, MAX_ORDER_VALUE_USD);
    orderAmount = parseFloat(orderAmount.toFixed(2));

    let marketPrice = estimatedPrice
      ? parseFloat(estimatedPrice.toFixed(2))
      : undefined;

    let response;
    let lastError = null;
    let order = null;
    const LIQUIDITY_BUFFER = 1.3;
    let priceIndex = 0;

    for (let attempt = 1; attempt <= MAX_CLOUDFLARE_RETRIES; attempt++) {
      try {
        if (attempt > 1) {
          const delay = CLOUDFLARE_RETRY_DELAY_MS * attempt;
          logToFile(
            "INFO",
            `Retrying market buy order (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              delayMs: delay,
              tokenId,
              priceIndex,
            }
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        let currentOrderAmount = orderAmount;
        let currentMarketPrice = marketPrice;

        let orderBook = null;
        let orderBookSource = "REST";

        try {
          if (orderbookWS && orderbookWS.isConnected) {
            orderbookWS.subscribe(tokenId);
            const wsOrderbook = orderbookWS.getOrderbook(tokenId);
            if (wsOrderbook && Date.now() - wsOrderbook.timestamp < 5000) {
              orderBook = {
                asks: wsOrderbook.asks,
                bids: wsOrderbook.bids,
              };
              orderBookSource = "WebSocket";
            }
          }

          if (!orderBook) {
            orderBook = await clobClient.getOrderBook(tokenId);
            orderBookSource = "REST";
          }

          if (!orderBook.asks || orderBook.asks.length === 0) {
            logToFile("WARN", "No asks found in orderbook, skipping order", {
              tokenId,
              currentOrderAmount,
              attempt,
            });
            throw new Error(
              "No asks found in orderbook. Cannot place market buy order."
            );
          }

          const sortedAsks = orderBook.asks
            .map((ask) => ({
              price: parseFloat(ask.price),
              size: parseFloat(ask.size),
            }))
            .sort((a, b) => a.price - b.price);

          if (priceIndex >= sortedAsks.length) {
            logToFile("WARN", "No more prices to try in orderbook", {
              tokenId,
              priceIndex,
              totalAsks: sortedAsks.length,
              attempt,
            });
            throw new Error(
              "Exhausted all available prices in orderbook. Cannot place order."
            );
          }

          const selectedPrice = sortedAsks[priceIndex].price;
          let cumulativeLiquidity = 0;
          let asksChecked = 0;

          for (let i = priceIndex; i < sortedAsks.length; i++) {
            const ask = sortedAsks[i];
            const askLiquidity = ask.size * ask.price;
            cumulativeLiquidity += askLiquidity;
            asksChecked++;
            if (cumulativeLiquidity >= currentOrderAmount * LIQUIDITY_BUFFER) {
              break;
            }
          }

          const requiredLiquidity = currentOrderAmount * LIQUIDITY_BUFFER;

          if (cumulativeLiquidity < MIN_ORDER_VALUE_USD) {
            logToFile(
              "WARN",
              "Insufficient cumulative liquidity for minimum order",
              {
                tokenId,
                cumulativeLiquidity,
                minRequired: MIN_ORDER_VALUE_USD,
                attempt,
                priceIndex,
              }
            );
            if (priceIndex < sortedAsks.length - 1) {
              priceIndex++;
              continue;
            }
            throw new Error(
              `Insufficient liquidity: ${cumulativeLiquidity.toFixed(
                2
              )} available, minimum ${MIN_ORDER_VALUE_USD} required`
            );
          }

          if (cumulativeLiquidity < requiredLiquidity) {
            logToFile(
              "WARN",
              "Insufficient liquidity buffer, adjusting order amount",
              {
                tokenId,
                requestedAmount: currentOrderAmount,
                cumulativeLiquidity,
                requiredLiquidity,
                adjustedAmount: cumulativeLiquidity / LIQUIDITY_BUFFER,
                attempt,
                priceIndex,
              }
            );
            currentOrderAmount = Math.max(
              MIN_ORDER_VALUE_USD,
              Math.min(
                cumulativeLiquidity / LIQUIDITY_BUFFER,
                MAX_ORDER_VALUE_USD
              )
            );
            currentOrderAmount = parseFloat(currentOrderAmount.toFixed(2));
          }

          currentMarketPrice = selectedPrice;
        } catch (orderBookError) {
          if (
            orderBookError.message &&
            (orderBookError.message.includes("No asks") ||
              orderBookError.message.includes("Insufficient liquidity") ||
              orderBookError.message.includes("Exhausted all available prices"))
          ) {
            throw orderBookError;
          }
          logToFile(
            "WARN",
            "Failed to fetch orderbook, proceeding with order",
            {
              tokenId,
              error: orderBookError.message,
              attempt,
            }
          );
        }

        const orderParams = {
          tokenID: tokenId,
          amount: currentOrderAmount,
          side: Side.BUY,
        };
        if (currentMarketPrice) {
          orderParams.price = currentMarketPrice;
        }

        order = await clobClient.createMarketOrder(orderParams);

        response = await clobClient.postOrder(order, OrderType.FOK);

        if (
          response &&
          response.error &&
          (response.error.includes("order couldn't be fully filled") ||
            response.error.includes("FOK orders are fully filled or killed"))
        ) {
          if (attempt < MAX_CLOUDFLARE_RETRIES) {
            logToFile(
              "WARN",
              "Order couldn't be filled at current price, trying next price",
              {
                tokenId,
                currentPrice: currentMarketPrice,
                currentAmount: currentOrderAmount,
                attempt,
                priceIndex,
              }
            );
            priceIndex++;
            continue;
          } else {
            throw new Error(
              `Order couldn't be fully filled after trying ${
                priceIndex + 1
              } price levels. Market may have insufficient liquidity.`
            );
          }
        }

        if (
          response &&
          response.error &&
          response.error.includes("invalid nonce")
        ) {
          logToFile(
            "WARN",
            `Invalid nonce in response, will retry with fresh nonce (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              tokenId,
              failedNonce: orderNonce,
              attempt,
            }
          );
          if (attempt < MAX_CLOUDFLARE_RETRIES) {
            const orderParams = {
              tokenID: tokenId,
              amount: currentOrderAmount,
              side: Side.BUY,
            };
            if (currentMarketPrice) {
              orderParams.price = currentMarketPrice;
            }
            order = await clobClient.createMarketOrder(orderParams);
            response = await clobClient.postOrder(order, OrderType.FOK);
            if (
              response &&
              response.error &&
              response.error.includes("invalid nonce")
            ) {
              continue;
            }
            if (response && response.error) {
              throw new Error(response.error);
            }
            break;
          } else {
            throw new Error(
              `Invalid nonce after ${MAX_CLOUDFLARE_RETRIES} attempts. The API may be rejecting all nonces. Please check your API credentials or contact Polymarket support.`
            );
          }
        }

        if (response && response.error) {
          throw new Error(response.error);
        }

        break;
      } catch (postError) {
        lastError = postError;
        const errorMsg = postError?.message || String(postError);
        const responseError =
          postError?.response?.error || postError?.error || errorMsg;

        if (
          responseError &&
          (responseError.includes("order couldn't be fully filled") ||
            responseError.includes("FOK orders are fully filled or killed") ||
            errorMsg.includes("order couldn't be fully filled") ||
            errorMsg.includes("FOK orders are fully filled or killed"))
        ) {
          if (attempt < MAX_CLOUDFLARE_RETRIES) {
            logToFile(
              "WARN",
              "Order couldn't be filled at current price (from exception), trying next price",
              {
                tokenId,
                currentPrice: currentMarketPrice,
                currentAmount: currentOrderAmount,
                attempt,
                priceIndex,
              }
            );
            priceIndex++;
            continue;
          } else {
            throw new Error(
              `Order couldn't be fully filled after trying ${
                priceIndex + 1
              } price levels. Market may have insufficient liquidity.`
            );
          }
        }

        if (
          responseError &&
          (responseError.includes("invalid nonce") ||
            errorMsg.includes("invalid nonce"))
        ) {
          logToFile(
            "WARN",
            `Invalid nonce detected in exception, incrementing nonce (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              tokenId,
              failedNonce: orderNonce,
              attempt,
            }
          );
          if (attempt < MAX_CLOUDFLARE_RETRIES) {
            const orderParams = {
              tokenID: tokenId,
              amount: currentOrderAmount,
              side: Side.BUY,
            };
            if (currentMarketPrice) {
              orderParams.price = currentMarketPrice;
            }
            order = await clobClient.createMarketOrder(orderParams);
            continue;
          } else {
            throw new Error(
              `Invalid nonce after ${MAX_CLOUDFLARE_RETRIES} attempts. The API may be rejecting all nonces. Please check your API credentials or contact Polymarket support.`
            );
          }
        }

        if (
          postError &&
          postError.message &&
          isCloudflareBlock(postError.message)
        ) {
          logToFile(
            "WARN",
            `Cloudflare block detected (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              tokenId,
              amount: orderAmount,
              attempt,
              errorMessage: postError.message.substring(0, 200),
            }
          );

          if (attempt === MAX_CLOUDFLARE_RETRIES) {
            const errorMsg =
              "Cloudflare is blocking CLOB API requests. Your server IP may be flagged. The Data API works, but order placement is blocked. Please contact Polymarket support or try from a different network.";
            logToFile("ERROR", "Cloudflare block - max retries reached", {
              tokenId,
              amount: orderAmount,
            });
            throw new Error(errorMsg);
          }
          continue;
        }
        throw postError;
      }
    }

    if (!response && lastError) {
      throw lastError;
    }

    if (isCloudflareBlock(response)) {
      const errorMsg =
        "Cloudflare is blocking requests. Your server IP may be flagged. Please try again later or contact Polymarket support.";
      logToFile("ERROR", "Cloudflare block detected (from response)", {
        tokenId,
        amount: orderAmount,
        responseType: typeof response,
        responsePreview:
          typeof response === "string"
            ? response.substring(0, 200)
            : JSON.stringify(response).substring(0, 200),
      });
      throw new Error(errorMsg);
    }

    return response;
  } catch (error) {
    if (error.message && error.message.includes("Cloudflare")) {
      throw error;
    }
    if (error.message && isCloudflareBlock(error.message)) {
      const errorMsg =
        "Cloudflare is blocking requests. Your server IP may be flagged. Please try again later or contact Polymarket support.";
      logToFile("ERROR", "Cloudflare block detected (from catch)", {
        tokenId,
        amount,
        errorMessage: error.message.substring(0, 200),
      });
      throw new Error(errorMsg);
    }
    logToFile("ERROR", "Failed to place market buy order", {
      error: error.message,
      stack: error.stack,
      tokenId,
      amount,
      estimatedPrice,
    });
    throw new Error(`Failed to place market buy order: ${error.message}`);
  }
}

async function placeMarketSellOrder(
  tokenId,
  amount,
  price,
  clobClient,
  clobClientReady,
  orderbookWS,
  provider,
  signer
) {
  if (!clobClient || !clobClientReady) {
    const error =
      "CLOB client not initialized or API credentials not set. Please wait for initialization to complete.";
    logToFile("ERROR", "placeMarketSellOrder failed", {
      error,
      tokenId,
      amount,
      price,
    });
    throw new Error(error);
  }

  try {
    const MIN_ORDER_VALUE_USD = 1;
    let orderSize = amount;
    let marketPrice = price ? parseFloat(price.toFixed(2)) : undefined;

    if (provider && signer) {
      try {
        let walletAddress = POLYMARKET_FUNDER;
        if (!walletAddress) {
          walletAddress = signer.address || (await signer.getAddress());
        }

        const tokenContract = new Contract(
          tokenId,
          [
            "function balanceOf(address owner) view returns (uint256)",
            "function allowance(address owner, address spender) view returns (uint256)",
            "function approve(address spender, uint256 amount) returns (bool)",
          ],
          signer
        );

        const tokenBalance = await tokenContract.balanceOf(walletAddress);
        const tokenBalanceFormatted = parseFloat(
          (Number(tokenBalance) / 1e18).toFixed(4)
        );

        if (tokenBalanceFormatted < orderSize) {
          logToFile(
            "WARN",
            "Insufficient token balance for sell order, skipping",
            {
              tokenId,
              tokenBalance: tokenBalanceFormatted,
              requestedSize: orderSize,
              shortfall: orderSize - tokenBalanceFormatted,
            }
          );
          throw new Error(
            `Insufficient token balance: You have ${tokenBalanceFormatted} tokens, but need ${orderSize} to sell. You must own the tokens before you can sell them.`
          );
        }

        if (CLOB_EXCHANGE_ADDRESS) {
          const currentAllowance = await tokenContract.allowance(
            walletAddress,
            CLOB_EXCHANGE_ADDRESS
          );
          const allowanceFormatted = parseFloat(
            (Number(currentAllowance) / 1e18).toFixed(4)
          );
          const orderSizeWei = BigInt(Math.floor(orderSize * 1e18));

          if (currentAllowance < orderSizeWei) {
            logToFile(
              "INFO",
              "Setting allowance for conditional token to Exchange",
              {
                tokenId: tokenId.substring(0, 10) + "...",
                currentAllowance: allowanceFormatted,
                requiredAmount: orderSize,
                exchangeAddress: CLOB_EXCHANGE_ADDRESS,
              }
            );

            const maxAllowance = BigInt(
              "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
            );
            const approveTx = await tokenContract.approve(
              CLOB_EXCHANGE_ADDRESS,
              maxAllowance
            );
            logToFile(
              "INFO",
              "Approval transaction sent, waiting for confirmation",
              {
                tokenId: tokenId.substring(0, 10) + "...",
                txHash: approveTx.hash,
              }
            );
            await approveTx.wait();
            logToFile("INFO", "Allowance approved successfully", {
              tokenId: tokenId.substring(0, 10) + "...",
              txHash: approveTx.hash,
            });
          } else {
            logToFile("DEBUG", "Sufficient allowance already set", {
              tokenId: tokenId.substring(0, 10) + "...",
              currentAllowance: allowanceFormatted,
              requiredAmount: orderSize,
            });
          }
        }
      } catch (balanceError) {
        if (
          balanceError.message &&
          balanceError.message.includes("Insufficient token balance")
        ) {
          throw balanceError;
        }
        logToFile(
          "WARN",
          "Failed to check token balance/allowance, proceeding",
          {
            tokenId,
            error: balanceError.message,
          }
        );
      }
    }

    let response;
    let lastError = null;
    let order = null;
    const LIQUIDITY_BUFFER = 1.3;
    let priceIndex = 0;

    for (let attempt = 1; attempt <= MAX_CLOUDFLARE_RETRIES; attempt++) {
      try {
        if (attempt > 1) {
          const delay = CLOUDFLARE_RETRY_DELAY_MS * attempt;
          logToFile(
            "INFO",
            `Retrying market sell order (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              delayMs: delay,
              tokenId,
              priceIndex,
            }
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        let currentOrderSize = orderSize;
        let currentMarketPrice = marketPrice;

        if (!marketPrice) {
          currentMarketPrice = undefined;
        } else {
          let orderBook = null;
          let orderBookSource = "REST";

          try {
            if (orderbookWS && orderbookWS.isConnected) {
              orderbookWS.subscribe(tokenId);
              const wsOrderbook = orderbookWS.getOrderbook(tokenId);
              if (wsOrderbook && Date.now() - wsOrderbook.timestamp < 5000) {
                orderBook = {
                  asks: wsOrderbook.asks,
                  bids: wsOrderbook.bids,
                };
                orderBookSource = "WebSocket";
              }
            }

            if (!orderBook) {
              orderBook = await clobClient.getOrderBook(tokenId);
              orderBookSource = "REST";
            }

            if (!orderBook.bids || orderBook.bids.length === 0) {
              logToFile("WARN", "No bids found in orderbook, skipping order", {
                tokenId,
                currentOrderSize,
                attempt,
              });
              throw new Error(
                "No bids found in orderbook. Cannot place market sell order."
              );
            }

            const sortedBids = orderBook.bids
              .map((bid) => ({
                price: parseFloat(bid.price),
                size: parseFloat(bid.size),
              }))
              .sort((a, b) => b.price - a.price);

            if (priceIndex >= sortedBids.length) {
              logToFile("WARN", "No more prices to try in orderbook", {
                tokenId,
                priceIndex,
                totalBids: sortedBids.length,
                attempt,
              });
              throw new Error(
                "Exhausted all available prices in orderbook. Cannot place order."
              );
            }

            const selectedPrice = sortedBids[priceIndex].price;
            let cumulativeLiquidity = 0;
            let bidsChecked = 0;

            for (let i = priceIndex; i < sortedBids.length; i++) {
              const bid = sortedBids[i];
              const bidLiquidity = bid.size * bid.price;
              cumulativeLiquidity += bidLiquidity;
              bidsChecked++;
              if (
                cumulativeLiquidity >=
                currentOrderSize * selectedPrice * LIQUIDITY_BUFFER
              ) {
                break;
              }
            }

            const requiredLiquidity =
              currentOrderSize * selectedPrice * LIQUIDITY_BUFFER;

            const orderValue = currentOrderSize * selectedPrice;
            if (orderValue < MIN_ORDER_VALUE_USD) {
              const requiredSize =
                Math.ceil((MIN_ORDER_VALUE_USD / selectedPrice) * 10000) /
                10000;
              currentOrderSize = Math.floor(requiredSize * 10000) / 10000;
            }

            if (orderValue > MAX_ORDER_VALUE_USD) {
              const maxSize =
                Math.floor((MAX_ORDER_VALUE_USD / selectedPrice) * 10000) /
                10000;
              currentOrderSize = Math.floor(maxSize * 10000) / 10000;
            }

            if (cumulativeLiquidity < currentOrderSize * selectedPrice) {
              if (priceIndex < sortedBids.length - 1) {
                priceIndex++;
                continue;
              }
              throw new Error(
                `Insufficient liquidity: ${cumulativeLiquidity.toFixed(
                  2
                )} available, need ${(currentOrderSize * selectedPrice).toFixed(
                  2
                )}`
              );
            }

            currentMarketPrice = selectedPrice;
          } catch (orderBookError) {
            if (
              orderBookError.message &&
              (orderBookError.message.includes("No bids") ||
                orderBookError.message.includes("Insufficient liquidity") ||
                orderBookError.message.includes(
                  "Exhausted all available prices"
                ))
            ) {
              throw orderBookError;
            }
            logToFile(
              "WARN",
              "Failed to fetch orderbook, proceeding with order",
              {
                tokenId,
                error: orderBookError.message,
                attempt,
              }
            );
          }
        }

        const orderParams = {
          tokenID: tokenId,
          amount: currentOrderSize,
          side: Side.SELL,
        };
        if (currentMarketPrice) {
          orderParams.price = currentMarketPrice;
        }

        order = await clobClient.createMarketOrder(orderParams);

        response = await clobClient.postOrder(order, OrderType.FOK);

        if (
          response &&
          response.error &&
          response.error.includes("invalid nonce")
        ) {
          logToFile(
            "WARN",
            `Invalid nonce in response, will retry with fresh nonce (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              tokenId,
              failedNonce: orderNonce,
              attempt,
            }
          );
          if (attempt < MAX_CLOUDFLARE_RETRIES) {
            const retryOrderParams = {
              tokenID: tokenId,
              amount: orderSize,
              side: Side.SELL,
            };
            if (marketPrice) {
              retryOrderParams.price = marketPrice;
            }

            order = await clobClient.createMarketOrder(retryOrderParams);
            response = await clobClient.postOrder(order, OrderType.FOK);
            if (
              response &&
              response.error &&
              response.error.includes("invalid nonce")
            ) {
              continue;
            }
            if (response && response.error) {
              throw new Error(response.error);
            }
            break;
          } else {
            throw new Error(
              `Invalid nonce after ${MAX_CLOUDFLARE_RETRIES} attempts. The API may be rejecting all nonces. Please check your API credentials or contact Polymarket support.`
            );
          }
        }

        if (response && response.error) {
          if (
            response.error.includes("not enough balance") ||
            response.error.includes("not enough allowance")
          ) {
            logToFile(
              "WARN",
              "Insufficient token balance/allowance for sell order",
              {
                tokenId,
                orderSize,
                error: response.error,
              }
            );
            throw new Error(
              `Cannot sell: You don't own enough tokens. You need to buy tokens first before you can sell them. Error: ${response.error}`
            );
          }
          throw new Error(response.error);
        }

        break;
      } catch (postError) {
        lastError = postError;
        const errorMsg = postError?.message || String(postError);
        const responseError =
          postError?.response?.error || postError?.error || errorMsg;

        if (
          responseError &&
          (responseError.includes("not enough balance") ||
            responseError.includes("not enough allowance") ||
            errorMsg.includes("not enough balance") ||
            errorMsg.includes("not enough allowance"))
        ) {
          logToFile(
            "WARN",
            "Insufficient token balance/allowance detected, skipping sell order",
            {
              tokenId,
              orderSize,
              error: errorMsg,
            }
          );
          throw new Error(
            `Cannot sell: You don't own enough tokens. You need to buy tokens first before you can sell them.`
          );
        }

        if (
          responseError &&
          (responseError.includes("invalid nonce") ||
            errorMsg.includes("invalid nonce"))
        ) {
          logToFile(
            "WARN",
            `Invalid nonce detected in exception, incrementing nonce (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              tokenId,
              failedNonce: orderNonce,
              attempt,
            }
          );
          if (attempt < MAX_CLOUDFLARE_RETRIES) {
            order = await clobClient.createOrder({
              tokenID: tokenId,
              price: marketPrice,
              side: Side.SELL,
              size: orderSize,
              feeRateBps: 0,
              nonce: orderNonce,
            });
            continue;
          } else {
            throw new Error(
              `Invalid nonce after ${MAX_CLOUDFLARE_RETRIES} attempts. The API may be rejecting all nonces. Please check your API credentials or contact Polymarket support.`
            );
          }
        }

        if (
          postError &&
          postError.message &&
          isCloudflareBlock(postError.message)
        ) {
          logToFile(
            "WARN",
            `Cloudflare block detected (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              tokenId,
              amount: orderSize,
              attempt,
              errorMessage: postError.message.substring(0, 200),
            }
          );

          if (attempt === MAX_CLOUDFLARE_RETRIES) {
            const errorMsg =
              "Cloudflare is blocking CLOB API requests. Your server IP may be flagged. The Data API works, but order placement is blocked. Please contact Polymarket support or try from a different network.";
            logToFile("ERROR", "Cloudflare block - max retries reached", {
              tokenId,
              amount: orderSize,
            });
            throw new Error(errorMsg);
          }
          continue;
        }
        throw postError;
      }
    }

    if (!response && lastError) {
      throw lastError;
    }

    if (isCloudflareBlock(response)) {
      const errorMsg =
        "Cloudflare is blocking requests. Your server IP may be flagged. Please try again later or contact Polymarket support.";
      logToFile("ERROR", "Cloudflare block detected (from response)", {
        tokenId,
        amount: orderSize,
        responseType: typeof response,
        responsePreview:
          typeof response === "string"
            ? response.substring(0, 200)
            : JSON.stringify(response).substring(0, 200),
      });
      throw new Error(errorMsg);
    }

    return response;
  } catch (error) {
    if (error.message && error.message.includes("Cloudflare")) {
      throw error;
    }
    if (error.message && isCloudflareBlock(error.message)) {
      const errorMsg =
        "Cloudflare is blocking requests. Your server IP may be flagged. Please try again later or contact Polymarket support.";
      logToFile("ERROR", "Cloudflare block detected (from catch)", {
        tokenId,
        amount,
        errorMessage: error.message.substring(0, 200),
      });
      throw new Error(errorMsg);
    }
    logToFile("ERROR", "Failed to place market sell order", {
      error: error.message,
      stack: error.stack,
      tokenId,
      amount,
      price,
    });
    throw new Error(`Failed to place market sell order: ${error.message}`);
  }
}

module.exports = {
  placeBuyOrder,
  placeSellOrder,
  placeMarketBuyOrder,
  placeMarketSellOrder,
  setOrderNonce,
  getOrderNonce,
  incrementOrderNonce,
};
