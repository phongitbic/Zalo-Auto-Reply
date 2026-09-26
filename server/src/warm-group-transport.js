import zlib from "node:zlib";
import { HttpConnection } from "./http-connection.js";

// Chỉ lệnh gửi tin nhóm đi qua kết nối nóng; API nhóm khác (getGroupInfo, ...) dùng fetch thường
// để không chiếm kết nối dành cho cuốc.
export const WARM_GROUP_SEND_PATHS = new Set([
  "/api/group/sendmsg",
  "/api/group/mention",
  "/api/group/quote",
]);

const MAX_WARM_UP_BODY_BYTES = 64 * 1024;
const DEFAULT_RECONNECT_DELAYS_MS = [0, 250, 1000, 3000];

const toHeaderObject = (headers) => {
  const result = {};
  if (!headers) return result;
  const entries = typeof headers.entries === "function" && !Array.isArray(headers)
    ? headers.entries()
    : Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [key, value] of entries) {
    if (value === undefined || value === null) continue;
    result[String(key).toLowerCase()] = String(value);
  }
  return result;
};

const toRequestBody = (body) => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || body instanceof Uint8Array) return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new TypeError(`Warm group transport does not support body type ${body?.constructor?.name ?? typeof body}`);
};

const decodeBody = (buffer, encoding) => {
  switch (String(encoding ?? "").trim().toLowerCase()) {
    case "":
    case "identity":
      return buffer;
    case "gzip":
    case "x-gzip":
      return zlib.gunzipSync(buffer);
    case "deflate":
      try {
        return zlib.inflateSync(buffer);
      } catch {
        return zlib.inflateRawSync(buffer);
      }
    case "br":
      return zlib.brotliDecompressSync(buffer);
    default:
      throw new Error(`Unsupported content-encoding: ${encoding}`);
  }
};

/**
 * Giữ N (mặc định 2) kết nối HTTP/1.1 riêng tới máy chủ gửi tin nhóm của Zalo.
 * - Làm nóng luân phiên, không bao giờ làm nóng 2 kết nối cùng lúc → luôn còn ít nhất 1 kết nối rảnh.
 * - Kết nối bị đóng (Zalo/NAT/timeout) → tự mở và làm nóng lại ngay ở nền (backoff nếu lỗi liên tiếp).
 * - Cuốc thật chọn kết nối đã nối và đang rảnh; không bao giờ hủy request làm nóng.
 */
export class WarmGroupTransport {
  constructor({
    origin,
    connections = 2,
    warmIntervalMs = 5000,
    warmTimeoutMs = 3000,
    requestTimeoutMs = 30000,
    reconnectDelaysMs = DEFAULT_RECONNECT_DELAYS_MS,
    ClientCtor = HttpConnection,
    clientOptions = {},
    stats = {},
    logger = null,
  }) {
    if (!origin) throw new Error("WarmGroupTransport requires an origin");
    this.origin = new URL(origin).origin;
    this.connections = Math.max(2, Math.floor(connections) || 2);
    this.warmIntervalMs = warmIntervalMs;
    this.warmTimeoutMs = warmTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.reconnectDelaysMs = reconnectDelaysMs.length ? reconnectDelaysMs : DEFAULT_RECONNECT_DELAYS_MS;
    this.ClientCtor = ClientCtor;
    this.clientOptions = clientOptions;
    this.logger = logger;
    this.stats = stats;
    this.slots = [];
    this.tickTimer = null;
    this.nextSlot = 0;
    this.closed = false;
    Object.assign(this.stats, {
      groupConnections: this.connections,
      groupConnectionsReady: 0,
      groupReconnects: 0,
      warmSends: this.stats.warmSends ?? 0,
      coldSends: this.stats.coldSends ?? 0,
      lastSendConnectionWarm: this.stats.lastSendConnectionWarm ?? null,
    });
  }

  handles(url) {
    try {
      const parsed = new URL(url);
      return parsed.origin === this.origin && WARM_GROUP_SEND_PATHS.has(parsed.pathname.replace(/\/+$/, ""));
    } catch {
      return false;
    }
  }

  start() {
    if (this.slots.length || this.closed) return;
    for (let index = 0; index < this.connections; index += 1) {
      const slot = {
        index,
        client: null,
        connected: false,
        inflight: 0,
        warming: false,
        active: false,
        waiters: [],
        failures: 0,
        rewarmTimer: null,
        lastActivityAt: 0,
      };
      slot.client = this.createClient(slot);
      this.slots.push(slot);
    }
    // Mở tất cả kết nối ngay khi đăng nhập.
    for (const slot of this.slots) void this.warm(slot);
    // Mỗi kết nối được làm nóng một lần trong mỗi warmIntervalMs, các lượt so le nhau.
    const tickMs = Math.max(25, Math.floor(this.warmIntervalMs / this.connections));
    this.tickTimer = setInterval(() => this.tick(), tickMs);
    this.tickTimer.unref?.();
  }

  createClient(slot) {
    const client = new this.ClientCtor(this.origin, { connectTimeout: 5000, ...this.clientOptions });
    client.on("connect", () => {
      if (slot.client !== client) return;
      slot.connected = true;
      this.updateReady();
    });
    const onDown = () => {
      if (slot.client !== client) return;
      slot.connected = false;
      this.updateReady();
      if (!this.closed) {
        this.stats.groupReconnects += 1;
        this.scheduleRewarm(slot);
      }
    };
    client.on("disconnect", onDown);
    client.on("connectionError", onDown);
    return client;
  }

  updateReady() {
    this.stats.groupConnectionsReady = this.slots.filter((slot) => slot.connected).length;
  }

  scheduleRewarm(slot) {
    if (this.closed || slot.rewarmTimer) return;
    const delays = this.reconnectDelaysMs;
    const delay = delays[Math.min(slot.failures, delays.length - 1)];
    slot.rewarmTimer = setTimeout(() => {
      slot.rewarmTimer = null;
      if (this.closed || slot.connected) return;
      // Đang gửi cuốc trên kết nối này: làm nóng lại khi cuốc xong (xem request()).
      if (slot.inflight > 0 || slot.warming) return;
      void this.warm(slot);
    }, delay);
    slot.rewarmTimer.unref?.();
  }

  tick() {
    if (this.closed) return;
    // Không bao giờ làm nóng 2 kết nối cùng lúc → luôn còn kết nối rảnh cho cuốc.
    if (this.slots.some((slot) => slot.warming)) return;
    const slot = this.slots[this.nextSlot];
    this.nextSlot = (this.nextSlot + 1) % this.slots.length;
    if (slot.inflight > 0) return;
    // Vừa gửi cuốc/làm nóng trong nửa chu kỳ gần đây thì socket vẫn còn nóng.
    if (slot.connected && performance.now() - slot.lastActivityAt < this.warmIntervalMs / 2) return;
    void this.warm(slot);
  }

  async warm(slot) {
    if (this.closed || slot.warming || slot.inflight > 0) return false;
    slot.warming = true;
    const startedAt = performance.now();
    try {
      const response = await slot.client.request({
        path: "/",
        method: "GET",
        headers: { range: "bytes=0-0", "accept-encoding": "identity" },
        signal: AbortSignal.timeout(this.warmTimeoutMs),
        maxBodyBytes: MAX_WARM_UP_BODY_BYTES,
      });
      // Zalo trả "Connection: close" cho lượt làm nóng thì socket không giữ được → tính như lỗi để
      // giãn nhịp mở lại (tránh vòng lặp mở/đóng liên tục).
      if (response.connectionClose) {
        slot.failures += 1;
        this.stats.groupWarmUpConnectionClose = (this.stats.groupWarmUpConnectionClose ?? 0) + 1;
      } else {
        slot.failures = 0;
      }
      this.stats.lastGroupWarmUpAt = new Date().toISOString();
      this.stats.lastGroupWarmUpMs = Number((performance.now() - startedAt).toFixed(3));
      this.stats.lastGroupWarmUpStatus = response.statusCode;
      this.stats.groupWarmUpSuccesses = (this.stats.groupWarmUpSuccesses ?? 0) + 1;
      return true;
    } catch (error) {
      slot.failures += 1;
      this.stats.groupWarmUpFailures = (this.stats.groupWarmUpFailures ?? 0) + 1;
      this.logger?.warn?.(`Zalo group warm-up #${slot.index} failed:`, error?.message ?? error);
      return false;
    } finally {
      slot.warming = false;
      slot.lastActivityAt = performance.now();
      this.wake(slot);
      if (!this.closed && !slot.connected && slot.inflight === 0) this.scheduleRewarm(slot);
    }
  }

  wake(slot) {
    slot.waiters.shift()?.();
  }

  async waitIdle(slot) {
    while (!this.closed && (slot.warming || slot.active)) {
      await new Promise((resolve) => slot.waiters.push(resolve));
    }
    if (this.closed) throw new Error("Warm group transport is closed");
  }

  pickSlot() {
    const idle = (slot) => slot.inflight === 0 && !slot.warming;
    return this.slots.find((slot) => slot.connected && idle(slot))
      // Hiếm: mọi kết nối nóng đều bận. Xếp sau request làm nóng (~1 RTT) vẫn nhanh hơn mở TLS mới.
      ?? this.slots.find((slot) => slot.connected && slot.inflight === 0)
      ?? this.slots.find(idle)
      ?? this.slots.reduce((best, slot) => (slot.inflight < best.inflight ? slot : best));
  }

  async request(url, options = {}) {
    if (this.closed) throw new Error("Warm group transport is closed");
    const slot = this.pickSlot();
    const warm = slot.connected;
    this.stats.lastSendConnectionWarm = warm;
    if (warm) this.stats.warmSends += 1;
    else this.stats.coldSends += 1;

    const parsed = new URL(url);
    const headers = toHeaderObject(options.headers);
    delete headers.host;
    delete headers.connection;
    delete headers["content-length"];
    // Chỉ nhận mã hóa giải được bằng node:zlib (bỏ zstd).
    headers["accept-encoding"] = "gzip, deflate, br";

    // Giữ chỗ đồng bộ ngay khi chọn để request/lượt làm nóng khác không chen vào kết nối này.
    slot.inflight += 1;
    try {
      await this.waitIdle(slot);
      slot.active = true;
      const response = await slot.client.request({
        path: `${parsed.pathname}${parsed.search}`,
        method: (options.method ?? "GET").toUpperCase(),
        headers,
        body: toRequestBody(options.body),
        signal: options.signal ?? AbortSignal.timeout(this.requestTimeoutMs),
      });
      const body = decodeBody(response.body, response.headers["content-encoding"]);
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (key === "content-encoding" || key === "content-length" || key === "transfer-encoding") continue;
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item !== undefined) responseHeaders.append(key, String(item));
        }
      }
      const status = response.statusCode;
      const nullBody = status === 204 || status === 205 || status === 304;
      return new Response(nullBody ? null : body, { status, headers: responseHeaders });
    } finally {
      slot.active = false;
      slot.inflight -= 1;
      slot.lastActivityAt = performance.now();
      this.wake(slot);
      if (!this.closed && !slot.connected && slot.inflight === 0) this.scheduleRewarm(slot);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const slot of this.slots) {
      if (slot.rewarmTimer) clearTimeout(slot.rewarmTimer);
      slot.rewarmTimer = null;
      for (const resolve of slot.waiters.splice(0)) resolve();
      // close() chờ cuốc đang gửi xong rồi mới đóng socket.
      Promise.resolve(slot.client.close()).catch(() => { });
    }
    this.stats.groupConnectionsReady = 0;
  }
}
