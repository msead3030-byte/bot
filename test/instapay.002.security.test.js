"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { SecretBox } = require("../src/SecretBox");
const { openStoreDatabase } = require("../src/StoreDatabase");
const { StoreService } = require("../src/StoreService");
const { parseSms, isNameMatch, normalizePhoneNumber, normalizeSenderName } = require("../src/SmsParser");
const { SmsWebhookServer } = require("../src/SmsWebhookServer");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "instapay-security-test-"));
  const db = openStoreDatabase(path.join(directory, "store.db"));
  const store = new StoreService({
    db,
    secretBox: new SecretBox("c".repeat(64)),
  });
  return {
    store,
    cleanup() {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("normalizePhoneNumber handles 002 Egypt code, +20, local 01, and missing zeros correctly", () => {
  // Local 11 digits
  assert.equal(normalizePhoneNumber("01012345678"), "01012345678");
  assert.equal(normalizePhoneNumber("01104826670"), "01104826670");
  assert.equal(normalizePhoneNumber("01234567890"), "01234567890");
  assert.equal(normalizePhoneNumber("01555555555"), "01555555555");

  // With 002 Egypt prefix (14 digits)
  assert.equal(normalizePhoneNumber("00201012345678"), "01012345678");
  assert.equal(normalizePhoneNumber("00201104826670"), "01104826670");

  // With 002 Egypt prefix without leading 0 (13 digits: 002 + 10...)
  assert.equal(normalizePhoneNumber("0021012345678"), "01012345678");

  // With +20 prefix
  assert.equal(normalizePhoneNumber("+201012345678"), "01012345678");
  assert.equal(normalizePhoneNumber("+2001012345678"), "01012345678");

  // With 20 prefix
  assert.equal(normalizePhoneNumber("201012345678"), "01012345678");

  // Arabic numerals
  assert.equal(normalizePhoneNumber("٠٠٢٠١٠١٢٣٤٥٦٧٨"), "01012345678");
  assert.equal(normalizePhoneNumber("٠١٠١٢٣٤٥٦٧٨"), "01012345678");

  // Spaces and formatting
  assert.equal(normalizePhoneNumber("002 010 1234 5678"), "01012345678");
  assert.equal(normalizePhoneNumber("+20-10-1234-5678"), "01012345678");
});

test("isNameMatch transliteration handles Arabic name matching English bank SMS name", () => {
  // Arabic input vs English bank name
  assert.equal(isNameMatch("أحمد علي", "AHMED ALI MOHAMED"), true);
  assert.equal(isNameMatch("احمد علي", "AHMED ALI"), true);
  assert.equal(isNameMatch("محمد محمود", "MOHAMED MAHMOUD HASSAN"), true);
  assert.equal(isNameMatch("حسام حسن", "HOSSAM HASSAN"), true);
  assert.equal(isNameMatch("مصطفى كامل", "MOSTAFA KAMEL"), true);
  assert.equal(isNameMatch("مروان سالم", "MARWAN SALEM"), true);

  // English input vs Arabic bank name
  assert.equal(isNameMatch("Ahmed Ali", "أحمد علي إبراهيم"), true);

  // Compound names
  assert.equal(isNameMatch("عبد الرحمن", "عبدالرحمن احمد"), true);
  assert.equal(isNameMatch("عبد الله", "عبدالله محمد"), true);
});

test("InstaPay SMS with phone starting with 002: verifies by name AND by phone (with or without 002)", () => {
  const { store, cleanup } = fixture();
  try {
    const userId = "777888";
    store.ensureUser({ id: userId, first_name: "Customer" });

    // Customer creates topup for 100 EGP
    const topup = store.createAutoTopup(userId, 10000, "instapay", "01104826670");

    // Incoming SMS from bank/wallet containing name AND phone starting with 002
    const smsText = "تم استلام مبلغ 100.00 جنيه من أحمد علي (00201012345678) بواسطة انستاباي بنجاح. رقم العملية: 88776655.";
    const parsed = parseSms(smsText);
    assert.ok(parsed);
    assert.equal(parsed.amountPiasters, 10000);
    assert.equal(parsed.senderPhone, "01012345678");
    assert.equal(isNameMatch("أحمد علي", parsed.senderName), true);

    const record = store.recordSmsTransfer(parsed);
    assert.equal(record.duplicate, false);

    // 1. Verification by Name works!
    const claimByName = store.verifyAndClaimInstaPayTopup(userId, topup.id, "أحمد علي");
    assert.equal(claimByName.ok, true);
    assert.equal(claimByName.balance, 10000);
    assert.equal(claimByName.topup.status, "succeeded");
  } finally {
    cleanup();
  }
});

test("InstaPay SMS with only phone number (002...): verifies if user enters phone with 002 OR local 01", () => {
  const { store, cleanup } = fixture();
  try {
    const user1 = "111";
    store.ensureUser({ id: user1, first_name: "User1" });
    const topup1 = store.createAutoTopup(user1, 5000, "instapay", "01104826670");

    // SMS has only phone number starting with 002 (no name)
    const smsText1 = "تم استلام مبلغ 50.00 جنيه من 00201099887766 بواسطة انستاباي بنجاح رقم العملية 1234567";
    const parsed1 = parseSms(smsText1);
    assert.ok(parsed1);
    assert.equal(parsed1.senderPhone, "01099887766");
    store.recordSmsTransfer(parsed1);

    // User verifies with 002 Egypt code:
    const claim1 = store.verifyAndClaimInstaPayTopup(user1, topup1.id, "00201099887766");
    assert.equal(claim1.ok, true);
    assert.equal(claim1.balance, 5000);

    // Another user tests verifying with local 01 number when SMS has 002:
    const user2 = "222";
    store.ensureUser({ id: user2, first_name: "User2" });
    const topup2 = store.createAutoTopup(user2, 7500, "instapay", "01104826670");

    const smsText2 = "تم استلام مبلغ 75.00 جنيه من 00201122334455 عبر انستاباي رقم العملية: 9876543";
    const parsed2 = parseSms(smsText2);
    assert.ok(parsed2);
    store.recordSmsTransfer(parsed2);

    // User enters local 01 number (without 002):
    const claim2 = store.verifyAndClaimInstaPayTopup(user2, topup2.id, "01122334455");
    assert.equal(claim2.ok, true);
    assert.equal(claim2.balance, 7500);
  } finally {
    cleanup();
  }
});

test("Security: Anti-double-spending & single claim guarantee", () => {
  const { store, cleanup } = fixture();
  try {
    const user1 = "10001";
    const user2 = "10002";
    store.ensureUser({ id: user1, first_name: "Victim" });
    store.ensureUser({ id: user2, first_name: "Attacker" });

    const topup1 = store.createAutoTopup(user1, 10000, "instapay", "01104826670");
    const topup2 = store.createAutoTopup(user2, 10000, "instapay", "01104826670");

    const smsText = "تم استلام مبلغ 100.00 جنيه من 00201011112222 بواسطة انستاباي رقم العملية: 445566";
    const parsed = parseSms(smsText);
    store.recordSmsTransfer(parsed);

    // User 1 claims the transfer
    const claim1 = store.verifyAndClaimInstaPayTopup(user1, topup1.id, "01011112222");
    assert.equal(claim1.ok, true);
    assert.equal(store.balance(user1), 10000);

    // User 1 attempts to claim again: returns alreadyCredited without double crediting
    const claim1Again = store.verifyAndClaimInstaPayTopup(user1, topup1.id, "01011112222");
    assert.equal(claim1Again.alreadyCredited, true);
    assert.equal(store.balance(user1), 10000); // Balance stays 10000

    // Attacker tries to claim the same transfer: REJECTED!
    const claim2 = store.verifyAndClaimInstaPayTopup(user2, topup2.id, "01011112222");
    assert.equal(claim2.ok, false);
    assert.equal(store.balance(user2), 0); // Attacker gets 0!
  } finally {
    cleanup();
  }
});

test("Security: Anti-spoofing rejects fake SMS originating from personal mobile numbers", async () => {
  const { store, cleanup } = fixture();
  try {
    const server = new SmsWebhookServer({ store, api: null });

    // Simulate an attacker sending an SMS to the phone from personal mobile 01099999999
    // with text imitating a Vodafone Cash notification:
    const fakeText = "تم استلام مبلغ 500.00 جنيه من 01099999999 بنجاح في محفظة فودافون كاش. رقم العملية: 99887766.";
    const result = await server._processSmsText(fakeText, null, "01099999999", "01099999999");

    // Must be rejected with 403 / spoofing error:
    assert.equal(result.ok, false);
    assert.match(result.error, /personal mobile SIM/);

    // Verify nothing was recorded into database:
    const transfers = store.listRecentSmsTransfers(10);
    assert.equal(transfers.length, 0);
  } finally {
    cleanup();
  }
});
