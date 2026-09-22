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
 * - InstaPay (إنستاباي)
 * - Orange Cash (أورانج كاش)
 * - Etisalat Cash (اتصالات كاش)
 * - WE Pay (وي باي)
 * 
 * Returns: {
 *   ok: boolean,
 *   provider: string,
 *   amountPiasters: number,
 *   amountEgp: number,
 *   senderPhone: string,
 *   trxId: string,
 *   rawMessage: string
 * } or null if not a recognized transfer SMS.
 */
function parseSms(message) {
  const text = String(message || "").trim();
  if (!text) return null;

  // ----------------------------------------------------
  // 1. Vodafone Cash (فودافون كاش)
  // ----------------------------------------------------
  // أشكال رسائل فودافون كاش:
  // "تم استلام مبلغ 100.00 جنيه من 01012345678 بنجاح ... رقم العملية: 1234567890."
  // "تم استلام مبلغ 100 ج.م من 01012345678 بنجاح ... رقم العملية 1234567890"
  // "You have received 100.00 EGP from 01012345678. Transaction ID: 1234567890."
  if (text.includes("تم استلام مبلغ") || text.includes("You have received") || text.includes("فودافون كاش") || text.includes("Vodafone Cash")) {
    // Arabic Vodafone Cash
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
          amountPiasters,
          amountEgp: amountPiasters / 100,
          senderPhone,
          trxId: `vf_${trxId}`,
          rawMessage: text,
        };
      }
    }

    // English Vodafone Cash
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
          amountPiasters,
          amountEgp: amountPiasters / 100,
          senderPhone,
          trxId: `vf_${trxId}`,
          rawMessage: text,
        };
      }
    }
  }

  // ----------------------------------------------------
  // 2. InstaPay (إنستاباي / IPN)
  // ----------------------------------------------------
  // "تم تحويل مبلغ 100.00 جم لحسابك من ... مرجع: 1234567890"
  // "Received EGP 100.00 via IPN from 010... Ref: 1234567890"
  if (text.includes("إنستاباي") || text.includes("انستاباي") || text.includes("InstaPay") || text.includes("IPN") || (text.includes("مرجع") && text.includes("مبلغ"))) {
    const instapayAmount = text.match(/(?:مبلغ|EGP|جنيه|جم)\s*([\d,.]+)|([\d,.]+)\s*(?:EGP|جم|جنيه)/i);
    const instapayPhone = text.match(/من\s*(?:رقم|حساب)?\s*([0-9+]{10,14})/i) || text.match(/(01[0125]\d{8})/);
    const instapayRef = text.match(/(?:مرجع|Ref|رقم\s+المرجع)[:\s]*([A-Za-z0-9_-]+)/i);

    const amtStr = instapayAmount ? (instapayAmount[1] || instapayAmount[2]) : null;
    if (amtStr && instapayRef) {
      const amountPiasters = toPiasters(amtStr);
      const senderPhone = instapayPhone ? normalizePhoneNumber(instapayPhone[1]) : "";
      const trxId = instapayRef[1].replace(/[^\w-]/g, "");

      if (amountPiasters > 0 && trxId) {
        return {
          ok: true,
          provider: "instapay",
          amountPiasters,
          amountEgp: amountPiasters / 100,
          senderPhone,
          trxId: `insta_${trxId}`,
          rawMessage: text,
        };
      }
    }
  }

  // ----------------------------------------------------
  // 3. Orange Cash, Etisalat Cash, WE Pay (عام لكافة المحافظ)
  // ----------------------------------------------------
  // نمط عام للمحافظ الإلكترونية المصرية
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
        amountPiasters,
        amountEgp: amountPiasters / 100,
        senderPhone,
        trxId: `${provider}_${trxId}`,
        rawMessage: text,
      };
    }
  }

  return null;
}

module.exports = {
  normalizePhoneNumber,
  parseSms,
  toPiasters,
};
