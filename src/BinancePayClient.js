"use strict";

const crypto = require("crypto");
const fetch = require("node-fetch");

class BinancePayClient {
  constructor({
    apiKey = process.env.BINANCE_PAY_API_KEY,
    secretKey = process.env.BINANCE_PAY_SECRET_KEY,
    baseUrl = process.env.BINANCE_PAY_BASE_URL || "https://bpay.binanceapi.com",
    usdtRate = process.env.BINANCE_USDT_RATE || "50.00",
  } = {}) {
    this.apiKey = String(apiKey || "").trim();
    this.secretKey = String(secretKey || "").trim();
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.usdtRate = Math.max(0.01, parseFloat(usdtRate) || 50.0);
  }

  isConfigured() {
    return Boolean(this.apiKey && this.secretKey);
  }

  getUsdtRate() {
    return this.usdtRate;
  }

  calculateUsdtFromEgp(amountPiasters) {
    const egp = (Number(amountPiasters) || 0) / 100;
    const usdt = egp / this.usdtRate;
    return parseFloat(usdt.toFixed(2));
  }

  calculatePiastersFromUsdt(usdtAmount) {
    const usdt = parseFloat(usdtAmount) || 0;
    const egp = usdt * this.usdtRate;
    return Math.round(egp * 100);
  }

  _generateSignature(timestamp, nonce, bodyStr) {
    const payload = `${timestamp}\n${nonce}\n${bodyStr}\n`;
    return crypto
      .createHmac("sha512", this.secretKey)
      .update(payload)
      .digest("hex")
      .toUpperCase();
  }

  _headers(bodyStr) {
    const timestamp = Date.now().toString();
    const nonce = crypto.randomBytes(16).toString("hex");
    const signature = this._generateSignature(timestamp, nonce, bodyStr);

    return {
      "content-type": "application/json",
      "BinancePay-Timestamp": timestamp,
      "BinancePay-Nonce": nonce,
      "BinancePay-Certificate-SN": this.apiKey,
      "BinancePay-Signature": signature,
    };
  }

  async createOrder({
    merchantTradeNo,
    orderAmount,
    currency = "USDT",
    goodsName = "AI Studio Digital Subscription",
    goodsDetail = "Balance Topup for AI Studio Store",
  }) {
    if (!this.isConfigured()) {
      throw new Error("Binance Pay API credentials are not configured in .env");
    }

    const endpoint = `${this.baseUrl}/binancepay/openapi/v2/order`;
    const payload = {
      env: {
        terminalType: "WEB",
      },
      merchantTradeNo: String(merchantTradeNo),
      orderAmount: Number(orderAmount).toFixed(2),
      currency: String(currency).toUpperCase(),
      goods: {
        goodsType: "02",
        goodsCategory: "6000",
        referenceGoodsId: "sub_credit",
        goodsName: String(goodsName).slice(0, 100),
        goodsDetail: String(goodsDetail).slice(0, 250),
      },
    };

    const bodyStr = JSON.stringify(payload);
    const headers = this._headers(bodyStr);

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: bodyStr,
      timeout: 15000,
    });

    const data = await response.json();
    if (data.status !== "SUCCESS") {
      throw new Error(`Binance Pay Error: ${data.errorMessage || data.code || "Failed to create order"}`);
    }

    return {
      ok: true,
      prepayId: data.data?.prepayId,
      checkoutUrl: data.data?.checkoutUrl,
      universalUrl: data.data?.universalUrl,
      deeplink: data.data?.deeplink,
      qrContent: data.data?.qrContent,
      expireTime: data.data?.expireTime,
      raw: data.data,
    };
  }

  async queryOrder({ merchantTradeNo, prepayId }) {
    if (!this.isConfigured()) {
      throw new Error("Binance Pay API credentials are not configured in .env");
    }

    const endpoint = `${this.baseUrl}/binancepay/openapi/v2/order/query`;
    const payload = {};
    if (merchantTradeNo) payload.merchantTradeNo = String(merchantTradeNo);
    if (prepayId) payload.prepayId = String(prepayId);

    const bodyStr = JSON.stringify(payload);
    const headers = this._headers(bodyStr);

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: bodyStr,
      timeout: 15000,
    });

    const data = await response.json();
    if (data.status !== "SUCCESS") {
      throw new Error(`Binance Pay Query Error: ${data.errorMessage || data.code || "Failed to query order"}`);
    }

    const orderData = data.data || {};
    const isPaid = orderData.status === "PAID" || orderData.orderStatus === "PAID";

    return {
      ok: true,
      isPaid,
      status: orderData.status || orderData.orderStatus,
      merchantTradeNo: orderData.merchantTradeNo,
      transactionId: orderData.transactionId,
      totalFee: orderData.totalFee,
      currency: orderData.currency,
      raw: orderData,
    };
  }
}

module.exports = {
  BinancePayClient,
};
