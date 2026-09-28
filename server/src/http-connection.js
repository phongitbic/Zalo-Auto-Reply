import { EventEmitter } from "node:events";
import net from "node:net";
import tls from "node:tls";

const CRLF = "\r\n";
const HEADER_END = Buffer.from("\r\n\r\n");
const MAX_HEADER_BYTES = 64 * 1024;

const abortError = (signal) => {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
};

/**
 * Một kết nối HTTP/1.1 keep-alive duy nhất, mỗi lúc một request.
 * Dùng socket node:tls/node:net của Bun (khứ hồi ~0,07 ms cục bộ) thay vì undici (~1,3 ms trên Bun),
 * và báo ngay "disconnect" khi máy chủ đóng socket để tầng trên làm nóng lại.
 *
 * Sự kiện: "connect", "disconnect", "connectionError".
 */
export class HttpConnection extends EventEmitter {
  constructor(origin, { connectTimeout = 5000, tlsOptions = {}, keepAliveProbeMs = 15000 } = {}) {
    super();
    const url = new URL(origin);
    this.secure = url.protocol === "https:";
    this.host = url.hostname;
    this.port = Number(url.port) || (this.secure ? 443 : 80);
    this.hostHeader = url.port ? `${url.hostname}:${url.port}` : url.hostname;
    this.connectTimeout = connectTimeout;
    this.tlsOptions = tlsOptions;
    this.keepAliveProbeMs = keepAliveProbeMs;
    this.socket = null;
    this.connecting = null;
    this.busy = false;
    this.pending = null;
    this.closed = false;
    this.closeWhenIdle = false;
  }

  get connected() {
    return Boolean(this.socket && !this.connecting && !this.socket.destroyed);
  }

  connect() {
    if (this.closed) return Promise.reject(new Error("Connection is closed"));
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const options = { host: this.host, port: this.port };
      const socket = this.secure
        ? tls.connect({ ...options, servername: net.isIP(this.host) ? undefined : this.host, ALPNProtocols: ["http/1.1"], ...this.tlsOptions })
        : net.connect(options);
      const readyEvent = this.secure ? "secureConnect" : "connect";
      let settled = false;
      const timer = setTimeout(() => {
        fail(new Error(`Connect timeout after ${this.connectTimeout} ms`));
        socket.destroy();
      }, this.connectTimeout);
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connecting = null;
        this.socket = null;
        this.emit("connectionError", error);
        reject(error);
      };
      socket.once("error", fail);
      socket.once(readyEvent, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("error", fail);
        socket.setNoDelay(true);
        socket.setKeepAlive(true, this.keepAliveProbeMs);
        this.socket = socket;
        this.connecting = null;
        this.attach(socket);
        this.emit("connect");
        resolve();
      });
    });
    return this.connecting;
  }

  attach(socket) {
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", () => { });
    socket.on("end", () => socket.destroy());
    socket.once("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      const pending = this.pending;
      if (pending) {
        if (pending.readUntilClose && pending.head) {
          this.finish(Buffer.concat(pending.chunks));
        } else {
          this.pending = null;
          this.busy = false;
          pending.reject(new Error("Socket closed before the response completed"));
        }
      }
      this.emit("disconnect");
    });
  }

  /**
   * @returns {Promise<{statusCode:number, headers:Record<string,string|string[]>, body:Buffer, connectionClose:boolean}>}
   */
  async request({ path = "/", method = "GET", headers = {}, body, signal, maxBodyBytes = Infinity }) {
    if (this.busy) throw new Error("HttpConnection handles one request at a time");
    if (signal?.aborted) throw abortError(signal);
    this.busy = true;
    try {
      await this.connect();
    } catch (error) {
      this.busy = false;
      throw error;
    }
    if (signal?.aborted) {
      this.busy = false;
      throw abortError(signal);
    }

    const payload = body === undefined || body === null
      ? null
      : Buffer.isBuffer(body) ? body : Buffer.from(body);
    let head = `${method} ${path} HTTP/1.1${CRLF}Host: ${this.hostHeader}${CRLF}`;
    for (const [key, value] of Object.entries(headers)) {
      if (/[\r\n]/.test(key) || /[\r\n]/.test(String(value))) throw new Error(`Invalid header ${key}`);
      head += `${key}: ${value}${CRLF}`;
    }
    if (payload || !["GET", "HEAD"].includes(method)) head += `content-length: ${payload?.length ?? 0}${CRLF}`;
    head += CRLF;

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (this.pending?.resolve !== wrappedResolve) return;
        this.pending = null;
        this.busy = false;
        this.socket?.destroy();
        reject(abortError(signal));
      };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const wrappedResolve = (value) => { cleanup(); resolve(value); };
      const wrappedReject = (error) => { cleanup(); reject(error); };
      this.pending = {
        method,
        resolve: wrappedResolve,
        reject: wrappedReject,
        maxBodyBytes,
        buffer: Buffer.alloc(0),
        head: null,
        chunks: [],
        received: 0,
        readUntilClose: false,
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      // Một lần ghi duy nhất cho header + body.
      this.socket.write(payload ? Buffer.concat([Buffer.from(head, "latin1"), payload]) : Buffer.from(head, "latin1"));
    });
  }

  onData(chunk) {
    const pending = this.pending;
    if (!pending) {
      // Dữ liệu không mong đợi khi rảnh → socket không còn tin cậy.
      this.socket?.destroy();
      return;
    }
    try {
      pending.buffer = pending.buffer.length ? Buffer.concat([pending.buffer, chunk]) : chunk;
      this.parse(pending);
    } catch (error) {
      this.pending = null;
      this.busy = false;
      this.socket?.destroy();
      pending.reject(error);
    }
  }

  parse(pending) {
    while (!pending.head) {
      const end = pending.buffer.indexOf(HEADER_END);
      if (end < 0) {
        if (pending.buffer.length > MAX_HEADER_BYTES) throw new Error("Response headers too large");
        return;
      }
      const lines = pending.buffer.subarray(0, end).toString("latin1").split(CRLF);
      pending.buffer = pending.buffer.subarray(end + 4);
      const match = /^HTTP\/1\.([01]) (\d{3})/.exec(lines[0]);
      if (!match) throw new Error(`Invalid HTTP status line: ${lines[0].slice(0, 80)}`);
      const statusCode = Number(match[2]);
      if (statusCode >= 100 && statusCode < 200) continue; // 100-continue, 103...
      const headers = {};
      for (const line of lines.slice(1)) {
        const index = line.indexOf(":");
        if (index <= 0) continue;
        const key = line.slice(0, index).trim().toLowerCase();
        const value = line.slice(index + 1).trim();
        if (key === "set-cookie") (headers[key] ??= []).push(value);
        else headers[key] = headers[key] === undefined ? value : `${headers[key]}, ${value}`;
      }
      const connectionHeader = String(headers.connection ?? "").toLowerCase();
      pending.head = {
        statusCode,
        headers,
        connectionClose: connectionHeader.includes("close") || (match[1] === "0" && !connectionHeader.includes("keep-alive")),
      };
      const noBody = pending.method === "HEAD" || statusCode === 204 || statusCode === 304;
      if (noBody) {
        pending.mode = "length";
        pending.remaining = 0;
      } else if (String(headers["transfer-encoding"] ?? "").toLowerCase().includes("chunked")) {
        pending.mode = "chunked";
        pending.chunkRemaining = -1;
      } else if (headers["content-length"] !== undefined) {
        const length = Number(headers["content-length"]);
        if (!Number.isSafeInteger(length) || length < 0) throw new Error("Invalid content-length");
        if (length > pending.maxBodyBytes) throw new Error(`Response body exceeds ${pending.maxBodyBytes} bytes`);
        pending.mode = "length";
        pending.remaining = length;
      } else {
        pending.mode = "close";
        pending.readUntilClose = true;
        pending.head.connectionClose = true;
      }
    }

    if (pending.mode === "length") {
      const take = Math.min(pending.remaining, pending.buffer.length);
      if (take) this.pushBody(pending, pending.buffer.subarray(0, take));
      pending.buffer = pending.buffer.subarray(take);
      pending.remaining -= take;
      if (pending.remaining === 0) this.finish(Buffer.concat(pending.chunks), pending.buffer.length > 0);
      return;
    }

    if (pending.mode === "close") {
      if (pending.buffer.length) this.pushBody(pending, pending.buffer);
      pending.buffer = Buffer.alloc(0);
      return;
    }

    // chunked
    while (true) {
      if (pending.chunkRemaining === -1) {
        const lineEnd = pending.buffer.indexOf(CRLF);
        if (lineEnd < 0) return;
        const size = parseInt(pending.buffer.subarray(0, lineEnd).toString("latin1").split(";")[0].trim(), 16);
        if (!Number.isFinite(size) || size < 0) throw new Error("Invalid chunk size");
        pending.buffer = pending.buffer.subarray(lineEnd + 2);
        if (size === 0) {
          pending.chunkRemaining = -2; // đọc trailer
        } else {
          pending.chunkRemaining = size;
        }
      }
      if (pending.chunkRemaining === -2) {
        const lineEnd = pending.buffer.indexOf(CRLF);
        if (lineEnd < 0) return;
        const isEmpty = lineEnd === 0;
        pending.buffer = pending.buffer.subarray(lineEnd + 2);
        if (isEmpty) {
          this.finish(Buffer.concat(pending.chunks), pending.buffer.length > 0);
          return;
        }
        continue;
      }
      if (pending.buffer.length < pending.chunkRemaining + 2) return;
      this.pushBody(pending, pending.buffer.subarray(0, pending.chunkRemaining));
      pending.buffer = pending.buffer.subarray(pending.chunkRemaining + 2);
      pending.chunkRemaining = -1;
    }
  }

  pushBody(pending, chunk) {
    pending.received += chunk.length;
    if (pending.received > pending.maxBodyBytes) throw new Error(`Response body exceeds ${pending.maxBodyBytes} bytes`);
    pending.chunks.push(Buffer.from(chunk));
  }

  finish(body, trailingBytes = false) {
    const pending = this.pending;
    this.pending = null;
    this.busy = false;
    const { statusCode, headers, connectionClose } = pending.head;
    if (connectionClose || trailingBytes || this.closeWhenIdle) this.socket?.destroy();
    pending.resolve({ statusCode, headers, body, connectionClose });
    if (this.closeWhenIdle) this.destroy();
  }

  /** Đóng khi request hiện tại (nếu có) hoàn tất. */
  close() {
    this.closed = true;
    if (this.busy) this.closeWhenIdle = true;
    else this.destroy();
    return Promise.resolve();
  }

  destroy() {
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
  }
}
