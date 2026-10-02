"use strict";

const { spawn } = require("child_process");
const https = require("https");

class AutoTunnelService {
  constructor(options = {}) {
    this.port = options.port || Number(process.env.SMS_WEBHOOK_PORT || 3000);
    this.user = options.user || process.env.SMS_GATEWAY_USER || "CPHM-B";
    this.pass = options.pass || process.env.SMS_GATEWAY_PASS || "1zrnufhhceepf7";
    this.baseUrl = options.baseUrl || process.env.SMS_GATEWAY_URL || "https://api.sms-gate.app";
    this.secret = options.secret || process.env.SMS_WEBHOOK_SECRET || "";
    this.sshProcess = null;
    this.currentPublicUrl = "";
    this.registeredWebhookId = "";
    this.isStopping = false;
    this.reconnectTimer = null;
  }

  // Append secret as query param if set (sms-gate.app doesn't support custom headers)
  _buildWebhookUrl(baseWebhookUrl) {
    const cleanSecret = String(this.secret || "").trim();
    if (!cleanSecret) return baseWebhookUrl;
    const separator = baseWebhookUrl.includes("?") ? "&" : "?";
    return `${baseWebhookUrl}${separator}secret=${encodeURIComponent(cleanSecret)}`;
  }

  apiRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const auth = Buffer.from(`${this.user}:${this.pass}`).toString("base64");
      const postData = body ? JSON.stringify(body) : null;

      const req = https.request(
        url,
        {
          method,
          headers: {
            Authorization: `Basic ${auth}`,
            Accept: "application/json",
            ...(postData ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) } : {}),
          },
        },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () => {
            let data = null;
            try {
              data = JSON.parse(raw);
            } catch {
              data = raw;
            }
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data);
            } else {
              const errMsg = typeof data === "object" ? JSON.stringify(data) : data;
              reject(new Error(`[${res.statusCode}] ${errMsg}`));
            }
          });
        }
      );

      req.on("error", reject);
      if (postData) req.write(postData);
      req.end();
    });
  }

  async syncCloudWebhook(targetWebhookUrl) {
    if (!this.user || !this.pass) {
      console.warn("[AutoTunnel] SMS_GATEWAY_USER / PASS not set. Skipping webhook registration.");
      return null;
    }

    try {
      console.log(`[AutoTunnel] 🔄 فحص ومزامنة الويب هوك مع السحاب (${this.baseUrl})...`);
      const existing = await this.apiRequest("GET", "/3rdparty/v1/webhooks");
      const webhooks = Array.isArray(existing) ? existing : [];

      // Check if already registered (match by base URL ignoring secret param)
      const normalizedTarget = targetWebhookUrl.split("?")[0];
      const alreadyPresent = webhooks.find((w) => w.url === targetWebhookUrl || w.url.split("?")[0] === normalizedTarget);
      if (alreadyPresent) {
        console.log(`[AutoTunnel] ✅ الويب هوك مسجل مسبقاً ونشط: ${targetWebhookUrl} (ID: ${alreadyPresent.id})`);
        this.registeredWebhookId = alreadyPresent.id;

        // Clean up other obsolete webhooks
        for (const w of webhooks) {
          if (w.id !== alreadyPresent.id) {
            try {
              await this.apiRequest("DELETE", `/3rdparty/v1/webhooks/${w.id}`);
              console.log(`[AutoTunnel] 🧹 تم تنظيف ويب هوك قديم: ${w.id}`);
            } catch {}
          }
        }
        return alreadyPresent;
      }

      // Remove only temporary tunnel webhooks (lhr.life / localhost.run / ngrok) to prevent deleting production webhooks
      for (const w of webhooks) {
        if (w.url && (w.url.includes("railway.app") || w.url.includes("up.railway.app"))) {
          console.log(`[AutoTunnel] 🛡️ تم الإبقاء على ويب هوك الإنتاج السحابي (Railway): ${w.url}`);
          continue;
        }
        try {
          await this.apiRequest("DELETE", `/3rdparty/v1/webhooks/${w.id}`);
          console.log(`[AutoTunnel] 🧹 تم حذف ويب هوك نفق مؤقت قديم: ${w.id} (${w.url})`);
        } catch (e) {
          console.warn(`[AutoTunnel] تحذير أثناء حذف ويب هوك قديم: ${e.message}`);
        }
      }

      // Register new webhook
      const newWebhook = await this.apiRequest("POST", "/3rdparty/v1/webhooks", {
        url: targetWebhookUrl,
        event: "sms:received",
      });

      this.registeredWebhookId = newWebhook.id;
      console.log("================================================================");
      console.log("  🎉 تم تفعيل الويب هوك وربط بوابة الرسائل بنجاح 100%!");
      console.log(`  🌐 الرابط العام: ${targetWebhookUrl}`);
      console.log(`  🆔 معرف الويب هوك: ${newWebhook.id}`);
      console.log("  ⚡ الآن أي رسالة فودافون كاش تصل لهاتفك سيتم شحنها تلقائياً!");
      console.log("================================================================");
      return newWebhook;
    } catch (err) {
      console.error(`[AutoTunnel] ❌ فشل تسجيل الويب هوك في السحاب: ${err.message}`);
      return null;
    }
  }

  start() {
    this.isStopping = false;
    clearTimeout(this.reconnectTimer);

    console.log("[AutoTunnel] 🚀 جاري فتح نفق HTTPS سحابي للربط مع تطبيق بوابة الرسائل...");

    const sshArgs = [
      "-o", "StrictHostKeyChecking=no",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-R", `80:127.0.0.1:${this.port}`,
      "nokey@localhost.run",
    ];

    try {
      this.sshProcess = spawn("ssh", sshArgs, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      console.error("[AutoTunnel] ❌ تعذر تشغيل أمر ssh:", err.message);
      return;
    }

    let urlDiscovered = false;

    const parseOutput = async (chunk) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/[a-zA-Z0-9.-]+\.lhr\.life/);
      if (match && !urlDiscovered) {
        urlDiscovered = true;
        this.currentPublicUrl = match[0];
        const rawWebhookUrl = `${this.currentPublicUrl}/api/sms/webhook`;
        const webhookUrl = this._buildWebhookUrl(rawWebhookUrl);
        await this.syncCloudWebhook(webhookUrl);
      }
    };

    this.sshProcess.stdout.on("data", parseOutput);
    this.sshProcess.stderr.on("data", parseOutput);

    this.sshProcess.on("close", (code) => {
      if (this.isStopping) return;
      console.warn(`[AutoTunnel] ⚠️ انقطع النفق السحابي (كود ${code}). إعادة الاتصال تلقائياً خلال 5 ثوانٍ...`);
      this.reconnectTimer = setTimeout(() => {
        if (!this.isStopping) this.start();
      }, 5000);
    });

    this.sshProcess.on("error", (err) => {
      if (this.isStopping) return;
      console.error("[AutoTunnel] خطأ في عملية النفق:", err.message);
    });
  }

  stop() {
    this.isStopping = true;
    clearTimeout(this.reconnectTimer);
    if (this.sshProcess) {
      try {
        this.sshProcess.kill();
      } catch {}
      this.sshProcess = null;
    }
  }
}

let instance = null;

function getAutoTunnel(options) {
  if (!instance) {
    instance = new AutoTunnelService(options);
  }
  return instance;
}

module.exports = {
  AutoTunnelService,
  getAutoTunnel,
};
