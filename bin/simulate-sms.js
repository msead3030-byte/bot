#!/usr/bin/env node
"use strict";

const http = require("http");

const args = process.argv.slice(2);
function getArg(name, def = "") {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return def;
}

const port = Number(getArg("port", process.env.SMS_WEBHOOK_PORT || 3000));
const host = getArg("host", "localhost");
const secret = getArg("secret", process.env.SMS_WEBHOOK_SECRET || "");
const provider = getArg("provider", "vodafone");
const amount = getArg("amount", "50");
const sender = getArg("sender", "01012345678");
const trx = getArg("trx", String(Math.floor(1000000000 + Math.random() * 9000000000)));

let message = "";
if (provider === "vodafone") {
  message = `تم استلام مبلغ ${amount}.00 جنيه من ${sender} بنجاح في محفظة فودافون كاش. رقم العملية: ${trx}.`;
} else if (provider === "instapay") {
  message = `تم تحويل مبلغ ${amount}.00 جم لحسابك من ${sender} عبر إنستاباي بنجاح. مرجع: ${trx}`;
} else if (provider === "orange") {
  message = `تم إيداع مبلغ ${amount} جنيه من رقم ${sender} بنجاح في أورانج كاش. رقم المعاملة: ${trx}`;
} else {
  message = `تم استلام مبلغ ${amount} جنيه من ${sender}. رقم العملية: ${trx}`;
}

const payload = JSON.stringify({
  message,
  secret,
});

console.log("==========================================");
console.log("🚀 إرسال رسالة SMS وهمية لاختبار الويب هوك");
console.log("==========================================");
console.log(`🌐 الوجهة: http://${host}:${port}/api/sms/webhook`);
console.log(`📱 المزود: ${provider}`);
console.log(`💵 المبلغ: ${amount} جنيه`);
console.log(`📞 رقم المحول منه: ${sender}`);
console.log(`🧾 كود العملية: ${trx}`);
console.log(`💬 نص الرسالة: \n"${message}"`);
console.log("------------------------------------------");

const req = http.request(
  {
    hostname: host,
    port: port,
    path: "/api/sms/webhook",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      ...(secret ? { "X-Webhook-Secret": secret } : {}),
    },
  },
  (res) => {
    let resBody = "";
    res.on("data", (chunk) => (resBody += chunk));
    res.on("end", () => {
      console.log(`📥 كود استجابة السيرفر: ${res.statusCode}`);
      try {
        const json = JSON.parse(resBody);
        console.log("📄 تفاصيل الرد:");
        console.log(JSON.stringify(json, null, 2));
        if (json.ok) {
          console.log("\n✅ نجاح! السيرفر استلم الرسالة وقام بمعالجتها بنجاح.");
        } else {
          console.log("\n⚠️ السيرفر تجاهل الرسالة أو لم يقبلها.");
        }
      } catch {
        console.log("📄 الرد النصي:", resBody);
      }
    });
  }
);

req.on("error", (err) => {
  console.error("❌ تعذر الاتصال بسيرفر البوت:", err.message);
  console.error("تأكد أن البوت يعمل وسيرفر الويب هوك مفتوح على المنفذ " + port);
});

req.write(payload);
req.end();
