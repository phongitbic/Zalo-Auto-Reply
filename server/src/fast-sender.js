import crypto from "node:crypto";

// Đường gửi "Ok" nhanh cho tin nhóm có quote, thay cho api.sendMessage của zca-js.
// zca-js mỗi lần gửi phải: mã hóa AES bằng crypto-js (JavaScript thuần), đọc cookie bằng
// tough-cookie (async, nhiều bước), dựng URL/headers lại từ đầu. Đoạn code này chỉ chạy khi có
// cuốc nên thường ở trạng thái "nguội" với JIT -> tốn ~1-2 ms trước khi request rời máy.
// Ở đây: khóa AES, URL, headers, cookie đều chuẩn bị sẵn; mã hóa bằng OpenSSL (node:crypto);
// fetch được gọi đồng bộ ngay trong onMessage.

const ZERO_IV = Buffer.alloc(16);
const COOKIE_REFRESH_MS = 10_000;

const cipherName = (key) => {
  if (key.length === 16) return "aes-128-cbc";
  if (key.length === 24) return "aes-192-cbc";
  if (key.length === 32) return "aes-256-cbc";
  throw new Error(`Unexpected Zalo secret key length ${key.length}`);
};

export const buildGroupQuoteParams = (payload, threadId, clientId = Date.now()) => {
  const quote = payload.quote;
  const params = {
    grid: String(threadId),
    message: payload.msg,
    clientId,
  };
  if (Array.isArray(payload.mentions) && payload.mentions.length) {
    params.mentionInfo = JSON.stringify(payload.mentions.map((mention) => ({
      pos: mention.pos,
      uid: mention.uid,
      len: mention.len,
      type: mention.uid == "-1" ? 1 : 0,
    })));
  }
  params.qmsgOwner = quote.uidFrom;
  params.qmsgId = quote.msgId;
  params.qmsgCliId = quote.cliMsgId;
  params.qmsgType = 1;
  params.qmsgTs = quote.ts;
  params.qmsg = quote.content;
  params.visibility = 0;
  if (quote.ttl !== undefined) params.qmsgTTL = quote.ttl;
  params.ttl = 0;
  for (const key of Object.keys(params)) {
    if (params[key] === undefined) delete params[key];
  }
  return params;
};

export class FastGroupSender {
  constructor({ api, fetch: fetchImpl, proxy, requestTimeoutMs = 30000 }) {
    const ctx = api.getContext();
    if (!ctx?.secretKey || !ctx.cookie || !ctx.userAgent) throw new Error("Zalo context is incomplete");
    const groupBase = api.zpwServiceMap?.group?.[0];
    if (!groupBase) throw new Error("Missing Zalo group service URL");

    this.ctx = ctx;
    this.fetch = fetchImpl;
    this.proxy = proxy;
    this.requestTimeoutMs = requestTimeoutMs;
    this.key = Buffer.from(ctx.secretKey, "base64");
    this.cipher = cipherName(this.key);
    this.decipher = this.cipher;

    const url = new URL(`${groupBase}/api/group`);
    url.searchParams.append("nretry", "0");
    url.searchParams.set("zpw_ver", String(ctx.API_VERSION));
    url.searchParams.set("zpw_type", String(ctx.API_TYPE));
    url.pathname += "/quote";
    this.quoteUrl = url.toString();
    this.origin = url.origin;

    this.baseHeaders = {
      Accept: "application/json, text/plain, */*",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "en-US,en;q=0.9",
      "content-type": "application/x-www-form-urlencoded",
      Origin: "https://chat.zalo.me",
      Referer: "https://chat.zalo.me/",
      "User-Agent": ctx.userAgent,
    };
    this.headers = null;
    this.cookieTimer = null;
    this.disposed = false;
  }

  async init() {
    await this.refreshCookie();
    this.cookieTimer = setInterval(() => void this.refreshCookie().catch(() => { }), COOKIE_REFRESH_MS);
    this.cookieTimer.unref?.();
    return this;
  }

  async refreshCookie() {
    const cookie = await this.ctx.cookie.getCookieString(this.origin);
    this.headers = { ...this.baseHeaders, Cookie: cookie };
  }

  dispose() {
    this.disposed = true;
    if (this.cookieTimer) clearInterval(this.cookieTimer);
    this.cookieTimer = null;
  }

  // Chỉ xử lý đúng dạng tin của bot: text, có quote tin text "webchat". Dạng khác -> zca-js.
  canSend(payload) {
    return Boolean(
      !this.disposed
      && this.headers
      && payload
      && typeof payload === "object"
      && typeof payload.msg === "string"
      && payload.msg.length > 0
      && payload.quote
      && typeof payload.quote.content === "string"
      && payload.quote.msgType === "webchat"
    );
  }

  encrypt(text) {
    const cipher = crypto.createCipheriv(this.cipher, this.key, ZERO_IV);
    return Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("base64");
  }

  decrypt(base64) {
    const decipher = crypto.createDecipheriv(this.decipher, this.key, ZERO_IV);
    const input = Buffer.from(decodeURIComponent(base64), "base64");
    return Buffer.concat([decipher.update(input), decipher.final()]).toString("utf8");
  }

  buildBody(payload, threadId) {
    const params = buildGroupQuoteParams(payload, threadId);
    return `params=${encodeURIComponent(this.encrypt(JSON.stringify(params)))}`;
  }

  // Giữ JIT/OpenSSL nóng cho đúng đoạn code gửi mà không gửi gì lên Zalo.
  rehearse() {
    if (!this.headers) return;
    this.buildBody({
      msg: "@warm Ok",
      mentions: [{ pos: 0, uid: "0", len: 5 }],
      quote: { uidFrom: "0", msgId: "0", cliMsgId: "0", ts: "0", msgType: "webchat", content: "warm", ttl: 0 },
    }, "0");
  }

  send(payload, threadId) {
    const body = this.buildBody(payload, threadId);
    const options = {
      method: "POST",
      headers: this.headers,
      body,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    };
    if (this.proxy) options.proxy = this.proxy;
    const request = this.fetch(this.quoteUrl, options);
    return request.then((response) => this.handleResponse(response));
  }

  async handleResponse(response) {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    if (setCookies.length) {
      void Promise.all(setCookies.map((cookie) =>
        this.ctx.cookie.setCookie(cookie, this.quoteUrl).catch(() => { })))
        .then(() => this.refreshCookie())
        .catch(() => { });
    }
    if (!response.ok) throw new Error(`Request failed with status code ${response.status}`);
    const json = await response.json();
    if (json.error_code != 0) {
      const error = new Error(json.error_message || `Zalo error ${json.error_code}`);
      error.code = json.error_code;
      throw error;
    }
    const decoded = JSON.parse(this.decrypt(json.data));
    if (decoded.error_code != 0) {
      const error = new Error(decoded.error_message || `Zalo error ${decoded.error_code}`);
      error.code = decoded.error_code;
      throw error;
    }
    return decoded.data;
  }
}

// So khớp mã hóa với crypto-js (thư viện zca-js dùng). Lệch -> không dùng đường nhanh.
export const verifyAgainstCryptoJs = async (sender) => {
  let CryptoJS;
  try {
    CryptoJS = (await import("crypto-js")).default;
  } catch {
    return { verified: false, reason: "crypto-js không tải được, bỏ qua so khớp" };
  }
  const sample = JSON.stringify({ grid: "1", message: "@Tiếng Việt Ok", clientId: 1, qmsg: "tpbn → sân bay 350k" });
  const expected = CryptoJS.AES.encrypt(sample, CryptoJS.enc.Base64.parse(sender.ctx.secretKey), {
    iv: CryptoJS.enc.Hex.parse("00000000000000000000000000000000"),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  }).ciphertext.toString(CryptoJS.enc.Base64);
  if (sender.encrypt(sample) !== expected) throw new Error("Fast sender encryption mismatch");
  if (sender.decrypt(expected) !== sample) throw new Error("Fast sender decryption mismatch");
  return { verified: true };
};
