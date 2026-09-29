#!/usr/bin/env node
"use strict";

require("dotenv").config({ quiet: true });

const { TelegramApi } = require("../src/TelegramApi");
const { CashupClient } = require("../src/CashupClient");
const { SecretBox } = require("../src/SecretBox");
const { openStoreDatabase } = require("../src/StoreDatabase");
const { StoreService } = require("../src/StoreService");
const { SmsWebhookServer } = require("../src/SmsWebhookServer");
const { poll } = require("../src/bot");

function idSet(value) {
  return new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean));
}

function bootstrapSuperAdmins(store, configuredIds) {
  const existingActiveAdmins = store.listSuperAdmins().filter((admin) => admin.status === "active");
  if (!existingActiveAdmins.length && !configuredIds.size) {
    throw new Error("M_AUTOMATION_SUPER_ADMIN_IDS is required when the database has no active admin.");
  }
  for (const id of configuredIds) {
    if (!store.getSuperAdmin(id)) {
      store.ensureSuperAdmin(id, { displayName: `Owner ${id}`, addedBy: id, status: "active" });
    }
  }
  if (!store.listSuperAdmins().some((admin) => admin.status === "active")) {
    throw new Error("The database has no active admin. Restore an active admin before starting the bot.");
  }
}

async function autoRegisterCloudSmsGateway(publicDomain) {
  const user = process.env.SMS_GATEWAY_USER;
  const pass = process.env.SMS_GATEWAY_PASS;
  if (!user || !pass || !publicDomain) return;

  const cleanDomain = String(publicDomain).replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const webhookUrl = `https://${cleanDomain}/api/sms/webhook`;
  const baseUrl = process.env.SMS_GATEWAY_URL || "https://api.sms-gate.app";

  try {
    const https = require("https");
    const auth = Buffer.from(`${user}:${pass}`).toString("base64");

    const listWebhooks = () =>
      new Promise((resolve) => {
        const req = https.request(
          new URL("/3rdparty/v1/webhooks", baseUrl),
          {
            method: "GET",
            headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
          },
          (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () => {
              try {
                resolve(JSON.parse(raw));
              } catch {
                resolve([]);
              }
            });
          }
        );
        req.on("error", () => resolve([]));
        req.end();
      });

    const existing = await listWebhooks();
    if (Array.isArray(existing) && existing.some((w) => w.url === webhookUrl)) {
      console.log(`[SMS Gateway] Webhook already registered: ${webhookUrl}`);
      return;
    }

    const body = JSON.stringify({ url: webhookUrl, event: "sms:received" });
    const req = https.request(
      new URL("/3rdparty/v1/webhooks", baseUrl),
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Accept: "application/json",
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`[SMS Gateway] Successfully registered Cloud Webhook: ${webhookUrl}`);
          } else {
            console.log(`[SMS Gateway] Webhook registration notice [${res.statusCode}]: ${raw}`);
          }
        });
      }
    );
    req.on("error", (e) => console.warn(`[SMS Gateway] Webhook registration error: ${e.message}`));
    req.write(body);
    req.end();
  } catch (err) {
    console.warn(`[SMS Gateway] Auto-register error: ${err.message}`);
  }
}

function main() {
  const token = process.env.M_AUTOMATION_BOT_TOKEN || process.env.MINOF_AI_STUDIO_BOT_TOKEN;
  if (!token) throw new Error("M_AUTOMATION_BOT_TOKEN is required.");
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token.trim())) {
    console.warn("[warn] BOT_TOKEN format looks unusual — expected format: 123456:ABC-DEF...");
  }

  const dataKey = process.env.M_AUTOMATION_DATA_KEY || process.env.MINOF_AI_STUDIO_DATA_KEY;
  if (!dataKey) {
    throw new Error("M_AUTOMATION_DATA_KEY is required. Generate a random 32-byte hex value.");
  }

  const superAdminsRaw = process.env.M_AUTOMATION_SUPER_ADMIN_IDS || process.env.MINOF_AI_STUDIO_SUPER_ADMIN_IDS;
  const superAdmins = idSet(superAdminsRaw);

  const dbPath = process.env.M_AUTOMATION_DB_PATH || process.env.MINOF_AI_STUDIO_DB_PATH;
  const db = openStoreDatabase(dbPath);
  const secretBox = new SecretBox(dataKey);
  const cashupClient = new CashupClient();
  const store = new StoreService({ db, secretBox, cashupClient });

  bootstrapSuperAdmins(store, superAdmins);

  const api = new TelegramApi(token);

  const autoTopupEnabled = !/^(0|false|no|off)$/i.test(String(process.env.AUTO_TOPUP_ENABLED ?? "true"));
  let smsServer = null;
  if (autoTopupEnabled) {
    smsServer = new SmsWebhookServer({
      store,
      api,
      port: process.env.PORT || process.env.SMS_WEBHOOK_PORT || 3000,
      secret: process.env.SMS_WEBHOOK_SECRET || "",
    });
    smsServer.start().catch((err) => {
      console.warn("[warn] SMS Webhook server failed to start:", err.message);
    });

    const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.PUBLIC_URL;
    if (publicDomain) {
      autoRegisterCloudSmsGateway(publicDomain).catch(() => {});
    }
  }

  const cleanup = () => {
    if (smsServer) {
      try { smsServer.stop(); } catch { }
    }
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  poll(api, store, superAdmins);
}

if (require.main === module) main();

module.exports = { bootstrapSuperAdmins, main };
