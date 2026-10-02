"use strict";

const http = require("http");
const crypto = require("crypto");
const { parseSms, normalizePhoneNumber } = require("./SmsParser");

// In-memory rate limiter per IP (max 60 requests per minute)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;

setInterval(() => {
  const now = Date.now();
  for (const [ip, item] of rateLimitMap.entries()) {
    if (now - item.start > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

function isRateLimited(ip) {
  const now = Date.now();
  let record = rateLimitMap.get(ip);
  if (!record || now - record.start > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { start: now, count: 1 });
    return false;
  }
  record.count += 1;
  return record.count > RATE_LIMIT_MAX;
}

function safeTimingCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      // Protect against gigantic payloads (max 1MB)
      if (raw.length > 1e6) {
        req.destroy();
        resolve({});
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      const contentType = String(req.headers["content-type"] || "").toLowerCase();
      if (contentType.includes("application/json")) {
        try {
          return resolve(JSON.parse(raw));
        } catch {
          return resolve({ raw });
        }
      }
      if (contentType.includes("application/x-www-form-urlencoded")) {
        try {
          const params = new URLSearchParams(raw);
          const obj = {};
          for (const [k, v] of params.entries()) obj[k] = v;
          return resolve(obj);
        } catch {
          return resolve({ raw });
        }
      }
      // Fallback
      resolve({ raw, text: raw });
    });
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(data));
}

class SmsWebhookServer {
  constructor({ store, api, port = 3000, secret = "" }) {
    this.store = store;
    this.api = api;
    this.port = Number(process.env.PORT || process.env.SMS_WEBHOOK_PORT || port || 3000);
    this.secret = String(process.env.SMS_WEBHOOK_SECRET || secret || "").trim();
    this.server = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        try {
          await this.handleRequest(req, res);
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error.message });
        }
      });

      this.server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          console.warn(`[SMS Webhook] Port ${this.port} is in use, server not started.`);
        } else {
          console.error("[SMS Webhook] Server error:", err.message);
        }
        reject(err);
      });

      this.server.listen(this.port, () => {
        console.log(`[SMS Webhook] Server listening on port ${this.port}`);
        if (!this.secret) {
          console.warn("[SECURITY WARN] SMS_WEBHOOK_SECRET is empty. Set SMS_WEBHOOK_SECRET in .env for protected production hosting.");
        }
        resolve(this.server);
      });
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  async handleRequest(req, res) {
    const clientIp = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
    if (isRateLimited(clientIp)) {
      sendJson(res, 429, { ok: false, error: "Too many requests. Please slow down." });
      return;
    }

    const url = new URL(req.url, `http://localhost:${this.port}`);
    const method = req.method.toUpperCase();

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization, x-webhook-secret",
      });
      res.end();
      return;
    }

    // Health check
    if (method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      sendJson(res, 200, {
        ok: true,
        service: "sms-webhook",
        status: "active",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Diagnostics endpoint (secured with secret)
    if (method === "GET" && url.pathname === "/api/sms/diagnostics") {
      const qToken = url.searchParams.get("secret") || req.headers["x-webhook-secret"] || "";
      if (this.secret && !safeTimingCompare(qToken, this.secret)) {
        sendJson(res, 401, { ok: false, error: "Unauthorized" });
        return;
      }
      const recentTransfers = this.store.db.prepare("SELECT id, provider, amount_piasters, sender_phone, sender_name, status, trx_id, raw_message, received_at FROM sms_transfers ORDER BY id DESC LIMIT 10").all();
      const recentTopups = this.store.db.prepare("SELECT id, user_id, amount_piasters, status, sender_identifier, validate_attempts, last_error, created_at, updated_at FROM topups ORDER BY id DESC LIMIT 10").all();
      sendJson(res, 200, { ok: true, transfers: recentTransfers, topups: recentTopups });
      return;
    }

    // Webhook endpoint
    if (url.pathname === "/api/sms/webhook") {
      // Support GET requests from API Gateway apps (e.g. the mobile app sending ?id=...&status=...&message=...)
      if (method === "GET") {
        const qMessage = url.searchParams.get("message") || url.searchParams.get("text") ||
          url.searchParams.get("body") || url.searchParams.get("sms") || url.searchParams.get("content") || "";

        // If no message in query params, treat as a simple status check
        if (!qMessage) {
          sendJson(res, 200, { ok: true, message: "SMS Webhook endpoint is active. Use POST or GET with ?message= to submit SMS messages." });
          return;
        }

        // Authenticate secret token from query string for GET requests
        const qToken = url.searchParams.get("secret") || url.searchParams.get("token") ||
          req.headers["x-webhook-secret"] || req.headers["authorization"]?.replace(/^Bearer\s+/i, "").trim() || "";
        if (this.secret) {
          if (!qToken || !safeTimingCompare(qToken, this.secret)) {
            sendJson(res, 401, { ok: false, error: "Unauthorized. Invalid or missing secret token." });
            return;
          }
        }

        // Process the SMS message from GET params
        return await this._processSmsText(qMessage, res);
      }

      if (method !== "POST") {
        sendJson(res, 405, { ok: false, error: "Method not allowed. Use POST or GET." });
        return;
      }

      const body = await parseBody(req);

      // Handle ping/test events from webhook dashboards (e.g. mysmsgate.net)
      const eventType = String(body.event || body.eventType || body.type || "").toLowerCase();
      if (eventType.includes("ping") || eventType.includes("test") || body.action === "ping") {
        sendJson(res, 200, { ok: true, status: "pong", message: "Webhook verified successfully." });
        return;
      }

      // Authenticate secret token using timing-safe comparison
      const authHeader = req.headers["x-webhook-secret"] || req.headers["authorization"] || "";
      const cleanHeader = authHeader.replace(/^Bearer\s+/i, "").trim();
      const token = cleanHeader || url.searchParams.get("secret") || body.secret || "";

      if (this.secret) {
        if (!token || !safeTimingCompare(token, this.secret)) {
          sendJson(res, 401, { ok: false, error: "Unauthorized. Invalid or missing secret token." });
          return;
        }
      }

      // Extract message text from common forwarder body keys (including mysmsgate.net / sms-gate.app / android-sms-gateway)
      const payloadObj = (body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)) ? body.payload : {};
      const senderInfo = payloadObj.sender || body.sender || "unknown";

      // Handle batched SMS from sms-gate.app
      if (Array.isArray(body.payload) && body.payload.length > 0) {
        console.log(`[SMS Webhook] Processing batched SMS event (${body.payload.length} messages) from device ${body.deviceId || "unknown"}`);
        let lastResult = null;
        for (const item of body.payload) {
          const itemText = item.message || item.text || item.body || "";
          const itemPhone = item.phoneNumber || item.from || "";
          if (itemText) {
            lastResult = await this._processSmsText(itemText, null, itemPhone);
          }
        }
        sendJson(res, 200, { ok: true, status: "batch_processed", count: body.payload.length, last: lastResult });
        return;
      }

      const rawText = body.message || payloadObj.message || body.text || payloadObj.text || body.body || body.content || body.sms || body.raw || "";
      if (!rawText) {
        sendJson(res, 400, { ok: false, error: "Missing message/text in request body." });
        return;
      }

      // Extract sender phone number if provided by sms-gate.app in payload.phoneNumber
      // This is the number that SENT the SMS (e.g. Vodafone cash sender number)
      const senderPhone = payloadObj.phoneNumber || body.phoneNumber || payloadObj.from || body.from || "";

      console.log(`[SMS Webhook] Received SMS [Sender: ${senderInfo}${senderPhone ? ` | Phone: ${senderPhone}` : ""}]: "${rawText.replace(/\r?\n/g, ' ').slice(0, 80)}"`);
      return await this._processSmsText(rawText, res, senderPhone);
    }

    // Binance Pay Webhook
    if (url.pathname === "/api/binance/webhook") {
      if (method !== "POST") {
        sendJson(res, 405, { ok: false, error: "Method not allowed. Use POST." });
        return;
      }

      const body = await parseBody(req);
      const bizStatus = body.bizStatus || body.data?.status || body.status || "";
      const rawData = body.data ? (typeof body.data === "string" ? JSON.parse(body.data) : body.data) : body;
      const merchantTradeNo = rawData.merchantTradeNo || body.merchantTradeNo || "";

      if (!merchantTradeNo) {
        sendJson(res, 400, { ok: false, error: "Missing merchantTradeNo in payload." });
        return;
      }

      if (bizStatus === "PAY_SUCCESS" || rawData.status === "PAID" || rawData.orderStatus === "PAID") {
        const topup = this.store.db.prepare("SELECT * FROM topups WHERE provider_order_id = ?").get(merchantTradeNo);
        if (topup && topup.status === "pending") {
          try {
            const claimResult = this.store.verifyAndClaimBinanceTopup(topup.user_id, topup.id, {
              ...rawData,
              isPaid: true,
              merchantTradeNo,
            });

            if (claimResult.ok && this.api && topup.user_id) {
              const amountEgp = (topup.amount_piasters / 100).toFixed(2);
              const balanceEgp = (claimResult.balance / 100).toFixed(2);
              const notification = [
                "🎉 تم استلام شحن Binance Pay بنجاح!",
                "━━━━━━━━━━━━━━━━━━━━━━━━",
                `💵 المبلغ المضاف: ${amountEgp} جنيه`,
                `🪙 وسيلة الدفع: Binance Pay (USDT)`,
                `🧾 رقم الطلب: ${merchantTradeNo}`,
                `💰 رصيدك الحالي: ${balanceEgp} جنيه`,
              ].join("\n");

              this.api.sendMessage(topup.user_id, notification).catch(() => { });
            }
          } catch (err) {
            console.error("[Binance Webhook] Auto-credit error:", err.message);
          }
        }
      }

      sendJson(res, 200, { returnCode: "SUCCESS", returnMessage: null });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found." });
  }

  // Shared SMS processing logic used by both GET and POST handlers
  async _processSmsText(rawText, res, senderPhone = "") {
    const sendOrReturn = (statusCode, data) => {
      if (res) sendJson(res, statusCode, data);
      return data;
    };

    // Parse SMS text
    const parsed = parseSms(rawText);
    if (!parsed || !parsed.ok) {
      return sendOrReturn(200, {
        ok: false,
        status: "ignored",
        reason: "Message is not a recognized wallet transfer SMS.",
        rawPreview: String(rawText).slice(0, 100),
      });
    }

    // Override senderPhone if not found in SMS text but provided externally (and not equal to receiver SIM)
    const receiverNum = normalizePhoneNumber(process.env.AUTO_TOPUP_WALLET_RECEIVER || "01104826670");
    if (!parsed.senderPhone && senderPhone) {
      const normExternal = normalizePhoneNumber(senderPhone);
      if (normExternal && normExternal.length >= 10 && normExternal !== receiverNum) {
        parsed.senderPhone = normExternal;
      }
    }

    // Record in database
    const recordResult = this.store.recordSmsTransfer(parsed);
    if (recordResult.duplicate) {
      return sendOrReturn(200, {
        ok: true,
        status: "duplicate_ignored",
        trxId: parsed.trxId,
        message: "Transfer already recorded previously.",
      });
    }

    // Look for pending top-up waiting for this transfer
    let autoCredited = false;
    const pendingTopup = this.store.findPendingTopupForSms(
      parsed.senderPhone,
      parsed.amountPiasters,
      new Date().toISOString(),
      parsed.senderName
    );

    if (pendingTopup) {
      try {
        // Use the transfer already returned from recordSmsTransfer (no extra DB query needed)
        const smsTransfer = recordResult.transfer;
        if (!smsTransfer) {
          throw new Error("SMS transfer record missing after insert.");
        }

        const claimResult = this.store.autoClaimSmsTopup(pendingTopup, smsTransfer);

        if (claimResult.ok) {
          autoCredited = true;
          // Notify user on Telegram
          if (this.api && pendingTopup.user_id) {
            const amountEgp = (parsed.amountPiasters / 100).toFixed(2);
            const balanceEgp = (claimResult.balance / 100).toFixed(2);
            const senderDetail = parsed.senderName
              ? `👤 اسم المحوِّل: ${parsed.rawSenderName || parsed.senderName}`
              : `📱 رقم المحول: ${parsed.senderPhone}`;

            const notification = [
              "🎉 تم تأكيد استلام تحويلك بنجاح!",
              "━━━━━━━━━━━━━━━━━━━━━━━━",
              `💵 المبلغ المضاف: ${amountEgp} جنيه`,
              senderDetail,
              `🧾 كود العملية: ${parsed.trxId.replace(/^\w+_/, "")}`,
              `💰 رصيدك الحالي: ${balanceEgp} جنيه`,
            ].join("\n");

            this.api.sendMessage(pendingTopup.user_id, notification).catch(() => { });
          }
        }
      } catch (err) {
        console.error("[SMS Webhook] Auto-credit error:", err.message);
      }
    }

    return sendOrReturn(200, {
      ok: true,
      status: "recorded",
      trxId: parsed.trxId,
      amountEgp: parsed.amountEgp,
      senderPhone: parsed.senderPhone,
      senderName: parsed.senderName || "",
      autoCredited,
    });
  }
}

module.exports = {
  SmsWebhookServer,
};
