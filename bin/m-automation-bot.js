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
