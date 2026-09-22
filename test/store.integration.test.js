"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { SecretBox } = require("../src/SecretBox");
const { openStoreDatabase } = require("../src/StoreDatabase");
const { StoreService } = require("../src/StoreService");
const { parseSms } = require("../src/SmsParser");
const { handleCallback, handleMessage } = require("../src/bot");
const { bootstrapSuperAdmins } = require("../bin/m-automation-bot");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "m-automation-store-test-"));
  const db = openStoreDatabase(path.join(directory, "store.db"));
  const store = new StoreService({
    db,
    secretBox: new SecretBox("a".repeat(64)),
  });
  return {
    store,
    cleanup() {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function makeApi() {
  const calls = [];
  const record = (method) => async (...args) => {
    calls.push({ method, args });
    return true;
  };
  return {
    calls,
    answerCallbackQuery: record("answerCallbackQuery"),
    editMessageText: record("editMessageText"),
    sendDocument: record("sendDocument"),
    sendMessage: record("sendMessage"),
    sendPhoto: record("sendPhoto"),
  };
}

function telegramUser(id, firstName = "User") {
  return { id: Number(id), first_name: firstName, username: `user${id}` };
}

test("bootstrap requires a configured admin only for an uninitialized database", () => {
  const { store, cleanup } = fixture();
  try {
    assert.throws(() => bootstrapSuperAdmins(store, new Set()), /SUPER_ADMIN_IDS/);
    bootstrapSuperAdmins(store, new Set(["100"]));
    assert.equal(store.isSuperAdmin("100"), true);

    store.addSuperAdmin("100", "101", { displayName: "Second owner" });
    store.deactivateSuperAdmin("100", "101");
    bootstrapSuperAdmins(store, new Set(["101"]));
    assert.equal(store.isSuperAdmin("101"), false, "a removed configured admin must not be reactivated on restart");
    assert.throws(() => store.deactivateSuperAdmin("100", "100"), /cannot remove their own role/);
  } finally {
    cleanup();
  }
});

test("merchant ownership, safe role removal, and accurate merchant reports", () => {
  const { store, cleanup } = fixture();
  try {
    store.ensureUser({ id: "1", first_name: "Owner" });
    store.ensureSuperAdmin("1", { displayName: "Owner", addedBy: "1" });
    store.addMerchant("1", "2", { displayName: "Merchant A" });
    store.addMerchant("1", "3", { displayName: "Merchant B" });
    store.ensureUser({ id: "4", first_name: "Buyer" });

    const first = store.createProduct("2", {
      title: "First product",
      pricePiasters: 10000,
      fulfillmentType: "ready_stock",
      status: "active",
    });
    store.addStock("2", first.id, ["first-code", "second-code"]);
    const second = store.createProduct("2", {
      title: "Second product",
      pricePiasters: 5000,
      fulfillmentType: "assisted",
      status: "active",
    });
    const foreign = store.createProduct("3", {
      title: "Foreign product",
      pricePiasters: 5000,
      fulfillmentType: "assisted",
      status: "active",
    });

    assert.throws(() => store.updateProductPrice("2", foreign.id, 6000), /Product not found/);
    store.updateProductPrice("1", foreign.id, 6000);

    store.adminCreditUser("1", "4", 30000, "test credit");
    assert.equal(store.purchase("4", first.id).ok, true);
    assert.equal(store.purchase("4", first.id).ok, true);

    const merchant = store.listMerchants().find((row) => row.telegram_id === "2");
    assert.equal(Number(merchant.product_count), 2);
    assert.equal(Number(merchant.order_count), 2);
    assert.equal(Number(merchant.gross_piasters), 20000);

    const archived = store.deleteProduct("2", first.id);
    assert.equal(archived.status, "archived");
    assert.equal(store.listUserPurchaseHistory("4").length, 2, "archiving must retain purchase history");

    store.deactivateMerchant("1", "2");
    assert.equal(store.isActiveMerchant("2"), false);
    assert.equal(store.getProduct(second.id).status, "paused");
    assert.throws(() => store.addStock("2", first.id, ["cannot-add"]), /Staff account is not active/);
    assert.throws(() => store.createProduct("2", {
      title: "Not allowed",
      pricePiasters: 100,
      fulfillmentType: "assisted",
    }), /Merchant is not active/);
  } finally {
    cleanup();
  }
});

test("manual top-up approval is receipt-gated and idempotent", () => {
  const { store, cleanup } = fixture();
  try {
    store.ensureUser({ id: "1", first_name: "Owner" });
    store.ensureSuperAdmin("1", { displayName: "Owner", addedBy: "1" });
    store.ensureUser({ id: "2", first_name: "Buyer" });

    const topup = store.createManualTopup("2", "wallet", 12500);
    assert.throws(() => store.approveManualTopup("1", topup.id), /awaiting approval/);
    const submitted = store.submitManualTopupProof("2", topup.id, { kind: "photo", fileId: "photo-file-id" });
    assert.equal(submitted.status, "proof_submitted");
    assert.throws(() => store.approveManualTopup("2", topup.id), /Admin permission/);

    const approved = store.approveManualTopup("1", topup.id);
    assert.equal(approved.alreadyApproved, false);
    assert.equal(approved.balance, 12500);
    const repeated = store.approveManualTopup("1", topup.id);
    assert.equal(repeated.alreadyApproved, true);
    assert.equal(store.balance("2"), 12500);

    const rejected = store.createManualTopup("2", "binance", 10000);
    store.submitManualTopupProof("2", rejected.id, { kind: "document", fileId: "document-file-id" });
    const result = store.rejectManualTopup("1", rejected.id, "Amount does not match receipt.");
    assert.equal(result.status, "rejected");
    assert.equal(store.balance("2"), 12500);
  } finally {
    cleanup();
  }
});

test("Telegram receipt flow reaches admins and credits the buyer once", async () => {
  const originalEnv = {
    MANUAL_TOPUPS_ENABLED: process.env.MANUAL_TOPUPS_ENABLED,
    MANUAL_WALLET_RECEIVER: process.env.MANUAL_WALLET_RECEIVER,
    MANUAL_WALLET_INSTRUCTIONS: process.env.MANUAL_WALLET_INSTRUCTIONS,
  };
  process.env.MANUAL_TOPUPS_ENABLED = "true";
  process.env.MANUAL_WALLET_RECEIVER = "01000000000";
  process.env.MANUAL_WALLET_INSTRUCTIONS = "Transfer the exact amount.";

  const { store, cleanup } = fixture();
  try {
    store.ensureUser({ id: "1", first_name: "Owner" });
    store.ensureSuperAdmin("1", { displayName: "Owner", addedBy: "1" });
    const api = makeApi();
    const buyer = telegramUser("2", "Buyer");

    await handleCallback(api, store, new Set(), {
      id: "callback-1",
      from: buyer,
      data: "manual_topup:wallet",
      message: { chat: { id: 2 }, message_id: 10 },
    });
    assert.deepEqual(store.getState("2"), { state: "manual_topup_amount", data: { paymentMethod: "wallet" } });

    await handleMessage(api, store, new Set(), { chat: { id: 2 }, from: buyer, text: "100" });
    const proofState = store.getState("2");
    assert.equal(proofState.state, "manual_topup_proof");

    await handleMessage(api, store, new Set(), {
      chat: { id: 2 },
      from: buyer,
      photo: [{ file_id: "small" }, { file_id: "large" }],
    });
    assert.equal(store.getState("2"), null);
    const pending = store.getManualTopup(proofState.data.topupId);
    assert.equal(pending.status, "proof_submitted");
    assert.ok(api.calls.some((call) => call.method === "sendPhoto" && call.args[0] === "1" && call.args[1] === "large"));

    await handleCallback(api, store, new Set(), {
      id: "callback-2",
      from: telegramUser("1", "Owner"),
      data: `admin:approve_manual_topup:${pending.id}`,
      message: { chat: { id: 1 }, message_id: 11 },
    });
    assert.equal(store.balance("2"), 10000);

    await handleCallback(api, store, new Set(), {
      id: "callback-3",
      from: telegramUser("1", "Owner"),
      data: `admin:approve_manual_topup:${pending.id}`,
      message: { chat: { id: 1 }, message_id: 12 },
    });
    assert.equal(store.balance("2"), 10000, "repeated callback must not credit twice");
  } finally {
    cleanup();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("user language switcher updates preference and adjusts menu language", async () => {
  const { store, cleanup } = fixture();
  try {
    const user = telegramUser("5", "ArabicUser");
    store.ensureUser(user);

    assert.equal(store.getUserLanguage("5"), "ar", "Default language must be Arabic");

    store.setUserLanguage("5", "en");
    assert.equal(store.getUserLanguage("5"), "en", "User language must be updated to English");

    const api = makeApi();

    // Trigger language menu via callback
    await handleCallback(api, store, new Set(), {
      id: "callback-lang-menu",
      from: user,
      data: "main:language",
      message: { chat: { id: 5 }, message_id: 20 },
    });

    assert.ok(
      api.calls.some((c) => c.method === "editMessageText" || c.method === "sendMessage"),
      "Language menu must send or edit message"
    );

    // Switch back to Arabic via callback
    await handleCallback(api, store, new Set(), {
      id: "callback-lang-ar",
      from: user,
      data: "lang:ar",
      message: { chat: { id: 5 }, message_id: 21 },
    });

    assert.equal(store.getUserLanguage("5"), "ar", "Callback lang:ar must set language to Arabic");
    assert.ok(
      api.calls.some((c) => c.method === "answerCallbackQuery" && c.args[0] === "callback-lang-ar"),
      "Callback query must be answered"
    );

    // Switch to English via callback
    await handleCallback(api, store, new Set(), {
      id: "callback-lang-en",
      from: user,
      data: "lang:en",
      message: { chat: { id: 5 }, message_id: 22 },
    });

    assert.equal(store.getUserLanguage("5"), "en", "Callback lang:en must set language to English");
  } finally {
    cleanup();
  }
});

test("maintenance mode blocks normal users but allows super admins", async () => {
  const { store, cleanup } = fixture();
  try {
    const admin = telegramUser("1", "Admin");
    const normalUser = telegramUser("10", "Normal");
    store.ensureUser(admin);
    store.ensureSuperAdmin("1", { displayName: "Admin" });
    store.ensureUser(normalUser);

    assert.equal(store.getMaintenanceMode(), false);
    store.setMaintenanceMode(true);
    assert.equal(store.getMaintenanceMode(), true);

    const api = makeApi();
    const superAdmins = new Set(["1"]);

    // Normal user message when maintenance mode is active
    await handleMessage(api, store, superAdmins, { chat: { id: 10 }, from: normalUser, text: "🛒 المنتجات" });
    assert.ok(
      api.calls.some((c) => c.method === "sendMessage" && c.args[1].includes("تحت الصيانة")),
      "Normal user must receive maintenance alert"
    );

    // Admin message when maintenance mode is active
    api.calls.length = 0;
    await handleMessage(api, store, superAdmins, { chat: { id: 1 }, from: admin, text: "⚙️ لوحة الإدارة" });
    assert.ok(
      api.calls.some((c) => c.method === "sendMessage" || c.method === "editMessageText"),
      "Super admin must still access bot during maintenance"
    );
  } finally {
    cleanup();
  }
});

test("topup selection displays wallet and binance receiver details", async () => {
  const originalEnv = {
    MANUAL_WALLET_RECEIVER: process.env.MANUAL_WALLET_RECEIVER,
    MANUAL_BINANCE_RECEIVER: process.env.MANUAL_BINANCE_RECEIVER,
  };
  process.env.MANUAL_WALLET_RECEIVER = "01099998888";
  process.env.MANUAL_BINANCE_RECEIVER = "987654321";

  const { store, cleanup } = fixture();
  try {
    const user = telegramUser("20", "TopupUser");
    store.ensureUser(user);
    const api = makeApi();

    // Select wallet topup
    await handleCallback(api, store, new Set(), {
      id: "callback-topup-wallet",
      from: user,
      data: "topup_select:wallet",
      message: { chat: { id: 20 }, message_id: 30 },
    });
    assert.ok(
      api.calls.some((c) => (c.method === "editMessageText" || c.method === "sendMessage") && String(c.args[2] || c.args[1]).includes("01099998888")),
      "Wallet receiver number must be displayed"
    );

    // Select binance topup
    api.calls.length = 0;
    await handleCallback(api, store, new Set(), {
      id: "callback-topup-binance",
      from: user,
      data: "topup_select:binance",
      message: { chat: { id: 20 }, message_id: 31 },
    });
    assert.ok(
      api.calls.some((c) => (c.method === "editMessageText" || c.method === "sendMessage") && String(c.args[2] || c.args[1]).includes("987654321")),
      "Binance Pay ID must be displayed"
    );
  } finally {
    cleanup();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("sms transfer parsing, duplicate prevention, and strict single-use claim security", () => {
  const { store, cleanup } = fixture();
  try {
    store.ensureUser({ id: "10", first_name: "Alice" });
    store.ensureUser({ id: "20", first_name: "Attacker Bob" });

    // 1. Test SMS parser with Egyptian Vodafone Cash
    const rawSms = "تم استلام مبلغ 150.00 جنيه من 01012345678 بنجاح في محفظة فودافون كاش. رقم العملية: 987654321.";
    const parsed = parseSms(rawSms);
    assert.ok(parsed);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.amountPiasters, 15000);
    assert.equal(parsed.senderPhone, "01012345678");
    assert.equal(parsed.trxId, "vf_987654321");

    // 2. Record the SMS transfer
    const rec1 = store.recordSmsTransfer(parsed);
    assert.equal(rec1.duplicate, false);
    assert.equal(rec1.transfer.status, "unclaimed");

    // 3. Re-recording the exact same SMS transfer MUST be flagged duplicate
    const rec2 = store.recordSmsTransfer(parsed);
    assert.equal(rec2.duplicate, true, "Same transaction ID must be rejected as duplicate");

    // 4. Alice creates a top-up for 150 EGP (15000 piasters)
    const aliceTopup = store.createAutoTopup("10", 15000, "wallet", "01000000000");
    assert.equal(aliceTopup.status, "pending");

    // 5. Alice claims it with the matching sender number (even with international/Arabic format)
    const claimResult = store.verifyAndClaimSmsTopup("10", aliceTopup.id, "+201012345678");
    assert.equal(claimResult.ok, true);
    assert.equal(claimResult.balance, 15000, "Alice balance must be credited exactly 150 EGP");
    assert.equal(store.balance("10"), 15000);

    // 6. Double claim by Alice on the same top-up is idempotent and doesn't add more money
    const aliceAgain = store.verifyAndClaimSmsTopup("10", aliceTopup.id, "01012345678");
    assert.equal(aliceAgain.alreadyCredited, true);
    assert.equal(store.balance("10"), 15000, "Balance must not increase on repeat calls");

    // 7. Attacker Bob tries to claim the SAME transfer with another topup
    const bobTopup = store.createAutoTopup("20", 15000, "wallet", "01000000000");
    const bobClaim = store.verifyAndClaimSmsTopup("20", bobTopup.id, "01012345678");
    assert.equal(bobClaim.ok, false, "Bob must NOT be able to claim a transfer already claimed by Alice");
    assert.equal(store.balance("20"), 0, "Bob balance must remain 0");

    // 8. Verify ledger has exactly 1 entry for this transfer
    const aliceLedger = store.ledger("10");
    assert.equal(aliceLedger.length, 1);
    assert.equal(aliceLedger[0].idempotency_key, "sms_topup:vf_987654321");
  } finally {
    cleanup();
  }
});

test("auto-credit pending topup when SMS arrives later via webhook", () => {
  const { store, cleanup } = fixture();
  try {
    store.ensureUser({ id: "30", first_name: "Charlie" });

    // Charlie creates topup and enters his phone number FIRST
    const charlieTopup = store.createAutoTopup("30", 5000, "wallet", "01000000000");

    // Charlie submits his sender phone number (currently no transfer yet)
    const attempt1 = store.verifyAndClaimSmsTopup("30", charlieTopup.id, "01098765432");
    assert.equal(attempt1.ok, false);
    assert.equal(store.balance("30"), 0);

    // Now the SMS arrives from Vodafone Cash
    const rawSms = "تم استلام مبلغ 50.00 جنيه من 01098765432 بنجاح. كود العملية: 5544332211.";
    const parsed = parseSms(rawSms);
    assert.ok(parsed);

    // Webhook records SMS
    store.recordSmsTransfer(parsed);

    // Webhook checks findPendingTopupForSms
    const pending = store.findPendingTopupForSms(parsed.senderPhone, parsed.amountPiasters);
    assert.ok(pending, "Must find Charlie's pending topup");
    assert.equal(pending.user_id, "30");

    // Webhook executes claim
    const autoClaim = store.verifyAndClaimSmsTopup(pending.user_id, pending.id, parsed.senderPhone);
    assert.equal(autoClaim.ok, true);
    assert.equal(store.balance("30"), 5000);
  } finally {
    cleanup();
  }
});



