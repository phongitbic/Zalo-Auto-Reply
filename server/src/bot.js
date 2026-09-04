import fs from "node:fs/promises";
import path from "node:path";
import { LoginQRCallbackEventType, ThreadType, Zalo } from "zca-js";
import { RecentMessageCache } from "./recent-message-cache.js";
import { matchesPriorityLocation } from "./priority-locations.js";
import { getActiveLocations, summarizePriorityRoutes } from "./priority-routes.js";

const getMessageId = (message) =>
  message.data?.msgId ?? message.data?.cliMsgId ?? message.data?.globalMsgId;

const getTextContent = (message) => {
  const content = message?.data?.content;
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";
  return content.text ?? content.msg ?? content.body ?? "";
};

export const containsOkWord = (text) => /(^|[^a-z0-9])ok(?=$|[^a-z0-9])/i.test(String(text));

const getQuotePayload = (message) => {
  const data = message?.data;
  const msgId = data?.msgId ?? data?.cliMsgId ?? data?.globalMsgId ?? data?.id;
  if (!data || !msgId) return undefined;

  return {
    uidFrom: data.uidFrom ?? data.fromUid,
    msgId,
    cliMsgId: data.cliMsgId ?? msgId,
    ts: data.ts ?? data.timestamp,
    msgType: data.msgType ?? data.type ?? "text",
    content: data.content ?? "",
    ttl: data.ttl ?? 0,
  };
};

const getReplyPayload = (message, replyText, quote) => {
  const senderName = message?.data?.dName?.trim();
  const senderId = message?.data?.uidFrom;
  if (!senderName || !senderId) return quote ? { msg: replyText, quote } : replyText;

  const mentionText = `@${senderName}`;
  const msg = `${mentionText} ${replyText}`;
  return {
    msg,
    mentions: [{ pos: 0, uid: String(senderId), len: mentionText.length }],
    ...(quote ? { quote } : {}),
  };
};

export class ZaloReplyBot {
  constructor({
    allowedGroupIds,
    replyText,
    sessionFile,
    priorityOnly = false,
    priorityLocations = [],
    priorityRoutes = [],
    hotPathLogging = false,
    keepAliveIntervalMs = 15000,
    emit = () => {},
  }) {
    this.allowedGroupIds = allowedGroupIds;
    this.replyText = replyText;
    this.sessionFile = sessionFile;
    this.priorityOnly = priorityOnly;
    this.priorityRoutes = priorityRoutes;
    this.priorityLocations = priorityRoutes.length ? getActiveLocations(priorityRoutes) : priorityLocations;
    this.hotPathLogging = hotPathLogging;
    this.keepAliveIntervalMs = keepAliveIntervalMs;
    this.keepAliveTimer = null;
    this.keepAliveInFlight = false;
    this.emit = emit;
    this.api = null;
    this.enabled = true;
    this.status = "offline";
    this.stats = {
      received: 0,
      sent: 0,
      failed: 0,
      prioritySkipped: 0,
      lastDispatchMs: null,
      lastNetworkMs: null,
      lastLatencyMs: null,
    };
    this.seen = new RecentMessageCache();
  }

  snapshot() {
    return {
      enabled: this.enabled,
      status: this.status,
      groupsConfigured: this.allowedGroupIds.size,
      replyText: this.replyText,
      priorityOnly: this.priorityOnly,
      priorityLocationsConfigured: this.priorityLocations.length,
      priorityRoutes: summarizePriorityRoutes(this.priorityRoutes),
      stats: this.stats,
    };
  }

  publish() {
    this.emit("status", this.snapshot());
  }

  async start() {
    if (this.status === "connecting" || this.status === "online") return;
    this.status = "connecting";
    this.publish();

    try {
      // Update checks and library logs are unnecessary on the latency-sensitive bot process.
      const zalo = new Zalo({ logging: false, checkUpdate: false });
      this.api = await this.login(zalo);
      this.api.listener.on("message", (message) => this.onMessage(message));
      this.api.listener.on("connected", () => {
        this.status = "online";
        this.publish();
      });
      this.api.listener.on("disconnected", () => {
        this.status = "reconnecting";
        this.publish();
      });
      this.api.listener.on("closed", () => {
        this.status = "offline";
        this.publish();
      });
      this.api.listener.on("error", (error) => {
        console.error("ZCA listener error:", error);
        this.status = "error";
        this.publish();
      });
      this.api.listener.start({ retryOnClose: true });
      this.startKeepAlive();
    } catch (error) {
      this.status = "error";
      this.publish();
      throw error;
    }
  }

  startKeepAlive() {
    if (this.keepAliveTimer) return;

    const ping = async () => {
      if (!this.api || this.keepAliveInFlight) return;
      this.keepAliveInFlight = true;
      try {
        await this.api.keepAlive();
      } catch (error) {
        if (this.hotPathLogging) console.warn("Zalo keep-alive failed:", error.message);
      } finally {
        this.keepAliveInFlight = false;
      }
    };

    void ping();
    this.keepAliveTimer = setInterval(ping, this.keepAliveIntervalMs);
    this.keepAliveTimer.unref?.();
  }

  stopKeepAlive() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  async login(zalo) {
    try {
      const credentials = JSON.parse(await fs.readFile(this.sessionFile, "utf8"));
      console.log("Logging in with saved ZCA session");
      return await zalo.login(credentials);
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        console.warn("Saved session is invalid; switching to QR login:", error.message);
      }
    }

    return zalo.loginQR({ qrPath: "qr.png" }, async (event) => {
      if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
        await event.actions.saveToFile();
      }
      if (event.type === LoginQRCallbackEventType.QRCodeExpired) event.actions.retry();
      if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
        await fs.mkdir(path.dirname(this.sessionFile), { recursive: true });
        await fs.writeFile(this.sessionFile, JSON.stringify(event.data), { mode: 0o600 });
        console.log("ZCA session saved");
      }
    });
  }

  onMessage(message) {
    const receivedAt = performance.now();
    this.stats.received += 1;
    const threadId = String(message.threadId);

    if (!this.enabled || message.isSelf || message.type !== ThreadType.Group) return;
    if (!this.allowedGroupIds.has(threadId)) return;

    const incomingText = getTextContent(message).trim();
    if (containsOkWord(incomingText)) return;

    // Dedupe before text normalization and location scanning.
    const messageId = getMessageId(message);
    const dedupeKey = `${threadId}:${messageId ?? JSON.stringify(message.data)}`;
    if (this.seen.hasOrAdd(dedupeKey)) return;

    if (this.priorityOnly && !matchesPriorityLocation(incomingText, this.priorityLocations)) {
      this.stats.prioritySkipped += 1;
      return;
    }

    const quote = getQuotePayload(message);
    const payload = getReplyPayload(message, this.replyText, quote);
    const networkStartedAt = performance.now();

    // Calling the async function starts request preparation synchronously up to its first await.
    const sendPromise = this.api.sendMessage(payload, message.threadId, ThreadType.Group);
    this.stats.lastDispatchMs = Number((performance.now() - receivedAt).toFixed(3));

    sendPromise
      .then(() => {
        const completedAt = performance.now();
        this.stats.sent += 1;
        this.stats.lastNetworkMs = Math.round(completedAt - networkStartedAt);
        this.stats.lastLatencyMs = Math.round(completedAt - receivedAt);
        this.emit("activity", {
          groupId: threadId,
          dispatchMs: this.stats.lastDispatchMs,
          networkMs: this.stats.lastNetworkMs,
          latencyMs: this.stats.lastLatencyMs,
          at: new Date().toISOString(),
        });
        this.publish();
      })
      .catch((error) => {
        this.stats.failed += 1;
        console.error(`Send failed for group ${threadId}:`, error);
        this.publish();
      });

    if (this.hotPathLogging) {
      console.log(`Dispatched reply for group ${threadId} in ${this.stats.lastDispatchMs} ms`);
    }
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.publish();
  }

  setPriorityOnly(enabled) {
    this.priorityOnly = Boolean(enabled);
    this.publish();
  }

  setPriorityLocations(locations) {
    this.priorityLocations = [...locations];
    this.publish();
  }

  setPriorityRoutes(routes) {
    this.priorityRoutes = routes;
    this.priorityLocations = getActiveLocations(routes);
    this.publish();
  }
}
