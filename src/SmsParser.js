"use strict";

/**
 * Normalizes Egyptian and international phone numbers into a standard 11-digit local format:
 * e.g. "+201012345678" -> "01012345678"
 * e.g. "201012345678"  -> "01012345678"
 * e.g. "01012345678"   -> "01012345678"
 */
function convertArabicNumerals(str) {
  return String(str || "").replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
}

function normalizePhoneNumber(raw) {
  if (!raw) return "";
  const converted = convertArabicNumerals(raw);
  let digits = converted.replace(/\D/g, "");
  // If starts with 01 and has 11 digits (01xxxxxxxxx)
  if (digits.startsWith("01") && digits.length === 11) {
    return digits;
  }
  // If starts with 1 and has 10 digits (missing leading zero: 1xxxxxxxxx)
  if (digits.startsWith("1") && digits.length === 10) {
    return "0" + digits;
  }
  // If starts with 20 and has 12 digits (201xxxxxxxxx)
  if (digits.startsWith("201") && digits.length === 12) {
    return "0" + digits.slice(2);
  }
  // If starts with 00201...
  if (digits.startsWith("00201") && digits.length === 14) {
    return "0" + digits.slice(4);
  }
  return digits;
}

/**
 * Normalizes Arabic and English person names for flexible and fuzzy matching:
 * - Unifies alef forms (أ إ آ -> ا)
 * - Unifies yaa forms (ى -> ي)
 * - Unifies taa marbuta (ة -> ه)
 * - Strips tashkeel / diacritics
 * - Normalizes whitespace and casing
 */
function normalizeSenderName(raw) {
  if (!raw) return "";
  let name = String(raw).trim().toLowerCase();
  // Remove Arabic diacritics
  name = name.replace(/[\u064B-\u065F\u0670]/g, "");
  // Normalize letters
  name = name.replace(/[أإآ]/g, "ا");
  name = name.replace(/ى/g, "ي");
  name = name.replace(/ة/g, "ه");
  name = name.replace(/ؤ/g, "و");
  name = name.replace(/ئ/g, "ي");
  // Remove non-alphanumeric except spaces
  name = name.replace(/[^\p{L}\p{N}\s]/gu, " ");
  // Collapse whitespace
  name = name.replace(/\s+/g, " ").trim();
  return name;
}

/**
 * Checks if input sender name matches the candidate name from SMS:
 * e.g. "احمد علي" matches "أحمد علي إبراهيم"
 */
function isNameMatch(inputName, candidateName) {
  const normInput = normalizeSenderName(inputName);
  const normCandidate = normalizeSenderName(candidateName);
  if (!normInput || !normCandidate) return false;

  // Exact match
  if (normCandidate === normInput) return true;

  // Substring match
  if (normCandidate.includes(normInput) || normInput.includes(normCandidate)) return true;

  // Check if every individual word of input exists in candidate
  const inputWords = normInput.split(" ").filter((w) => w.length > 1);
  if (inputWords.length > 0 && inputWords.every((word) => normCandidate.includes(word))) {
    return true;
  }

  return false;
}

/**
 * Parses numeric amount to piasters (e.g. 50.50 EGP -> 5050 piasters)
 */
function toPiasters(amountStr) {
  const clean = convertArabicNumerals(String(amountStr || "")).replace(/,/g, "").trim();
  const num = parseFloat(clean);
  if (isNaN(num) || num <= 0) return 0;
  return Math.round(num * 100);
}

/**
 * Detects the service provider and extracts payment details from raw SMS text.
 * Supported providers:
 * - Vodafone Cash (فودافون كاش)
 * - InstaPay (إنستاباي / IPN)
 * - Orange Cash (أورانج كاش)
 * - Etisalat Cash (اتصالات كاش)
 * - WE Pay (وي باي)
 */
function parseSms(message) {
  const text = String(message || "").trim();
  if (!text) return null;

  // ----------------------------------------------------
  // 1. Vodafone Cash & Egyptian Mobile Wallets (المحافظ الإلكترونية)
  // ----------------------------------------------------
  if (
    text.includes("استلام") ||
    text.includes("تحويل") ||
    text.includes("إيداع") ||
    text.includes("received") ||
    text.includes("كاش") ||
    text.includes("Cash") ||
    text.includes("محفظ")
  ) {
    const amountMatch = (
      text.match(/(?:تم\s+(?:استلام|تحويل|إيداع)|مبلغ|استلام|تحويل|إيداع)\s*(?:مبلغ\s*)?([\d,.]+)\s*(?:جنيه|جنية|ج\.م|جم|ج|EGP|LE)?/i) ||
      text.match(/([\d,.]+)\s*(?:جنيه|جنية|ج\.م|جم|EGP|LE)/i) ||
      text.match(/(?:EGP|LE|جنيه|ج\.م|جم)\s*([\d,.]+)/i)
    );

    // Extract phone: prioritize number following "من" / "from" / "بواسطة"
    let senderPhone = "";
    const fromMatch = text.match(/(?:من|بواسطة|from)\s*(?:رقم\s*|حساب\s*|محفظة\s*)?[:\s]*([0-9+]{10,14})/i);
    if (fromMatch) {
      senderPhone = normalizePhoneNumber(fromMatch[1]);
    }

    // Fallback: any Egyptian mobile number in message that is NOT the store's receiver number
    const receiverNum = normalizePhoneNumber(process.env.AUTO_TOPUP_WALLET_RECEIVER || "01104826670");
    if (!senderPhone || senderPhone === receiverNum) {
      const allPhones = Array.from(text.matchAll(/(01[0125]\d{8})/g)).map((m) => m[1]);
      const otherPhone = allPhones.find((p) => p !== receiverNum);
      if (otherPhone) {
        senderPhone = otherPhone;
      }
    }

    const trxMatch = (
      text.match(/(?:رقم\s+العملية|كود\s+العملية|رقم\s+المعاملة|كود\s+المعاملة|رقم\s+التحويل|كود\s+التحويل|عملية\s+رقم|معاملة\s+رقم|العملية|مرجع(?:\s+العملية)?|المرجع|برقم\s+مرجعي|Transaction\s*ID|Trx\s*ID|Ref(?:erence)?(?:\s+No\.?)?)[:\s#]*([A-Za-z0-9_-]{4,})/i) ||
      text.match(/\b([A-Z0-9]{8,14})\b/i)
    );

    if (amountMatch && senderPhone) {
      const amountPiasters = toPiasters(amountMatch[1]);
      let trxId = trxMatch ? trxMatch[1].replace(/[^\w-]/g, "") : "";

      if (!trxId) {
        const numMatch = text.match(/\b(\d{6,12})\b/);
        trxId = numMatch ? numMatch[1] : `${Date.now()}`;
      }

      let provider = "wallet";
      if (text.includes("فودافون") || text.includes("Vodafone")) provider = "vodafone_cash";
      else if (text.includes("اورانج") || text.includes("أورانج") || text.includes("Orange")) provider = "orange_cash";
      else if (text.includes("اتصالات") || text.includes("Etisalat") || text.includes("e&")) provider = "etisalat_cash";
      else if (text.includes("وي باي") || text.includes("WE Pay") || text.includes("WE pay")) provider = "we_pay";

      if (amountPiasters > 0 && senderPhone && trxId) {
        return {
          ok: true,
          provider,
          paymentMethod: "wallet",
          amountPiasters,
          amountEgp: amountPiasters / 100,
          senderPhone,
          senderName: "",
          trxId: `${provider === "vodafone_cash" ? "vf" : provider}_${trxId}`,
          rawMessage: text,
        };
      }
    }
  }

  // ----------------------------------------------------
  // 2. InstaPay (إنستاباي / IPN / التحويلات اللحظية)
  // ----------------------------------------------------
  if (
    text.includes("إنستاباي") ||
    text.includes("انستاباي") ||
    text.includes("InstaPay") ||
    text.includes("IPN") ||
    (text.includes("مرجع") && text.includes("مبلغ"))
  ) {
    // Amount: match various patterns like "مبلغ 100.00 جنيه مصري" or "100 EGP"
    const instapayAmount = (
      text.match(/(?:مبلغ)\s*([\d,.]+)\s*(?:جنيه\s*مصري|جنيه|ج\.م|جم|EGP)/i) ||
      text.match(/([\d,.]+)\s*(?:جنيه\s*مصري|جنيه|ج\.م|جم|EGP)/i) ||
      text.match(/(?:EGP|جنيه|جم)\s*([\d,.]+)/i)
    );

    // Reference: matches "مرجعي 123", "برقم مرجعي 123", "رقم المرجع: 123", "مرجع: 123", "Ref: 123"
    const instapayRef = (
      text.match(/(?:برقم\s+مرجعي|رقم\s+مرجعي|رقم\s+المرجع|مرجع\s+العملية|مرجع\s+الدفع|المرجع|مرجع|Ref(?:erence)?(?:\s+No\.?)?)[:\s#]*([A-Za-z0-9_-]{4,})/i) ||
      text.match(/(?:كود\s+العملية|Transaction\s*ID|رقم\s+العملية|رقم\s+التحويل)[:\s]*([A-Za-z0-9_-]{4,})/i)
    );

    const amtStr = instapayAmount ? (instapayAmount[1] || instapayAmount[2]) : null;
    if (amtStr && instapayRef) {
      const amountPiasters = toPiasters(amtStr);
      const trxId = instapayRef[1].replace(/[^\w-]/g, "");

      // Extract sender phone if present
      const phoneMatch = text.match(/من\s*(?:رقم|حساب)?\s*([0-9+]{10,14})/i) || text.match(/(01[0125]\d{8})/);
      const senderPhone = phoneMatch ? normalizePhoneNumber(phoneMatch[1]) : "";

      // Extract sender name: "من محمد احمد" or "from John Doe"
      let senderName = "";
      const nameMatchAr = text.match(
        /(?:من|بواسطة|العميل)\s+([\p{L}\s]{3,40}?)(?=\s+(?:عبر|من\s+خلال|مرجع|كود|بمبلغ|لحسابك|بتاريخ|برقم|\.|,|$))/iu
      );
      if (nameMatchAr && !/\d/.test(nameMatchAr[1])) {
        senderName = nameMatchAr[1].trim();
      }

      if (!senderName) {
        const nameMatchEn = text.match(/(?:from|by)\s+([A-Za-z\s]{3,40}?)(?=\s+(?:via|ref|account|on|\.|$))/i);
        if (nameMatchEn && !/\d/.test(nameMatchEn[1])) {
          senderName = nameMatchEn[1].trim();
        }
      }

      if (amountPiasters > 0 && trxId) {
        return {
          ok: true,
          provider: "instapay",
          paymentMethod: "instapay",
          amountPiasters,
          amountEgp: amountPiasters / 100,
          senderPhone,
          senderName: normalizeSenderName(senderName),
          rawSenderName: senderName,
          trxId: `insta_${trxId}`,
          rawMessage: text,
        };
      }
    }
  }

  // ----------------------------------------------------
  // 3. Orange Cash, Etisalat Cash, WE Pay (عام لكافة المحافظ)
  // ----------------------------------------------------
  const genericAmountMatch = text.match(/(?:استلام|تحويل|إيداع|مبلغ)\s+([\d,.]+)\s*(?:جنيه|ج\.م|جم|EGP)?/i)
    || text.match(/([\d,.]+)\s*(?:جنيه|ج\.م|جم|EGP)/i);
  const genericPhoneMatch = text.match(/(?:من|رقم)?\s*(01[0125]\d{8})/);
  const genericTrxMatch = text.match(/(?:رقم\s+العملية|رقم\s+المعاملة|المرجع|كود\s+العملية|Transaction\s*ID|Ref)[:\s]*([A-Za-z0-9_-]{4,})/i);

  if (genericAmountMatch && genericPhoneMatch && genericTrxMatch) {
    const amountPiasters = toPiasters(genericAmountMatch[1]);
    const senderPhone = normalizePhoneNumber(genericPhoneMatch[1]);
    const trxId = genericTrxMatch[1].replace(/[^\w-]/g, "");

    let provider = "wallet";
    if (text.includes("اورانج") || text.includes("أورانج") || text.includes("Orange")) provider = "orange_cash";
    else if (text.includes("اتصالات") || text.includes("Etisalat") || text.includes("e&")) provider = "etisalat_cash";
    else if (text.includes("وي") || text.includes("WE")) provider = "we_pay";

    if (amountPiasters > 0 && senderPhone && trxId) {
      return {
        ok: true,
        provider,
        paymentMethod: "wallet",
        amountPiasters,
        amountEgp: amountPiasters / 100,
        senderPhone,
        senderName: "",
        trxId: `${provider}_${trxId}`,
        rawMessage: text,
      };
    }
  }

  return null;
}

module.exports = {
  normalizePhoneNumber,
  normalizeSenderName,
  isNameMatch,
  parseSms,
  toPiasters,
};
