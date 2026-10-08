"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { SecretBox } = require("../src/SecretBox");
const { openStoreDatabase } = require("../src/StoreDatabase");
const { StoreService } = require("../src/StoreService");
const { handleCallback, handleMessage } = require("../src/bot");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "m-automation-quantity-test-"));
  const db = openStoreDatabase(path.join(directory, "store.db"));
  const store = new StoreService({
    db,
    secretBox: new SecretBox("a".repeat(64)),
  });
  return {
    store,
    db,
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

test("StoreService: purchase with quantity > 1 reserves multiple stock items and deducts total correctly", () => {
  const { store, cleanup } = fixture();
  try {
    const adminId = "1001";
    const buyerId = "2001";
    store.ensureSuperAdmin(adminId, { displayName: "Admin" });
    store.ensureUser(telegramUser(buyerId, "Buyer"));

    // Create product with 5 stock items (price 50 EGP = 5000 piasters each)
    const product = store.createProduct(adminId, {
      title: "Netflix Gift Card",
      category: "Gift Cards",
      pricePiasters: 5000,
      fulfillmentType: "ready_stock",
    });
    store.addStock(adminId, product.id, [
      "CARD-AAA-111",
      "CARD-BBB-222",
      "CARD-CCC-333",
      "CARD-DDD-444",
      "CARD-EEE-555",
    ]);

    assert.equal(store.getProduct(product.id).available_stock, 5);

    // Credit buyer with 200 EGP (20,000 piasters)
    store.adminCreditUser(adminId, buyerId, 20000, "Initial balance");
    assert.equal(store.balance(buyerId), 20000);

    // Purchase 3 items
    const result = store.purchase(buyerId, product.id, { quantity: 3 });
    assert.equal(result.ok, true);
    assert.equal(result.order.quantity, 3);
    assert.equal(result.order.unit_price_piasters, 5000);
    assert.equal(result.order.total_piasters, 15000);
    assert.equal(result.balance, 5000);
    assert.equal(store.getProduct(product.id).available_stock, 2);

    // Delivery text should contain all 3 codes
    assert.match(result.deliveryText, /CARD-AAA-111/);
    assert.match(result.deliveryText, /CARD-BBB-222/);
    assert.match(result.deliveryText, /CARD-CCC-333/);

    // Trying to purchase 3 more items should fail with sold_out / insufficient stock (only 2 left)
    const failResult = store.purchase(buyerId, product.id, { quantity: 3 });
    assert.equal(failResult.ok, false);
    assert.equal(failResult.reason, "sold_out");
    assert.equal(failResult.available, 2);

    // Refund order restores all 3 items to stock
    const refund = store.adminRefundOrder(adminId, result.order.id, "Test refund");
    assert.equal(refund.refunded, true);
    assert.equal(store.getProduct(product.id).available_stock, 5);
    assert.equal(store.balance(buyerId), 20000);
  } finally {
    cleanup();
  }
});

test("Bot: interactive quantity selection and wallet checkout flow", async () => {
  const { store, cleanup } = fixture();
  try {
    const adminId = "1001";
    const buyerId = "2001";
    store.ensureSuperAdmin(adminId, { displayName: "Admin" });
    store.ensureUser(telegramUser(buyerId, "Buyer"));

    const product = store.createProduct(adminId, {
      title: "PlayStation Plus 1 Month",
      category: "Gaming",
      pricePiasters: 10000,
      fulfillmentType: "ready_stock",
    });
    store.addStock(adminId, product.id, ["PSN-KEY-1", "PSN-KEY-2", "PSN-KEY-3"]);

    store.adminCreditUser(adminId, buyerId, 25000, "Credit 250 EGP");

    const api = makeApi();

    // 1. User clicks buy:product.id -> opens checkout menu
    await handleCallback(api, store, [adminId], {
      id: "cb1",
      from: telegramUser(buyerId),
      message: { message_id: 11, chat: { id: Number(buyerId) } },
      data: `buy:${product.id}`,
    });

    const lastCall1 = api.calls[api.calls.length - 1];
    assert.equal(lastCall1.method, "editMessageText");
    assert.match(lastCall1.args[2], /تحديد الكمية وطريقة الدفع/);
    assert.match(lastCall1.args[2], /الكمية المحددة/);
    assert.match(lastCall1.args[2], /1\*\* قطعة/);

    // 2. User increases quantity to 2
    await handleCallback(api, store, [adminId], {
      id: "cb2",
      from: telegramUser(buyerId),
      message: { message_id: 11, chat: { id: Number(buyerId) } },
      data: `buy_qty:${product.id}:2`,
    });

    const lastCall2 = api.calls[api.calls.length - 1];
    assert.equal(lastCall2.method, "editMessageText");
    assert.match(lastCall2.args[2], /الكمية المحددة/);
    assert.match(lastCall2.args[2], /2\*\* قطعة/);
    assert.match(lastCall2.args[2], /200 EGP/);

    // 3. User clicks pay_wallet with quantity 2
    await handleCallback(api, store, [adminId], {
      id: "cb3",
      from: telegramUser(buyerId),
      message: { message_id: 11, chat: { id: Number(buyerId) } },
      data: `pay_wallet:${product.id}:2`,
    });

    // Check delivery message
    const sendCalls = api.calls.filter((c) => c.method === "sendMessage");
    const deliveryCall = sendCalls[sendCalls.length - 1];
    assert.match(deliveryCall.args[1], /تم إتمام الشراء بنجاح/);
    assert.match(deliveryCall.args[1], /الكمية: 2 قطعة/);
    assert.match(deliveryCall.args[1], /PSN-KEY-1/);
    assert.match(deliveryCall.args[1], /PSN-KEY-2/);

    assert.equal(store.getProduct(product.id).available_stock, 1);
    assert.equal(store.balance(buyerId), 5000);
  } finally {
    cleanup();
  }
});

test("Bot: direct payment menu does not include manual receipt proof and fulfills automatically via wallet SMS", async () => {
  const { store, cleanup } = fixture();
  try {
    const adminId = "1001";
    const buyerId = "2001";
    store.ensureSuperAdmin(adminId, { displayName: "Admin" });
    store.ensureUser(telegramUser(buyerId, "Buyer"));

    const product = store.createProduct(adminId, {
      title: "Steam Wallet 50 USD",
      category: "Steam",
      pricePiasters: 8000,
      fulfillmentType: "ready_stock",
    });
    store.addStock(adminId, product.id, ["STEAM-A1", "STEAM-B2"]);

    const api = makeApi();

    // 1. User clicks pay_direct:product.id:2
    await handleCallback(api, store, [adminId], {
      id: "cb1",
      from: telegramUser(buyerId),
      message: { message_id: 12, chat: { id: Number(buyerId) } },
      data: `pay_direct:${product.id}:2`,
    });

    const menuCall = api.calls[api.calls.length - 1];
    assert.equal(menuCall.method, "editMessageText");
    const keyboard = menuCall.args[3].reply_markup.inline_keyboard;
    const allButtonsText = keyboard.flat().map((b) => b.text).join(" ");
    const allButtonsData = keyboard.flat().map((b) => b.callback_data).join(" ");

    // Ensure NO manual receipt / image proof option is shown
    assert.doesNotMatch(allButtonsText, /إثبات|صورة|ايصال|إيصال/);
    assert.doesNotMatch(allButtonsData, /receipt/);

    // 2. User selects direct payment via wallet
    await handleCallback(api, store, [adminId], {
      id: "cb2",
      from: telegramUser(buyerId),
      message: { message_id: 12, chat: { id: Number(buyerId) } },
      data: `direct_pay:wallet:${product.id}:2`,
    });

    assert.equal(store.getState(buyerId).state, "direct_order_phone");

    // Simulate SMS arrival for 160 EGP (16000 piasters) from 01012345678
    store.recordSmsTransfer({
      sender: "VF-Cash",
      senderPhone: "01012345678",
      amountPiasters: 16000,
      trxId: "vf_direct_order_test_99",
      rawSms: "تم استلام 160 جنيه من 01012345678",
    });

    // 3. Buyer sends their phone number
    await handleMessage(api, store, [adminId], {
      chat: { id: Number(buyerId) },
      from: telegramUser(buyerId),
      text: "01012345678",
    });

    // Check that buyer received delivery of both keys automatically without manual approval
    const buyerMessages = api.calls.filter((c) => c.method === "sendMessage" && String(c.args[0]) === buyerId);
    const buyerDelivery = buyerMessages[buyerMessages.length - 1];
    assert.match(buyerDelivery.args[1], /تم إتمام الشراء بنجاح/);
    assert.match(buyerDelivery.args[1], /الكمية: 2 قطعة/);
    assert.match(buyerDelivery.args[1], /STEAM-A1/);
    assert.match(buyerDelivery.args[1], /STEAM-B2/);

    assert.equal(store.getProduct(product.id).available_stock, 0);
  } finally {
    cleanup();
  }
});
