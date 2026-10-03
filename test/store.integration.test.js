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

test("does NOT credit topup until user matches the sender phone number", () => {
  const { store, cleanup } = fixture();
  try {
    store.ensureUser({ id: "99", first_name: "Tariq" });

    // 1. Tariq creates topup of 100 EGP (10000 piasters)
    const topup = store.createAutoTopup("99", 10000, "wallet", "01104826670");
    assert.equal(topup.status, "pending");
    assert.equal(store.balance("99"), 0);

    // 2. Incoming SMS arrives from 01011112222
    const rawSms = "تم استلام مبلغ 100.00 جنيه من 01011112222 بنجاح في محفظة فودافون كاش. رقم العملية: 9876543210.";
    const parsed = parseSms(rawSms);
    assert.ok(parsed);

    const rec = store.recordSmsTransfer(parsed);
    assert.equal(rec.duplicate, false);

    // 3. Webhook tries to find pending topup: Tariq hasn't entered phone yet -> MUST BE NULL
    const pending = store.findPendingTopupForSms(parsed.senderPhone, parsed.amountPiasters);
    assert.equal(pending, null, "Must NOT auto-credit before user enters phone number");
    assert.equal(store.balance("99"), 0);

    // 4. Tariq enters a WRONG phone number (e.g. 01099999999) -> MUST FAIL
    const wrongClaim = store.verifyAndClaimSmsTopup("99", topup.id, "01099999999");
    assert.equal(wrongClaim.ok, false);
    assert.equal(store.balance("99"), 0);

    // 5. Tariq enters the CORRECT phone number (01011112222) -> MUST SUCCEED
    const correctClaim = store.verifyAndClaimSmsTopup("99", topup.id, "01011112222");
    assert.equal(correctClaim.ok, true);
    assert.equal(store.balance("99"), 10000);
    assert.equal(correctClaim.topup.status, "succeeded");

    // 6. Another attempt to claim with same transfer must NOT credit twice
    const doubleClaim = store.verifyAndClaimSmsTopup("99", topup.id, "01011112222");
    assert.equal(doubleClaim.alreadyCredited, true);
    assert.equal(store.balance("99"), 10000);
  } finally {
    cleanup();
  }
});

test("admin customer log, order log, order search, and refund features", async () => {
  const { store, cleanup } = fixture();
  try {
    const adminId = "100";
    const merchantId = "200";
    const clientA = "301";
    const clientB = "302";

    store.ensureUser({ id: adminId, first_name: "Boss Admin", username: "boss" });
    store.ensureSuperAdmin(adminId, { displayName: "Boss Admin", addedBy: adminId });
    store.ensureUser({ id: merchantId, first_name: "Merchant Store", username: "merchant" });
    store.addMerchant(adminId, merchantId, { displayName: "Store Merchant" });
    store.ensureUser({ id: clientA, first_name: "Ahmed", last_name: "Ali", username: "ahmed_ali" });
    store.ensureUser({ id: clientB, first_name: "Mohamed", last_name: "Hassan", username: "mohamed_h" });

    // 1. Credit clients
    store.adminCreditUser(adminId, clientA, 50000, "Initial deposit A"); // 500 EGP
    store.adminCreditUser(adminId, clientA, 25000, "Second deposit A"); // 250 EGP
    store.adminCreditUser(adminId, clientB, 30000, "Initial deposit B"); // 300 EGP

    assert.equal(store.balance(clientA), 75000);
    assert.equal(store.balance(clientB), 30000);

    // 2. Create products
    const readyProd = store.createProduct(merchantId, {
      title: "Netflix 1 Month",
      category: "Streaming",
      pricePiasters: 20000, // 200 EGP
      fulfillmentType: "ready_stock",
      status: "active",
    });
    store.addStock(merchantId, readyProd.id, ["NETFLIX-CODE-1", "NETFLIX-CODE-2"]);

    const assistProd = store.createProduct(merchantId, {
      title: "ChatGPT Plus Upgrade",
      category: "AI",
      pricePiasters: 40000, // 400 EGP
      fulfillmentType: "assisted",
      status: "active",
    });

    // 3. Client A purchases ready product and assisted product
    const order1 = store.purchase(clientA, readyProd.id);
    assert.equal(order1.ok, true);
    assert.equal(order1.order.status, "completed");

    const order2 = store.purchase(clientA, assistProd.id, { userInput: "user@example.com / pass123" });
    assert.equal(order2.ok, true);
    assert.equal(order2.order.status, "awaiting_delivery");

    // Client A balance: 75000 - 20000 - 40000 = 15000 (150 EGP)
    assert.equal(store.balance(clientA), 15000);

    // 4. Verify listCustomers
    const { total, customers } = store.listCustomers();
    assert.equal(total >= 2, true);
    const foundA = customers.find((c) => c.telegram_id === clientA);
    assert.ok(foundA);
    assert.equal(foundA.total_recharged, 75000);
    assert.equal(foundA.current_balance, 15000);
    assert.equal(foundA.order_count, 2);
    assert.equal(foundA.total_spent, 60000);

    // Test search in listCustomers
    const searchRes = store.listCustomers({ search: "ahmed_ali" });
    assert.equal(searchRes.total, 1);
    assert.equal(searchRes.customers[0].telegram_id, clientA);

    // 5. Verify getCustomerDetails
    const detailsA = store.getCustomerDetails(clientA);
    assert.equal(detailsA.balance, 15000);
    assert.equal(detailsA.total_recharged, 75000);
    assert.equal(detailsA.total_spent, 60000);
    assert.equal(detailsA.order_count, 2);
    assert.equal(detailsA.recentOrders.length, 2);
    assert.equal(detailsA.recentDeposits.length, 2);

    // 6. Verify listAllOrders
    const allOrders = store.listAllOrders({ status: "all" });
    assert.equal(allOrders.total >= 2, true);

    const pendingOrders = store.listAllOrders({ status: "awaiting_delivery" });
    assert.equal(pendingOrders.total >= 1, true);
    assert.equal(pendingOrders.orders[0].id, order2.order.id);

    // 7. Verify searchOrder
    // By ID
    const foundById = store.searchOrder(String(order2.order.id));
    assert.ok(foundById);
    assert.equal(foundById.id, order2.order.id);
    assert.equal(foundById.user_input_text, "user@example.com / pass123");

    // By #ID
    const foundByHashId = store.searchOrder(`#${order2.order.id}`);
    assert.ok(foundByHashId);
    assert.equal(foundByHashId.id, order2.order.id);

    // By Ref
    const foundByRef = store.searchOrder(order1.order.order_ref);
    assert.ok(foundByRef);
    assert.equal(foundByRef.id, order1.order.id);

    // 8. Admin Refund order2 (assisted order)
    const refundResult = store.adminRefundOrder(adminId, order2.order.id, "Testing admin refund");
    assert.equal(refundResult.refunded, true);
    assert.equal(refundResult.order.status, "cancelled");
    // Client A balance was 15000 + 40000 = 55000 (550 EGP)
    assert.equal(refundResult.newBalance, 55000);
    assert.equal(store.balance(clientA), 55000);

    // Double refund must throw
    assert.throws(() => store.adminRefundOrder(adminId, order2.order.id), /ملغي ومسترجع/);

    // 9. Test Bot UI callbacks
    const api = makeApi();
    const superAdmins = new Set([adminId]);

    // Test admin:customers callback
    await handleCallback(api, store, superAdmins, {
      id: "cb_1",
      data: "admin:customers:0",
      from: telegramUser(adminId, "Boss"),
      message: { message_id: 11, chat: { id: Number(adminId) } },
    });
    assert.ok(api.calls.some((c) => c.method === "editMessageText" && c.args[2].includes("سجل العملاء والأرصدة")));

    // Test admin:customer_view callback
    await handleCallback(api, store, superAdmins, {
      id: "cb_2",
      data: `admin:customer_view:${clientA}`,
      from: telegramUser(adminId, "Boss"),
      message: { message_id: 12, chat: { id: Number(adminId) } },
    });
    assert.ok(api.calls.some((c) => c.method === "editMessageText" && c.args[2].includes("ملف العميل")));

    // Test admin:orders callback
    await handleCallback(api, store, superAdmins, {
      id: "cb_3",
      data: "admin:orders:all:0",
      from: telegramUser(adminId, "Boss"),
      message: { message_id: 13, chat: { id: Number(adminId) } },
    });
    assert.ok(api.calls.some((c) => c.method === "editMessageText" && c.args[2].includes("سجل جميع الطلبات")));

    // Test admin:order_view callback
    await handleCallback(api, store, superAdmins, {
      id: "cb_4",
      data: `admin:order_view:${order1.order.id}`,
      from: telegramUser(adminId, "Boss"),
      message: { message_id: 14, chat: { id: Number(adminId) } },
    });
    assert.ok(api.calls.some((c) => c.method === "editMessageText" && c.args[2].includes("تفاصيل الطلب")));
  } finally {
    cleanup();
  }
});

test("Binance Pay top-up displays UID 1221301796 and contact support flow", async () => {
  const { store, cleanup } = fixture();
  try {
    const user = telegramUser("77", "CryptoUser");
    store.ensureUser(user);

    const api = makeApi();
    await handleCallback(api, store, new Set(), {
      id: "cb_binance",
      data: "auto_topup:binance",
      from: user,
      message: { message_id: 50, chat: { id: 77 } },
    });

    const call = api.calls.find((c) => c.method === "editMessageText");
    assert.ok(call, "Must edit message to show Binance instructions");
    assert.ok(call.args[2].includes("1221301796"), "Must contain Binance UID 1221301796");
    assert.ok(call.args[2].includes("الدعم"), "Must instruct user to contact support");
  } finally {
    cleanup();
  }
});

test("InstaPay transfer to wallet number is matched automatically by SMS amount and sender name", async () => {
  const { store, cleanup } = fixture();
  try {
    const user = telegramUser("88", "InstaUser");
    store.ensureUser(user);

    // 1. User initiates InstaPay topup of 250 EGP
    const topup = store.createAutoTopup("88", 25000, "instapay", "01104826670");
    assert.equal(topup.amount_piasters, 25000);
    assert.equal(topup.status, "pending");

    // 2. An SMS arrives from Vodafone Cash receiving a transfer from an InstaPay account (no phone, just name)
    const rawSms = "تم استلام مبلغ 250.00 جنيه من حسام حسن علي بنجاح في محفظة فودافون كاش. رقم العملية: 5544332211.";
    const parsed = parseSms(rawSms);
    assert.ok(parsed, "SMS should be parsed");
    assert.equal(parsed.amountPiasters, 25000);
    assert.equal(parsed.senderName, "حسام حسن علي");
    assert.equal(parsed.paymentMethod, "instapay");

    // Record incoming SMS into store
    const recordResult = store.recordSmsTransfer(parsed);
    assert.equal(recordResult.duplicate, false);

    // 3. User verifies by providing their name (e.g. "حسام حسن")
    const claimResult = store.verifyAndClaimInstaPayTopup("88", topup.id, "حسام حسن");
    assert.equal(claimResult.ok, true);
    assert.equal(claimResult.balance, 25000);
    assert.equal(store.balance("88"), 25000);

    // 4. Repeated claim returns alreadyCredited: true and does not add double balance
    const repeated = store.verifyAndClaimInstaPayTopup("88", topup.id, "حسام حسن");
    assert.equal(repeated.ok, true);
    assert.equal(repeated.alreadyCredited, true);
    assert.equal(store.balance("88"), 25000);
  } finally {
    cleanup();
  }
});




