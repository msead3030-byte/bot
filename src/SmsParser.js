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
  const converted = convertArabicNumerals(String(raw).trim());
  let digits = converted.replace(/\D/g, "");

  // Normalize Egyptian international prefixes: 002, +20, 20
  // e.g. 00201012345678 (14 digits) -> 01012345678
  if (digits.startsWith("00201") && digits.length === 14) {
    digits = "0" + digits.slice(4);
  } else if (digits.startsWith("0021") && digits.length === 13) {
    digits = "0" + digits.slice(3);
  } else if (digits.startsWith("002") && digits.length >= 13) {
    digits = digits.slice(3);
    if (!digits.startsWith("0")) digits = "0" + digits;
  } else if (digits.startsWith("2001") && digits.length === 13) {
    digits = digits.slice(2);
  } else if (digits.startsWith("201") && digits.length === 12) {
    digits = "0" + digits.slice(2);
  } else if (digits.startsWith("1") && digits.length === 10) {
    digits = "0" + digits;
  }

  if (digits.startsWith("01") && digits.length === 11) {
    return digits;
  }
  return digits;
}

// Transliteration dictionary between common Egyptian Arabic names and English spellings
const ARABIC_TO_LATIN = {
  "احمد": ["ahmed", "ahmad"],
  "محمد": ["mohamed", "mohammed", "muhammad", "muhamed", "mohd"],
  "محمود": ["mahmoud", "mahmood"],
  "علي": ["ali", "aly"],
  "حسن": ["hassan", "hasan"],
  "حسين": ["hussein", "hussien", "hossein"],
  "ابراهيم": ["ibrahim", "ebrahim"],
  "مصطفى": ["mostafa", "mustafa"],
  "عمر": ["omar", "omer"],
  "عمرو": ["amr"],
  "خالد": ["khaled", "khalid"],
  "طارق": ["tarek", "tariq"],
  "سيد": ["sayed", "saeed"],
  "جمال": ["gamal", "jamal"],
  "عادل": ["adel", "adil"],
  "كريم": ["karim", "kareem"],
  "حسام": ["hossam", "hosam"],
  "يوسف": ["youssef", "yosef", "yusuf"],
  "مينا": ["mina"],
  "جورج": ["george"],
  "بيشوي": ["bishoy", "beshoy"],
  "بيتر": ["peter"],
  "فادي": ["fady", "fadi"],
  "هاني": ["hany", "hani"],
  "وائل": ["wael"],
  "وليد": ["walid", "waleed"],
  "ايهاب": ["ehab", "ihab"],
  "اشرف": ["ashraf"],
  "سامح": ["sameh"],
  "ايمن": ["ayman"],
  "اسلام": ["islam", "eslam"],
  "اسامه": ["osama", "oussama"],
  "حمدي": ["hamdy", "hamdi"],
  "مجدي": ["magdy", "magdi"],
  "سامي": ["samy", "sami"],
  "نبيل": ["nabil", "nabeel"],
  "رضا": ["reda", "redha"],
  "شريف": ["sherif", "shereef"],
  "ياسر": ["yasser", "yaser"],
  "عماد": ["emad", "imad"],
  "هشام": ["hesham", "hisham"],
  "حاتم": ["hatem"],
  "سعيد": ["saeed", "said"],
  "سمير": ["samir", "sameer"],
  "عاطف": ["atef"],
  "صلاح": ["salah"],
  "علاء": ["alaa"],
  "مدحت": ["medhat"],
  "باسم": ["bassem", "basem"],
  "رامي": ["ramy", "rami"],
  "هيثم": ["haitham", "haytham"],
  "مروان": ["marwan"],
  "سالم": ["salem"],
  "مساعد": ["mosaad", "mosaed", "musaad"],
  "كامل": ["kamel", "kamil"],
  "عبدالله": ["abdallah", "abdullah", "abdalla"],
  "عبدالرحمن": ["abdelrahman", "abdel-rahman", "abdurrahman"],
  "عبدالعزيز": ["abdelaziz", "abdel-aziz"],
  "فتحي": ["fathy", "fathi"],
  "صبري": ["sabry", "sabri"],
  "شوقي": ["shawky", "shawki"],
  "فكري": ["fekry", "fikri"],
  "بدوي": ["badawy", "badawi"],
  "عزت": ["ezzat"],
  "رفعت": ["refaat", "refat"],
  "شكري": ["shokry", "shoukry"],
  "جلال": ["galal", "jalal"],
  "شعبان": ["shaaban"],
  "رمضان": ["ramadan"]
};

const LATIN_TO_ARABIC = {};
for (const [ar, latinList] of Object.entries(ARABIC_TO_LATIN)) {
  for (const lat of latinList) {
    LATIN_TO_ARABIC[lat] = ar;
  }
}

/**
 * Normalizes Arabic and English person names for flexible and fuzzy matching:
 * - Unifies alef forms (أ إ آ -> ا)
 * - Unifies yaa forms (ى -> ي)
 * - Unifies taa marbuta (ة -> ه)
 * - Strips tashkeel / diacritics
 * - Normalizes compound names (عبد الرحمن -> عبدالرحمن)
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
  // Normalize compound names
  name = name.replace(/عبد\s+/g, "عبد");
  name = name.replace(/ابو\s+/g, "ابو");
  // Remove non-alphanumeric except spaces
  name = name.replace(/[^\p{L}\p{N}\s]/gu, " ");
  // Collapse whitespace
  name = name.replace(/\s+/g, " ").trim();
  return name;
}

function cleanExtractedName(raw) {
  if (!raw) return "";
  let name = String(raw).trim();
  const stopWords = [
    "انستاباي", "إنستاباي", "انستا باي", "إنستا باي", "انستا", "إنستا", "ipn", "instapay",
    "محفظة", "محفظتك", "حساب", "حسابك", "بنك", "كاش", "فودافون", "اتصالات", "اورانج", "أورانج", "وي",
    "عميل", "العميل", "بواسطة", "عبر", "من خلال", "من"
  ];
  for (const sw of stopWords) {
    const reg = new RegExp(`(^|\\s)${sw}(\\s|$)`, "giu");
    name = name.replace(reg, " ");
  }
  name = name.replace(/\s+/g, " ").trim();
  if (name.length >= 2 && /[\p{L}]/u.test(name)) {
    return name;
  }
  return "";
}

/**
 * Checks if input sender name matches the candidate name from SMS:
 * e.g. "احمد علي" matches "أحمد علي إبراهيم"
 * e.g. "أحمد علي" matches "AHMED ALI" (cross-language)
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

  // Cross-lingual matching (Arabic <-> English/Latin)
  const isInputArabic = /[\u0600-\u06FF]/.test(normInput);
  const isCandidateArabic = /[\u0600-\u06FF]/.test(normCandidate);

  if (isInputArabic !== isCandidateArabic) {
    const arabicWords = (isInputArabic ? normInput : normCandidate).split(" ").filter((w) => w.length > 1);
    const latinWords = (isInputArabic ? normCandidate : normInput).split(" ").filter((w) => w.length > 1);

    const mappedLatinAsArabic = latinWords.map((w) => LATIN_TO_ARABIC[w] || w);
    const matchedCount = arabicWords.filter((ar) => {
      if (mappedLatinAsArabic.includes(ar)) return true;
      const possibleLatin = ARABIC_TO_LATIN[ar] || [];
      return possibleLatin.some((lat) => latinWords.includes(lat) || latinWords.some((lw) => lw.includes(lat) || lat.includes(lw)));
    }).length;

    if (matchedCount >= 1 && (matchedCount / arabicWords.length >= 0.5 || matchedCount >= 2)) {
      return true;
    }
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
    const receiverNum = normalizePhoneNumber(process.env.AUTO_TOPUP_WALLET_RECEIVER || "01104826670");

    const fromMatch = text.match(/(?:من|بواسطة|from)\s*(?:رقم\s*|حساب\s*|محفظة\s*)?[:\s]*([0-9+]{10,16})/i);
    if (fromMatch) {
      const norm = normalizePhoneNumber(fromMatch[1]);
      if (norm && norm !== receiverNum) {
        senderPhone = norm;
      }
    }

    // Phone in parentheses e.g. (00201012345678)
    if (!senderPhone) {
      const parenMatch = text.match(/\(([0-9+]{10,16})\)/);
      if (parenMatch) {
        const norm = normalizePhoneNumber(parenMatch[1]);
        if (norm && norm !== receiverNum) {
          senderPhone = norm;
        }
      }
    }

    // Fallback: any Egyptian mobile number in message that is NOT the store's receiver number
    if (!senderPhone) {
      const allPhones = Array.from(text.matchAll(/(?:(?:\+?20|0020|002)?(01[0125]\d{8}))/g)).map((m) => m[1]);
      const otherPhone = allPhones.find((p) => p !== receiverNum);
      if (otherPhone) {
        senderPhone = otherPhone;
      }
    }

    const trxMatch = (
      text.match(/(?:رقم\s+العملية|كود\s+العملية|رقم\s+المعاملة|كود\s+المعاملة|رقم\s+التحويل|كود\s+التحويل|عملية\s+رقم|معاملة\s+رقم|العملية|مرجع(?:\s+العملية)?|المرجع|برقم\s+مرجعي|Transaction\s*ID|Trx\s*ID|Ref(?:erence)?(?:\s+No\.?)?)[:\s#]*([A-Za-z0-9_-]{4,})/i) ||
      text.match(/\b([A-Z0-9]{8,14})\b/i)
    );

    // Extract sender name: ALWAYS extract even if senderPhone is present!
    let senderName = "";

    // Pattern A: "من [NAME] ([PHONE])" or "من [NAME] [PHONE]"
    const nameBeforePhone = text.match(/(?:من|بواسطة|from|by)\s+([\p{L}\s]{2,40}?)\s*(?:\([0-9+]+\)|[0-9+]{10,16})/iu);
    if (nameBeforePhone && !/\d/.test(nameBeforePhone[1])) {
      senderName = cleanExtractedName(nameBeforePhone[1]);
    }

    // Pattern B: "من [PHONE] بواسطة [NAME]" or "[PHONE] [NAME]"
    if (!senderName) {
      const nameAfterPhone = text.match(/[0-9+]{10,16}\s+(?:بواسطة|عبر|by)?\s*([\p{L}\s]{2,40}?)(?=\s+(?:بنجاح|في|محفظ|إلى|الى|لحسابك|عبر|رقم|كود|مرجع|عملية|معاملة|بتاريخ|برقم|successfully|to|in|wallet|account|via|ref|trx)|\.|,|$)/iu);
      if (nameAfterPhone && !/\d/.test(nameAfterPhone[1])) {
        senderName = cleanExtractedName(nameAfterPhone[1]);
      }
    }

    // Pattern C: General match after "من" / "بواسطة"
    if (!senderName) {
      const generalNameMatch = text.match(
        /(?:من|بواسطة|from|by)\s+(?:انستاباي\s*(?:بواسطة|\/)?\s*|ipn\s*(?:\/|-)?\s*|حساب\s+بنكي\s*(?:بواسطة|\/)?\s*)?([\p{L}\s]{2,40}?)(?=\s+(?:بنجاح|في|محفظ|إلى|الى|لحسابك|عبر|رقم|كود|مرجع|عملية|معاملة|بتاريخ|برقم|successfully|to|in|wallet|account|via|ref|trx)|\.|,|$)/iu
      );
      if (generalNameMatch && !/\d/.test(generalNameMatch[1])) {
        senderName = cleanExtractedName(generalNameMatch[1]);
      }
    }

    // Pattern D: "بواسطة [NAME]"
    if (!senderName) {
      const byMatch = text.match(/(?:بواسطة|by)\s+([\p{L}\s]{2,40}?)(?=\s+(?:بنجاح|في|محفظ|إلى|الى|عبر|رقم|كود|مرجع|عملية|معاملة|بتاريخ|برقم|successfully)|\.|,|$)/iu);
      if (byMatch && !/\d/.test(byMatch[1])) {
        senderName = cleanExtractedName(byMatch[1]);
      }
    }

    if (amountMatch && (senderPhone || senderName)) {
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

      const isInsta = (
        text.includes("إنستاباي") ||
        text.includes("انستاباي") ||
        text.includes("InstaPay") ||
        text.includes("IPN") ||
        (!senderPhone && Boolean(senderName))
      );
      const paymentMethod = isInsta ? "instapay" : "wallet";
      const prefix = isInsta ? "insta" : (provider === "vodafone_cash" ? "vf" : provider);

      if (amountPiasters > 0 && trxId) {
        return {
          ok: true,
          provider: isInsta ? "instapay" : provider,
          paymentMethod,
          amountPiasters,
          amountEgp: amountPiasters / 100,
          senderPhone: senderPhone || "",
          senderName: normalizeSenderName(senderName),
          rawSenderName: senderName,
          trxId: `${prefix}_${trxId}`,
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
    const instapayAmount = (
      text.match(/(?:مبلغ)\s*([\d,.]+)\s*(?:جنيه\s*مصري|جنيه|ج\.م|جم|EGP)/i) ||
      text.match(/([\d,.]+)\s*(?:جنيه\s*مصري|جنيه|ج\.م|جم|EGP)/i) ||
      text.match(/(?:EGP|جنيه|جم)\s*([\d,.]+)/i)
    );

    const instapayRef = (
      text.match(/(?:برقم\s+مرجعي|رقم\s+مرجعي|رقم\s+المرجع|مرجع\s+العملية|مرجع\s+الدفع|المرجع|مرجع|Ref(?:erence)?(?:\s+No\.?)?)[:\s#]*([A-Za-z0-9_-]{4,})/i) ||
      text.match(/(?:كود\s+العملية|Transaction\s*ID|رقم\s+العملية|رقم\s+التحويل)[:\s]*([A-Za-z0-9_-]{4,})/i)
    );

    const amtStr = instapayAmount ? (instapayAmount[1] || instapayAmount[2]) : null;
    if (amtStr && instapayRef) {
      const amountPiasters = toPiasters(amtStr);
      const trxId = instapayRef[1].replace(/[^\w-]/g, "");

      // Extract sender phone if present (handles 002..., +20..., 01...)
      const phoneMatch = text.match(/(?:من|رقم|حساب)?\s*(?:رقم\s*)?([0-9+]{10,16})/i) || text.match(/(01[0125]\d{8})/);
      const senderPhone = phoneMatch ? normalizePhoneNumber(phoneMatch[1]) : "";

      // Extract sender name
      let senderName = "";
      const nameBeforePhone = text.match(/(?:من|بواسطة|from|by)\s+([\p{L}\s]{2,40}?)\s*(?:\([0-9+]+\)|[0-9+]{10,16})/iu);
      if (nameBeforePhone && !/\d/.test(nameBeforePhone[1])) {
        senderName = cleanExtractedName(nameBeforePhone[1]);
      }

      if (!senderName) {
        const nameMatchAr = text.match(
          /(?:من|بواسطة|العميل)\s+(?:انستاباي\s*(?:بواسطة|\/)?\s*|ipn\s*(?:\/|-)?\s*|حساب\s+بنكي\s*(?:بواسطة|\/)?\s*)?([\p{L}\s]{2,40}?)(?=\s+(?:بنجاح|في|محفظ|إلى|الى|عبر|من\s+خلال|مرجع|كود|بمبلغ|لحسابك|بتاريخ|برقم|\.|,|$))/iu
        );
        if (nameMatchAr && !/\d/.test(nameMatchAr[1])) {
          senderName = cleanExtractedName(nameMatchAr[1]);
        }
      }

      if (!senderName) {
        const nameMatchEn = text.match(/(?:from|by)\s+([A-Za-z\s]{3,40}?)(?=\s+(?:via|ref|account|on|\.|$))/i);
        if (nameMatchEn && !/\d/.test(nameMatchEn[1])) {
          senderName = cleanExtractedName(nameMatchEn[1]);
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
