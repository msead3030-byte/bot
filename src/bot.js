"use strict";

const fs = require("fs");
const path = require("path");
const { sleep } = require("./TelegramApi");
const { t } = require("./i18n");
const { BinancePayClient } = require("./BinancePayClient");

const binancePayClient = new BinancePayClient();
const BANNER_PATH = path.join(__dirname, "..", "assets", "store_banner.jpg");

const log = {
  _fmt(level, tag, msg, ctx) {
    const ts = new Date().toISOString();
    const ctxStr = ctx ? ` | ${JSON.stringify(ctx)}` : "";
    return `${ts} [${level}] [${tag}] ${msg}${ctxStr}`;
  },
  info(tag, msg, ctx) { console.log(log._fmt("INFO", tag, msg, ctx)); },
  warn(tag, msg, ctx) { console.warn(log._fmt("WARN", tag, msg, ctx)); },
  error(tag, msg, ctx) { console.error(log._fmt("ERROR", tag, msg, ctx)); },
};

function brandName() {
  return String(process.env.STORE_BRAND_NAME || "AI Studio").trim();
}

function formatDateTime(isoString) {
  if (!isoString) return "";
  try {
    const d = new Date(isoString);
    const date = d.toLocaleDateString("ar-EG", { year: "numeric", month: "short", day: "numeric" });
    const time = d.toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
    return `${date} - ${time}`;
  } catch {
    return String(isoString).slice(0, 16);
  }
}

function currencyCode() {
  return String(process.env.STORE_CURRENCY_CODE || "EGP").trim().toUpperCase() || "EGP";
}

function formatMoney(piasters) {
  const value = Number(piasters || 0);
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const units = Math.floor(abs / 100);
  const cents = abs % 100;
  return `${sign}${units}${cents ? "." + String(cents).padStart(2, "0") : ""} ${currencyCode()}`;
}

function parseMoneyToPiasters(value) {
  const converted = String(value || "").replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
  const raw = converted.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error("⚠️ يرجى إرسال مبلغ صحيح، مثال: 50 أو 50.25");
  const [units, cents = ""] = raw.split(".");
  return Number(units) * 100 + Number(cents.padEnd(2, "0").slice(0, 2));
}

function isEnabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function manualPaymentConfig(method) {
  const key = String(method || "").trim().toUpperCase();
  if (!['WALLET', 'BINANCE'].includes(key)) return null;
  const receiver = String(process.env[`MANUAL_${key}_RECEIVER`] || "").trim();
  const instructions = String(process.env[`MANUAL_${key}_INSTRUCTIONS`] || "").trim();
  if (!receiver) return null;
  return {
    method: key.toLowerCase(),
    label: key === 'WALLET' ? 'المحفظة' : 'Binance',
    receiver,
    instructions,
  };
}

function manualPaymentMethods() {
  return ['wallet', 'binance'].map(manualPaymentConfig).filter(Boolean);
}

function topupsEnabled() {
  return isEnabled(process.env.MANUAL_TOPUPS_ENABLED) && manualPaymentMethods().length > 0;
}

function isAutoTopupEnabled() {
  return isEnabled(process.env.AUTO_TOPUP_ENABLED ?? true);
}

function autoTopupReceiver() {
  return String(process.env.AUTO_TOPUP_WALLET_RECEIVER || process.env.MANUAL_WALLET_RECEIVER || "01000000000").trim();
}

function isCommand(text, command) {
  const value = String(text || "").trim();
  if (!value.startsWith("/")) return false;
  return value.split(/\s+/)[0].slice(1).split("@")[0].toLowerCase() === command;
}

function panel(title, lines = []) {
  return [`✨ ${title}`, "━━━━━━━━━━━━━━━━━━━━━━━━", ...lines.filter((line) => line !== null && line !== undefined && line !== "")].join("\n");
}

function displayName(user = {}) {
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (full) return full;
  if (user.username) return `@${user.username}`;
  return String(user.telegram_id || user.id || "مستخدم");
}

function escMd(text) {
  return String(text || "").replace(/([_*`\[])/g, "\\$1");
}

function staffStatus(store, superAdmins, userId) {
  const id = String(userId);
  return {
    isSuperAdmin: store.isSuperAdmin(id),
    isMerchant: store.isActiveMerchant(id),
  };
}

function adminContactUrl() {
  const url = String(process.env.ADMIN_CONTACT_URL || "").trim();
  if (url) {
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    return `https://t.me/${url.replace(/^@/, "")}`;
  }
  const username = String(process.env.ADMIN_USERNAME || "").trim().replace(/^@/, "");
  if (username && username !== "your_admin_username") return `https://t.me/${username}`;
  return null;
}

function adminContactButton(label = "📞 التواصل مع الأدمن") {
  const url = adminContactUrl();
  if (url) return { text: label, url };
  return { text: label, callback_data: "main:contact_admin" };
}

function mandatorySubscriptionsConfig() {
  const items = [];
  const defs = [
    { key: "REQUIRED_CHANNEL_1", linkKey: "REQUIRED_CHANNEL_1_LINK", labelAr: "📢 الانضمام للقناة الأولى", labelEn: "📢 Join Channel 1" },
    { key: "REQUIRED_CHANNEL_2", linkKey: "REQUIRED_CHANNEL_2_LINK", labelAr: "📢 الانضمام للقناة الثانية", labelEn: "📢 Join Channel 2" },
    { key: "REQUIRED_GROUP_1", linkKey: "REQUIRED_GROUP_1_LINK", labelAr: "💬 الانضمام للجروب الأول", labelEn: "💬 Join Group 1" },
    { key: "REQUIRED_GROUP_2", linkKey: "REQUIRED_GROUP_2_LINK", labelAr: "💬 الانضمام للجروب الثاني", labelEn: "💬 Join Group 2" },
    { key: "MANDATORY_JOIN_CHAT_ID", linkKey: "MANDATORY_JOIN_LINK", labelAr: "📢 الانضمام للجروب الرسمي", labelEn: "📢 Join Official Group" },
  ];
  for (const d of defs) {
    let raw = String(process.env[d.key] || "").trim();
    let link = String(process.env[d.linkKey] || "").trim();
    if (!raw && !link) continue;

    let chatId = raw;
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      if (!link) link = raw;
      const match = raw.match(/t\.me\/([a-zA-Z0-9_]+)$/);
      if (match && !match[1].startsWith("+")) {
        chatId = `@${match[1]}`;
      } else {
        chatId = "";
      }
    }

    if (!link && chatId.startsWith("@")) {
      link = `https://t.me/${chatId.replace(/^@/, "")}`;
    }

    items.push({
      chatId,
      link: link || "https://t.me/",
      labelAr: d.labelAr,
      labelEn: d.labelEn,
    });
  }
  return items;
}

async function checkMandatoryJoin(api, userId) {
  const items = mandatorySubscriptionsConfig();
  if (!items.length) return { ok: true, missing: [] };
  const missing = [];
  for (const item of items) {
    if (!item.chatId) continue;
    try {
      const member = await api.getChatMember(item.chatId, userId);
      const status = String(member?.status || "").toLowerCase();
      if (!["creator", "administrator", "member"].includes(status)) {
        missing.push(item);
      }
    } catch (error) {
      log.warn("bot", `Mandatory join check failed for user ${userId} on ${item.chatId}: ${error.message}`);
      missing.push(item);
    }
  }
  if (missing.length) return { ok: false, missing };
  return { ok: true, missing: [] };
}

async function sendMandatoryJoinPrompt(api, store, chatId, userId, messageId = null) {
  const check = await checkMandatoryJoin(api, userId);
  if (check.ok) return true;
  const lang = store ? store.getUserLanguage(userId) : "ar";
  const text = panel(t("mandatory_join_title", lang), [
    t("mandatory_join_body", lang),
  ]);
  const rows = check.missing.map((item) => [{
    text: lang === "en" ? item.labelEn : item.labelAr,
    url: item.link,
  }]);
  rows.push([{ text: t("btn_check_join", lang), callback_data: "check_join" }]);
  await safeEditOrSend(api, chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
  return false;
}

function replyMenuKeyboard(isStaff = false, lang = "ar") {
  const keyboard = [
    [{ text: t("btn_products", lang) }, { text: t("btn_wallet", lang) }],
    [{ text: t("btn_language", lang) }, { text: t("btn_more", lang) }],
  ];
  if (isStaff) {
    keyboard.push([{ text: t("btn_admin_panel", lang) }]);
  }
  return { keyboard, resize_keyboard: true };
}

function homeKeyboard(isStaff = false, lang = "ar") {
  const isAr = lang === "ar";
  return {
    inline_keyboard: [
      [
        { text: isAr ? "🛒 تصفح المنتجات" : "🛒 Browse Products", callback_data: "main:shop" },
        { text: isAr ? "💼 المحفظة" : "💼 Wallet", callback_data: "main:wallet" },
      ],
      [
        { text: isAr ? "🌐 اللغة" : "🌐 Language", callback_data: "main:language" },
        { text: isAr ? "➕ المزيد" : "➕ More", callback_data: "main:more" },
      ],
      ...(isStaff ? [[{ text: isAr ? "⚙️ لوحة الإدارة والتحكم" : "⚙️ Admin Terminal", callback_data: "main:admin" }]] : []),
    ],
  };
}

function subNavKeyboard(lang = "ar", extraRows = []) {
  const isAr = lang === "ar";
  return {
    inline_keyboard: [
      ...extraRows,
      [
        { text: isAr ? "⚡ شحن الرصيد" : "⚡ Top-up", callback_data: "main:topup" },
        { text: isAr ? "🏠 القائمة الرئيسية" : "🏠 Main Menu", callback_data: "main:home" },
      ],
    ],
  };
}

async function showLanguageMenu(api, store, chatId, userId, messageId = null) {
  const lang = store.getUserLanguage(userId);
  const text = panel(t("btn_language", lang), [t("select_language_prompt", lang)]);
  const keyboard = {
    inline_keyboard: [
      [
        { text: `${t("btn_lang_ar", lang)}${lang === "ar" ? " ✅" : ""}`, callback_data: "lang:ar" },
        { text: `${t("btn_lang_en", lang)}${lang === "en" ? " ✅" : ""}`, callback_data: "lang:en" },
      ],
      [{ text: t("btn_home", lang), callback_data: "main:home" }],
    ],
  };
  await safeEditOrSend(api, chatId, messageId, text, { reply_markup: keyboard });
}

function adminKeyboard(isSuperAdmin = false, isMaintenance = false) {
  const rows = [
    [{ text: "➕ إضافة منتج جديد", callback_data: "merchant:create_product" }, { text: "📦 منتجاتي والمخزون", callback_data: "merchant:products" }],
    [{ text: "⏳ الطلبات المعلقة", callback_data: "merchant:orders" }, { text: "📊 تقارير الأرباح", callback_data: "merchant:reports" }],
  ];
  if (isSuperAdmin) {
    rows.push([{ text: "👤 إضافة تاجر", callback_data: "admin:add_merchant" }, { text: "🛡️ إضافة أدمن", callback_data: "admin:add_admin" }]);
    rows.push([{ text: "👥 جميع التجار", callback_data: "admin:merchants" }, { text: "🛡️ جميع الأدمنز", callback_data: "admin:admins" }]);
    rows.push([{ text: "➖ إزالة تاجر", callback_data: "admin:remove_merchant" }, { text: "⛔ إزالة أدمن", callback_data: "admin:remove_admin" }]);
    rows.push([{ text: "💵 إضافة رصيد", callback_data: "admin:credit" }, { text: "🔄 تصفير رصيد", callback_data: "admin:zero" }]);
    rows.push([{ text: "👥 الأعضاء", callback_data: "admin:members" }, { text: "🌐 تقرير المنصة الشامل", callback_data: "admin:report" }]);
    rows.push([{ text: "🏷️ تحديد سعر خاص لزبون", callback_data: "admin:custom_price" }]);
    rows.push([{ text: "📢 إرسال رسالة جماعية", callback_data: "admin:broadcast" }]);
    rows.push([{ text: "📱 سجل رسائل التحويل SMS", callback_data: "admin:sms_transfers" }]);
    rows.push([{ text: isMaintenance ? "▶️ إيقاف وضع الصيانة (تفعيل البوت)" : "🛠️ تفعيل وضع الصيانة (إيقاف البوت)", callback_data: "admin:toggle_maintenance" }]);
  }
  rows.push([{ text: "🏠 القائمة الرئيسية", callback_data: "main:home" }]);
  return { inline_keyboard: rows };
}

function productTypeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "⚡ تسليم فوري (Ready Stock)", callback_data: "merchant:wizard_type:ready_stock" }],
      [{ text: "🛠️ تسليم بمساعدة البائع (Assisted)", callback_data: "merchant:wizard_type:assisted" }],
      [{ text: "❌ إلغاء", callback_data: "flow:cancel" }],
    ]
  };
}

function renderCyberStockBar(count) {
  if (count <= 0) return "🔴 [░░░░░░░░░░] 0% (نفد المخزون)";
  const maxVisual = 20;
  const filled = Math.min(10, Math.max(1, Math.round((Math.min(count, maxVisual) / maxVisual) * 10)));
  const empty = 10 - filled;
  const pct = Math.min(100, Math.round((count / maxVisual) * 100));
  const color = count > 5 ? "🟢" : "🟠";
  return `${color} [${"█".repeat(filled)}${"░".repeat(empty)}] ${pct}% (${count} متاح)`;
}

function productListKeyboard(products) {
  const rows = products.map((product) => {
    let stockBadge = "";
    if (product.fulfillment_type === "ready_stock") {
      const count = product.available_stock || 0;
      if (count > 5) stockBadge = ` • 🟢 [${count}]`;
      else if (count > 0) stockBadge = ` • 🟠 [${count}]`;
      else stockBadge = ` • 🔴 [نفد]`;
    } else {
      stockBadge = ` • 🛠️ [خدمة]`;
    }
    return [{ text: `🎮 ${product.title} ╏ ${formatMoney(product.price_piasters)}${stockBadge}`, callback_data: `product:${product.id}` }];
  });
  rows.push([
    { text: "⚡ شحن رصيد", callback_data: "main:topup" },
    { text: "🏠 القائمة الرئيسية", callback_data: "main:home" },
  ]);
  return { inline_keyboard: rows };
}

function productActions(product, isAvailable = true) {
  const rows = [];
  if (isAvailable) {
    rows.push([{ text: `💳 شراء فوري الآن ╏ ${formatMoney(product.price_piasters)}`, callback_data: `buy:${product.id}` }]);
  }
  rows.push([
    { text: "👈 عودة للمتجر", callback_data: "main:shop" },
    { text: "🏠 القائمة الرئيسية", callback_data: "main:home" },
  ]);
  return { inline_keyboard: rows };
}

function merchantProductKeyboard(product) {
  const rows = [];
  if (product.fulfillment_type === "ready_stock") {
    rows.push([{ text: "➕ إضافة مخزون", callback_data: `merchant:add_stock:${product.id}` }]);
    rows.push([{ text: "🗑️ مسح المخزون المتاح", callback_data: `merchant:clear_stock:${product.id}` }]);
  }
  rows.push([{ text: "✏️ تعديل السعر", callback_data: `merchant:edit_price:${product.id}` }]);
  rows.push([{ text: product.status === "active" ? "⏸️ إيقاف المنتج" : "▶️ تفعيل المنتج", callback_data: `merchant:toggle:${product.id}` }]);
  rows.push([{ text: "🗑️ أرشفة المنتج", callback_data: `merchant:delete:${product.id}` }]);
  rows.push([{ text: "👈 عودة لمنتجاتي", callback_data: "merchant:products" }]);
  return { inline_keyboard: rows };
}

function topupKeyboard() {
  const methods = manualPaymentMethods();
  return {
    inline_keyboard: [
      ...methods.map((method) => [{ text: `💳 الدفع عبر ${method.label}`, callback_data: `manual_topup:${method.method}` }]),
      [adminContactButton("📞 التواصل مع الأدمن للشحن المباشر")],
      [{ text: "🏠 القائمة الرئيسية", callback_data: "main:home" }],
    ]
  };
}

function homeText(store, userId, from = {}) {
  const lang = store.getUserLanguage(userId);
  const user = store.getUser(userId) || from;
  const name = displayName(user);
  const balance = formatMoney(store.balance(userId));
  const brand = brandName().toUpperCase();

  if (lang === "en") {
    return [
      `╔══════════════════════════════╗`,
      `      ⚡ AI STUDIO STORE ⚡`,
      `   Digital Subscriptions Store`,
      `╚══════════════════════════════╝`,
      "",
      `◈ Customer ╏ **${escMd(name)}**`,
      `◈ User ID  ╏ \`${userId}\``,
      `◈ Balance  ╏ **${balance}** ⚡`,
      `◈ Status   ╏ 🟢 [ACTIVE & READY]`,
      "",
      `╭─[ ⚡ INSTANT DIGITAL TOP-UP ]────────`,
      `│ E-Wallets • InstaPay • Binance Pay`,
      `╰─────────────────────────────────`,
      "",
      `🤖 AI tools, digital subscriptions & accounts with instant delivery.`,
      `👇 Select an option from the menu below:`,
    ].join("\n");
  }

  return [
    `╔══════════════════════════════╗`,
    `      ⚡ AI STUDIO STORE ⚡`,
    `  متجر الاشتراكات والخدمات الرقمية`,
    `╚══════════════════════════════╝`,
    "",
    `◈ المـسـتـخـدم ╏ **${escMd(name)}**`,
    `◈ مـعـرّف الـحـسـاب ╏ \`${userId}\``,
    `◈ رصـيـد الـمـحـفـظـة ╏ **${balance}** ⚡`,
    `◈ حـالـة الـحـسـاب ╏ 🟢 [مـفـعـل وجـاهـز لـلـشـراء]`,
    "",
    `╭─[ ⚡ شـحـن فـوري وتـلـقـائـي ]───────`,
    `│ فودافون كاش • إنستاباي • Binance Pay`,
    `╰─────────────────────────────────`,
    "",
    `🤖 اشتراكات رقمية، حسابات، وأدوات تقنية ذكية بتسليم فوري.`,
    `👇 اختر وجهتك من القائمة أدناه:`,
  ].join("\n");
}

function productText(store, userId, product) {
  const price = store.effectivePrice(userId, product);
  let stockLine = "";
  let deliveryLine = "";
  if (product.fulfillment_type === "ready_stock") {
    const count = product.available_stock || 0;
    stockLine = `◈ الـمـخـزون ╏ ${renderCyberStockBar(count)}`;
    deliveryLine = `◈ نـوع الـتـسـلـيـم ╏ ⚡ تسليم فوري وتلقائي (Ready Stock)`;
  } else {
    stockLine = `◈ الـمـخـزون ╏ 🟢 متاح حسب الطلب`;
    deliveryLine = `◈ نـوع الـتـسـلـيـم ╏ 🛠️ تسليم بمساعدة التاجر (تنفيذ سريع)`;
  }

  const lines = [
    `╔══════════════════════════════╗`,
    `  📦 ${product.title}`,
    `╚══════════════════════════════╝`,
    "",
    `◈ الـقـسـم ╏ 🏷️ ${product.category}`,
    `◈ الـسـعـر ╏ 💵 **${formatMoney(price)}**`,
    stockLine,
    deliveryLine,
    "",
    `╭─[ 📝 الـمـواصـفـات والـتـفـاصـيـل ]────────`,
    `│ ${product.description || "لا يوجد وصف إضافي مضاف لهذا المنتج."}`,
    `╰─────────────────────────────────`,
  ];
  return lines.join("\n");
}

async function safeEditOrSend(api, chatId, messageId, text, options = {}) {
  if (messageId) {
    try {
      return await api.editMessageText(chatId, messageId, text, options);
    } catch {
      try {
        return await api.editMessageCaption(chatId, messageId, text, options);
      } catch { }
    }
  }
  return api.sendMessage(chatId, text, options);
}

async function showHome(api, store, superAdmins, chatId, from, messageId = null) {
  const id = store.ensureUser(from);
  const stf = staffStatus(store, superAdmins, id);
  const lang = store.getUserLanguage(id);
  const inlineKbd = homeKeyboard(stf.isSuperAdmin || stf.isMerchant, lang);
  const caption = homeText(store, id, from);

  if (messageId) {
    return safeEditOrSend(api, chatId, messageId, caption, {
      parse_mode: "Markdown",
      reply_markup: inlineKbd,
    });
  }

  // Anchor persistent reply menu at bottom
  await api.sendMessage(chatId, "⚡", {
    reply_markup: replyMenuKeyboard(stf.isSuperAdmin || stf.isMerchant, lang),
  }).catch(() => { });

  // Send visual Cyber Store Banner Photo if present on disk
  if (fs.existsSync(BANNER_PATH)) {
    try {
      return await api.sendPhoto(chatId, BANNER_PATH, {
        caption,
        parse_mode: "Markdown",
        reply_markup: inlineKbd,
      });
    } catch (err) {
      console.warn("[showHome] sendPhoto failed, fallback to text:", err.message);
    }
  }

  return api.sendMessage(chatId, caption, {
    parse_mode: "Markdown",
    reply_markup: inlineKbd,
  });
}

async function showShop(api, store, chatId, messageId = null) {
  const allProducts = store.listProducts({ status: "active" });
  const products = allProducts.slice(0, 30);
  const lines = [
    `╔══════════════════════════════╗`,
    `  🛒 مـتـجـر الـكـروت والـمـنـتـجـات  ⚡`,
    `╚══════════════════════════════╝`,
    "",
    products.length
      ? `🎮 يتوفر حالياً: **${allProducts.length}** منتج جاهز للشراء الفوري.\nاختر المنتج لمشاهدة شريط المخزون وتأكيد الطلب:`
      : `⚠️ لا توجد منتجات معروضة حالياً في المتجر.`,
  ];
  if (allProducts.length > 30) lines.push(`(يتم عرض أول 30 منتج من إجمالي ${allProducts.length})`);
  const text = lines.join("\n");
  await safeEditOrSend(api, chatId, messageId, text, { parse_mode: "Markdown", reply_markup: productListKeyboard(products) });
}

async function showWallet(api, store, chatId, userId, messageId = null) {
  const lang = store.getUserLanguage(userId);
  const isAr = lang === "ar";
  const balance = store.balance(userId);
  const lines = [
    `╔══════════════════════════════╗`,
    `  💼 مـحـفـظـة AI Studio الـرقـمـيـة`,
    `╚══════════════════════════════╝`,
    "",
    `◈ رصـيـدك الـحـالـي ╏ **${formatMoney(balance)}** ⚡`,
    `◈ حـالـة الـمـحـفـظـة ╏ 🟢 [مـفـعـلـة وجـاهـزة لـلـشـراء]`,
    "",
    isAr
      ? "💡 يمكنك شحن رصيدك عبر المحافظ أو إنستاباي أو باينانس، أو الاطلاع على كشف الحساب بالتفصيل:"
      : "💡 You can add balance via E-Wallet, InstaPay, or Binance Pay, or view your balance statement:",
  ];

  const keyboard = {
    inline_keyboard: [
      [{ text: isAr ? "⚡ إضافة رصيد (شحن)" : "⚡ Add Balance", callback_data: "main:topup" }],
      [{ text: isAr ? "📜 كشف حساب الرصيد" : "📜 Balance Statement", callback_data: "main:statement" }],
      [{ text: isAr ? "🏠 القائمة الرئيسية" : "🏠 Main Menu", callback_data: "main:home" }],
    ],
  };

  await safeEditOrSend(api, chatId, messageId, lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

const showBalance = showWallet;

async function showMoreMenu(api, store, chatId, userId, messageId = null) {
  const lang = store.getUserLanguage(userId);
  const isAr = lang === "ar";
  const lines = [
    `╔══════════════════════════════╗`,
    `     ➕ الـخـدمـات والـمـزيـد`,
    `╚══════════════════════════════╝`,
    "",
    isAr ? "👇 اختر من القائمة التالية للوصول للخدمات الإضافية:" : "👇 Select a service from the options below:",
  ];

  const keyboard = {
    inline_keyboard: [
      [
        { text: isAr ? "👤 الملف الشخصي" : "👤 Profile", callback_data: "main:account" },
        adminContactButton(isAr ? "💬 الدعم الفني" : "💬 Support"),
      ],
      [
        { text: isAr ? "📋 سجل المشتريات" : "📋 Purchase History", callback_data: "main:orders" },
        { text: isAr ? "📜 كشف الحساب" : "📜 Statement", callback_data: "main:statement" },
      ],
      [
        { text: isAr ? "🔍 البحث عن اشتراك" : "🔍 Search", callback_data: "main:search" },
      ],
      [
        { text: isAr ? "🏠 القائمة الرئيسية" : "🏠 Main Menu", callback_data: "main:home" },
      ],
    ],
  };

  await safeEditOrSend(api, chatId, messageId, lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

async function showStatement(api, store, chatId, userId, messageId = null) {
  const lang = store.getUserLanguage(userId);
  const isAr = lang === "ar";
  const deposits = store.userDepositLedger(userId, 15);
  const balance = store.balance(userId);

  const lines = [
    `╔══════════════════════════════╗`,
    `  📜 كـشـف حـسـاب الـرصـيـد والـشـحـن`,
    `╚══════════════════════════════╝`,
    "",
    `◈ رصـيـدك الـحـالـي ╏ **${formatMoney(balance)}** ⚡`,
    "",
    isAr ? "╭─[ 💰 سـجـل كـل رصـيـد أُضـيـف لـحـسـابـك ]───────" : "╭─[ 💰 DEPOSIT HISTORY ]───────────",
  ];

  if (deposits.length) {
    for (const d of deposits) {
      const dateStr = formatDateTime(d.created_at);
      const noteStr = d.note || "شحن رصيد";
      lines.push(`│ ➕ **${formatMoney(d.amount_piasters)}**`);
      lines.push(`│   📅 التاريخ: ${dateStr}`);
      lines.push(`│   📝 التفاصيل: ${noteStr}`);
      lines.push("├─────────────────────────────────");
    }
    lines[lines.length - 1] = "╰─────────────────────────────────";
  } else {
    lines.push(isAr ? "│ 💡 لا توجد عمليات شحن رصيد مسجلة حتى الآن." : "│ 💡 No deposit records found yet.");
    lines.push("╰─────────────────────────────────");
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: isAr ? "⚡ إضافة رصيد" : "⚡ Add Balance", callback_data: "main:topup" }],
      [{ text: isAr ? "💼 المحفظة" : "💼 Wallet", callback_data: "main:wallet" }, { text: isAr ? "➕ المزيد" : "➕ More", callback_data: "main:more" }],
      [{ text: isAr ? "🏠 الرئيسية" : "🏠 Home", callback_data: "main:home" }],
    ],
  };

  await safeEditOrSend(api, chatId, messageId, lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

async function showOrders(api, store, chatId, userId, messageId = null) {
  const lang = store.getUserLanguage(userId);
  const isAr = lang === "ar";
  const orders = store.listUserPurchaseHistory(userId, 15);
  const lines = [
    `╔══════════════════════════════╗`,
    `  📋 سـجـل الـطـلـبـات والـمـشـتـريـات`,
    `╚══════════════════════════════╝`,
    "",
  ];

  if (orders.length) {
    for (const order of orders) {
      const statusBadge = order.status === "completed" ? "🟢 مكتمل" : order.status === "awaiting_delivery" ? "⏳ قيد التنفيذ" : `⚪ ${order.status}`;
      const dateStr = formatDateTime(order.created_at);
      lines.push(`◈ **طلب #${order.id}** ╏ ${order.product_title || "اشتراك رقمي"}`);
      lines.push(`   💵 القيمة: **${formatMoney(order.total_piasters)}**`);
      lines.push(`   📅 التاريخ: ${dateStr}`);
      lines.push(`   📊 الحالة: ${statusBadge}`);
      lines.push("───────────────────────────────");
    }
  } else {
    lines.push(isAr ? "💡 لا توجد لديك طلبات أو مشتريات سابقة حتى الآن." : "💡 You have no purchase history yet.");
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: isAr ? "🛒 تصفح المنتجات" : "🛒 Browse Products", callback_data: "main:shop" }],
      [{ text: isAr ? "➕ المزيد" : "➕ More", callback_data: "main:more" }, { text: isAr ? "🏠 الرئيسية" : "🏠 Home", callback_data: "main:home" }],
    ],
  };

  await safeEditOrSend(api, chatId, messageId, lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

async function showAccount(api, store, chatId, userId, from = {}, messageId = null) {
  const lang = store.getUserLanguage(userId);
  const isAr = lang === "ar";
  const user = store.getUser(userId) || from;
  const balance = store.balance(userId);
  const ordersCount = store.listUserPurchaseHistory(userId, 100).length;
  const joinDate = user.created_at ? formatDateTime(user.created_at) : "غير محدد";

  const lines = [
    `╔══════════════════════════════╗`,
    `  👤 مـلـف الـعـمـيـل الـشـخـصـي`,
    `╚══════════════════════════════╝`,
    "",
    `◈ الاسـم ╏ **${escMd(displayName(user))}**`,
    `◈ المـعـرّف (ID) ╏ \`${userId}\``,
    `◈ رصـيـد الـمـحـفـظـة ╏ **${escMd(formatMoney(balance))}** ⚡`,
    `◈ إجـمـالـي الـمـشـتـريـات ╏ **${ordersCount}** طلب`,
    `◈ تـاريـخ الانـضـمـام ╏ ${joinDate}`,
    `◈ الـعـضـويـة ╏ 🎖️ [VIP Customer]`,
  ];

  const keyboard = {
    inline_keyboard: [
      [{ text: isAr ? "⚡ إضافة رصيد" : "⚡ Add Balance", callback_data: "main:topup" }],
      [{ text: isAr ? "📋 مشترياتي" : "📋 My Orders", callback_data: "main:orders" }, { text: isAr ? "📜 كشف الحساب" : "📜 Statement", callback_data: "main:statement" }],
      [{ text: isAr ? "➕ المزيد" : "➕ More", callback_data: "main:more" }, { text: isAr ? "🏠 الرئيسية" : "🏠 Home", callback_data: "main:home" }],
    ],
  };

  await safeEditOrSend(api, chatId, messageId, lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

async function showContactAdmin(api, store, chatId, messageId = null) {
  const url = adminContactUrl();
  const lines = [
    "💬 خدمة العملاء والدعم الفني",
    "",
    url ? "يمكنك التواصل مباشرة مع الأدمن عبر الرابط الأدناه:" : "يرجى التواصل مع مالك البوت أو الأدمن لإدارة حسابك وشحن رصيدك.",
  ];
  const keyboard = {
    inline_keyboard: [
      ...(url ? [[{ text: "💬 فتح محادثة الأدمن", url }]] : []),
      [{ text: "🏠 القائمة الرئيسية", callback_data: "main:home" }],
    ],
  };
  await safeEditOrSend(api, chatId, messageId, panel("📞 التواصل مع الأدمن", lines), { reply_markup: keyboard });
}

async function showTopupMenu(api, store, chatId, userId, messageId = null) {
  const lang = store.getUserLanguage(userId);
  const isAr = lang === "ar";
  const text = panel(isAr ? "⚡ شحن رصيد المحفظة" : "⚡ Top-up Wallet", [
    isAr ? "اختر وسيلة الشحن المناسبة لك لتأكيد الرصيد تلقائياً:" : "Choose your preferred payment method:",
  ]);

  const rows = [];
  if (isAutoTopupEnabled()) {
    rows.push([
      { text: isAr ? "📱 محفظة كاش (تأكيد بالرقم)" : "📱 E-Wallet (Confirm by Phone)", callback_data: "auto_topup:wallet" }
    ]);
    rows.push([
      { text: isAr ? "⚡ إنستاباي InstaPay (تأكيد بالاسم)" : "⚡ InstaPay (Confirm by Name)", callback_data: "auto_topup:instapay" }
    ]);
    rows.push([
      { text: isAr ? "🪙 Binance Pay (تأكيد تلقائي بالـ USDT)" : "🪙 Binance Pay (USDT)", callback_data: "auto_topup:binance" }
    ]);
  }

  if (topupsEnabled()) {
    rows.push([{ text: isAr ? "💳 شحن يدوي بمراجعة الإيصال" : "💳 Manual Top-up", callback_data: "topup_select:wallet" }]);
  }

  rows.push([adminContactButton(t("btn_contact_admin_topup", lang))]);
  rows.push([{ text: isAr ? "💼 المحفظة" : "💼 Wallet", callback_data: "main:wallet" }, { text: t("btn_home", lang), callback_data: "main:home" }]);

  await safeEditOrSend(api, chatId, messageId, text, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows }
  });
}

async function showAdmin(api, store, superAdmins, chatId, userId, messageId = null) {
  const stf = staffStatus(store, superAdmins, userId);
  if (!stf.isSuperAdmin && !stf.isMerchant) {
    await safeEditOrSend(api, chatId, messageId, panel("🚫 وصول غير مصرح", ["هذه المنطقة مخصصة للإدارة والطاقم فقط."]), { reply_markup: homeKeyboard(false) });
    return;
  }
  const stats = store.merchantStats(userId);
  const isMaint = store.getMaintenanceMode();
  await safeEditOrSend(api, chatId, messageId, panel("⚙️ لوحة الإدارة والتحكم", [
    `📦 عدد منتجاتك: ${stats.product_count || 0}`,
    `🛍️ إجمالي الطلبات: ${stats.order_count || 0}`,
    `⏳ طلبات قيد التسليم: ${stats.pending_delivery || 0}`,
    `💵 إجمالي الإيرادات: ${formatMoney(stats.gross_piasters || 0)}`,
    isMaint ? "⚠️ وضع الصيانة مفعل حالياً (البوت متوقف بالنسبة للمستخدمين)" : "🟢 البوت يعمل حالياً لجميع المستخدمين",
  ]), { reply_markup: adminKeyboard(stf.isSuperAdmin, isMaint) });
}

async function notifyStaffAboutAssistedOrder(api, store, superAdmins, result) {
  const recipients = new Set([
    String(result.order.merchant_id),
    ...store.listSuperAdmins().filter((admin) => admin.status === "active").map((admin) => String(admin.telegram_id)),
  ]);
  const text = panel("🚨 طلب جديد يحتاج تسليم (Assisted Order)", [
    `رقم الطلب: #${result.order.id}`,
    `المنتج: ${result.product.title}`,
    `المشتري: ${result.order.user_id}`,
    `المبلغ الخصوم: ${formatMoney(result.order.total_piasters)}`,
    "",
    "📝 متطلبات وبيانات المشتري:",
    result.order.user_input_text,
  ]);
  for (const recipient of recipients) {
    await api.sendMessage(recipient, text, { reply_markup: { inline_keyboard: [[{ text: "📤 تسليم الطلب الآن", callback_data: `merchant:deliver:${result.order.id}` }]] } }).catch(() => { });
  }
}

async function handlePurchaseResult(api, store, superAdmins, chatId, userId, result) {
  if (!result.ok) {
    if (result.reason === "insufficient_balance") {
      const keyboardRows = [
        [adminContactButton("📞 التواصل مع الأدمن للشحن")],
      ];
      if (topupsEnabled()) {
        keyboardRows.push([{ text: "💳 طرق الشحن اليدوي", callback_data: "main:topup" }]);
      }
      keyboardRows.push([{ text: "🏠 القائمة الرئيسية", callback_data: "main:home" }]);

      await api.sendMessage(chatId, panel("⚠️ رصيد المحفظة غير كافٍ", [
        `سعر المنتج: ${formatMoney(result.price)}`,
        `رصيدك الحالي: ${formatMoney(result.balance)}`,
        "",
        "💡 يرجى التواصل مع الأدمن لشحن محفظتك وإتمام عملية الشراء.",
      ]), { reply_markup: { inline_keyboard: keyboardRows } });
      return;
    }
    if (result.reason === "sold_out") {
      await api.sendMessage(chatId, panel("🔴 نفد المخزون", ["عذراً، هذا المنتج غير متوفر في المخزون حالياً."]), { reply_markup: homeKeyboard(false) });
      return;
    }
    await api.sendMessage(chatId, panel("❌ تعذر إتمام الطلب", ["المنتج غير متاح حالياً."]), { reply_markup: homeKeyboard(false) });
    return;
  }

  if (result.order.fulfillment_type === "ready_stock") {
    await api.sendMessage(chatId, panel("🎉 تم إتمام الشراء بنجاح!", [
      `رقم الطلب: #${result.order.id}`,
      `رصيدك الجديد: ${formatMoney(result.balance)}`,
      "",
      "🔑 وبيانات المنتج/الكود الخاص بك:",
      result.deliveryText,
    ]), { reply_markup: homeKeyboard(false) });
    return;
  }

  await notifyStaffAboutAssistedOrder(api, store, superAdmins, result);
  await api.sendMessage(chatId, panel("✅ تم استلام طلبك بنجاح", [
    `رقم الطلب: #${result.order.id}`,
    `رصيدك المتبقي: ${formatMoney(result.balance)}`,
    "سيقوم البائع بمراجعة متطلباتك وتسليم المنتج لك هنا فور الجاهزية.",
  ]), { reply_markup: homeKeyboard(false) });
}

async function startManualTopup(api, store, chatId, userId, paymentMethod, amountPiasters) {
  const config = manualPaymentConfig(paymentMethod);
  if (!topupsEnabled() || !config) throw new Error("طريقة الدفع المختارة غير متاحة حالياً.");
  const topup = store.createManualTopup(userId, config.method, amountPiasters);
  store.setState(userId, "manual_topup_proof", { topupId: topup.id });
  await api.sendMessage(chatId, panel(`💳 شحن يدوي عبر ${config.label}`, [
    `المبلغ المطلوب: ${formatMoney(topup.amount_piasters)}`,
    `أرسل التحويل إلى: ${config.receiver}`,
    config.instructions || "أدخل بيانات التحويل الصحيحة ثم احتفظ بالإيصال.",
    "",
    "بعد التحويل أرسل سكرين شوت أو ملف الإيصال هنا. سيصل تلقائياً إلى الأدمن للمراجعة، ثم يضاف الرصيد يدوياً بعد الاعتماد.",
  ]), { reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] } });
}

function receiptFromMessage(message = {}) {
  if (Array.isArray(message.photo) && message.photo.length) {
    return { kind: "photo", fileId: message.photo[message.photo.length - 1].file_id };
  }
  if (message.document?.file_id) return { kind: "document", fileId: message.document.file_id };
  return null;
}

async function notifyAdminsAboutManualTopup(api, store, topup) {
  const admins = store.listSuperAdmins().filter((admin) => admin.status === "active");
  const caption = panel("🧾 إثبات شحن يدوي جديد", [
    `رقم الطلب: #${topup.id}`,
    `العميل: ${topup.user_id}`,
    `الطريقة: ${topup.payment_method === "wallet" ? "المحفظة" : "Binance"}`,
    `المبلغ المطلوب: ${formatMoney(topup.amount_piasters)}`,
    "راجع قيمة التحويل والإثبات قبل الاعتماد.",
  ]);
  const options = {
    caption,
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ اعتماد وإضافة الرصيد", callback_data: `admin:approve_manual_topup:${topup.id}` }],
        [{ text: "❌ رفض مع سبب", callback_data: `admin:reject_manual_topup:${topup.id}` }],
      ],
    },
  };
  await Promise.allSettled(admins.map((admin) => (
    topup.proof_kind === "photo"
      ? api.sendPhoto(admin.telegram_id, topup.proof_file_id, options)
      : api.sendDocument(admin.telegram_id, topup.proof_file_id, options)
  )));
}

async function handleManualTopupReceipt(api, store, chatId, userId, state, message) {
  if (state.state !== "manual_topup_proof") return false;
  const receipt = receiptFromMessage(message);
  if (!receipt) {
    await api.sendMessage(chatId, "📎 أرسل سكرين شوت أو ملف الإيصال فقط، أو استخدم /cancel للإلغاء.");
    return true;
  }
  const topup = store.submitManualTopupProof(userId, state.data.topupId, receipt);
  store.clearState(userId);
  await notifyAdminsAboutManualTopup(api, store, topup);
  await api.sendMessage(chatId, panel("✅ تم إرسال إثبات التحويل", [
    `رقم الطلب: #${topup.id}`,
    "سيقوم الأدمن بمراجعة الإيصال. ستصلك رسالة عند اعتماد أو رفض الطلب.",
  ]), { reply_markup: homeKeyboard(false) });
  return true;
}

async function handleStateMessage(api, store, superAdmins, chatId, from, state, text) {
  const userId = String(from.id);
  const stf = staffStatus(store, superAdmins, userId);

  if (state.state === "manual_topup_amount") {
    const amount = parseMoneyToPiasters(text);
    store.clearState(userId);
    await startManualTopup(api, store, chatId, userId, state.data.paymentMethod, amount);
    return;
  }

  if (state.state === "auto_topup_amount_wallet" || state.state === "auto_topup_amount") {
    const amount = parseMoneyToPiasters(text);
    store.clearState(userId);
    const receiver = autoTopupReceiver();
    const topup = store.createAutoTopup(userId, amount, "wallet", receiver);
    const lines = [
      `💵 المبلغ المطلوب تحويله بالضبط: **${formatMoney(topup.amount_piasters)}**`,
      `📱 رقم المحفظة / فودافون كاش: \`${receiver}\``,
      "",
      "📌 خطوات إتمام الشحن والتأكيد بالرقم:",
      "1. قم بتحويل المبلغ المحدد أعلاه بالضبط إلى رقم المحفظة.",
      "2. بعد إتمام التحويل، اضغط على زر [✅ تم التحويل - تأكيد بالرقم] بالأسفل.",
      "3. سيطلب منك البوت رقم الهاتف الذي حوّلت منه للتحقق من رسالة الـ SMS وإضافة رصيدك فوراً في ثوانٍ.",
    ];
    await api.sendMessage(chatId, panel("📱 شحن رصيد فوري عبر المحفظة", lines), {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ تم التحويل - تأكيد بالرقم", callback_data: `auto_topup_confirm_phone:${topup.id}` }],
          [{ text: "❌ إلغاء", callback_data: "flow:cancel" }],
        ],
      },
    });
    return;
  }

  if (state.state === "auto_topup_amount_instapay") {
    const amount = parseMoneyToPiasters(text);
    store.clearState(userId);
    const instapayReceiver = String(process.env.AUTO_TOPUP_INSTAPAY_RECEIVER || process.env.AUTO_TOPUP_WALLET_RECEIVER || "01000000000").trim();
    const topup = store.createAutoTopup(userId, amount, "instapay", instapayReceiver);
    const lines = [
      `💵 المبلغ المطلوب تحويله بالضبط: **${formatMoney(topup.amount_piasters)}**`,
      `⚡ عنوان / رقم إنستاباي (InstaPay): \`${instapayReceiver}\``,
      "",
      "📌 خطوات إتمام الشحن والتأكيد بالاسم:",
      "1. افتح تطبيق إنستاباي وحوّل المبلغ المحدد أعلاه للعنوان المذكور.",
      "2. بعد إتمام التحويل، اضغط على زر [✅ تم التحويل - تأكيد بالاسم] بالأسفل.",
      "3. سيطلب منك البوت اسمك المسجل في إنستاباي أو اسم الحساب المحوِّل لمطابقة الإشعار وإضافة رصيدك فوراً.",
    ];
    await api.sendMessage(chatId, panel("⚡ شحن رصيد فوري عبر إنستاباي", lines), {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ تم التحويل - تأكيد بالاسم", callback_data: `auto_topup_confirm_name:${topup.id}` }],
          [{ text: "❌ إلغاء", callback_data: "flow:cancel" }],
        ],
      },
    });
    return;
  }

  if (state.state === "auto_topup_amount_binance") {
    const amountPiasters = parseMoneyToPiasters(text);
    store.clearState(userId);
    const usdtAmount = binancePayClient.calculateUsdtFromEgp(amountPiasters);
    const topup = store.createAutoTopup(userId, amountPiasters, "binance_pay", "Binance Pay");

    if (binancePayClient.isConfigured()) {
      try {
        const orderResult = await binancePayClient.createOrder({
          merchantTradeNo: topup.provider_order_id,
          orderAmount: usdtAmount,
          currency: "USDT",
          goodsName: `AI Studio Top-up #${topup.id}`,
        });

        const lines = [
          `💵 المبلغ المطلوب إضافته: **${formatMoney(topup.amount_piasters)}**`,
          `🪙 قيمة الدفع بـ USDT: **${usdtAmount.toFixed(2)} USDT**`,
          `🧾 رقم الطلب: \`${topup.provider_order_id}\``,
          "",
          "📌 طريقة الدفع المباشر:",
          "1. اضغط على زر [🔗 فتح رابط الدفع في Binance] بالأسفل للدفع في ثوانٍ.",
          "2. بعد إتمام الدفع، اضغط على زر [🔄 تأكيد واستلام الرصيد فوراً] ليتحقق البوت ويشحن رصيدك تلقائياً.",
        ];

        const inlineRows = [];
        if (orderResult.checkoutUrl || orderResult.universalUrl) {
          inlineRows.push([{ text: "🔗 فتح رابط الدفع في Binance", url: orderResult.universalUrl || orderResult.checkoutUrl }]);
        }
        inlineRows.push([{ text: "🔄 تأكيد واستلام الرصيد فوراً", callback_data: `binance_pay_check:${topup.id}` }]);
        inlineRows.push([{ text: "❌ إلغاء", callback_data: "flow:cancel" }]);

        await api.sendMessage(chatId, panel("🪙 فاتورة دفع Binance Pay الفورية", lines), {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: inlineRows },
        });
        return;
      } catch (err) {
        log.error("binance", "Failed to create Binance Pay order: " + err.message);
      }
    }

    // Fallback if Binance Pay API is not configured
    const binanceReceiver = String(process.env.MANUAL_BINANCE_RECEIVER || "غير محدد").trim();
    const lines = [
      `💵 المبلغ المطلوب: **${formatMoney(topup.amount_piasters)}** (${usdtAmount.toFixed(2)} USDT)`,
      `🆔 معرف باينانس Binance Pay ID: \`${binanceReceiver}\``,
      "",
      "قم بالتحويل عبر Binance Pay ثم تواصل مع الإدارة أو أرسل الإثبات لإضافة الرصيد.",
    ];
    await api.sendMessage(chatId, panel("🪙 شحن عبر Binance Pay", lines), {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [adminContactButton("📞 التواصل مع الدعم")],
          [{ text: "🏠 القائمة الرئيسية", callback_data: "main:home" }],
        ],
      },
    });
    return;
  }

  if (state.state === "auto_topup_sender_phone") {
    const topupId = state.data.topupId;
    const cleanSender = text.trim();
    try {
      const result = store.verifyAndClaimSmsTopup(userId, topupId, cleanSender);
      if (result.ok) {
        store.clearState(userId);
        const senderPhone = result.transfer?.sender_phone || cleanSender;
        const trxId = result.transfer?.trx_id ? result.transfer.trx_id.replace(/^[^_]+_/, "") : "مكتمل";
        const lines = [
          `💵 المبلغ المضاف: **${formatMoney(result.topup.amount_piasters)}**`,
          `📱 رقم المحول: ${senderPhone}`,
          `🧾 كود العملية: ${trxId}`,
          `💰 رصيدك الحالي: **${formatMoney(result.balance)}**`,
        ];
        await api.sendMessage(chatId, panel("🎉 تم شحن رصيدك بنجاح!", lines), {
          reply_markup: homeKeyboard(false),
        });
        return;
      }

      // Not found yet
      const lines = [
        `المبلغ المطلوب: ${formatMoney(result.topup.amount_piasters)}`,
        `الرقم المدخل: ${cleanSender}`,
        "",
        "⏳ لم يتم العثور على إشعار التحويل حتى الآن.",
        "💡 إذا كنت قد حوّلت للتو، قد تستغرق شبكة المحفظة من 30 إلى 60 ثانية لوصول إشعار الـ SMS.",
        "يمكنك الانتظار ثوانٍ ثم الضغط على زر [🔄 إعادة الفحص الآن]، أو تأكد من إدخال الرقم الصحيح.",
      ];
      await api.sendMessage(chatId, panel("⏳ في انتظار إشعار التحويل", lines), {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 إعادة الفحص الآن", callback_data: `auto_topup_retry_phone:${topupId}` }],
            [{ text: "✏️ تعديل رقم الهاتف المحول منه", callback_data: `auto_topup_confirm_phone:${topupId}` }],
            [{ text: "❌ إلغاء الطلب", callback_data: "flow:cancel" }],
          ],
        },
      });
      return;
    } catch (err) {
      await api.sendMessage(chatId, `⚠️ ${err.message}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 إعادة المحاولة", callback_data: `auto_topup_confirm_phone:${topupId}` }],
            [{ text: "❌ إلغاء", callback_data: "flow:cancel" }],
          ],
        },
      });
      return;
    }
  }

  if (state.state === "auto_topup_sender_name") {
    const topupId = state.data.topupId;
    const cleanSender = text.trim();
    try {
      const result = store.verifyAndClaimInstaPayTopup(userId, topupId, cleanSender);
      if (result.ok) {
        store.clearState(userId);
        const senderName = result.transfer?.sender_name || cleanSender;
        const trxId = result.transfer?.trx_id ? result.transfer.trx_id.replace(/^[^_]+_/, "") : "مكتمل";
        const lines = [
          `💵 المبلغ المضاف: **${formatMoney(result.topup.amount_piasters)}**`,
          `👤 اسم المحول: ${senderName}`,
          `🧾 كود العملية / المرجع: ${trxId}`,
          `💰 رصيدك الحالي: **${formatMoney(result.balance)}**`,
        ];
        await api.sendMessage(chatId, panel("🎉 تم شحن رصيدك عبر إنستاباي بنجاح!", lines), {
          reply_markup: homeKeyboard(false),
        });
        return;
      }

      // Not found yet
      const lines = [
        `المبلغ المطلوب: ${formatMoney(result.topup.amount_piasters)}`,
        `الاسم المدخل: ${cleanSender}`,
        "",
        "⏳ لم يتم العثور على إشعار تحويل إنستاباي مطابق حتى الآن.",
        "💡 يرجى التأكد من إتمام التحويل من تطبيق إنستاباي وأن الاسم يطابق اسم حسابك البنكي.",
        "يمكنك الانتظار ثوانٍ ثم الضغط على [🔄 إعادة الفحص الآن] أو تعديل الاسم:",
      ];
      await api.sendMessage(chatId, panel("⏳ في انتظار إشعار إنستاباي", lines), {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 إعادة الفحص الآن", callback_data: `auto_topup_retry_name:${topupId}` }],
            [{ text: "✏️ تعديل اسم المحول / المرجع", callback_data: `auto_topup_confirm_name:${topupId}` }],
            [{ text: "❌ إلغاء الطلب", callback_data: "flow:cancel" }],
          ],
        },
      });
      return;
    } catch (err) {
      await api.sendMessage(chatId, `⚠️ ${err.message}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 إعادة المحاولة", callback_data: `auto_topup_confirm_name:${topupId}` }],
            [{ text: "❌ إلغاء", callback_data: "flow:cancel" }],
          ],
        },
      });
      return;
    }
  }

  if (state.state === "manual_topup_proof") {
    await api.sendMessage(chatId, "📎 أرسل سكرين شوت أو ملف الإيصال فقط، أو استخدم /cancel للإلغاء.");
    return;
  }

  if (state.state === "search_query") {
    store.clearState(userId);
    const results = store.searchProducts(text);
    if (!results.length) {
      await api.sendMessage(chatId, panel("🔍 نتائج البحث", [`لم يتم العثور على منتجات باسم \"${text}\"`, "جرب كلمة بحث أخرى."]), { reply_markup: homeKeyboard(false) });
      return;
    }
    await api.sendMessage(chatId, panel("🔍 نتائج البحث", [`تم العثور على ${results.length} منتج:`]), { reply_markup: productListKeyboard(results) });
    return;
  }

  if (state.state === "assisted_input") {
    store.clearState(userId);
    const result = store.purchase(userId, state.data.productId, { userInput: text });
    await handlePurchaseResult(api, store, superAdmins, chatId, userId, result);
    return;
  }

  if (!stf.isSuperAdmin && !stf.isMerchant) return false;

  if (state.state === "merchant_product_title") {
    store.setState(userId, "merchant_product_category", { title: text });
    await api.sendMessage(chatId, "🏷️ أرسل تصنيف/قسم المنتج (مثال: حسابات، خدمات، ألعاب):", { reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] } });
    return;
  }
  if (state.state === "merchant_product_category") {
    store.setState(userId, "merchant_product_description", { ...state.data, category: text });
    await api.sendMessage(chatId, "📝 أرسل وصف المنتج والتفاصيل للمشتري:", { reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] } });
    return;
  }
  if (state.state === "merchant_product_description") {
    store.setState(userId, "merchant_product_price", { ...state.data, description: text });
    await api.sendMessage(chatId, `💵 أرسل سعر المنتج بـ ${currencyCode()} (مثال: 50 أو 100):`, { reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] } });
    return;
  }
  if (state.state === "merchant_product_price") {
    const pricePiasters = parseMoneyToPiasters(text);
    store.setState(userId, "merchant_product_type", { ...state.data, pricePiasters });
    await api.sendMessage(chatId, "⚡ اختر نوع التسليم للمنتج:", { reply_markup: productTypeKeyboard() });
    return;
  }

  if (state.state === "merchant_stock") {
    const items = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const before = store.getProduct(state.data.productId)?.available_stock || 0;
    const result = store.addStock(userId, state.data.productId, items);
    store.clearState(userId);
    await api.sendMessage(chatId, panel("🎉 تم إضافة المخزون بنجاح!", [
      `الكمية المضافة: ${result.added} قطعة`,
      `المخزون الكلي المتاح الآن: ${result.product.available_stock} قطعة`,
      before === 0 ? "🟢 المنتج أصبح نشطاً ومعروضاً للبيع في المتجر الآن!" : "",
    ]), { reply_markup: homeKeyboard(true) });
    return;
  }

  if (state.state === "merchant_edit_price") {
    const product = store.updateProductPrice(userId, state.data.productId, parseMoneyToPiasters(text));
    store.clearState(userId);
    await api.sendMessage(chatId, panel("✏️ تم تحديث السعر بنجاح", [
      `المنتج: #${product.id} ${product.title}`,
      `السعر الجديد: ${formatMoney(product.price_piasters)}`,
    ]), { reply_markup: homeKeyboard(true) });
    return;
  }

  if (state.state === "merchant_delivery") {
    const order = store.deliverOrder(userId, state.data.orderId, text);
    store.clearState(userId);
    await api.sendMessage(order.user_id, panel("🎉 تم تسليم طلبك!", [
      `رقم الطلب: #${order.id}`,
      `المنتج: ${order.product_title}`,
      "",
      "🔑 التسليم والنتيجة:",
      order.delivery_text,
    ]), { reply_markup: homeKeyboard(false) }).catch(() => { });
    await api.sendMessage(chatId, panel("✅ تم التسليم", [`الطلب #${order.id} تم تحديثه كمكتمل.`]), { reply_markup: homeKeyboard(true) });
    return;
  }

  if (!stf.isSuperAdmin) return false;

  if (state.state === "admin_add_merchant") {
    const [targetId, ...nameParts] = String(text || "").trim().split(/\s+/);
    const name = nameParts.join(" ") || `تاجر ${targetId}`;
    const merchant = store.addMerchant(userId, targetId, { displayName: name });
    store.clearState(userId);
    await api.sendMessage(chatId, panel("👤 تم إضافة التاجر", [`ID: ${merchant.telegram_id}`, `الاسم: ${merchant.display_name || name}`]), { reply_markup: adminKeyboard(true) });
    return;
  }

  if (state.state === "admin_add_admin") {
    const [targetId, ...nameParts] = String(text || "").trim().split(/\s+/);
    const name = nameParts.join(" ") || `أدمن ${targetId}`;
    const admin = store.addSuperAdmin(userId, targetId, { displayName: name });
    store.clearState(userId);
    await api.sendMessage(chatId, panel("🛡️ تم إضافة الأدمن", [`ID: ${admin.telegram_id}`, `الاسم: ${admin.display_name || name}`]), { reply_markup: adminKeyboard(true) });
    return;
  }

  if (state.state === "admin_remove_merchant") {
    const targetId = store.resolveUserId(text);
    if (!targetId) throw new Error("⚠️ لم يتم العثور على التاجر.");
    store.deactivateMerchant(userId, targetId);
    store.clearState(userId);
    await api.sendMessage(chatId, panel("➖ تم إيقاف التاجر", [`ID: ${targetId}`, "تم إيقاف منتجاته النشطة وحفظ السجل السابق."]), { reply_markup: adminKeyboard(true) });
    return;
  }

  if (state.state === "admin_remove_admin") {
    const targetId = store.resolveUserId(text);
    if (!targetId) throw new Error("⚠️ لم يتم العثور على الأدمن.");
    store.deactivateSuperAdmin(userId, targetId);
    store.clearState(userId);
    await api.sendMessage(chatId, panel("⛔ تم إيقاف الأدمن", [`ID: ${targetId}`, "تم تعطيل صلاحياته وإيقاف منتجاته النشطة مع حفظ السجل السابق."]), { reply_markup: adminKeyboard(true) });
    return;
  }

  if (state.state === "admin_reject_manual_topup") {
    const topup = store.rejectManualTopup(userId, state.data.topupId, text);
    store.clearState(userId);
    await api.sendMessage(topup.user_id, panel("❌ تم رفض إثبات الشحن", [
      `رقم الطلب: #${topup.id}`,
      `السبب: ${topup.reviewer_note}`,
      "يمكنك بدء طلب شحن جديد بعد مراجعة بيانات التحويل.",
    ]), { reply_markup: homeKeyboard(false) }).catch(() => { });
    await api.sendMessage(chatId, panel("❌ تم رفض طلب الشحن", [`رقم الطلب: #${topup.id}`]), { reply_markup: adminKeyboard(true) });
    return;
  }

  if (state.state === "admin_credit") {
    const [targetInput, amountInput, ...noteParts] = String(text || "").trim().split(/\s+/);
    const targetId = store.resolveUserId(targetInput);
    if (!targetId) throw new Error("⚠️ لم يتم العثور على المستخدم.");
    const creditAmount = parseMoneyToPiasters(amountInput);
    const noteText = noteParts.join(" ") || "شحن يدوي من الأدمن";
    const balance = store.adminCreditUser(userId, targetId, creditAmount, noteText);
    store.clearState(userId);
    await api.sendMessage(chatId, panel("💵 تم إضافة الرصيد بنجاح", [`المستخدم: ${targetId}`, `رصيده الحالي: ${formatMoney(balance)}`]), { reply_markup: adminKeyboard(true) });
    // إشعار المستخدم بشحن رصيده
    await api.sendMessage(targetId, panel("💰 تم شحن رصيدك!", [
      `تم إضافة ${formatMoney(creditAmount)} إلى محفظتك.`,
      `رصيدك الحالي: ${formatMoney(balance)}`,
      noteText !== "شحن يدوي من الأدمن" ? `ملاحظة: ${noteText}` : "",
    ]), { reply_markup: homeKeyboard(false) }).catch(() => { });
    return;
  }

  if (state.state === "admin_zero") {
    const targetId = store.resolveUserId(text);
    if (!targetId) throw new Error("⚠️ لم يتم العثور على المستخدم.");
    store.adminZeroBalance(userId, targetId);
    store.clearState(userId);
    await api.sendMessage(chatId, panel("🔄 تم تصفير الرصيد بنجاح", [`المستخدم: ${targetId}`]), { reply_markup: adminKeyboard(true) });
    return;
  }

  if (state.state === "admin_custom_price") {
    const [targetInput, productIdInput, priceInput, ...noteParts] = String(text || "").trim().split(/\s+/);
    const targetId = store.resolveUserId(targetInput);
    if (!targetId) throw new Error("⚠️ لم يتم العثور على المستخدم.");
    const override = store.setUserPriceOverride(userId, targetId, Number(productIdInput), parseMoneyToPiasters(priceInput), noteParts.join(" "));
    store.clearState(userId);
    await api.sendMessage(chatId, panel("🏷️ تم حفظ السعر الخاص", [
      `المستخدم: ${override.user_id}`,
      `المنتج: #${override.product_id}`,
      `السعر المخصص: ${formatMoney(override.price_piasters)}`,
    ]), { reply_markup: adminKeyboard(true) });
    return;
  }

  if (state.state === "admin_broadcast") {
    store.clearState(userId);
    const userIds = store.getAllUserIds();
    await api.sendMessage(chatId, `⏳ جاري إرسال الرسالة الجماعية إلى ${userIds.length} عضو...`);
    let successCount = 0;
    let failCount = 0;
    for (const targetId of userIds) {
      try {
        await api.sendMessage(targetId, panel("📢 رسالة إدارية هامة", [text]));
        successCount += 1;
      } catch {
        failCount += 1;
      }
      await sleep(100);
    }
    await api.sendMessage(chatId, panel("📢 اكتمل إرسال الرسالة الجماعية!", [
      `إجمالي الأعضاء: ${userIds.length}`,
      `✅ تم الإرسال بنجاح إلى: ${successCount} عضو`,
      `❌ تعذر الإرسال إلى: ${failCount} عضو (أو قام بإيقاف البوت)`,
    ]), { reply_markup: adminKeyboard(true) });
    return;
  }

  return false;
}

async function handleMessage(api, store, superAdmins, message) {
  const chatId = message.chat?.id;
  const from = message.from || {};
  if (!chatId || !from.id) return;
  const userId = store.ensureUser(from);
  const text = String(message.text || "").trim();
  const pendingState = store.getState(userId);

  if (pendingState && (message.photo || message.document)) {
    try {
      const handled = await handleManualTopupReceipt(api, store, chatId, userId, pendingState, message);
      if (handled) return;
    } catch (error) {
      await api.sendMessage(chatId, error.message || "⚠️ حدث خطأ ما.", { reply_markup: homeKeyboard(false) });
      return;
    }
  }

  const stf = staffStatus(store, superAdmins, userId);
  const isMaint = store.getMaintenanceMode();
  if (isMaint && !stf.isSuperAdmin && !stf.isMerchant) {
    const lang = store.getUserLanguage(userId);
    await api.sendMessage(chatId, t("maintenance_alert", lang)).catch(() => { });
    return;
  }

  if (!stf.isSuperAdmin && !stf.isMerchant) {
    const joinCheck = await checkMandatoryJoin(api, userId);
    if (!joinCheck.ok) {
      await sendMandatoryJoinPrompt(api, store, chatId, userId);
      return;
    }
  }

  // التعامل مع الأزرار الثابتة بالأسفل (Reply Keyboards)
  if (text === t("btn_products", "ar") || text === t("btn_products", "en") || text.includes("المنتجات") || text.includes("Products")) { store.clearState(userId); await showShop(api, store, chatId); return; }
  if (text === t("btn_wallet", "ar") || text === t("btn_wallet", "en") || text.includes("المحفظة") || text.includes("Wallet")) { store.clearState(userId); await showWallet(api, store, chatId, userId); return; }
  if (text === t("btn_language", "ar") || text === t("btn_language", "en") || text.includes("اللغة") || text.includes("Language")) { store.clearState(userId); await showLanguageMenu(api, store, chatId, userId); return; }
  if (text === t("btn_more", "ar") || text === t("btn_more", "en") || text.includes("المزيد") || text.includes("More")) { store.clearState(userId); await showMoreMenu(api, store, chatId, userId); return; }
  if (text === t("btn_orders", "ar") || text === t("btn_orders", "en") || text.includes("المشتريات") || text.includes("طلباتي")) { store.clearState(userId); await showOrders(api, store, chatId, userId); return; }
  if (text === t("btn_statement", "ar") || text === t("btn_statement", "en") || text.includes("كشف حساب")) { store.clearState(userId); await showStatement(api, store, chatId, userId); return; }
  if (text === t("btn_account", "ar") || text === t("btn_account", "en") || text.includes("الملف الشخصي") || text.includes("حسابي")) { store.clearState(userId); await showAccount(api, store, chatId, userId, from); return; }
  if (text === t("btn_contact_admin", "ar") || text === t("btn_contact_admin", "en") || text.includes("الدعم الفني") || text.includes("التواصل مع الأدمن")) { store.clearState(userId); await showContactAdmin(api, store, chatId); return; }
  if (text === t("btn_admin_panel", "ar") || text === t("btn_admin_panel", "en")) { store.clearState(userId); await showAdmin(api, store, superAdmins, chatId, userId); return; }
  if (text === t("btn_topup", "ar") || text === t("btn_topup", "en") || text.includes("إضافة رصيد") || text.includes("شحن الرصيد")) {
    store.clearState(userId);
    await showTopupMenu(api, store, chatId, userId);
    return;
  }
  if (text === t("btn_search", "ar") || text === t("btn_search", "en") || text.includes("البحث") || text.includes("بحث")) {
    store.setState(userId, "search_query", {});
    await api.sendMessage(chatId, "🔍 أرسل اسم الاشتراك أو المنتج الذي تبحث عنه:", { reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] } });
    return;
  }

  if (isCommand(text, "start")) {
    store.clearState(userId);
    await showHome(api, store, superAdmins, chatId, from);
    return;
  }
  if (isCommand(text, "help")) {
    store.clearState(userId);
    const helpLines = [
      "🛒 المنتجات — تصفح المتجر والمنتجات المتاحة",
      "💰 المحفظة — عرض رصيدك وآخر العمليات",
      "📦 طلباتي — سجل مشترياتك وحالة الطلبات",
      "👤 حسابي — بياناتك الشخصية",
      "💳 شحن الرصيد — اختيار وسيلة الدفع والتواصل مع الأدمن",
      "",
      "الأوامر المتاحة:",
      "/start — القائمة الرئيسية",
      "/help — هذه الرسالة",
      "/cancel — إلغاء العملية الحالية",
    ];
    await api.sendMessage(chatId, panel(`❓ المساعدة — ${brandName()}`, helpLines), {
      reply_markup: homeKeyboard(stf.isSuperAdmin || stf.isMerchant),
    });
    return;
  }
  if (isCommand(text, "cancel")) {
    store.clearState(userId);
    await api.sendMessage(chatId, "❌ تم الإلغاء.", { reply_markup: homeKeyboard(false) });
    return;
  }

  const state = pendingState;
  if (state) {
    try {
      const handled = await handleStateMessage(api, store, superAdmins, chatId, from, state, text);
      if (handled !== false) return;
    } catch (error) {
      await api.sendMessage(chatId, error.message || "⚠️ حدث خطأ ما.", { reply_markup: homeKeyboard(staffStatus(store, superAdmins, userId).isMerchant) });
      return;
    }
  }

  await showHome(api, store, superAdmins, chatId, from);
}

async function handleCallback(api, store, superAdmins, query) {
  const chatId = query.message?.chat?.id || query.from?.id;
  const messageId = query.message?.message_id;
  const from = query.from || {};
  if (!chatId || !from.id) return;
  const userId = store.ensureUser(from);
  const data = String(query.data || "");
  await api.answerCallbackQuery(query.id).catch(() => { });
  const stf = staffStatus(store, superAdmins, userId);

  const isMaint = store.getMaintenanceMode();
  if (isMaint && !stf.isSuperAdmin && !stf.isMerchant) {
    const lang = store.getUserLanguage(userId);
    await api.answerCallbackQuery(query.id, { text: t("maintenance_alert", lang), show_alert: true }).catch(() => { });
    await safeEditOrSend(api, chatId, messageId, t("maintenance_alert", lang));
    return;
  }

  if (data === "check_join") {
    const joinCheck = await checkMandatoryJoin(api, userId);
    const lang = store.getUserLanguage(userId);
    if (joinCheck.ok) {
      await api.answerCallbackQuery(query.id, { text: t("join_success", lang), show_alert: true }).catch(() => { });
      await showHome(api, store, superAdmins, chatId, from, messageId);
    } else {
      await api.answerCallbackQuery(query.id, { text: t("join_failed", lang), show_alert: true }).catch(() => { });
    }
    return;
  }

  if (data === "main:contact_admin") {
    await showContactAdmin(api, store, chatId, messageId);
    return;
  }

  if (data === "main:language") {
    await showLanguageMenu(api, store, chatId, userId, messageId);
    return;
  }

  if (data.startsWith("lang:")) {
    const targetLang = data.split(":")[1];
    store.setUserLanguage(userId, targetLang);
    await api.answerCallbackQuery(query.id, { text: t("lang_changed", targetLang), show_alert: true }).catch(() => { });
    await showHome(api, store, superAdmins, chatId, from, messageId);
    return;
  }

  if (data === "topup_select:wallet") {
    const receiver = String(process.env.MANUAL_WALLET_RECEIVER || "غير محدد").trim();
    const lang = store.getUserLanguage(userId);
    const text = panel(t("topup_wallet_btn", lang), [
      t("topup_wallet_info", lang, { receiver }),
    ]);
    const keyboard = {
      inline_keyboard: [
        [adminContactButton(t("btn_contact_admin_topup", lang))],
        [{ text: t("btn_home", lang), callback_data: "main:home" }],
      ],
    };
    await safeEditOrSend(api, chatId, messageId, text, { parse_mode: "Markdown", reply_markup: keyboard });
    return;
  }

  if (data === "topup_select:binance") {
    const receiver = String(process.env.MANUAL_BINANCE_RECEIVER || "غير محدد").trim();
    const lang = store.getUserLanguage(userId);
    const text = panel(t("topup_binance_btn", lang), [
      t("topup_binance_info", lang, { receiver }),
    ]);
    const keyboard = {
      inline_keyboard: [
        [adminContactButton(t("btn_contact_admin_topup", lang))],
        [{ text: t("btn_home", lang), callback_data: "main:home" }],
      ],
    };
    await safeEditOrSend(api, chatId, messageId, text, { parse_mode: "Markdown", reply_markup: keyboard });
    return;
  }

  if (!stf.isSuperAdmin && !stf.isMerchant) {
    const joinCheck = await checkMandatoryJoin(api, userId);
    if (!joinCheck.ok) {
      await sendMandatoryJoinPrompt(api, store, chatId, userId, messageId);
      return;
    }
  }

  if (data === "flow:cancel") {
    store.clearState(userId);
    await safeEditOrSend(api, chatId, messageId, "❌ تم الإلغاء.", { reply_markup: homeKeyboard(stf.isSuperAdmin || stf.isMerchant) });
    return;
  }

  if (data === "main:home") {
    store.clearState(userId);
    await showHome(api, store, superAdmins, chatId, from, messageId);
    return;
  }
  if (data === "main:shop") { await showShop(api, store, chatId, messageId); return; }
  if (data === "main:wallet" || data === "main:balance") { await showWallet(api, store, chatId, userId, messageId); return; }
  if (data === "main:more") { await showMoreMenu(api, store, chatId, userId, messageId); return; }
  if (data === "main:statement") { await showStatement(api, store, chatId, userId, messageId); return; }
  if (data === "main:orders") { await showOrders(api, store, chatId, userId, messageId); return; }
  if (data === "main:account") { await showAccount(api, store, chatId, userId, from, messageId); return; }
  if (data === "main:search") {
    store.setState(userId, "search_query", {});
    await safeEditOrSend(api, chatId, messageId, "🔍 أرسل اسم الاشتراك أو المنتج الذي تبحث عنه:", {
      reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] }
    });
    return;
  }
  if (data === "main:admin") { await showAdmin(api, store, superAdmins, chatId, userId, messageId); return; }

  if (data === "main:topup") {
    await showTopupMenu(api, store, chatId, userId, messageId);
    return;
  }

  // طرق الشحن الإلكتروني الفوري:
  if (data === "auto_topup:wallet" || data === "auto_topup:start") {
    const receiver = autoTopupReceiver();
    if (!receiver) {
      await safeEditOrSend(api, chatId, messageId, "⚠️ خدمة الشحن عبر المحفظة غير مهيأة حالياً. يرجى التواصل مع الإدارة.", {
        reply_markup: homeKeyboard(false),
      });
      return;
    }
    store.setState(userId, "auto_topup_amount_wallet", {});
    await safeEditOrSend(api, chatId, messageId, panel("📱 شحن عبر المحفظة الإلكترونية", [
      "✏️ أرسل المبلغ الذي تريد شحنه بالجنيه المصري (مثال: 50 أو 100):",
      `📱 سيتم التحويل إلى رقم المحفظة: \`${receiver}\``,
    ]), {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] },
    });
    return;
  }

  if (data === "auto_topup:instapay") {
    const instapayReceiver = String(process.env.AUTO_TOPUP_INSTAPAY_RECEIVER || process.env.AUTO_TOPUP_WALLET_RECEIVER || "01000000000").trim();
    store.setState(userId, "auto_topup_amount_instapay", {});
    await safeEditOrSend(api, chatId, messageId, panel("⚡ شحن فوري عبر إنستاباي", [
      "✏️ أرسل المبلغ الذي تريد شحنه بالجنيه المصري (مثال: 50 أو 100):",
      `⚡ عنوان / رقم إنستاباي: \`${instapayReceiver}\``,
    ]), {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] },
    });
    return;
  }

  if (data === "auto_topup:binance") {
    store.setState(userId, "auto_topup_amount_binance", {});
    const rate = binancePayClient.getUsdtRate();
    await safeEditOrSend(api, chatId, messageId, panel("🪙 شحن تلقائي عبر Binance Pay", [
      "✏️ أرسل مبلغ الرصيد الذي تريد إضافته بالجنيه (مثال: 50 أو 100 أو 500):",
      `سعر احتساب 1 USDT = ${rate.toFixed(2)} EGP`,
    ]), {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] },
    });
    return;
  }

  if (data.startsWith("auto_topup_confirm_phone:") || data.startsWith("auto_topup_confirm:")) {
    const topupId = Number(data.split(":")[1]);
    const topup = store.getTopup(topupId);
    if (!topup || topup.user_id !== userId) {
      await safeEditOrSend(api, chatId, messageId, "⚠️ طلب الشحن غير موجود أو منتهي الصلاحية.", { reply_markup: homeKeyboard(false) });
      return;
    }
    store.setState(userId, "auto_topup_sender_phone", { topupId });
    await safeEditOrSend(api, chatId, messageId, "📱 أرسل الآن رقم المحفظة / الهاتف الذي قمت بالتحويل منه (مثال: 01012345678):", {
      reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] },
    });
    return;
  }

  if (data.startsWith("auto_topup_confirm_name:")) {
    const topupId = Number(data.split(":")[1]);
    const topup = store.getTopup(topupId);
    if (!topup || topup.user_id !== userId) {
      await safeEditOrSend(api, chatId, messageId, "⚠️ طلب الشحن غير موجود أو منتهي الصلاحية.", { reply_markup: homeKeyboard(false) });
      return;
    }
    store.setState(userId, "auto_topup_sender_name", { topupId });
    await safeEditOrSend(api, chatId, messageId, "👤 أرسل الآن اسم الراسل المسجل في إنستاباي أو رقم المرجع:", {
      reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] },
    });
    return;
  }

  if (data.startsWith("auto_topup_retry_phone:") || data.startsWith("auto_topup_retry:")) {
    const topupId = Number(data.split(":")[1]);
    const topup = store.getTopup(topupId);
    if (!topup || topup.user_id !== userId) {
      await safeEditOrSend(api, chatId, messageId, "⚠️ طلب الشحن غير موجود أو منتهي الصلاحية.", { reply_markup: homeKeyboard(false) });
      return;
    }
    if (!topup.sender_identifier) {
      store.setState(userId, "auto_topup_sender_phone", { topupId });
      await safeEditOrSend(api, chatId, messageId, "📱 يرجى إرسال رقم الهاتف المحول منه أولاً:", {
        reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] },
      });
      return;
    }

    try {
      const result = store.verifyAndClaimSmsTopup(userId, topupId, topup.sender_identifier);
      if (result.ok) {
        store.clearState(userId);
        const senderPhone = result.transfer?.sender_phone || topup.sender_identifier;
        const trxId = result.transfer?.trx_id ? result.transfer.trx_id.replace(/^[^_]+_/, "") : "مكتمل";
        const lines = [
          `💵 المبلغ المضاف: **${formatMoney(result.topup.amount_piasters)}**`,
          `📱 رقم المحول: ${senderPhone}`,
          `🧾 كود العملية: ${trxId}`,
          `💰 رصيدك الحالي: **${formatMoney(result.balance)}**`,
        ];
        await safeEditOrSend(api, chatId, messageId, panel("🎉 تم شحن رصيدك بنجاح!", lines), {
          reply_markup: homeKeyboard(false),
        });
        return;
      }

      await api.answerCallbackQuery(query.id, {
        text: "⏳ لم تصل رسالة التحويل بعد. انتظر ثوانٍ وجرب مرة أخرى.",
        show_alert: true,
      }).catch(() => { });
    } catch (err) {
      await api.answerCallbackQuery(query.id, {
        text: `⚠️ ${err.message}`,
        show_alert: true,
      }).catch(() => { });
    }
    return;
  }

  if (data.startsWith("auto_topup_retry_name:")) {
    const topupId = Number(data.split(":")[1]);
    const topup = store.getTopup(topupId);
    if (!topup || topup.user_id !== userId) {
      await safeEditOrSend(api, chatId, messageId, "⚠️ طلب الشحن غير موجود أو منتهي الصلاحية.", { reply_markup: homeKeyboard(false) });
      return;
    }
    if (!topup.sender_identifier) {
      store.setState(userId, "auto_topup_sender_name", { topupId });
      await safeEditOrSend(api, chatId, messageId, "👤 يرجى إرسال اسم الراسل في إنستاباي أولاً:", {
        reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] },
      });
      return;
    }

    try {
      const result = store.verifyAndClaimInstaPayTopup(userId, topupId, topup.sender_identifier);
      if (result.ok) {
        store.clearState(userId);
        const senderName = result.transfer?.sender_name || topup.sender_identifier;
        const trxId = result.transfer?.trx_id ? result.transfer.trx_id.replace(/^[^_]+_/, "") : "مكتمل";
        const lines = [
          `💵 المبلغ المضاف: **${formatMoney(result.topup.amount_piasters)}**`,
          `👤 اسم المحول: ${senderName}`,
          `🧾 كود العملية / المرجع: ${trxId}`,
          `💰 رصيدك الحالي: **${formatMoney(result.balance)}**`,
        ];
        await safeEditOrSend(api, chatId, messageId, panel("🎉 تم شحن رصيدك عبر إنستاباي بنجاح!", lines), {
          reply_markup: homeKeyboard(false),
        });
        return;
      }

      await api.answerCallbackQuery(query.id, {
        text: "⏳ لم تصل رسالة إنستاباي بعد. انتظر ثوانٍ وجرب مرة أخرى.",
        show_alert: true,
      }).catch(() => { });
    } catch (err) {
      await api.answerCallbackQuery(query.id, {
        text: `⚠️ ${err.message}`,
        show_alert: true,
      }).catch(() => { });
    }
    return;
  }

  if (data.startsWith("binance_pay_check:")) {
    const topupId = Number(data.split(":")[1]);
    const topup = store.getTopup(topupId);
    if (!topup || topup.user_id !== userId) {
      await api.answerCallbackQuery(query.id, { text: "⚠️ طلب الشحن غير موجود.", show_alert: true }).catch(() => { });
      return;
    }
    if (topup.status === "succeeded") {
      await api.answerCallbackQuery(query.id, { text: "🎉 تم إضافة الرصيد لحسابك بالفعل!", show_alert: true }).catch(() => { });
      await showWallet(api, store, chatId, userId, messageId);
      return;
    }

    try {
      const queryResult = await binancePayClient.queryOrder({ merchantTradeNo: topup.provider_order_id });
      if (queryResult.isPaid) {
        const claim = store.verifyAndClaimBinanceTopup(userId, topup.id, queryResult);
        await api.answerCallbackQuery(query.id, { text: "🎉 تم التحقق وإضافة الرصيد بنجاح!", show_alert: true }).catch(() => { });
        const lines = [
          `💵 المبلغ المضاف: **${formatMoney(claim.topup.amount_piasters)}**`,
          `🪙 العملة: USDT (${queryResult.totalFee || ""})`,
          `🧾 رقم العملية: ${queryResult.transactionId || topup.provider_order_id}`,
          `💰 رصيدك الحالي: **${formatMoney(claim.balance)}**`,
        ];
        await safeEditOrSend(api, chatId, messageId, panel("🎉 تم شحن رصيدك بنجاح!", lines), {
          reply_markup: homeKeyboard(false),
        });
        return;
      }

      await api.answerCallbackQuery(query.id, {
        text: "⏳ لم يتم تسجيل الدفع في بايننس بعد. تأكد من إتمام العملية في التطبيق ثم أعد المحاولة.",
        show_alert: true,
      }).catch(() => { });
    } catch (err) {
      await api.answerCallbackQuery(query.id, {
        text: `⚠️ ${err.message}`,
        show_alert: true,
      }).catch(() => { });
    }
    return;
  }

  if (data === "admin:sms_transfers") {
    if (!stf.isSuperAdmin) return;
    const transfers = store.listRecentSmsTransfers(15);
    const lines = transfers.length ? [] : ["لا توجد رسائل تحويل مستلمة حتى الآن."];
    for (const t of transfers) {
      const statusIcon = t.status === "claimed" ? "✅ مستخدم" : "⏳ غير مستخدم";
      const userTag = t.claimed_by_user_id ? ` (العميل: ${t.claimed_by_user_id})` : "";
      lines.push(`${statusIcon} ${formatMoney(t.amount_piasters)} • من ${t.sender_phone} • كود: ${t.trx_id.replace(/^[^_]+_/, "")}${userTag}`);
    }
    await safeEditOrSend(api, chatId, messageId, panel("📱 آخر رسائل التحويلات المستلمة", lines), {
      reply_markup: adminKeyboard(true, store.getMaintenanceMode()),
    });
    return;
  }

  if (data.startsWith("manual_topup:")) {
    const paymentMethod = data.split(":")[1];
    const config = manualPaymentConfig(paymentMethod);
    if (!topupsEnabled() || !config) {
      await safeEditOrSend(api, chatId, messageId, "⚠️ طريقة الدفع المختارة غير متاحة حالياً.", { reply_markup: homeKeyboard(false) });
      return;
    }
    store.setState(userId, "manual_topup_amount", { paymentMethod: config.method });
    await safeEditOrSend(api, chatId, messageId, `✏️ أرسل مبلغ الشحن عبر ${config.label} بـ ${currencyCode()} (مثال: 50 أو 100):`, { reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] } });
    return;
  }

  if (data.startsWith("product:")) {
    const product = store.getProduct(Number(data.split(":")[1]));
    if (!product) {
      await safeEditOrSend(api, chatId, messageId, "⚠️ المنتج غير موجود.", { reply_markup: homeKeyboard(false) });
      return;
    }
    const isAvailable = product.status === "active" && (product.fulfillment_type !== "ready_stock" || product.available_stock > 0);
    await safeEditOrSend(api, chatId, messageId, productText(store, userId, product), { reply_markup: productActions(product, isAvailable) });
    return;
  }

  if (data.startsWith("buy:")) {
    const product = store.getProduct(Number(data.split(":")[1]));
    if (!product) {
      await safeEditOrSend(api, chatId, messageId, "⚠️ المنتج غير موجود.", { reply_markup: homeKeyboard(false) });
      return;
    }
    if (product.fulfillment_type === "assisted") {
      store.setState(userId, "assisted_input", { productId: product.id });
      await safeEditOrSend(api, chatId, messageId, panel("📝 تفاصيل الطلب المتطلب", [
        `المنتج: ${product.title}`,
        `السعر: ${formatMoney(store.effectivePrice(userId, product))}`,
        "",
        "📌 يرجى إرسال بياناتك أو الإيميل أو متطلباتك في رسالة واحدة هنا:",
      ]), { reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] } });
      return;
    }
    // تأكيد قبل الشراء
    const price = store.effectivePrice(userId, product);
    await safeEditOrSend(api, chatId, messageId, panel("⚠️ تأكيد الشراء", [
      `المنتج: ${product.title}`,
      `السعر: ${formatMoney(price)}`,
      `رصيدك الحالي: ${formatMoney(store.balance(userId))}`,
      "",
      "هل تريد المتابعة وإتمام الشراء؟",
    ]), {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ تأكيد الشراء", callback_data: `confirm_buy:${product.id}` }],
          [{ text: "❌ إلغاء", callback_data: `product:${product.id}` }],
        ]
      }
    });
    return;
  }

  if (data.startsWith("confirm_buy:")) {
    const product = store.getProduct(Number(data.split(":")[1]));
    if (!product) {
      await safeEditOrSend(api, chatId, messageId, "⚠️ المنتج غير موجود.", { reply_markup: homeKeyboard(false) });
      return;
    }
    const result = store.purchase(userId, product.id);
    await handlePurchaseResult(api, store, superAdmins, chatId, userId, result);
    return;
  }

  if (!stf.isSuperAdmin && !stf.isMerchant) return;

  if (data === "merchant:create_product") {
    store.setState(userId, "merchant_product_title", {});
    await safeEditOrSend(api, chatId, messageId, "📦 أرسل اسم وتنوان المنتج الجديد:", { reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] } });
    return;
  }
  if (data.startsWith("merchant:wizard_type:")) {
    const state = store.getState(userId);
    if (!state || state.state !== "merchant_product_type") {
      await safeEditOrSend(api, chatId, messageId, "⚠️ انتهت جلسة إنشاء المنتج.", { reply_markup: adminKeyboard(stf.isSuperAdmin) });
      return;
    }
    const type = data.split(":")[2];
    const product = store.createProduct(userId, { ...state.data, fulfillmentType: type });
    store.clearState(userId);
    if (type === "ready_stock") {
      store.setState(userId, "merchant_stock", { productId: product.id });
      await safeEditOrSend(api, chatId, messageId, panel("🎉 تم إنشاء المنتج بنجاح!", [
        `المنتج: #${product.id} ${product.title}`,
        "",
        "🔑 أرسل الأكواد أو الحسابات الخاصة بالمنتج الآن (كل عنصر في سطر):",
      ]), { reply_markup: { inline_keyboard: [[{ text: "⏩ تخطي الآن", callback_data: "flow:cancel" }]] } });
      return;
    }
    await safeEditOrSend(api, chatId, messageId, panel("🎉 تم إنشاء المنتج بنجاح!", [`المنتج: #${product.id} ${product.title}`]), { reply_markup: adminKeyboard(stf.isSuperAdmin) });
    return;
  }

  if (data === "merchant:products") {
    const products = stf.isSuperAdmin ? store.listProducts() : store.listMerchantProducts(userId);
    const rows = products.map((product) => [{ text: `#${product.id} ${product.title} • ${product.status === "active" ? "🟢 نشط" : "🔴 موقوف"}`, callback_data: `merchant:product:${product.id}` }]);
    rows.push([{ text: "➕ إضافة منتج جديد", callback_data: "merchant:create_product" }]);
    rows.push([{ text: "👈 عودة للإدارة", callback_data: "main:admin" }]);
    await safeEditOrSend(api, chatId, messageId, panel("📦 قائمة جميع منتجاتك", products.length ? [`إجمالي المنتجات: ${products.length}`] : ["لا توجد منتجات مسجلة بعد."]), { reply_markup: { inline_keyboard: rows } });
    return;
  }

  if (data.startsWith("merchant:product:")) {
    const product = store.getProduct(Number(data.split(":")[2]));
    if (!product || (product.merchant_id !== userId && !stf.isSuperAdmin)) {
      await safeEditOrSend(api, chatId, messageId, "⚠️ المنتج غير موجود.", { reply_markup: adminKeyboard(stf.isSuperAdmin) });
      return;
    }
    await safeEditOrSend(api, chatId, messageId, panel("📦 تفاصيل المنتج والإدارة", [
      `المنتج: #${product.id} ${product.title}`,
      `الحالة: ${product.status === "active" ? "🟢 نشط (معروض)" : "🔴 موقوف"}`,
      `نوع التسليم: ${product.fulfillment_type === "ready_stock" ? "⚡ فوري" : "🛠️ بمساعدة"}`,
      `السعر الحالي: ${formatMoney(product.price_piasters)}`,
      product.fulfillment_type === "ready_stock" ? `المخزون المتاح: ${product.available_stock || 0} قطعة` : "",
    ]), { reply_markup: merchantProductKeyboard(product) });
    return;
  }

  if (data.startsWith("merchant:add_stock:")) {
    store.setState(userId, "merchant_stock", { productId: Number(data.split(":")[2]) });
    await safeEditOrSend(api, chatId, messageId, "🔑 أرسل عناصر المخزون الآن (كل كود/حساب في سطر منفصل):", { reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] } });
    return;
  }

  if (data.startsWith("merchant:clear_stock:")) {
    const count = store.clearAvailableStock(userId, Number(data.split(":")[2]));
    await safeEditOrSend(api, chatId, messageId, panel("🗑️ تم مسح المخزون", [`عدد العناصر المزالة: ${count} قطعة`]), { reply_markup: adminKeyboard(stf.isSuperAdmin) });
    return;
  }

  if (data.startsWith("merchant:toggle:")) {
    const product = store.getProduct(Number(data.split(":")[2]));
    if (!product || (product.merchant_id !== userId && !stf.isSuperAdmin)) {
      await safeEditOrSend(api, chatId, messageId, "⚠️ المنتج غير موجود.", { reply_markup: adminKeyboard(stf.isSuperAdmin) });
      return;
    }
    const next = product.status === "active" ? "paused" : "active";
    store.setProductStatus(userId, product.id, next);
    await safeEditOrSend(api, chatId, messageId, panel("🔄 تم تغيير حالة المنتج", [`المنتج الآن: ${next === "active" ? "🟢 نشط ومعروض" : "🔴 موقوف"}`]), { reply_markup: adminKeyboard(stf.isSuperAdmin) });
    return;
  }

  if (data.startsWith("merchant:delete:")) {
    const productId = Number(data.split(":")[2]);
    const product = store.getProduct(productId);
    if (!product || (product.merchant_id !== userId && !stf.isSuperAdmin)) {
      await safeEditOrSend(api, chatId, messageId, "⚠️ المنتج غير موجود.", { reply_markup: adminKeyboard(stf.isSuperAdmin) });
      return;
    }
    await safeEditOrSend(api, chatId, messageId, panel("⚠️ تأكيد أرشفة المنتج", [
      `المنتج: #${product.id} ${product.title}`,
      `السعر: ${formatMoney(product.price_piasters)}`,
      "",
      "هل أنت متأكد من إيقاف وإخفاء هذا المنتج؟ سيتم الاحتفاظ بالطلبات والسجل.",
    ]), {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🗑️ نعم، أرشفة المنتج", callback_data: `merchant:confirm_delete:${productId}` }],
          [{ text: "❌ لا، رجوع", callback_data: `merchant:product:${productId}` }],
        ]
      }
    });
    return;
  }

  if (data.startsWith("merchant:confirm_delete:")) {
    const productId = Number(data.split(":")[2]);
    const product = store.deleteProduct(userId, productId);
    await safeEditOrSend(api, chatId, messageId, panel("🗑️ تم أرشفة المنتج", [`المنتج #${product.id} لم يعد معروضاً للبيع، مع الاحتفاظ بالطلبات والسجل.`]), { reply_markup: adminKeyboard(stf.isSuperAdmin) });
    return;
  }

  if (data.startsWith("merchant:edit_price:")) {
    const productId = Number(data.split(":")[2]);
    store.setState(userId, "merchant_edit_price", { productId });
    await safeEditOrSend(api, chatId, messageId, "✏️ أرسل السعر الجديد بـ EGP (مثال: 75):", { reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] } });
    return;
  }

  if (data === "merchant:orders") {
    const orders = store.listMerchantOrders(userId, { status: "awaiting_delivery", limit: 20 });
    const rows = orders.map((order) => [{ text: `#${order.id} ${order.product_title}`, callback_data: `merchant:deliver:${order.id}` }]);
    rows.push([{ text: "👈 عودة للإدارة", callback_data: "main:admin" }]);
    await safeEditOrSend(api, chatId, messageId, panel("⏳ الطلبات المعلقة التي تنتظر التسليم", orders.length ? [`عدد الطلبات المنتظرة: ${orders.length}`] : ["لا توجد طلبات معلقة حالياً."]), { reply_markup: { inline_keyboard: rows } });
    return;
  }

  if (data.startsWith("merchant:deliver:")) {
    const orderId = Number(data.split(":")[2]);
    store.setState(userId, "merchant_delivery", { orderId });
    await safeEditOrSend(api, chatId, messageId, `📤 أرسل كود/بيانات التسليم للطلب #${orderId}:`, { reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] } });
    return;
  }

  if (data === "merchant:reports") {
    const stats = store.merchantStats(userId);
    await safeEditOrSend(api, chatId, messageId, panel("📊 تقرير أرباحك ومبيعاتك", [
      `📦 المنتجات: ${stats.product_count || 0}`,
      `🛍️ إجمالي الطلبات: ${stats.order_count || 0}`,
      `⏳ المعلقة: ${stats.pending_delivery || 0}`,
      `💵 إجمالي الأرباح: ${formatMoney(stats.gross_piasters || 0)}`,
    ]), { reply_markup: adminKeyboard(stf.isSuperAdmin) });
    return;
  }

  if (!stf.isSuperAdmin) return;

  if (data === "admin:add_merchant") {
    store.setState(userId, "admin_add_merchant", {});
    await safeEditOrSend(api, chatId, messageId, "👤 أرسل رقم ID التاجر واسمه (مثال: 123456789 أحمد التاجر):", { reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] } });
    return;
  }

  if (data === "admin:add_admin") {
    store.setState(userId, "admin_add_admin", {});
    await safeEditOrSend(api, chatId, messageId, "🛡️ أرسل رقم ID الأدمن واسمه (مثال: 123456789 أحمد الأدمن):", { reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] } });
    return;
  }

  if (data === "admin:remove_merchant") {
    store.setState(userId, "admin_remove_merchant", {});
    await safeEditOrSend(api, chatId, messageId, "➖ أرسل رقم ID أو اسم المستخدم للتاجر الذي تريد إيقافه. سيتم إيقاف منتجاته النشطة مع حفظ جميع السجلات.", { reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] } });
    return;
  }

  if (data === "admin:remove_admin") {
    store.setState(userId, "admin_remove_admin", {});
    await safeEditOrSend(api, chatId, messageId, "⛔ أرسل رقم ID أو اسم المستخدم للأدمن الذي تريد إيقافه. لا يمكن إزالة آخر أدمن نشط.", { reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] } });
    return;
  }

  if (data.startsWith("admin:approve_manual_topup:")) {
    const topupId = Number(data.split(":")[2]);
    const result = store.approveManualTopup(userId, topupId);
    if (!result.alreadyApproved) {
      await api.sendMessage(result.topup.user_id, panel("🎉 تم اعتماد شحن الرصيد", [
        `رقم الطلب: #${result.topup.id}`,
        `المبلغ المضاف: ${formatMoney(result.topup.amount_piasters)}`,
        `رصيدك الحالي: ${formatMoney(result.balance)}`,
      ]), { reply_markup: homeKeyboard(false) }).catch(() => { });
    }
    await safeEditOrSend(api, chatId, messageId, panel("✅ تم اعتماد طلب الشحن", [
      `رقم الطلب: #${result.topup.id}`,
      `العميل: ${result.topup.user_id}`,
      `الرصيد بعد الإضافة: ${formatMoney(result.balance)}`,
      result.alreadyApproved ? "تم اعتماده مسبقاً؛ لم تتم إضافة الرصيد مرة أخرى." : "تمت إضافة الرصيد مرة واحدة بنجاح.",
    ]), { reply_markup: adminKeyboard(true) });
    return;
  }

  if (data.startsWith("admin:reject_manual_topup:")) {
    const topupId = Number(data.split(":")[2]);
    const topup = store.getManualTopup(topupId);
    if (!topup || topup.status !== "proof_submitted") throw new Error("إثبات الشحن غير متاح للمراجعة.");
    store.setState(userId, "admin_reject_manual_topup", { topupId: topup.id });
    await safeEditOrSend(api, chatId, messageId, `❌ أرسل سبب رفض إثبات الشحن للطلب #${topup.id}:`, { reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] } });
    return;
  }

  if (data === "admin:credit") {
    store.setState(userId, "admin_credit", {});
    await safeEditOrSend(api, chatId, messageId, "💵 أرسل: IDالمستخدم المبلغ ملاحظة\nمثال: `123456789 100 شحن يدوي`", { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] } });
    return;
  }

  if (data === "admin:zero") {
    store.setState(userId, "admin_zero", {});
    await safeEditOrSend(api, chatId, messageId, "🔄 أرسل ID المستخدم لتصفير رصيده:", { reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] } });
    return;
  }

  if (data === "admin:custom_price") {
    store.setState(userId, "admin_custom_price", {});
    await safeEditOrSend(api, chatId, messageId, "🏷️ أرسل: IDالمستخدم رقم\_المنتج السعر\_الجديد ملاحظة\nمثال: `123456789 1 30 خصم خاص`", { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] } });
    return;
  }

  if (data === "admin:broadcast") {
    store.setState(userId, "admin_broadcast", {});
    await safeEditOrSend(api, chatId, messageId, "📢 أرسل النص أو الرسالة التي ترغب في تعميمها وإرسالها لجميع أعضاء البوت:", { reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "flow:cancel" }]] } });
    return;
  }

  if (data === "admin:toggle_maintenance") {
    const current = store.getMaintenanceMode();
    const next = !current;
    store.setMaintenanceMode(next);
    const stats = store.merchantStats(userId);
    await safeEditOrSend(api, chatId, messageId, panel("⚙️ لوحة الإدارة والتحكم", [
      `📦 عدد منتجاتك: ${stats.product_count || 0}`,
      `🛍️ إجمالي الطلبات: ${stats.order_count || 0}`,
      `⏳ طلبات قيد التسليم: ${stats.pending_delivery || 0}`,
      `💵 إجمالي الإيرادات: ${formatMoney(stats.gross_piasters || 0)}`,
      next ? "⚠️ تم تفعيل وضع الصيانة! (البوت متوقف حالياً للمستخدمين)" : "🟢 تم إيقاف وضع الصيانة! (البوت يعمل الآن للجميع)",
    ]), { reply_markup: adminKeyboard(stf.isSuperAdmin, next) });
    return;
  }

  if (data === "admin:members" || data.startsWith("admin:members:")) {
    const page = data.startsWith("admin:members:") ? Number(data.split(":")[2]) : 0;
    const pageSize = 15;
    const offset = page * pageSize;
    const total = store.countUsers();
    const users = store.listUsers(pageSize, offset);
    const lines = [`إجمالي الأعضاء المسجلين: ${total} عضو`, `الصفحة ${page + 1} من ${Math.ceil(total / pageSize) || 1}`, ""];
    for (const user of users) lines.push(`👤 ${displayName(user)} • ${user.telegram_id}`);
    const navRows = [];
    const navButtons = [];
    if (page > 0) navButtons.push({ text: "◀️ السابق", callback_data: `admin:members:${page - 1}` });
    if (offset + pageSize < total) navButtons.push({ text: "التالي ▶️", callback_data: `admin:members:${page + 1}` });
    if (navButtons.length) navRows.push(navButtons);
    navRows.push([{ text: "👈 عودة للإدارة", callback_data: "main:admin" }]);
    await safeEditOrSend(api, chatId, messageId, panel("👥 قائمة الأعضاء", lines), { reply_markup: { inline_keyboard: navRows } });
    return;
  }

  if (data === "admin:merchants") {
    const merchants = store.listMerchants();
    const lines = merchants.length ? [] : ["لا يوجد تجار مسجلون."];
    for (const merchant of merchants) {
      lines.push(`👤 ${merchant.display_name || merchant.telegram_id} • ${merchant.status === "active" ? "🟢 نشط" : "🔴 موقوف"} • منتجات: ${merchant.product_count || 0}`);
    }
    await safeEditOrSend(api, chatId, messageId, panel("👥 قائمة التجار", lines), { reply_markup: adminKeyboard(true) });
    return;
  }

  if (data === "admin:admins") {
    const admins = store.listSuperAdmins();
    const lines = admins.length ? [] : ["لا يوجد أدمنز مسجلون."];
    for (const admin of admins) {
      lines.push(`🛡️ ${admin.display_name || admin.telegram_id} • ${admin.status === "active" ? "🟢 نشط" : "🔴 موقوف"} • ${admin.telegram_id}`);
    }
    await safeEditOrSend(api, chatId, messageId, panel("🛡️ قائمة الأدمنز", lines), { reply_markup: adminKeyboard(true) });
    return;
  }

  if (data === "admin:report") {
    const stats = store.platformStats();
    await safeEditOrSend(api, chatId, messageId, panel("🌐 تقرير المنصة الشامل", [
      `👥 الأعضاء: ${stats.users}`,
      `👤 التجار: ${stats.merchants}`,
      `📦 المنتجات: ${stats.products}`,
      `🛍️ إجمالي الطلبات: ${stats.orders}`,
      `⏳ المعلقة: ${stats.pending}`,
      `💵 إجمالي التداولات: ${formatMoney(stats.gross)}`,
    ]), { reply_markup: adminKeyboard(true) });
    return;
  }
}

function queueKey(update) {
  return String(update.message?.chat?.id || update.callback_query?.message?.chat?.id || update.callback_query?.from?.id || "global");
}

const queues = new Map();

function enqueueUpdate(update, task) {
  const key = queueKey(update);
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(task, task).finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  queues.set(key, next);
  return next;
}

async function poll(api, store, superAdmins) {
  let offset = 0;
  let running = true;
  const timeout = Number(process.env.TELEGRAM_POLL_TIMEOUT || 25);
  log.info("bot", `${brandName()} polling started.`);

  const shutdown = (signal) => {
    log.info("bot", `Received ${signal}, shutting down gracefully...`);
    running = false;
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  while (running) {
    try {
      const updates = await api.getUpdates(offset, timeout);
      const pending = [];
      for (const update of updates) {
        offset = update.update_id + 1;
        pending.push(enqueueUpdate(update, async () => {
          const uid = update.message?.from?.id || update.callback_query?.from?.id;
          try {
            if (update.message) await handleMessage(api, store, superAdmins, update.message);
            if (update.callback_query) await handleCallback(api, store, superAdmins, update.callback_query);
          } catch (error) {
            const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id || update.callback_query?.from?.id;
            log.error("bot", error.message, { userId: uid });
            if (chatId) await api.sendMessage(chatId, error.message || "⚠️ حدث خطأ ما.").catch(() => { });
          }
        }));
      }
      await Promise.allSettled(pending);
    } catch (error) {
      if (!running) break;
      log.error("poll", error.message);
      await sleep(2000);
    }
  }
  await Promise.allSettled([...queues.values()]);
  log.info("bot", `${brandName()} stopped.`);
}

module.exports = {
  handleCallback,
  handleMessage,
  poll,
};
