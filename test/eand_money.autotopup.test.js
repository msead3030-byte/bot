"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { openStoreDatabase } = require("../src/StoreDatabase");
const { StoreService } = require("../src/StoreService");
const { SecretBox } = require("../src/SecretBox");
const { SmsWebhookServer } = require("../src/SmsWebhookServer");
const { parseSms } = require("../src/SmsParser");

function fixture() {
  const dbPath = path.join(__dirname, `test_eand_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.db`);
  const secretBox = new SecretBox("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  const db = openStoreDatabase(dbPath);
  const store = new StoreService({ db, secretBox });
  const cleanup = () => {
    try { db.close(); } catch {}
    try { fs.unlinkSync(dbPath); } catch {}
  };
  return { store, cleanup };
}

test("e& money: Webhook strictly accepts only e& money SMS and rejects others to prevent fraud and confusion", async () => {
  const { store, cleanup } = fixture();
  try {
    const server = new SmsWebhookServer({ store, api: null });

    // 1. Valid e& money SMS from official sender "e& money"
    const validEandText = "تم استلام مبلغ 50.00 ج.م من رقم 01021510826 بنجاح. رصيد محفظتك الحالي 150.00 ج.م. رقم العملية 12345678";
    const res1 = await server._processSmsText(validEandText, null, "01021510826", "e& money");
    assert.equal(res1.ok, true);
    assert.equal(res1.status, "recorded");
    assert.equal(res1.trxId, "eand_12345678");

    // 2. Reject Vodafone Cash SMS when strict e& money filter is active
    const vfText = "تم استلام مبلغ 100.00 جنيه من 01011112222 بنجاح في محفظة فودافون كاش. كود: 998877";
    const res2 = await server._processSmsText(vfText, null, "01011112222", "VF-Cash");
    assert.equal(res2.ok, false);
    assert.equal(res2.status, "ignored_not_eand_money");

    // 3. Reject personal mobile SIM sender (anti-spoofing fraud protection)
    const spoofText = "تم استلام مبلغ 500 جنيه من رقم 01099999999 بنجاح. رقم العملية 11223344";
    const res3 = await server._processSmsText(spoofText, null, "01099999999", "01099999999");
    assert.equal(res3.ok, false);
    assert.match(res3.error, /personal mobile SIM/);

    // 4. Verify only the 1 valid e& money transfer is recorded in database
    const transfers = store.listRecentSmsTransfers(10);
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0].trx_id, "eand_12345678");
  } finally {
    cleanup();
  }
});

test("e& money: Accepts and matches SMS received 5 minutes BEFORE payment request creation", async () => {
  const { store, cleanup } = fixture();
  try {
    const server = new SmsWebhookServer({ store, api: null });
    store.ensureUser({ id: "1001", first_name: "Ahmed" });

    // Step 1: Customer sends 100 EGP via e& money FIRST.
    // SMS arrives at the webhook server 3 minutes before customer opens bot.
    const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const smsText = "تم استلام مبلغ 100.00 ج.م من رقم 01021510826 بنجاح. رصيد محفظتك الحالي 200.00 ج.م. رقم العملية 88776655";
    const parsed = parseSms(smsText, { senderInfo: "e& money" });
    assert.ok(parsed);

    // Record transfer with received_at set to 3 minutes ago
    const cleanTrx = parsed.trxId;
    store.db.prepare(`
      INSERT INTO sms_transfers (trx_id, sender_phone, sender_name, amount_piasters, provider, payment_method, raw_message, status, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'unclaimed', ?)
    `).run(cleanTrx, parsed.senderPhone, parsed.senderName, parsed.amountPiasters, parsed.provider, parsed.paymentMethod, smsText, threeMinutesAgo);

    const recorded = store.getSmsTransferByTrxId(cleanTrx);
    assert.ok(recorded);
    assert.equal(recorded.status, "unclaimed");

    // Step 2: Now (3 minutes later), Ahmed opens Telegram and creates topup for 100 EGP
    const topup = store.createAutoTopup("1001", 10000, "wallet", "01104826670");
    assert.equal(topup.status, "pending");

    // Step 3: Ahmed enters his sender phone number "01021510826"
    const claim = store.verifyAndClaimSmsTopup("1001", topup.id, "01021510826");

    // Must successfully match and credit balance!
    assert.equal(claim.ok, true);
    assert.equal(claim.topup.status, "succeeded");
    assert.equal(claim.transfer.status, "claimed");
    assert.equal(store.balance("1001"), 10000);
  } finally {
    cleanup();
  }
});

test("e& money: Auto-claim pre-arrival SMS immediately when user creates topup if phone is known", async () => {
  const { store, cleanup } = fixture();
  try {
    store.ensureUser({ id: "2002", first_name: "Mahmoud" });

    // Simulate Mahmoud having previously topped up using 01021510826
    const pastTopup = store.createAutoTopup("2002", 5000, "wallet", "01104826670");
    store.db.prepare("UPDATE topups SET status = 'succeeded', sender_identifier = '01021510826' WHERE id = ?").run(pastTopup.id);

    // Mahmoud now transfers 50 EGP via e& money.
    // SMS arrives 2 minutes before Mahmoud opens the bot:
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    store.db.prepare(`
      INSERT INTO sms_transfers (trx_id, sender_phone, sender_name, amount_piasters, provider, payment_method, raw_message, status, received_at)
      VALUES (?, '01021510826', '', 5000, 'etisalat_cash', 'wallet', 'sms', 'unclaimed', ?)
    `).run("eand_99112233", twoMinutesAgo);

    // Now Mahmoud opens bot and creates topup:
    const newTopup = store.createAutoTopup("2002", 5000, "wallet", "01104826670");

    // It should immediately auto-claim without even waiting for input!
    assert.equal(newTopup.autoClaimed, true);
    assert.equal(newTopup.status, "succeeded");
    assert.equal(store.balance("2002"), 5000);
  } finally {
    cleanup();
  }
});

test("e& money: Matches SMS received up to 5 minutes AFTER payment request creation", async () => {
  const { store, cleanup } = fixture();
  try {
    const server = new SmsWebhookServer({ store, api: null });
    store.ensureUser({ id: "3003", first_name: "Kareem" });

    // Step 1: Kareem creates payment request FIRST at 12:00
    const topup = store.createAutoTopup("3003", 5000, "wallet", "01104826670");
    // Kareem enters his phone number in bot
    store.db.prepare("UPDATE topups SET sender_identifier = '01123456789' WHERE id = ?").run(topup.id);

    // Step 2: 2 minutes later (within 5 minutes), the e& money SMS arrives at the webhook
    const smsText = "تم استلام مبلغ 50.00 ج.م من رقم 01123456789 بنجاح. رصيد محفظتك الحالي 500.00 ج.م. رقم العملية: 44556677";
    const res = await server._processSmsText(smsText, null, "01123456789", "e& money");

    // Must be auto-credited via webhook!
    assert.equal(res.ok, true);
    assert.equal(res.autoCredited, true);
    assert.equal(store.balance("3003"), 5000);

    const freshTopup = store.getTopup(topup.id);
    assert.equal(freshTopup.status, "succeeded");
  } finally {
    cleanup();
  }
});

test("e& money: Anti-fraud ensures transfer cannot be claimed by another user or twice", async () => {
  const { store, cleanup } = fixture();
  try {
    store.ensureUser({ id: "4001", first_name: "Alice" });
    store.ensureUser({ id: "4002", first_name: "Bob" });

    // Alice creates topup
    const aliceTopup = store.createAutoTopup("4001", 5000, "wallet", "01104826670");

    // Transfer arrives from Alice's phone 01011111111
    const smsText = "تم استلام مبلغ 50.00 ج.م من رقم 01011111111 بنجاح. كود العملية: 112233";
    const parsed = parseSms(smsText, { senderInfo: "e& money" });
    store.recordSmsTransfer(parsed);

    // 1. Bob (attacker) tries to claim Alice's transfer with his own phone -> MUST FAIL
    const bobTopup = store.createAutoTopup("4002", 5000, "wallet", "01104826670");
    const bobClaim = store.verifyAndClaimSmsTopup("4002", bobTopup.id, "01022222222");
    assert.equal(bobClaim.ok, false);
    assert.equal(store.balance("4002"), 0);

    // 2. Alice claims with her correct phone -> MUST SUCCEED
    const aliceClaim = store.verifyAndClaimSmsTopup("4001", aliceTopup.id, "01011111111");
    assert.equal(aliceClaim.ok, true);
    assert.equal(store.balance("4001"), 5000);

    // 3. Double claim attempt by Alice or Bob must be blocked
    const doubleClaim = store.verifyAndClaimSmsTopup("4001", aliceTopup.id, "01011111111");
    assert.equal(doubleClaim.alreadyCredited, true);
    assert.equal(store.balance("4001"), 5000);
  } finally {
    cleanup();
  }
});
