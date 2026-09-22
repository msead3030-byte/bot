"use strict";

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function timeoutMs(method, payload = {}) {
  if (method === "getUpdates") {
    const seconds = Number(payload.timeout || 25);
    return (Number.isFinite(seconds) ? seconds : 25) * 1000 + 15000;
  }
  return Number(process.env.TG_REQUEST_TIMEOUT_MS || 10000);
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function multipartBody(fields = {}, files = {}) {
  const boundary = `----m-automation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value == null) continue;
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    parts.push(Buffer.from(`${typeof value === "object" ? JSON.stringify(value) : String(value)}\r\n`));
  }
  for (const [name, file] of Object.entries(files)) {
    if (!file?.path) continue;
    const filename = file.filename || path.basename(file.path);
    const contentType = file.contentType || "application/octet-stream";
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`));
    parts.push(Buffer.from(`Content-Type: ${contentType}\r\n\r\n`));
    parts.push(fs.readFileSync(file.path));
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

class TelegramApi {
  constructor(token) {
    if (!token) throw new Error("Telegram token is required.");
    this.token = token;
    this.apiBase = `https://api.telegram.org/bot${token}`;
    this._lastCallByChat = new Map();
    this._cooldownUntilByChat = new Map();
    this._minPerChatGapMs = Number(process.env.TG_MIN_PER_CHAT_GAP_MS || 200);
  }

  _cleanupRateLimitMaps(now) {
    if (this._lastCallByChat.size > 1000) {
      const threshold = now - 600000;
      for (const [id, time] of this._lastCallByChat.entries()) {
        if (time < threshold) this._lastCallByChat.delete(id);
      }
    }
    if (this._cooldownUntilByChat.size > 1000) {
      for (const [id, until] of this._cooldownUntilByChat.entries()) {
        if (until < now) this._cooldownUntilByChat.delete(id);
      }
    }
  }

  async _pace(chatId) {
    if (!chatId) return;
    const now = Date.now();
    this._cleanupRateLimitMaps(now);
    const cooldown = this._cooldownUntilByChat.get(chatId) || 0;
    if (cooldown > now) await sleep(cooldown - now);
    const last = this._lastCallByChat.get(chatId) || 0;
    const gap = Date.now() - last;
    if (gap < this._minPerChatGapMs) await sleep(this._minPerChatGapMs - gap);
    this._lastCallByChat.set(chatId, Date.now());
  }

  async request(method, payload = {}, options = {}) {
    const attempts = Math.max(1, Number(options.attempts || process.env.TG_REQUEST_MAX_ATTEMPTS || 2));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await this._pace(payload.chat_id);
      let response;
      try {
        response = await fetchWithTimeout(`${this.apiBase}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }, timeoutMs(method, payload));
      } catch (error) {
        if (attempt < attempts) {
          await sleep(350 * attempt);
          continue;
        }
        throw new Error(`Telegram ${method} failed: ${error.name === "AbortError" ? "timeout" : error.message}`);
      }
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok) return data.result;
      const retryAfter = Number(data?.parameters?.retry_after || 0);
      if (response.status === 429 && retryAfter > 0 && attempt < attempts) {
        if (payload.chat_id) this._cooldownUntilByChat.set(payload.chat_id, Date.now() + retryAfter * 1000 + 250);
        await sleep(retryAfter * 1000 + 200);
        continue;
      }
      if (response.status === 400 && /message is not modified/i.test(data.description || "")) return true;
      if (response.status >= 500 && attempt < attempts) {
        await sleep(350 * attempt);
        continue;
      }
      throw new Error(`Telegram ${method} failed: ${data.description || response.status}`);
    }
    throw new Error(`Telegram ${method} failed.`);
  }

  async requestMultipart(method, fields = {}, files = {}) {
    const { boundary, body } = multipartBody(fields, files);
    await this._pace(fields.chat_id);
    const response = await fetchWithTimeout(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    }, Number(process.env.TG_FILE_UPLOAD_TIMEOUT_MS || 120000));
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.ok) return data.result;
    throw new Error(`Telegram ${method} failed: ${data.description || response.status}`);
  }

  getUpdates(offset, timeout = 25) {
    return this.request("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message", "callback_query"],
    });
  }

  sendMessage(chatId, text, options = {}) {
    return this.request("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...options,
    });
  }

  sendPhoto(chatId, photo, options = {}) {
    if (typeof photo === "string" && fs.existsSync(photo)) {
      return this.requestMultipart("sendPhoto", {
        chat_id: chatId,
        ...options,
      }, {
        photo: { path: photo }
      });
    }
    return this.request("sendPhoto", {
      chat_id: chatId,
      photo,
      ...options,
    });
  }

  editMessageCaption(chatId, messageId, caption, options = {}) {
    return this.request("editMessageCaption", {
      chat_id: chatId,
      message_id: messageId,
      caption,
      ...options,
    });
  }

  sendDocument(chatId, document, options = {}) {
    if (typeof document === "string" && fs.existsSync(document)) {
      return this.requestMultipart("sendDocument", {
        chat_id: chatId,
        ...options,
      }, {
        document: { path: document }
      });
    }
    return this.request("sendDocument", {
      chat_id: chatId,
      document,
      ...options,
    });
  }

  editMessageText(chatId, messageId, text, options = {}) {
    return this.request("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      ...options,
    });
  }

  answerCallbackQuery(callbackQueryId, options = {}) {
    return this.request("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...options,
    });
  }

  getChatMember(chatId, userId) {
    return this.request("getChatMember", {
      chat_id: chatId,
      user_id: userId,
    });
  }
}

module.exports = { TelegramApi, sleep };
