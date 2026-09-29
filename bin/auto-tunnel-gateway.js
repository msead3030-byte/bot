#!/usr/bin/env node
"use strict";

require("dotenv").config({ quiet: true });
const { spawn } = require("child_process");
const https = require("https");

const BASE_URL = process.env.SMS_GATEWAY_URL || "https://api.sms-gate.app";
const USER = process.env.SMS_GATEWAY_USER || "CPHM-B";
const PASS = process.env.SMS_GATEWAY_PASS || "1zrnufhhceepf7";
const LOCAL_PORT = process.env.SMS_WEBHOOK_PORT || 3000;

function registerWebhookApi(webhookUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL("/3rdparty/v1/webhooks", BASE_URL);
    const auth = Buffer.from(`${USER}:${PASS}`).toString("base64");
    const body = JSON.stringify({
      url: webhookUrl,
      event: "sms:received",
    });

    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Accept: "application/json",
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            const data = JSON.parse(raw);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data);
            } else {
              reject(new Error(`[${res.statusCode}] ${data.message || raw}`));
            }
          } catch {
            reject(new Error(raw));
          }
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function startAutoTunnel() {
  console.log("================================================================");
  console.log("  🚀 تشغيل النفق السحابي والربط التلقائي الفوري ببوابة الرسائل");
  console.log("================================================================");
  console.log(`📡 الخادم السحابي: ${BASE_URL}`);
  console.log(`📱 حساب المستخدم: ${USER}`);
  console.log(`🔌 منفذ البوت المحلي: ${LOCAL_PORT}`);
  console.log("\n⏳ جاري فتح نفق HTTPS عام ومستقر بدون أي برامج خارجية...");

  const sshArgs = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-R", `80:127.0.0.1:${LOCAL_PORT}`,
    "nokey@localhost.run"
  ];

  const ssh = spawn("ssh", sshArgs, { stdio: ["ignore", "pipe", "pipe"] });

  let registered = false;
  let publicUrl = "";

  ssh.stdout.on("data", async (chunk) => {
    const text = chunk.toString();
    const match = text.match(/https:\/\/[a-zA-Z0-9.-]+\.lhr\.life/);
    if (match && !registered) {
      publicUrl = match[0];
      registered = true;
      const fullWebhookUrl = `${publicUrl}/api/sms/webhook`;
      console.log(`\n🎉 تم إنشاء رابط النفق العام بنجاح!`);
      console.log(`🌐 الرابط العام: ${publicUrl}`);
      console.log(`🔗 رابط الويب هوك: ${fullWebhookUrl}\n`);
      console.log("⏳ جاري تسجيل الرابط أوتوماتيكياً في خادم الرسائل السحابي...");

      try {
        const result = await registerWebhookApi(fullWebhookUrl);
        console.log("================================================================");
        console.log("  ✅ تم ربط بوابة الرسائل وتفعيل الشحن التلقائي بنجاح 100%!");
        console.log("================================================================");
        console.log(`🆔 معرف الويب هوك: ${result.id}`);
        console.log("\n⚠️ ملاحظة هامة جداً:");
        console.log("  - اترك هذه النافذة مفتوحة طالما البوت قيد التشغيل.");
        console.log("  - أي رسالة فودافون كاش تصل لهاتفك سيتم شحنها تلقائياً الآن!\n");
      } catch (err) {
        console.error("❌ فشل تسجيل الويب هوك في السحاب:", err.message);
      }
    }
  });

  ssh.stderr.on("data", (chunk) => {
    const errText = chunk.toString();
    if (errText.includes("Warning") || errText.includes("connection id")) return;
  });

  ssh.on("close", (code) => {
    console.log(`\n⚠️ تم إغلاق النفق (كود الخروج: ${code})`);
  });

  process.on("SIGINT", () => {
    ssh.kill();
    process.exit();
  });
}

startAutoTunnel();
