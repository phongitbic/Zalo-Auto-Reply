import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LoginQRCallbackEventType, ThreadType, Zalo } from "zca-js";
import { RecentMessageCache } from "./recent-message-cache.js";
import {
  compilePriorityRoutes,
  getPriorityRouteStats,
  matchPriorityRoute,
  normalizeLocation,
  summarizePriorityRoutes,
} from "./priority-routes.js";
import { config } from "./config.js";

const getMessageId = (message) =>
  message.data?.msgId ?? message.data?.cliMsgId ?? message.data?.globalMsgId;

const getTextContent = (message) => {
  const content = message?.data?.content;
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";
  return content.text ?? content.msg ?? content.body ?? "";
};

const getSenderId = (message) => message?.data?.uidFrom ?? message?.data?.fromUid;
const getSenderName = (message) => {
  const value = [message?.data?.dName, message?.data?.displayName, message?.data?.senderName]
    .find((item) => typeof item === "string" && item.trim());
  return value?.trim() ?? "";
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

const getReplyPayload = (senderName, senderId, replyText, quote) => {
  if (!senderName || !senderId) return quote ? { msg: replyText, quote } : replyText;

  const mentionText = `@${senderName}`;
  const msg = `${mentionText} ${replyText}`;
  return {
    msg,
    mentions: [{ pos: 0, uid: String(senderId), len: mentionText.length }],
    ...(quote ? { quote } : {}),
  };
};

const getGroupName = (message, threadId) =>
  message?.data?.groupName ?? message?.data?.groupTopic ?? `Nhóm ${threadId}`;

export class ZaloReplyBot {
  constructor({
    allowedGroupIds,
    replyText,
    sessionFile,
    qrFile,
    enabled = true,
    priorityOnly = false,
    priorityRoutes = [],
    hotPathLogging = false,
    keepAliveIntervalMs = 5000,
    groupPreconnectIntervalMs = 1000,
    keepAliveRequestTimeoutMs = 5000,
    httpRequestTimeoutMs = 30000,
    reconnectBaseDelayMs = 1000,
    reconnectMaxDelayMs = 30000,
    recentMessages = [],
    configUpdatedAt = null,
    preconnect = typeof fetch.preconnect === "function" ? fetch.preconnect.bind(fetch) : null,
    emit = () => { },
  }) {
    this.allowedGroupIds = allowedGroupIds;
    this.replyText = replyText;
    this.sessionFile = sessionFile;
    this.qrFile = qrFile;
    this.priorityOnly = priorityOnly;
    this.priorityRoutes = priorityRoutes;
    this.compiledPriorityRoutes = compilePriorityRoutes(priorityRoutes);
    this.hotPathLogging = hotPathLogging;
    this.keepAliveIntervalMs = keepAliveIntervalMs;
    this.groupPreconnectIntervalMs = groupPreconnectIntervalMs;
    this.keepAliveRequestTimeoutMs = keepAliveRequestTimeoutMs;
    this.httpRequestTimeoutMs = httpRequestTimeoutMs;
    this.keepAliveTimer = null;
    this.keepAliveInFlight = false;
    this.groupPreconnectTimer = null;
    this.groupServiceOrigin = null;
    this.groupWarmUpInFlight = false;
    this.lastGroupActivityAt = 0;
    this.preconnect = preconnect;
    this.reconnectBaseDelayMs = reconnectBaseDelayMs;
    this.reconnectMaxDelayMs = reconnectMaxDelayMs;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.shuttingDown = false;
    this.httpFetch = (url, options = {}) => {
      const { agent: _unusedAgent, dispatcher: _unusedDispatcher, ...fetchOptions } = options;
      const timeoutMs = String(url).includes("/keepalive")
        ? this.keepAliveRequestTimeoutMs
        : this.httpRequestTimeoutMs;
      return fetch(url, {
        ...fetchOptions,
        keepalive: true,
        signal: fetchOptions.signal ?? AbortSignal.timeout(timeoutMs),
      });
    };
    this.emit = emit;
    this.api = null;
    this.enabled = enabled;
    this.qrAvailable = false;
    this.status = "offline";
    this.stats = {
      received: 0,
      sent: 0,
      failed: 0,
      prioritySkipped: 0,
      lastNormalizationMs: null,
      lastRouteMatchMs: null,
      lastDispatchMs: null,
      lastNetworkMs: null,
      lastLatencyMs: null,
    };
    this.redis = { status: "disabled", connected: false, version: 0, lastSyncedAt: null, error: null };
    this.configUpdatedAt = configUpdatedAt;
    this.seen = new RecentMessageCache();
    for (const item of recentMessages) {
      if (item?.groupId && item?.messageId) {
        this.seen.hasOrAdd(`${item.groupId}:${item.messageId}`);
      }
    }
    this.groupNames = new Map();
  }

  snapshot() {
    const priorityRouteStats = getPriorityRouteStats(this.priorityRoutes);
    return {
      enabled: this.enabled,
      status: this.status,
      groupsConfigured: this.allowedGroupIds.size,
      replyText: this.replyText,
      mode: this.priorityOnly ? "priority" : "all",
      acceptanceState: this.enabled ? "running" : "stopped",
      operationMode: this.enabled ? (this.priorityOnly ? "PRIORITY" : "ALL") : "STOPPED",
      qrAvailable: this.qrAvailable,
      priorityOnly: this.priorityOnly,
      priorityRoutes: summarizePriorityRoutes(this.priorityRoutes),
      priorityRouteStats,
      redis: this.redis,
      configUpdatedAt: this.configUpdatedAt,
      stats: this.stats,
    };
  }

  publish() {
    this.emit("status", this.snapshot());
  }

  publishStats() {
    this.emit("stats", { ...this.stats });
  }

  async start() {
    if (this.shuttingDown) return;
    if (this.status === "connecting" || this.status === "online") return;
    this.status = "connecting";
    this.publish();

    try {
      const zalo = new Zalo({
        logging: false,
        checkUpdate: false,
        polyfill: this.httpFetch,
        agent: config.proxyAgent,
      });
      const api = await this.login(zalo);
      if (this.shuttingDown) return;
      this.stopKeepAlive();
      this.stopGroupPreconnect();
      this.keepAliveInFlight = false;
      this.api = api;
      this.groupServiceOrigin = null;
      api.listener.on("message", (message) => this.onMessage(message));
      api.listener.on("connected", () => {
        if (api !== this.api) return;
        this.reconnectAttempts = 0;
        this.qrAvailable = false;
        this.status = "online";
        this.publish();
        void this.refreshGroupNames();
      });
      api.listener.on("disconnected", () => {
        if (api !== this.api || this.shuttingDown) return;
        this.status = "reconnecting";
        this.publish();
      });
      api.listener.on("closed", () => {
        if (api !== this.api || this.shuttingDown) return;
        this.status = "offline";
        this.publish();
        this.scheduleReconnect();
      });
      api.listener.on("error", (error) => {
        if (api !== this.api || this.shuttingDown) return;
        console.error("ZCA listener error:", error);
        this.status = "error";
        this.publish();
      });
      this.startGroupPreconnect();
      api.listener.start({ retryOnClose: true });
      this.startKeepAlive();
    } catch (error) {
      this.status = "error";
      this.publish();
      this.scheduleReconnect();
      throw error;
    }
  }

  scheduleReconnect() {
    if (this.shuttingDown || this.reconnectTimer) return;

    const delay = Math.min(
      this.reconnectBaseDelayMs * (2 ** this.reconnectAttempts),
      this.reconnectMaxDelayMs
    );
    this.reconnectAttempts += 1;
    this.status = "reconnecting";
    this.publish();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch((error) => console.error("Zalo reconnect failed:", error.message));
    }, delay);
    this.reconnectTimer.unref?.();
  }

  startKeepAlive() {
    if (this.keepAliveTimer) return;

    const ping = async () => {
      const api = this.api;
      if (!api || this.keepAliveInFlight) return;
      this.keepAliveInFlight = true;
      try {
        await api.keepAlive();
      } catch (error) {
        if (this.hotPathLogging) console.warn("Zalo keep-alive failed:", error.message);
      } finally {
        if (api === this.api) this.keepAliveInFlight = false;
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

  preconnectGroupTransport() {
    try {
      if (!this.groupServiceOrigin) {
        const groupServiceUrl = this.api?.zpwServiceMap?.group?.[0];
        if (!groupServiceUrl) return false;
        this.groupServiceOrigin = new URL(groupServiceUrl).origin;
      }
      if (this.preconnect) {
        try {
          this.preconnect(this.groupServiceOrigin);
        } catch (_) { }
      }
      return true;
    } catch (error) {
      if (this.hotPathLogging) console.warn("Zalo group preconnect failed:", error.message);
      return false;
    }
  }

  startGroupPreconnect() {
    if (this.groupPreconnectTimer || !this.preconnectGroupTransport()) return;

    const warmUp = async () => {
      this.preconnectGroupTransport();
      if (this.groupWarmUpInFlight || !this.groupServiceOrigin) return;

      // Option A1 (Adaptive): Tạm dừng nếu vừa có hoạt động nhắn tin trong 3 giây qua
      if (performance.now() - this.lastGroupActivityAt < 3000) return;

      this.groupWarmUpInFlight = true;
      try {
        await this.httpFetch(`${this.groupServiceOrigin}/`, {
          method: "HEAD",
          signal: AbortSignal.timeout(2500),
        });
      } catch (error) {
        if (this.hotPathLogging) console.warn("Zalo group warm-up failed:", error.message);
      } finally {
        this.groupWarmUpInFlight = false;
      }
    };

    this.groupPreconnectTimer = setInterval(warmUp, this.groupPreconnectIntervalMs);
    this.groupPreconnectTimer.unref?.();
  }

  stopGroupPreconnect() {
    if (this.groupPreconnectTimer) clearInterval(this.groupPreconnectTimer);
    this.groupPreconnectTimer = null;
    this.groupWarmUpInFlight = false;
  }

  async stop() {
    this.shuttingDown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopKeepAlive();
    this.stopGroupPreconnect();

    const api = this.api;
    this.api = null;
    this.groupServiceOrigin = null;
    if (api?.listener) api.listener.stop();
    this.status = "offline";
    this.publish();
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

    await fs.mkdir(path.dirname(this.qrFile), { recursive: true });
    return zalo.loginQR({ qrPath: this.qrFile }, async (event) => {
      if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
        await event.actions.saveToFile();
        await fs.chmod(this.qrFile, 0o600).catch(() => { });
        this.qrAvailable = true;
        this.status = "qr_required";
        this.emit("qr", { available: true, updatedAt: new Date().toISOString() });
        this.publish();
      }
      if (event.type === LoginQRCallbackEventType.QRCodeExpired) event.actions.retry();
      if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
        await fs.mkdir(path.dirname(this.sessionFile), { recursive: true });
        const tempSessionFile = `${this.sessionFile}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(tempSessionFile, JSON.stringify(event.data), { mode: 0o600 });
          await fs.rename(tempSessionFile, this.sessionFile);
          await fs.chmod(this.sessionFile, 0o600).catch(() => { });
        } finally {
          await fs.unlink(tempSessionFile).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
        this.qrAvailable = false;
        await fs.unlink(this.qrFile).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        console.log("ZCA session saved");
      }
    });
  }

  async refreshGroupNames() {
    if (!this.api || this.allowedGroupIds.size === 0) return;
    try {
      const response = await this.api.getGroupInfo([...this.allowedGroupIds]);
      for (const [groupId, group] of Object.entries(response.gridInfoMap ?? {})) {
        if (group?.name) this.groupNames.set(String(groupId), group.name);
      }
    } catch (error) {
      if (this.hotPathLogging) console.warn("Loading Zalo group names failed:", error.message);
    }
  }

  onMessage(message) {
    const receivedAt = performance.now();
    this.lastGroupActivityAt = receivedAt;
    const receivedAtIso = new Date().toISOString();
    this.stats.received += 1;
    const threadId = String(message.threadId);

    if (message.isSelf || message.type !== ThreadType.Group) return;
    if (!this.allowedGroupIds.has(threadId)) return;

    const messageId = getMessageId(message);
    const decisionBase = {
      messageId: messageId ? String(messageId) : null,
      groupId: threadId,
      senderId: getSenderId(message) ? String(getSenderId(message)) : null,
      senderName: getSenderName(message),
      receivedAt: receivedAtIso,
    };
    if (!this.enabled) {
      this.emit("decision", { ...decisionBase, accepted: false, reason: "IGNORED_BOT_STOPPED" });
      return;
    }
    if (!messageId) {
      this.emit("decision", { ...decisionBase, accepted: false, reason: "IGNORED_INVALID_MESSAGE" });
      return;
    }

    const dedupeKey = `${threadId}:${messageId}`;
    if (this.seen.hasOrAdd(dedupeKey)) {
      this.emit("decision", { ...decisionBase, accepted: false, reason: "IGNORED_DUPLICATE" });
      return;
    }

    const incomingText = getTextContent(message).trim();
    if (!incomingText) {
      this.emit("decision", { ...decisionBase, accepted: false, reason: "IGNORED_INVALID_MESSAGE" });
      return;
    }
    if (containsOkWord(incomingText)) {
      this.emit("decision", { ...decisionBase, accepted: false, reason: "IGNORED_INVALID_MESSAGE" });
      return;
    }

    const acceptanceMode = this.priorityOnly ? "priority" : "all";
    let matchedRoute = null;
    let acceptedReason = "ACCEPTED_ALL";
    let normalizationMs = 0;
    let routeMatchMs = 0;
    if (acceptanceMode === "priority") {
      const normalizationStartedAt = performance.now();
      const normalizedMessage = normalizeLocation(incomingText);
      normalizationMs = Number((performance.now() - normalizationStartedAt).toFixed(3));
      const routeMatchStartedAt = performance.now();
      const result = matchPriorityRoute(normalizedMessage, this.compiledPriorityRoutes);
      routeMatchMs = Number((performance.now() - routeMatchStartedAt).toFixed(3));
      this.stats.lastNormalizationMs = normalizationMs;
      this.stats.lastRouteMatchMs = routeMatchMs;
      if (!result.accepted) {
        this.stats.prioritySkipped += 1;
        this.emit("decision", {
          ...decisionBase,
          accepted: false,
          reason: result.reason,
          matchedRoute: result.route ? `${result.route.origin} → ${result.route.destination}` : null,
          timings: { normalizationMs, routeMatchMs },
        });
        return;
      }
      acceptedReason = result.reason;
      matchedRoute = `${result.route.origin} → ${result.route.destination}`;
    }

    const quote = getQuotePayload(message);
    const payload = getReplyPayload(
      decisionBase.senderName,
      decisionBase.senderId,
      this.replyText,
      quote
    );
    const networkStartedAt = performance.now();

    // Calling the async function starts request preparation synchronously up to its first await.
    const reportFailure = (error) => {
      this.seen.delete(dedupeKey);
      this.stats.failed += 1;
      console.error(`Send failed for group ${threadId}:`, error);
      this.emit("ORDER_FAILED", {
        eventId: randomUUID(),
        ...decisionBase,
        groupName: this.groupNames.get(threadId) ?? getGroupName(message, threadId),
        originalContent: incomingText,
        mode: acceptanceMode,
        matchedRoute,
        failedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - receivedAt),
        status: "failed",
        error: error?.message ?? String(error),
      });
      this.emit("decision", { ...decisionBase, accepted: false, reason: "SEND_FAILED", matchedRoute });
      this.publishStats();
    };

    let sendPromise;
    try {
      this.preconnectGroupTransport();
      sendPromise = Promise.resolve(this.api.sendMessage(payload, message.threadId, ThreadType.Group));
    } catch (error) {
      reportFailure(error);
      return;
    }
    const dispatchMs = Number((performance.now() - receivedAt).toFixed(3));
    this.stats.lastDispatchMs = dispatchMs;

    sendPromise
      .then(() => {
        const completedAt = performance.now();
        const networkMs = Number((completedAt - networkStartedAt).toFixed(3));
        const latencyMs = Number((completedAt - receivedAt).toFixed(3));
        this.stats.sent += 1;
        this.stats.lastNetworkMs = networkMs;
        this.stats.lastLatencyMs = latencyMs;
        const order = {
          eventId: randomUUID(),
          messageId: decisionBase.messageId,
          orderId: message?.data?.orderId ?? null,
          groupId: threadId,
          groupName: this.groupNames.get(threadId) ?? getGroupName(message, threadId),
          senderId: decisionBase.senderId,
          senderName: decisionBase.senderName,
          originalContent: incomingText,
          mode: acceptanceMode,
          matchedRoute,
          receivedAt: receivedAtIso,
          processingStartedAt: receivedAtIso,
          sentAt: new Date().toISOString(),
          dispatchMs,
          normalizationMs,
          routeMatchMs,
          networkMs,
          totalMs: latencyMs,
          latencyMs,
          status: "success",
        };
        this.emit("ORDER_ACCEPTED", order);
        this.emit("decision", {
          ...decisionBase,
          accepted: true,
          reason: acceptedReason,
          matchedRoute,
          timings: { normalizationMs, routeMatchMs, dispatchMs, networkMs, totalMs: latencyMs },
        });
        this.publishStats();
      })
      .catch(reportFailure);

    if (this.hotPathLogging) {
      console.log(`Dispatched reply for group ${threadId} in ${dispatchMs} ms`);
    }
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.configUpdatedAt = new Date().toISOString();
    this.publish();
  }

  setPriorityOnly(enabled) {
    this.priorityOnly = Boolean(enabled);
    this.configUpdatedAt = new Date().toISOString();
    this.publish();
  }

  setMode(mode) {
    if (!["all", "priority"].includes(mode)) throw new Error("Invalid acceptance mode");
    this.priorityOnly = mode === "priority";
    this.configUpdatedAt = new Date().toISOString();
    this.publish();
  }

  setControl({
    enabled = this.enabled,
    mode = this.priorityOnly ? "priority" : "all",
    updatedAt = new Date().toISOString(),
  }) {
    if (!["all", "priority"].includes(mode)) throw new Error("Invalid acceptance mode");
    this.enabled = Boolean(enabled);
    this.priorityOnly = mode === "priority";
    this.configUpdatedAt = updatedAt;
    this.publish();
  }

  setPriorityRoutes(routes) {
    this.priorityRoutes = routes;
    this.compiledPriorityRoutes = compilePriorityRoutes(routes);
    this.configUpdatedAt = new Date().toISOString();
    this.publish();
  }

  seedRecentMessages(items = []) {
    for (const item of items) {
      const key = typeof item === "string"
        ? item
        : item?.groupId && item?.messageId
          ? `${item.groupId}:${item.messageId}`
          : null;
      if (key) this.seen.hasOrAdd(key);
    }
  }

  setInfrastructureStatus(redis) {
    this.redis = { ...this.redis, ...redis };
    this.emit("redis", { ...this.redis });
  }
}
