#!/usr/bin/env node
"use strict";

require("dotenv").config({ quiet: true });
const https = require("https");
const http = require("http");

const BASE_URL = process.env.SMS_GATEWAY_URL || "https://api.sms-gate.app";
const USER = process.env.SMS_GATEWAY_USER || "CPHM-B";
const PASS = process.env.SMS_GATEWAY_PASS || "1zrnufhhceepf7";
const DEVICE_ID = process.env.SMS_GATEWAY_DEVICE_ID || "UPAu2ysqIEtZ83VRE-Dnb";
const LOCAL_PORT = process.env.SMS_WEBHOOK_PORT || 3000;

function apiRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const auth = Buffer.from(`${USER}:${PASS}`).toString("base64");

    const req = https.request(
      url,
      {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch {
            data = raw;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, data });
          } else {
            reject(new Error(`API Error [${res.statusCode}]: ${typeof data === "object" ? JSON.stringify(data) : data}`));
          }
        });
      }
    );

    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function checkStatus() {
  console.log("\n========================================================");
  console.log("  🔍 فحص حالة الهاتف وبوابة الرسائل (SMS Gateway)");
  console.log("========================================================");
  console.log(`📡 الخادم السحابي: ${BASE_URL}`);
  console.log(`👤 اسم المستخدم: ${USER}`);
  console.log(`📱 معرف الجهاز المحدد: ${DEVICE_ID}\n`);

  try {
    const res = await apiRequest("GET", "/3rdparty/v1/devices");
    const devices = Array.isArray(res.data) ? res.data : [res.data];

    if (!devices.length) {
      console.log("⚠️ لم يتم العثور على أجهزة مسجلة في هذا الحساب.");
      return;
    }

    console.log(`✅ تم العثور على (${devices.length}) جهاز مسجل:\n`);
    devices.forEach((d, idx) => {
      const isTarget = d.id === DEVICE_ID;
      const lastSeenDate = d.lastSeen ? new Date(d.lastSeen).toLocaleString("ar-EG") : "غير معروف";
      console.log(`  [${idx + 1}] جهاز: ${d.name || "Android Device"} ${isTarget ? "⭐ (الجهاز الحالي)" : ""}`);
      console.log(`      - الآيدي: ${d.id}`);
      console.log(`      - آخر ظهور أونلاين: ${lastSeenDate}`);
      if (d.simCards && Array.isArray(d.simCards)) {
        d.simCards.forEach((sim) => {
          console.log(`      - شريحة SIM ${sim.simNumber}: ${sim.carrierName || "بدون اسم"}`);
        });
      }
      console.log("");
    });

    // Also check registered webhooks
    console.log("--------------------------------------------------------");
    console.log("🔗 الويب هوك المسجل حالياً (Webhooks):");
    const whRes = await apiRequest("GET", "/3rdparty/v1/webhooks");
    const webhooks = Array.isArray(whRes.data) ? whRes.data : [];
    if (!webhooks.length) {
      console.log("  ⚠️ لا يوجد أي ويب هوك مسجل بعد!");
      console.log("  💡 يمكنك ربط رابط البوت الآن باستخدام:");
      console.log("     node bin/sms-gateway.js register <YOUR_PUBLIC_URL>/api/sms/webhook");
    } else {
      webhooks.forEach((w, idx) => {
        console.log(`  [${idx + 1}] ID: ${w.id}`);
        console.log(`      - الرابط: ${w.url}`);
        console.log(`      - الحدث: ${w.event}`);
      });
    }
    console.log("========================================================\n");
  } catch (err) {
    console.error("❌ فشل الاتصال بالبوابة:", err.message);
  }
}

async function listWebhooks() {
  try {
    const res = await apiRequest("GET", "/3rdparty/v1/webhooks");
    const list = Array.isArray(res.data) ? res.data : [];
    console.log("\n📋 قائمة الويب هوك المسجلة:");
    if (!list.length) {
      console.log("  (فارغة - لا يوجد أي رابط مسجل)");
    } else {
      console.table(list);
    }
  } catch (err) {
    console.error("❌ خطأ:", err.message);
  }
}

async function registerWebhook(rawUrl) {
  if (!rawUrl) {
    console.error("❌ يجب تحديد الرابط. مثال:");
    console.error("   node bin/sms-gateway.js register https://example.com/api/sms/webhook");
    process.exit(1);
  }

  let finalUrl = rawUrl.trim();
  if (!finalUrl.startsWith("http://") && !finalUrl.startsWith("https://")) {
    finalUrl = "https://" + finalUrl;
  }
  if (!finalUrl.includes("/api/sms/webhook")) {
    finalUrl = finalUrl.replace(/\/+$/, "") + "/api/sms/webhook";
  }

  console.log(`\n⏳ جاري تسجيل الويب هوك على السحاب: ${finalUrl} ...`);

  try {
    const res = await apiRequest("POST", "/3rdparty/v1/webhooks", {
      url: finalUrl,
      event: "sms:received",
    });

    console.log("✅ تم تسجيل الويب هوك بنجاح!");
    console.log("بيانات الويب هوك:", res.data);
    console.log("\n🎉 الآن أي رسالة تحويل SMS تصل لهاتفك سيتم إرسالها تلقائياً للبوت وتأكيد الدفع فوراً!");
  } catch (err) {
    console.error("❌ فشل تسجيل الويب هوك:", err.message);
  }
}

async function deleteWebhook(id) {
  if (!id) {
    console.error("❌ يرجى تحديد معرف الويب هوك المراد حذفه.");
    process.exit(1);
  }
  try {
    await apiRequest("DELETE", `/3rdparty/v1/webhooks/${id}`);
    console.log(`✅ تم حذف الويب هوك ${id} بنجاح.`);
  } catch (err) {
    console.error("❌ خطأ أثناء الحذف:", err.message);
  }
}

async function testLocalWebhook() {
  console.log(`\n🧪 اختبار خادم الويب هوك المحلي على المنفذ ${LOCAL_PORT} ...`);
  const payload = {
    deviceId: DEVICE_ID,
    event: "sms:received",
    id: "test-" + Date.now(),
    payload: {
      messageId: "msg-" + Date.now(),
      message: `تم استلام مبلغ 50.00 جنيه من 01012345678 رقم العملية test_${Math.floor(Math.random() * 900000 + 100000)}`,
      sender: "VodafoneCash",
      recipient: "+201104826670",
      simNumber: 2,
      receivedAt: new Date().toISOString(),
    },
  };

  const postData = JSON.stringify(payload);
  const options = {
    hostname: "127.0.0.1",
    port: LOCAL_PORT,
    path: "/api/sms/webhook",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData),
    },
  };

  const req = http.request(options, (res) => {
    let raw = "";
    res.on("data", (chunk) => (raw += chunk));
    res.on("end", () => {
      console.log(`✅ استجابة الخادم [كود ${res.statusCode}]:`, raw);
    });
  });

  req.on("error", (e) => {
    console.error(`❌ تعذر الاتصال بالخادم المحلي على 127.0.0.1:${LOCAL_PORT}:`, e.message);
    console.log("💡 تأكد أن البوت يعمل أولاً عبر start_bot_visible.bat");
  });

  req.write(postData);
  req.end();
}

const args = process.argv.slice(2);
const command = args[0] || "status";

switch (command) {
  case "status":
    checkStatus();
    break;
  case "list":
    listWebhooks();
    break;
  case "register":
    registerWebhook(args[1]);
    break;
  case "delete":
    deleteWebhook(args[1]);
    break;
  case "test":
    testLocalWebhook();
    break;
  default:
    console.log("الأوامر المتاحة:");
    console.log("  node bin/sms-gateway.js status           # فحص حالة الجهاز والويب هوك");
    console.log("  node bin/sms-gateway.js list             # عرض قائمة الويب هوك المسجلة");
    console.log("  node bin/sms-gateway.js register <URL>   # ربط وتفعيل ويب هوك جديد");
    console.log("  node bin/sms-gateway.js delete <ID>      # حذف ويب هوك محدد");
    console.log("  node bin/sms-gateway.js test             # محاكاة وصول رسالة للخادم المحلي");
}
