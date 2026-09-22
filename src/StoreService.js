"use strict";

const crypto = require("crypto");
const { normalizePhoneNumber } = require("./SmsParser");

const FULFILLMENT_TYPES = new Set(["ready_stock", "assisted"]);
const MANUAL_PAYMENT_METHODS = new Set(["wallet", "binance"]);
const MIN_TOPUP_PIASTERS = 10 * 100;
const MAX_TOPUP_PIASTERS = 5000 * 100;

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, maxLength = 2000) {
  return String(value || "").trim().replace(/\s+\n/g, "\n").slice(0, maxLength);
}

function parseJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function json(value) {
  return JSON.stringify(value || {});
}

function safeTelegramId(value, label = "Telegram ID") {
  const id = String(value || "").trim();
  if (!/^\d+$/.test(id)) throw new Error(`${label} is invalid.`);
  return id;
}

function orderRef(prefix = "ORD") {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function assertPositivePiasters(value, label = "Amount") {
  const amount = Number(value);
  if (!Number.isInteger(amount) || amount <= 0) throw new Error(`${label} must be a positive whole number.`);
  return amount;
}

function assertTopupAmount(amountPiasters) {
  const amount = assertPositivePiasters(amountPiasters, "Top-up amount");
  if (amount < MIN_TOPUP_PIASTERS || amount > MAX_TOPUP_PIASTERS) {
    throw new Error("مبلغ الشحن يجب أن يكون بين 10 و 5,000 جنيه.");
  }
  if (amount % 100 !== 0) throw new Error("يرجى إدخال مبلغ صحيح بالجنيه بدون كسور، مثال: 50 أو 100.");
  return amount;
}

class StoreService {
  constructor(options = {}) {
    this.db = options.db;
    this.secretBox = options.secretBox;
    this.cashupClient = options.cashupClient || null;
    if (!this.db) throw new Error("StoreService requires a database.");
    if (!this.secretBox) throw new Error("StoreService requires SecretBox.");
  }

  ensureUser(from = {}) {
    const id = safeTelegramId(from.id || from.telegram_id || from.telegramId, "User ID");
    const at = nowIso();
    this.db.prepare(`
      INSERT INTO users (telegram_id, username, first_name, last_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        updated_at = excluded.updated_at
    `).run(
      id,
      cleanText(from.username, 80),
      cleanText(from.first_name || from.firstName, 120),
      cleanText(from.last_name || from.lastName, 120),
      at,
      at
    );
    return id;
  }

  getUser(userId) {
    return this.db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(String(userId)) || null;
  }

  getAllUserIds() {
    const rows = this.db.prepare("SELECT telegram_id FROM users").all();
    return rows.map((r) => String(r.telegram_id));
  }

  getUserLanguage(userId) {
    return this.getUser(userId)?.language || "ar";
  }

  setUserLanguage(userId, lang) {
    const id = safeTelegramId(userId, "User ID");
    const value = ["ar", "en"].includes(String(lang)) ? String(lang) : "ar";
    this.db.prepare("UPDATE users SET language = ?, updated_at = ? WHERE telegram_id = ?").run(value, nowIso(), id);
    return value;
  }

  ensureMerchant(telegramId, options = {}) {
    const id = safeTelegramId(telegramId, "Merchant ID");
    const at = nowIso();
    this.db.prepare(`
      INSERT INTO merchants (telegram_id, display_name, status, added_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        display_name = COALESCE(NULLIF(excluded.display_name, ''), merchants.display_name),
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(
      id,
      cleanText(options.displayName || "", 160),
      options.status || "active",
      options.addedBy ? safeTelegramId(options.addedBy, "Admin ID") : "",
      at,
      at
    );
    return this.getMerchant(id);
  }

  getMerchant(telegramId) {
    return this.db.prepare("SELECT * FROM merchants WHERE telegram_id = ?").get(String(telegramId)) || null;
  }

  isActiveMerchant(telegramId) {
    return this.getMerchant(telegramId)?.status === "active";
  }

  listMerchants() {
    return this.db.prepare(`
      SELECT m.*,
        (SELECT COUNT(*) FROM products p WHERE p.merchant_id = m.telegram_id) AS product_count,
        (SELECT COUNT(*) FROM orders o WHERE o.merchant_id = m.telegram_id) AS order_count,
        (SELECT COALESCE(SUM(o.total_piasters), 0) FROM orders o WHERE o.merchant_id = m.telegram_id) AS gross_piasters
      FROM merchants m
      ORDER BY m.status ASC, gross_piasters DESC, m.created_at ASC
    `).all();
  }

  ensureSuperAdmin(telegramId, options = {}) {
    const id = safeTelegramId(telegramId, "Admin ID");
    const at = nowIso();
    this.db.prepare(`
      INSERT INTO super_admins (telegram_id, display_name, status, added_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        display_name = COALESCE(NULLIF(excluded.display_name, ''), super_admins.display_name),
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(
      id,
      cleanText(options.displayName || "", 160),
      options.status || "active",
      options.addedBy ? safeTelegramId(options.addedBy, "Admin ID") : "",
      at,
      at
    );
    this.ensureMerchant(id, {
      displayName: options.displayName || `Admin ${id}`,
      addedBy: options.addedBy || id,
      status: "active",
    });
    return this.getSuperAdmin(id);
  }

  getSuperAdmin(telegramId) {
    return this.db.prepare("SELECT * FROM super_admins WHERE telegram_id = ?").get(String(telegramId)) || null;
  }

  isSuperAdmin(telegramId) {
    return this.getSuperAdmin(telegramId)?.status === "active";
  }

  assertSuperAdmin(telegramId) {
    const id = safeTelegramId(telegramId, "Admin ID");
    if (!this.isSuperAdmin(id)) throw new Error("Admin permission is required.");
    return id;
  }

  assertActiveStaff(telegramId, label = "Staff ID") {
    const id = safeTelegramId(telegramId, label);
    if (!this.isSuperAdmin(id) && !this.isActiveMerchant(id)) throw new Error("Staff account is not active.");
    return id;
  }

  assertProductManager(telegramId, productId) {
    const id = this.assertActiveStaff(telegramId, "Merchant ID");
    const product = this.getProduct(productId);
    if (!product || (product.merchant_id !== id && !this.isSuperAdmin(id))) throw new Error("Product not found.");
    return { id, product };
  }

  listSuperAdmins() {
    return this.db.prepare("SELECT * FROM super_admins ORDER BY status ASC, created_at ASC").all();
  }

  addMerchant(adminId, telegramId, options = {}) {
    const admin = this.assertSuperAdmin(adminId);
    const id = safeTelegramId(telegramId, "Merchant ID");
    if (!this.getUser(id)) this.ensureUser({ id });
    return this.ensureMerchant(id, {
      displayName: options.displayName || "",
      addedBy: admin,
      status: "active",
    });
  }

  addSuperAdmin(adminId, telegramId, options = {}) {
    const admin = this.assertSuperAdmin(adminId);
    const id = safeTelegramId(telegramId, "Admin ID");
    if (!this.getUser(id)) this.ensureUser({ id });
    return this.ensureSuperAdmin(id, {
      displayName: options.displayName || "",
      addedBy: admin,
      status: "active",
    });
  }

  deactivateMerchant(adminId, telegramId) {
    const admin = this.assertSuperAdmin(adminId);
    const id = safeTelegramId(telegramId, "Merchant ID");
    if (this.isSuperAdmin(id)) throw new Error("Remove the admin role before removing this merchant.");
    const merchant = this.getMerchant(id);
    if (!merchant || merchant.status !== "active") throw new Error("Active merchant was not found.");
    const at = nowIso();
    this.db.transaction(() => {
      this.db.prepare("UPDATE merchants SET status = 'inactive', updated_at = ? WHERE telegram_id = ?").run(at, id);
      this.db.prepare("UPDATE products SET status = 'paused', updated_at = ? WHERE merchant_id = ? AND status = 'active'").run(at, id);
    })();
    return { removedBy: admin, merchant: this.getMerchant(id) };
  }

  deactivateSuperAdmin(adminId, telegramId) {
    const admin = this.assertSuperAdmin(adminId);
    const id = safeTelegramId(telegramId, "Admin ID");
    if (id === admin) throw new Error("An admin cannot remove their own role.");
    const target = this.getSuperAdmin(id);
    if (!target || target.status !== "active") throw new Error("Active admin was not found.");
    const activeCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM super_admins WHERE status = 'active'").get().count || 0);
    if (activeCount <= 1) throw new Error("The last active admin cannot be removed.");
    const at = nowIso();
    this.db.transaction(() => {
      this.db.prepare("UPDATE super_admins SET status = 'inactive', updated_at = ? WHERE telegram_id = ?").run(at, id);
      this.db.prepare("UPDATE merchants SET status = 'inactive', updated_at = ? WHERE telegram_id = ?").run(at, id);
      this.db.prepare("UPDATE products SET status = 'paused', updated_at = ? WHERE merchant_id = ? AND status = 'active'").run(at, id);
    })();
    return { removedBy: admin, admin: this.getSuperAdmin(id) };
  }

  resolveUserId(input) {
    const raw = String(input || "").trim().replace(/^@/, "");
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
      const row = this.db.prepare("SELECT telegram_id FROM users WHERE telegram_id = ?").get(raw);
      return row ? row.telegram_id : raw;
    }
    const row = this.db.prepare("SELECT telegram_id FROM users WHERE username = ? COLLATE NOCASE").get(raw);
    return row ? row.telegram_id : null;
  }

  countUsers() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM users").get()?.count || 0);
  }

  listUsers(limit = 20, offset = 0) {
    return this.db.prepare(`
      SELECT telegram_id, username, first_name, last_name, language, created_at
      FROM users
      ORDER BY created_at ASC
      LIMIT ? OFFSET ?
    `).all(Math.max(1, Math.min(50, Number(limit || 20))), Math.max(0, Number(offset || 0)));
  }

  balance(userId) {
    const id = safeTelegramId(userId, "User ID");
    const row = this.db.prepare("SELECT COALESCE(SUM(amount_piasters), 0) AS balance FROM ledger WHERE user_id = ?").get(id);
    return Number(row?.balance || 0);
  }

  ledger(userId, limit = 10) {
    return this.db.prepare(`
      SELECT * FROM ledger
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(safeTelegramId(userId, "User ID"), Math.max(1, Math.min(50, Number(limit || 10))));
  }

  adminCreditUser(adminId, userId, amountPiasters, note = "") {
    const admin = this.assertSuperAdmin(adminId);
    const user = safeTelegramId(userId, "User ID");
    const amount = assertPositivePiasters(amountPiasters, "Credit");
    if (!this.getUser(user)) this.ensureUser({ id: user });
    const at = nowIso();
    this.db.prepare(`
      INSERT INTO ledger (user_id, type, amount_piasters, reference_type, reference_id, idempotency_key, note, created_at)
      VALUES (?, 'admin_credit', ?, 'admin', ?, ?, ?, ?)
    `).run(user, amount, admin, `admin-credit:${admin}:${user}:${at}`, cleanText(note || "Admin credit", 200), at);
    return this.balance(user);
  }

  adminZeroBalance(adminId, userId) {
    const admin = this.assertSuperAdmin(adminId);
    const user = safeTelegramId(userId, "User ID");
    const current = this.balance(user);
    if (current === 0) return 0;
    const at = nowIso();
    this.db.prepare(`
      INSERT INTO ledger (user_id, type, amount_piasters, reference_type, reference_id, idempotency_key, note, created_at)
      VALUES (?, 'admin_zero', ?, 'admin', ?, ?, 'Admin zero balance', ?)
    `).run(user, -current, admin, `admin-zero:${admin}:${user}:${at}`, at);
    return this.balance(user);
  }

  getState(userId) {
    const row = this.db.prepare("SELECT * FROM conversation_state WHERE user_id = ?").get(String(userId));
    if (!row) return null;
    return { state: row.state, data: parseJson(row.data_json, {}) };
  }

  setState(userId, state, data = {}) {
    const id = safeTelegramId(userId, "User ID");
    this.db.prepare(`
      INSERT INTO conversation_state (user_id, state, data_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        state = excluded.state,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `).run(id, state, json(data), nowIso());
  }

  clearState(userId) {
    this.db.prepare("DELETE FROM conversation_state WHERE user_id = ?").run(String(userId));
  }

  async createTopup(userId, amountPiasters) {
    const id = safeTelegramId(userId, "User ID");
    const amount = assertTopupAmount(amountPiasters);
    if (!this.cashupClient) throw new Error("Payment provider is not configured.");
    const ref = orderRef("TOPUP");
    const data = await this.cashupClient.createPaymentIntent({
      productName: `${process.env.STORE_BRAND_NAME || "AI Studio bot"} wallet top-up`,
      amount: amount / 100,
      orderId: ref,
    });
    const paymentIntentId = data.payment_intent_id || data.paymentIntentId || data.id;
    if (!paymentIntentId) throw new Error("Payment provider did not return an ID.");
    const at = nowIso();
    const result = this.db.prepare(`
      INSERT INTO topups (
        user_id, amount_piasters, provider_order_id, payment_intent_id, status,
        receiver_number, instructions, raw_response_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(
      id,
      amount,
      ref,
      String(paymentIntentId),
      cleanText(data.receiverNumber || data.receiver_number || "", 120),
      cleanText(data.instructions || "", 1000),
      json(data),
      at,
      at
    );
    return this.getTopup(result.lastInsertRowid);
  }

  getTopup(topupId) {
    return this.db.prepare("SELECT * FROM topups WHERE id = ?").get(Number(topupId)) || null;
  }

  async validateTopup(userId, topupId, senderIdentifier) {
    const id = safeTelegramId(userId, "User ID");
    const topup = this.getTopup(topupId);
    if (!topup || topup.user_id !== id) throw new Error("Top-up request was not found.");
    if (topup.status === "succeeded") {
      return { ok: true, alreadyCredited: true, topup, balance: this.balance(id) };
    }
    if (topup.status !== "pending") throw new Error("This top-up is no longer pending.");
    if (!this.cashupClient) throw new Error("Payment provider is not configured.");
    const sender = cleanText(senderIdentifier, 180);
    if (!sender) throw new Error("Send the sender number or name.");

    let data;
    try {
      data = await this.cashupClient.validatePaymentIntent(topup.payment_intent_id, sender);
    } catch (error) {
      this.db.prepare(`
        UPDATE topups
        SET sender_identifier = ?, validate_attempts = validate_attempts + 1, last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(sender, cleanText(error.message, 500), nowIso(), topup.id);
      return { ok: false, topup: this.getTopup(topup.id), error: error.message || "Payment not found yet." };
    }

    const succeeded = data?.success === true || data?.status === "succeeded";
    if (!succeeded) {
      this.db.prepare(`
        UPDATE topups
        SET sender_identifier = ?, validate_attempts = validate_attempts + 1, last_error = ?, raw_response_json = ?, updated_at = ?
        WHERE id = ?
      `).run(sender, cleanText(data?.message || "Payment not found yet.", 500), json(data), nowIso(), topup.id);
      return { ok: false, topup: this.getTopup(topup.id), error: data?.message || "Payment not found yet." };
    }

    this.db.transaction(() => {
      const fresh = this.getTopup(topup.id);
      if (fresh.status === "succeeded") return;
      const at = nowIso();
      this.db.prepare(`
        UPDATE topups
        SET status = 'succeeded', sender_identifier = ?, validate_attempts = validate_attempts + 1,
          last_error = '', raw_response_json = ?, updated_at = ?
        WHERE id = ?
      `).run(sender, json(data), at, topup.id);
      this.db.prepare(`
        INSERT OR IGNORE INTO ledger (user_id, type, amount_piasters, reference_type, reference_id, idempotency_key, note, created_at)
        VALUES (?, 'topup', ?, 'topup', ?, ?, 'Wallet top-up', ?)
      `).run(id, topup.amount_piasters, String(topup.id), `topup:${topup.payment_intent_id}`, at);
    })();

    return { ok: true, alreadyCredited: false, topup: this.getTopup(topup.id), balance: this.balance(id), payload: data };
  }

  recordSmsTransfer({ trxId, senderPhone, amountPiasters, provider = "vodafone_cash", rawMessage = "" }) {
    if (!trxId) throw new Error("Transaction ID (trxId) is required.");
    const cleanTrx = cleanText(trxId, 100);
    const existing = this.db.prepare("SELECT * FROM sms_transfers WHERE trx_id = ?").get(cleanTrx);
    if (existing) {
      return { duplicate: true, transfer: existing };
    }

    const normPhone = normalizePhoneNumber(senderPhone);
    const amount = Number(amountPiasters);
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("Valid amount in piasters is required.");
    const at = nowIso();

    const result = this.db.prepare(`
      INSERT INTO sms_transfers (trx_id, sender_phone, amount_piasters, provider, raw_message, status, received_at)
      VALUES (?, ?, ?, ?, ?, 'unclaimed', ?)
    `).run(cleanTrx, normPhone, amount, cleanText(provider, 30), cleanText(rawMessage, 2000), at);

    const transfer = this.db.prepare("SELECT * FROM sms_transfers WHERE id = ?").get(result.lastInsertRowid);
    return { duplicate: false, transfer };
  }

  createAutoTopup(userId, amountPiasters, paymentMethod = "wallet", receiverNumber = "") {
    const user = safeTelegramId(userId, "User ID");
    const amount = assertTopupAmount(amountPiasters);
    if (!this.getUser(user)) this.ensureUser({ id: user });
    const at = nowIso();
    const orderId = orderRef("TOPUP");
    const paymentIntentId = `auto_${crypto.randomBytes(8).toString("hex")}`;

    const result = this.db.prepare(`
      INSERT INTO topups (
        user_id, amount_piasters, provider_order_id, payment_intent_id,
        status, receiver_number, instructions, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(user, amount, orderId, paymentIntentId, cleanText(receiverNumber, 50), cleanText(paymentMethod, 50), at, at);

    return this.getTopup(result.lastInsertRowid);
  }

  verifyAndClaimSmsTopup(userId, topupId, senderPhone) {
    const user = safeTelegramId(userId, "User ID");
    const topup = this.getTopup(topupId);
    if (!topup || topup.user_id !== user) {
      throw new Error("طلب الشحن غير موجود.");
    }
    if (topup.status === "succeeded") {
      return { ok: true, alreadyCredited: true, topup, balance: this.balance(user) };
    }
    if (topup.status !== "pending") {
      throw new Error("طلب الشحن هذا لم يعد معلقاً (تم إلغاؤه أو معالجته مسبقاً).");
    }

    if (Number(topup.validate_attempts || 0) >= 5) {
      throw new Error("تم تجاوز الحد الأقصى للمحاولات (5 محاولات). يرجى التواصل مع الدعم الفني.");
    }

    const normSender = normalizePhoneNumber(senderPhone);
    if (!normSender || normSender.length < 10) {
      throw new Error("يرجى إدخال رقم هاتف محفظة صحيح (مثال: 01012345678).");
    }

    // Save sender number and increment attempts
    this.db.prepare(`
      UPDATE topups
      SET sender_identifier = ?, validate_attempts = validate_attempts + 1, updated_at = ?
      WHERE id = ?
    `).run(normSender, nowIso(), topup.id);

    // Look for matching unclaimed SMS transfer:
    const windowMinutes = Number(process.env.AUTO_TOPUP_EXPIRY_MINUTES || 30);
    const minReceivedAt = new Date(new Date(topup.created_at).getTime() - windowMinutes * 60 * 1000).toISOString();

    const transfer = this.db.prepare(`
      SELECT * FROM sms_transfers
      WHERE status = 'unclaimed'
        AND claimed_by_user_id IS NULL
        AND sender_phone = ?
        AND amount_piasters = ?
        AND received_at >= ?
      ORDER BY id DESC
      LIMIT 1
    `).get(normSender, topup.amount_piasters, minReceivedAt);

    if (!transfer) {
      this.db.prepare(`
        UPDATE topups
        SET last_error = 'لم يتم العثور على تحويل مطابق حتى الآن', updated_at = ?
        WHERE id = ?
      `).run(nowIso(), topup.id);
      return {
        ok: false,
        topup: this.getTopup(topup.id),
        error: "لم يتم العثور على تحويل مطابق بهذا الرقم والمبلغ حتى الآن. يرجى التأكد من إتمام التحويل أو الانتظار ثوانٍ لإعادة المحاولة."
      };
    }

    // Atomic transaction to claim transfer and credit user balance
    let claimedTransfer = null;
    this.db.transaction(() => {
      // Re-verify transfer is still unclaimed inside transaction lock
      const freshTransfer = this.db.prepare(`
        SELECT * FROM sms_transfers
        WHERE id = ? AND status = 'unclaimed' AND claimed_by_user_id IS NULL
      `).get(transfer.id);

      if (!freshTransfer) {
        throw new Error("عذراً، هذا التحويل تم استخدامه بالفعل أو لم يعد متاحاً.");
      }

      const freshTopup = this.getTopup(topup.id);
      if (freshTopup.status === "succeeded") return;

      const at = nowIso();

      // 1. Mark transfer as claimed
      this.db.prepare(`
        UPDATE sms_transfers
        SET status = 'claimed', claimed_by_user_id = ?, claimed_topup_id = ?, claimed_at = ?
        WHERE id = ?
      `).run(user, topup.id, at, transfer.id);

      // 2. Mark topup as succeeded
      this.db.prepare(`
        UPDATE topups
        SET status = 'succeeded', last_error = '', updated_at = ?
        WHERE id = ?
      `).run(at, topup.id);

      // 3. Credit ledger with strict unique idempotency key
      this.db.prepare(`
        INSERT INTO ledger (
          user_id, type, amount_piasters, reference_type, reference_id, idempotency_key, note, created_at
        ) VALUES (?, 'topup', ?, 'sms_transfer', ?, ?, ?, ?)
      `).run(
        user,
        topup.amount_piasters,
        String(transfer.id),
        `sms_topup:${transfer.trx_id}`,
        `شحن رصيد آلي عبر التحويل (${transfer.trx_id})`,
        at
      );

      claimedTransfer = freshTransfer;
    })();

    return {
      ok: true,
      alreadyCredited: false,
      transfer: claimedTransfer || transfer,
      topup: this.getTopup(topup.id),
      balance: this.balance(user),
    };
  }

  findPendingTopupForSms(senderPhone, amountPiasters, receivedAt = nowIso()) {
    const normPhone = normalizePhoneNumber(senderPhone);
    const amount = Number(amountPiasters);
    const windowMinutes = Number(process.env.AUTO_TOPUP_EXPIRY_MINUTES || 30);
    const minCreatedAt = new Date(new Date(receivedAt).getTime() - windowMinutes * 60 * 1000).toISOString();

    return this.db.prepare(`
      SELECT * FROM topups
      WHERE status = 'pending'
        AND sender_identifier = ?
        AND amount_piasters = ?
        AND created_at >= ?
      ORDER BY id DESC
      LIMIT 1
    `).get(normPhone, amount, minCreatedAt) || null;
  }

  listRecentSmsTransfers(limit = 20) {
    return this.db.prepare(`
      SELECT * FROM sms_transfers
      ORDER BY id DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(100, Number(limit) || 20)));
  }

  createManualTopup(userId, paymentMethod, amountPiasters) {
    const user = safeTelegramId(userId, "User ID");
    const method = cleanText(paymentMethod, 20).toLowerCase();
    if (!MANUAL_PAYMENT_METHODS.has(method)) throw new Error("Unsupported manual payment method.");
    const amount = assertTopupAmount(amountPiasters);
    if (!this.getUser(user)) this.ensureUser({ id: user });
    const at = nowIso();
    const result = this.db.prepare(`
      INSERT INTO manual_topups (user_id, payment_method, amount_piasters, status, created_at, updated_at)
      VALUES (?, ?, ?, 'awaiting_proof', ?, ?)
    `).run(user, method, amount, at, at);
    return this.getManualTopup(result.lastInsertRowid);
  }

  getManualTopup(topupId) {
    return this.db.prepare("SELECT * FROM manual_topups WHERE id = ?").get(Number(topupId)) || null;
  }

  submitManualTopupProof(userId, topupId, proof = {}) {
    const user = safeTelegramId(userId, "User ID");
    const topup = this.getManualTopup(topupId);
    if (!topup || topup.user_id !== user) throw new Error("Manual top-up request was not found.");
    if (topup.status !== "awaiting_proof") throw new Error("This manual top-up is no longer awaiting a receipt.");
    const kind = cleanText(proof.kind, 20).toLowerCase();
    const fileId = cleanText(proof.fileId, 300);
    if (!["photo", "document"].includes(kind) || !fileId) throw new Error("Send a valid receipt image or document.");
    const at = nowIso();
    this.db.prepare(`
      UPDATE manual_topups
      SET status = 'proof_submitted', proof_kind = ?, proof_file_id = ?, submitted_at = ?, updated_at = ?
      WHERE id = ?
    `).run(kind, fileId, at, at, topup.id);
    return this.getManualTopup(topup.id);
  }

  approveManualTopup(adminId, topupId) {
    const admin = this.assertSuperAdmin(adminId);
    const id = Number(topupId);
    let approved = null;
    this.db.transaction(() => {
      const topup = this.getManualTopup(id);
      if (!topup) throw new Error("Manual top-up request was not found.");
      if (topup.status === "approved") {
        approved = { topup, alreadyApproved: true, balance: this.balance(topup.user_id) };
        return;
      }
      if (topup.status !== "proof_submitted") throw new Error("This receipt is not awaiting approval.");
      const at = nowIso();
      this.db.prepare(`
        INSERT OR IGNORE INTO ledger (user_id, type, amount_piasters, reference_type, reference_id, idempotency_key, note, created_at)
        VALUES (?, 'manual_topup', ?, 'manual_topup', ?, ?, ?, ?)
      `).run(
        topup.user_id,
        topup.amount_piasters,
        String(topup.id),
        `manual-topup:${topup.id}`,
        `Manual ${topup.payment_method} top-up approved`,
        at
      );
      this.db.prepare(`
        UPDATE manual_topups
        SET status = 'approved', reviewed_by = ?, reviewer_note = '', updated_at = ?
        WHERE id = ?
      `).run(admin, at, topup.id);
      const fresh = this.getManualTopup(topup.id);
      approved = { topup: fresh, alreadyApproved: false, balance: this.balance(fresh.user_id) };
    })();
    return approved;
  }

  rejectManualTopup(adminId, topupId, note = "") {
    const admin = this.assertSuperAdmin(adminId);
    const topup = this.getManualTopup(topupId);
    if (!topup) throw new Error("Manual top-up request was not found.");
    if (topup.status !== "proof_submitted") throw new Error("This receipt is not awaiting approval.");
    const at = nowIso();
    this.db.prepare(`
      UPDATE manual_topups
      SET status = 'rejected', reviewed_by = ?, reviewer_note = ?, updated_at = ?
      WHERE id = ?
    `).run(admin, cleanText(note || "Receipt could not be verified.", 500), at, topup.id);
    return this.getManualTopup(topup.id);
  }

  createProduct(merchantId, input = {}) {
    const mid = safeTelegramId(merchantId, "Merchant ID");
    if (!this.isActiveMerchant(mid) && !this.isSuperAdmin(mid)) throw new Error("Merchant is not active.");
    const fulfillmentType = cleanText(input.fulfillmentType || input.fulfillment_type, 40);
    if (!FULFILLMENT_TYPES.has(fulfillmentType)) throw new Error("Unsupported fulfillment type.");
    const status = cleanText(input.status || (fulfillmentType === "ready_stock" ? "draft" : "active"), 20);
    if (!["active", "paused", "draft"].includes(status)) throw new Error("Invalid product status.");
    const title = cleanText(input.title, 180);
    if (!title) throw new Error("Product title is required.");
    const price = assertPositivePiasters(input.pricePiasters || input.price_piasters, "Product price");
    const at = nowIso();
    const result = this.db.prepare(`
      INSERT INTO products (
        merchant_id, title, category, description, price_piasters, fulfillment_type,
        status, delivery_template_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mid,
      title,
      cleanText(input.category || "Digital", 120),
      cleanText(input.description || "", 1200),
      price,
      fulfillmentType,
      status,
      json(input.deliveryTemplate || {}),
      at,
      at
    );
    return this.getProduct(result.lastInsertRowid);
  }

  getProduct(productId) {
    return this.db.prepare(`
      SELECT p.*,
        m.display_name AS merchant_display_name,
        (SELECT COUNT(*) FROM stock_items s WHERE s.product_id = p.id AND s.status = 'available') AS available_stock
      FROM products p
      LEFT JOIN merchants m ON m.telegram_id = p.merchant_id
      WHERE p.id = ?
    `).get(Number(productId)) || null;
  }

  listProducts(options = {}) {
    const status = options.status ? cleanText(options.status, 20) : "";
    const where = status ? "WHERE p.status = ?" : "";
    const params = status ? [status] : [];
    return this.db.prepare(`
      SELECT p.*,
        m.display_name AS merchant_display_name,
        (SELECT COUNT(*) FROM stock_items s WHERE s.product_id = p.id AND s.status = 'available') AS available_stock
      FROM products p
      LEFT JOIN merchants m ON m.telegram_id = p.merchant_id
      ${where}
      ORDER BY p.status ASC, p.created_at DESC
    `).all(...params);
  }

  listMerchantProducts(merchantId) {
    return this.db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM stock_items s WHERE s.product_id = p.id AND s.status = 'available') AS available_stock
      FROM products p
      WHERE p.merchant_id = ?
      ORDER BY p.status ASC, p.created_at DESC
    `).all(safeTelegramId(merchantId, "Merchant ID"));
  }

  searchProducts(query) {
    const q = `%${String(query || "").trim()}%`;
    return this.db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM stock_items s WHERE s.product_id = p.id AND s.status = 'available') AS available_stock
      FROM products p
      WHERE p.status = 'active' AND (p.title LIKE ? OR p.category LIKE ? OR p.description LIKE ?)
      ORDER BY p.created_at DESC
      LIMIT 20
    `).all(q, q, q);
  }

  setProductStatus(merchantId, productId, status) {
    if (!["active", "paused", "draft"].includes(status)) throw new Error("Invalid product status.");
    const { product } = this.assertProductManager(merchantId, productId);
    this.db.prepare("UPDATE products SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), product.id);
    return this.getProduct(product.id);
  }

  updateProductPrice(merchantId, productId, pricePiasters) {
    const { product } = this.assertProductManager(merchantId, productId);
    const price = assertPositivePiasters(pricePiasters, "Product price");
    this.db.prepare("UPDATE products SET price_piasters = ?, updated_at = ? WHERE id = ?").run(price, nowIso(), product.id);
    return this.getProduct(product.id);
  }

  addStock(merchantId, productId, items = []) {
    const { product } = this.assertProductManager(merchantId, productId);
    if (product.fulfillment_type !== "ready_stock") throw new Error("Only ready-stock products can receive stock.");
    const cleanItems = items.map((item) => cleanText(item, 4000)).filter(Boolean);
    if (!cleanItems.length) throw new Error("Send at least one stock item.");
    const at = nowIso();
    const insert = this.db.prepare(`
      INSERT INTO stock_items (product_id, encrypted_payload, status, created_at, updated_at)
      VALUES (?, ?, 'available', ?, ?)
    `);
    const tx = this.db.transaction(() => {
      for (const item of cleanItems) insert.run(product.id, this.secretBox.encrypt(item), at, at);
      this.db.prepare("UPDATE products SET status = 'active', updated_at = ? WHERE id = ?").run(at, product.id);
    });
    tx();
    return { added: cleanItems.length, product: this.getProduct(product.id) };
  }

  clearAvailableStock(merchantId, productId) {
    const { product } = this.assertProductManager(merchantId, productId);
    if (product.fulfillment_type !== "ready_stock") throw new Error("Only ready-stock products have stock.");
    return this.db.prepare("DELETE FROM stock_items WHERE product_id = ? AND status = 'available'").run(product.id).changes;
  }

  deleteProduct(merchantId, productId) {
    const { product } = this.assertProductManager(merchantId, productId);
    this.db.prepare("UPDATE products SET status = 'archived', updated_at = ? WHERE id = ?").run(nowIso(), product.id);
    return this.getProduct(product.id);
  }

  getUserPriceOverride(userId, productId) {
    return this.db.prepare("SELECT * FROM user_price_overrides WHERE user_id = ? AND product_id = ?")
      .get(String(userId), Number(productId)) || null;
  }

  setUserPriceOverride(adminId, userId, productId, pricePiasters, note = "") {
    const admin = this.assertSuperAdmin(adminId);
    const user = safeTelegramId(userId, "User ID");
    const product = this.getProduct(productId);
    if (!product) throw new Error("Product not found.");
    const price = Number(pricePiasters);
    if (!Number.isInteger(price) || price < 0) throw new Error("Price must be a non-negative whole number.");
    const at = nowIso();
    this.db.prepare(`
      INSERT INTO user_price_overrides (user_id, product_id, price_piasters, note, set_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, product_id) DO UPDATE SET
        price_piasters = excluded.price_piasters,
        note = excluded.note,
        set_by = excluded.set_by,
        updated_at = excluded.updated_at
    `).run(user, product.id, price, cleanText(note, 200), admin, at, at);
    return this.getUserPriceOverride(user, product.id);
  }

  effectivePrice(userId, product) {
    const override = userId ? this.getUserPriceOverride(userId, product.id) : null;
    return override ? Number(override.price_piasters) : Number(product.price_piasters);
  }

  purchase(userId, productId, options = {}) {
    const user = safeTelegramId(userId, "User ID");
    const product = this.getProduct(productId);
    if (!product || product.status !== "active") return { ok: false, reason: "unavailable" };
    const total = this.effectivePrice(user, product);

    const userInput = cleanText(options.userInput || "", 4000);
    if (product.fulfillment_type === "assisted" && !userInput) {
      return { ok: false, reason: "needs_input", product };
    }

    return this.db.transaction(() => {
      const currentBalance = this.balance(user);
      if (currentBalance < total) {
        return { ok: false, reason: "insufficient_balance", balance: currentBalance, price: total };
      }

      let stock = null;
      let deliveryText = "";
      if (product.fulfillment_type === "ready_stock") {
        stock = this.db.prepare(`
          SELECT * FROM stock_items
          WHERE product_id = ? AND status = 'available'
          ORDER BY id ASC
          LIMIT 1
        `).get(product.id);
        if (!stock) return { ok: false, reason: "sold_out" };
        deliveryText = this.secretBox.decrypt(stock.encrypted_payload);
      }

      const ref = orderRef("ORD");
      const at = nowIso();
      const status = product.fulfillment_type === "ready_stock" ? "completed" : "awaiting_delivery";
      const result = this.db.prepare(`
        INSERT INTO orders (
          order_ref, user_id, merchant_id, product_id, quantity, unit_price_piasters,
          total_piasters, fulfillment_type, status, stock_item_id, user_input_encrypted,
          delivery_encrypted, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ref,
        user,
        product.merchant_id,
        product.id,
        total,
        total,
        product.fulfillment_type,
        status,
        stock?.id || null,
        userInput ? this.secretBox.encrypt(userInput) : "",
        deliveryText ? this.secretBox.encrypt(deliveryText) : "",
        at,
        at
      );
      const orderId = result.lastInsertRowid;
      this.db.prepare(`
        INSERT INTO ledger (user_id, type, amount_piasters, reference_type, reference_id, idempotency_key, note, created_at)
        VALUES (?, 'purchase', ?, 'order', ?, ?, ?, ?)
      `).run(user, -total, String(orderId), `order:${ref}:purchase`, product.title, at);

      if (stock) {
        const changed = this.db.prepare(`
          UPDATE stock_items
          SET status = 'sold', order_id = ?, sold_at = ?, updated_at = ?
          WHERE id = ? AND status = 'available'
        `).run(orderId, at, at, stock.id).changes;
        if (!changed) throw new Error("Stock changed during purchase. Try again.");
      }

      const order = this.getOrder(orderId);
      return {
        ok: true,
        order,
        product,
        deliveryText,
        balance: this.balance(user),
      };
    })();
  }

  getOrder(orderId) {
    const row = this.db.prepare(`
      SELECT o.*, p.title AS product_title, p.description AS product_description
      FROM orders o
      LEFT JOIN products p ON p.id = o.product_id
      WHERE o.id = ?
    `).get(Number(orderId));
    if (!row) return null;
    return {
      ...row,
      user_input_text: row.user_input_encrypted ? this.secretBox.decrypt(row.user_input_encrypted) : "",
      delivery_text: row.delivery_encrypted ? this.secretBox.decrypt(row.delivery_encrypted) : "",
    };
  }

  listUserPurchaseHistory(userId, limit = 20) {
    return this.db.prepare(`
      SELECT o.id, o.order_ref, o.product_id, o.total_piasters, o.fulfillment_type,
        o.status, o.created_at, p.title AS product_title
      FROM orders o
      LEFT JOIN products p ON p.id = o.product_id
      WHERE o.user_id = ?
      ORDER BY o.id DESC
      LIMIT ?
    `).all(safeTelegramId(userId, "User ID"), Math.max(1, Math.min(50, Number(limit || 20))));
  }

  listMerchantOrders(merchantId, options = {}) {
    const mid = safeTelegramId(merchantId, "Merchant ID");
    const status = options.status ? cleanText(options.status, 40) : "";
    const whereStatus = status ? "AND o.status = ?" : "";
    const params = status ? [mid, status] : [mid];
    return this.db.prepare(`
      SELECT o.*, p.title AS product_title
      FROM orders o
      LEFT JOIN products p ON p.id = o.product_id
      WHERE o.merchant_id = ? ${whereStatus}
      ORDER BY o.id DESC
      LIMIT ?
    `).all(...params, Math.max(1, Math.min(50, Number(options.limit || 20))));
  }

  deliverOrder(merchantId, orderId, deliveryText) {
    const mid = this.assertActiveStaff(merchantId, "Merchant ID");
    const order = this.getOrder(orderId);
    if (!order || (order.merchant_id !== mid && !this.isSuperAdmin(mid))) throw new Error("Order not found.");
    if (order.status !== "awaiting_delivery") throw new Error("Order is not awaiting delivery.");
    const delivery = cleanText(deliveryText, 4000);
    if (!delivery) throw new Error("Delivery text is required.");
    const at = nowIso();
    this.db.prepare(`
      UPDATE orders
      SET status = 'completed', delivery_encrypted = ?, updated_at = ?
      WHERE id = ?
    `).run(this.secretBox.encrypt(delivery), at, order.id);
    return this.getOrder(order.id);
  }

  merchantStats(merchantId) {
    const mid = safeTelegramId(merchantId, "Merchant ID");
    return this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM products WHERE merchant_id = ?) AS product_count,
        (SELECT COUNT(*) FROM orders WHERE merchant_id = ?) AS order_count,
        (SELECT COUNT(*) FROM orders WHERE merchant_id = ? AND status = 'awaiting_delivery') AS pending_delivery,
        (SELECT COALESCE(SUM(total_piasters), 0) FROM orders WHERE merchant_id = ? AND status IN ('completed','awaiting_delivery')) AS gross_piasters
    `).get(mid, mid, mid, mid);
  }

  platformStats() {
    return {
      users: this.countUsers(),
      merchants: this.db.prepare("SELECT COUNT(*) AS c FROM merchants WHERE status = 'active'").get().c,
      products: this.db.prepare("SELECT COUNT(*) AS c FROM products").get().c,
      orders: this.db.prepare("SELECT COUNT(*) AS c FROM orders").get().c,
      pending: this.db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status = 'awaiting_delivery'").get().c,
      gross: this.db.prepare("SELECT COALESCE(SUM(total_piasters), 0) AS c FROM orders WHERE status IN ('completed','awaiting_delivery')").get().c,
    };
  }

  getMaintenanceMode() {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'maintenance_mode'").get();
    return row ? row.value === "true" : false;
  }

  setMaintenanceMode(enabled) {
    const value = enabled ? "true" : "false";
    const at = nowIso();
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ('maintenance_mode', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(value, at);
    return enabled;
  }
}

module.exports = {
  MANUAL_PAYMENT_METHODS,
  MAX_TOPUP_PIASTERS,
  MIN_TOPUP_PIASTERS,
  StoreService,
  assertTopupAmount,
  cleanText,
  orderRef,
  safeTelegramId,
};
