"use strict";

const http = require("http");
const { parseSms, normalizePhoneNumber } = require("./SmsParser");

function parseBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      // Protect against gigantic payloads
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
    this.port = Number(process.env.SMS_WEBHOOK_PORT || port || 3000);
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

    // Webhook endpoint
    if (url.pathname === "/api/sms/webhook") {
      if (method !== "POST") {
        sendJson(res, 405, { ok: false, error: "Method not allowed. Use POST." });
        return;
      }

      const body = await parseBody(req);

      // Authenticate secret token
      const authHeader = req.headers["x-webhook-secret"] || req.headers["authorization"] || "";
      const cleanHeader = authHeader.replace(/^Bearer\s+/i, "").trim();
      const token = cleanHeader || url.searchParams.get("secret") || body.secret || "";

      if (this.secret && token !== this.secret) {
        sendJson(res, 401, { ok: false, error: "Unauthorized. Invalid or missing secret token." });
        return;
      }

      // Extract message text from common forwarder body keys
      const rawText = body.message || body.text || body.body || body.content || body.sms || body.raw || "";
      if (!rawText) {
        sendJson(res, 400, { ok: false, error: "Missing message/text in request body." });
        return;
      }

      // Parse SMS text
      const parsed = parseSms(rawText);
      if (!parsed || !parsed.ok) {
        sendJson(res, 200, {
          ok: false,
          status: "ignored",
          reason: "Message is not a recognized wallet transfer SMS.",
          rawPreview: String(rawText).slice(0, 100),
        });
        return;
      }

      // Record in database
      const recordResult = this.store.recordSmsTransfer(parsed);
      if (recordResult.duplicate) {
        sendJson(res, 200, {
          ok: true,
          status: "duplicate_ignored",
          trxId: parsed.trxId,
          message: "Transfer already recorded previously.",
        });
        return;
      }

      // Look for pending top-up waiting for this transfer
      let autoCredited = false;
      const pendingTopup = this.store.findPendingTopupForSms(parsed.senderPhone, parsed.amountPiasters);
      if (pendingTopup) {
        try {
          const claimResult = this.store.verifyAndClaimSmsTopup(
            pendingTopup.user_id,
            pendingTopup.id,
            parsed.senderPhone
          );
          if (claimResult.ok) {
            autoCredited = true;
            // Notify user on Telegram
            if (this.api && pendingTopup.user_id) {
              const amountEgp = (parsed.amountPiasters / 100).toFixed(2);
              const balanceEgp = (claimResult.balance / 100).toFixed(2);
              const notification = [
                "🎉 تم تأكيد استلام تحويلك بنجاح!",
                "━━━━━━━━━━━━━━━━━━━━━━━━",
                `💵 المبلغ المضاف: ${amountEgp} جنيه`,
                `📱 رقم المحول: ${parsed.senderPhone}`,
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

      sendJson(res, 200, {
        ok: true,
        status: "recorded",
        trxId: parsed.trxId,
        amountEgp: parsed.amountEgp,
        senderPhone: parsed.senderPhone,
        autoCredited,
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found." });
  }
}

module.exports = {
  SmsWebhookServer,
};
