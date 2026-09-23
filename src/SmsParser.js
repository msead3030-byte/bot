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
  // If starts with 20 and has 12 digits (201xxxxxxxxx)
  if (digits.startsWith("201") && digits.length === 12) {
    digits = "0" + digits.slice(2);
  }
  // If starts with 00201...
  if (digits.startsWith("00201") && digits.length === 14) {
    digits = "0" + digits.slice(4);
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
  // 1. Vodafone Cash (فودافون كاش)
  // ----------------------------------------------------
  if (text.includes("تم استلام مبلغ") || text.includes("You have received") || text.includes("فودافون كاش") || text.includes("Vodafone Cash")) {
    const arMatch = text.match(/تم\s+استلام\s+مبلغ\s+([\d,.]+)\s*(?:جنيه|ج\.م|جم)?\s+من\s*(?:رقم)?\s*([0-9+]+)/i);
    const arTrx = text.match(/(?:رقم\s+العملية|العملية|كود\s+العملية|مرجع)[:\s]*([A-Za-z0-9_-]+)/i);

    if (arMatch) {
      const amountPiasters = toPiasters(arMatch[1]);
      const senderPhone = normalizePhoneNumber(arMatch[2]);
      const trxId = arTrx ? arTrx[1].replace(/[^\w-]/g, "") : "";

      if (amountPiasters > 0 && senderPhone && trxId) {
        return {
          ok: true,
          provider: "vodafone_cash",
          paymentMethod: "wallet",
          amountPiasters,
          amountEgp: amountPiasters / 100,
          senderPhone,
          senderName: "",
          trxId: `vf_${trxId}`,
          rawMessage: text,
        };
      }
    }

    const enMatch = text.match(/received\s+([\d,.]+)\s*EGP\s+from\s*([0-9+]+)/i);
    const enTrx = text.match(/(?:Transaction\s*ID|Trx\s*ID|Ref)[:\s]*([A-Za-z0-9_-]+)/i);
    if (enMatch) {
      const amountPiasters = toPiasters(enMatch[1]);
      const senderPhone = normalizePhoneNumber(enMatch[2]);
      const trxId = enTrx ? enTrx[1].replace(/[^\w-]/g, "") : "";

      if (amountPiasters > 0 && senderPhone && trxId) {
        return {
          ok: true,
          provider: "vodafone_cash",
          paymentMethod: "wallet",
          amountPiasters,
          amountEgp: amountPiasters / 100,
          senderPhone,
          senderName: "",
          trxId: `vf_${trxId}`,
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
    const instapayAmount = text.match(/(?:مبلغ|EGP|جنيه|جم)\s*([\d,.]+)|([\d,.]+)\s*(?:EGP|جم|جنيه)/i);
    const instapayRef = text.match(/(?:مرجع|Ref|رقم\s+المرجع|كود\s+العملية|Transaction\s*ID)[:\s]*([A-Za-z0-9_-]+)/i);

    const amtStr = instapayAmount ? (instapayAmount[1] || instapayAmount[2]) : null;
    if (amtStr && instapayRef) {
      const amountPiasters = toPiasters(amtStr);
      const trxId = instapayRef[1].replace(/[^\w-]/g, "");

      // Extract sender phone if present
      const phoneMatch = text.match(/من\s*(?:رقم|حساب)?\s*([0-9+]{10,14})/i) || text.match(/(01[0125]\d{8})/);
      const senderPhone = phoneMatch ? normalizePhoneNumber(phoneMatch[1]) : "";

      // Extract sender name if present
      let senderName = "";
      const nameMatchAr = text.match(/(?:من|بواسطة|العميل)\s+([\p{L}\s]{3,40}?)(?=\s+(?:عبر|من\s+خلال|مرجع|كود|بمبلغ|لحسابك|بتاريخ|\.|$))/iu);
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
