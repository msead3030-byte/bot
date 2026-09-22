"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const RAILWAY_VOLUME_PATH = String(process.env.RAILWAY_VOLUME_MOUNT_PATH || "").trim();
const DEFAULT_DB_PATH = RAILWAY_VOLUME_PATH
  ? path.join(RAILWAY_VOLUME_PATH, "store.db")
  : path.join(PROJECT_ROOT, "runtime", "store.db");

function resolveDbPath(filePath = "") {
  if (!filePath) return DEFAULT_DB_PATH;
  return path.isAbsolute(filePath) ? filePath : path.join(PROJECT_ROOT, filePath);
}

function openStoreDatabase(filePath = (process.env.M_AUTOMATION_DB_PATH || process.env.MINOF_AI_STUDIO_DB_PATH)) {
  const dbPath = resolveDbPath(filePath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info("${table}")`).all().some((col) => col.name === column);
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id TEXT PRIMARY KEY,
      username TEXT NOT NULL DEFAULT '',
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS merchants (
      telegram_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      added_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS super_admins (
      telegram_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      added_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant_id TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Digital',
      description TEXT NOT NULL DEFAULT '',
      price_piasters INTEGER NOT NULL,
      fulfillment_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      delivery_template_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (merchant_id) REFERENCES merchants(telegram_id)
    );

    CREATE TABLE IF NOT EXISTS stock_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      encrypted_payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      order_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sold_at TEXT,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_ref TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      merchant_id TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price_piasters INTEGER NOT NULL,
      total_piasters INTEGER NOT NULL,
      fulfillment_type TEXT NOT NULL,
      status TEXT NOT NULL,
      stock_item_id INTEGER,
      user_input_encrypted TEXT NOT NULL DEFAULT '',
      delivery_encrypted TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id),
      FOREIGN KEY (merchant_id) REFERENCES merchants(telegram_id),
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (stock_item_id) REFERENCES stock_items(id)
    );

    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount_piasters INTEGER NOT NULL,
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id)
    );

    CREATE TABLE IF NOT EXISTS topups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      amount_piasters INTEGER NOT NULL,
      provider_order_id TEXT NOT NULL UNIQUE,
      payment_intent_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      receiver_number TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      sender_identifier TEXT NOT NULL DEFAULT '',
      validate_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      raw_response_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id)
    );

    CREATE TABLE IF NOT EXISTS manual_topups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      payment_method TEXT NOT NULL,
      amount_piasters INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'awaiting_proof',
      proof_kind TEXT NOT NULL DEFAULT '',
      proof_file_id TEXT NOT NULL DEFAULT '',
      submitted_at TEXT,
      reviewed_by TEXT NOT NULL DEFAULT '',
      reviewer_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id)
    );

    CREATE TABLE IF NOT EXISTS conversation_state (
      user_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_price_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      price_piasters INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      set_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, product_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sms_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trx_id TEXT UNIQUE NOT NULL,
      sender_phone TEXT NOT NULL,
      amount_piasters INTEGER NOT NULL,
      provider TEXT NOT NULL DEFAULT 'vodafone_cash',
      raw_message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unclaimed',
      claimed_by_user_id TEXT,
      claimed_topup_id INTEGER,
      received_at TEXT NOT NULL,
      claimed_at TEXT,
      FOREIGN KEY (claimed_by_user_id) REFERENCES users(telegram_id)
    );

    CREATE INDEX IF NOT EXISTS idx_products_merchant ON products(merchant_id);
    CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
    CREATE INDEX IF NOT EXISTS idx_stock_product_status ON stock_items(product_id, status);
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_topups_user_status ON topups(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_manual_topups_user_status ON manual_topups(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_manual_topups_status ON manual_topups(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_price_overrides_user ON user_price_overrides(user_id);
    CREATE INDEX IF NOT EXISTS idx_price_overrides_product ON user_price_overrides(product_id);
    CREATE INDEX IF NOT EXISTS idx_sms_transfers_lookup ON sms_transfers(sender_phone, amount_piasters, status);
    CREATE INDEX IF NOT EXISTS idx_sms_transfers_trx ON sms_transfers(trx_id);
    CREATE INDEX IF NOT EXISTS idx_sms_transfers_status ON sms_transfers(status, received_at);
  `);

  if (!columnExists(db, "users", "language")) {
    db.exec("ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT ''");
  }
}

module.exports = {
  DEFAULT_DB_PATH,
  openStoreDatabase,
  resolveDbPath,
};
