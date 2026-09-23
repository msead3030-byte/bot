"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { SecretBox } = require("../src/SecretBox");
const { openStoreDatabase } = require("../src/StoreDatabase");
const { StoreService } = require("../src/StoreService");
const { parseSms, isNameMatch, normalizeSenderName } = require("../src/SmsParser");
const { BinancePayClient } = require("../src/BinancePayClient");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-studio-test-"));
  const db = openStoreDatabase(path.join(directory, "store.db"));
  const store = new StoreService({
    db,
    secretBox: new SecretBox("b".repeat(64)),
  });
  return {
    store,
    cleanup() {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("SmsParser extracts InstaPay sender name in Arabic and English", () => {
  // Arabic InstaPay SMS
  const arSms = "تم تحويل مبلغ 150.00 جم لحسابك من أحمد محمد علي عبر انستاباي مرجع: IPN12345678";
  const parsedAr = parseSms(arSms);
  assert.ok(parsedAr);
  assert.equal(parsedAr.provider, "instapay");
  assert.equal(parsedAr.amountPiasters, 15000);
  assert.equal(parsedAr.trxId, "insta_IPN12345678");
  assert.equal(isNameMatch("احمد محمد", parsedAr.senderName), true);

  // English InstaPay / IPN SMS
  const enSms = "Received EGP 200.00 from MAHMOUD HASSAN via IPN. Ref: IPN99887766";
  const parsedEn = parseSms(enSms);
  assert.ok(parsedEn);
  assert.equal(parsedEn.amountPiasters, 20000);
  assert.equal(parsedEn.trxId, "insta_IPN99887766");
  assert.equal(isNameMatch("mahmoud", parsedEn.senderName), true);
});

test("isNameMatch handles Arabic diacritics, alef forms, and partial matching", () => {
  assert.equal(isNameMatch("أحمد علي", "احمد علي ابراهيم"), true);
  assert.equal(isNameMatch("محمد", "مُحَمَّد أحْمَد"), true);
  assert.equal(isNameMatch("سارة", "ساره محمود"), true);
  assert.equal(isNameMatch("John Doe", "JOHN DOE SMITH"), true);
  assert.equal(isNameMatch("علي", "مصطفى كامل"), false);
});

test("InstaPay topup verification by sender name and strict anti-double-spending", () => {
  const { store, cleanup } = fixture();
  try {
    const userId = "555111222";
    store.ensureUser({ id: userId, first_name: "Ahmed" });

    // 1. Create pending topup of 100 EGP (10000 piasters)
    const topup = store.createAutoTopup(userId, 10000, "instapay", "ai_studio@instapay");
    assert.equal(topup.status, "pending");
    assert.equal(store.balance(userId), 0);

    // 2. Incoming InstaPay SMS recorded
    const rawSms = "تم استلام مبلغ 100.00 جم من أحمد علي عبر انستاباي مرجع: IPN987654";
    const parsed = parseSms(rawSms);
    const rec = store.recordSmsTransfer(parsed);
    assert.equal(rec.duplicate, false);

    // 3. User verifies with their sender name
    const claim = store.verifyAndClaimInstaPayTopup(userId, topup.id, "أحمد علي");
    assert.equal(claim.ok, true);
    assert.equal(claim.balance, 10000);
    assert.equal(claim.topup.status, "succeeded");

    // 4. Double Spending Attack: User tries to claim the same topup again
    const retryClaim = store.verifyAndClaimInstaPayTopup(userId, topup.id, "أحمد علي");
    assert.equal(retryClaim.alreadyCredited, true);
    assert.equal(store.balance(userId), 10000); // Balance NOT increased twice!

    // 5. Cross-Account Theft Attack: Another user tries to claim the same SMS transfer
    const hackerId = "999888777";
    store.ensureUser({ id: hackerId, first_name: "Attacker" });
    const hackerTopup = store.createAutoTopup(hackerId, 10000, "instapay", "ai_studio@instapay");

    const hackerClaim = store.verifyAndClaimInstaPayTopup(hackerId, hackerTopup.id, "أحمد علي");
    assert.equal(hackerClaim.ok, false);
    assert.match(hackerClaim.error, /لم يتم العثور على تحويل/);
    assert.equal(store.balance(hackerId), 0); // Attacker balance remains 0!
  } finally {
    cleanup();
  }
});

test("Binance Pay topup verification and atomic single credit guarantee", () => {
  const { store, cleanup } = fixture();
  try {
    const userId = "333444555";
    store.ensureUser({ id: userId, first_name: "BinanceUser" });

    const topup = store.createAutoTopup(userId, 25000, "binance_pay", "Binance Pay");
    assert.equal(topup.status, "pending");

    // Mock successful Binance Pay query
    const binanceData = {
      isPaid: true,
      orderStatus: "PAID",
      merchantTradeNo: topup.provider_order_id,
      transactionId: "BINANCE_TX_12345",
      totalFee: "5.00000000",
      currency: "USDT",
    };

    const claim = store.verifyAndClaimBinanceTopup(userId, topup.id, binanceData);
    assert.equal(claim.ok, true);
    assert.equal(claim.balance, 25000);
    assert.equal(claim.topup.status, "succeeded");

    // Second attempt to credit
    const claim2 = store.verifyAndClaimBinanceTopup(userId, topup.id, binanceData);
    assert.equal(claim2.alreadyCredited, true);
    assert.equal(store.balance(userId), 25000); // Unchanged!
  } finally {
    cleanup();
  }
});

test("userDepositLedger returns chronological deposit history with values and dates", () => {
  const { store, cleanup } = fixture();
  try {
    const userId = "777888999";
    store.ensureUser({ id: userId });

    // Add multiple deposits
    const topup1 = store.createAutoTopup(userId, 5000, "wallet");
    store.db.prepare("UPDATE topups SET status = 'succeeded' WHERE id = ?").run(topup1.id);
    store.db.prepare(`
      INSERT INTO ledger (user_id, type, amount_piasters, reference_type, reference_id, idempotency_key, note, created_at)
      VALUES (?, 'topup', 5000, 'wallet', ?, 'dep_1', 'شحن رصيد محفظة', '2026-09-23T05:00:00.000Z')
    `).run(userId, String(topup1.id));

    const topup2 = store.createAutoTopup(userId, 15000, "instapay");
    store.db.prepare("UPDATE topups SET status = 'succeeded' WHERE id = ?").run(topup2.id);
    store.db.prepare(`
      INSERT INTO ledger (user_id, type, amount_piasters, reference_type, reference_id, idempotency_key, note, created_at)
      VALUES (?, 'topup', 15000, 'instapay', ?, 'dep_2', 'شحن إنستاباي', '2026-09-23T05:30:00.000Z')
    `).run(userId, String(topup2.id));

    const deposits = store.userDepositLedger(userId, 10);
    assert.equal(deposits.length, 2);
    assert.equal(deposits[0].amount_piasters, 15000);
    assert.equal(deposits[0].note, "شحن إنستاباي");
    assert.equal(deposits[1].amount_piasters, 5000);
    assert.equal(deposits[1].note, "شحن رصيد محفظة");
  } finally {
    cleanup();
  }
});

test("BinancePayClient calculates USDT conversions accurately", () => {
  const client = new BinancePayClient({ usdtRate: "50.00" });
  assert.equal(client.calculateUsdtFromEgp(5000), 1.00); // 50 EGP = 1.00 USDT
  assert.equal(client.calculateUsdtFromEgp(25000), 5.00); // 250 EGP = 5.00 USDT
  assert.equal(client.calculatePiastersFromUsdt(10.00), 50000); // 10 USDT = 500 EGP (50000 piasters)
});

test("StoreDatabase migrates existing database with older sms_transfers schema cleanly", () => {
  const Database = require("better-sqlite3");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "migration-test-"));
  const dbPath = path.join(directory, "old_store.db");
  const rawDb = new Database(dbPath);
  // Create an old version of sms_transfers without sender_name or payment_method
  rawDb.exec(`
    CREATE TABLE users (telegram_id TEXT PRIMARY KEY, username TEXT, first_name TEXT, last_name TEXT, language TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE sms_transfers (
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
      claimed_at TEXT
    );
  `);
  rawDb.close();

  // Now open with openStoreDatabase, which runs migrate(db)
  const migratedDb = openStoreDatabase(dbPath);
  try {
    const tableInfo = migratedDb.prepare('PRAGMA table_info("sms_transfers")').all();
    const columns = tableInfo.map((col) => col.name);
    assert.ok(columns.includes("sender_name"), "Should contain sender_name");
    assert.ok(columns.includes("payment_method"), "Should contain payment_method");

    // Also verify the index exists and works
    const indexes = migratedDb.prepare('PRAGMA index_list("sms_transfers")').all();
    assert.ok(indexes.some((idx) => idx.name === "idx_sms_transfers_name"), "Should create idx_sms_transfers_name");
  } finally {
    migratedDb.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

