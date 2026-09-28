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
import { WarmGroupTransport } from "./warm-group-transport.js";

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

const getOrderDedupeKey = (senderId, text) => {
  if (!senderId) return null;
  return `${senderId}\u0000${text}`;
};

const buildReplyPayload = (message, senderName, senderId, replyText) => {
  const data = message?.data;
  const msgId = data?.msgId ?? data?.cliMsgId ?? data?.globalMsgId ?? data?.id;
  const quote = data && msgId
    ? {
      uidFrom: data.uidFrom ?? data.fromUid,
      msgId,
      cliMsgId: data.cliMsgId ?? msgId,
      ts: data.ts ?? data.timestamp,
      msgType: data.msgType ?? data.type ?? "text",
      content: data.content ?? "",
      ttl: data.ttl ?? 0,
    }
    : undefined;

  if (!senderName || !senderId) return quote ? { msg: replyText, quote } : replyText;

  const mentionText = `@${senderName}`;
  const payload = {
    msg: `${mentionText} ${replyText}`,
    mentions: [{ pos: 0, uid: String(senderId), len: mentionText.length }],
  };
  if (quote) payload.quote = quote;
  return payload;
};

const getGroupName = (message, threadId) =>
  message?.data?.groupName ?? message?.data?.groupTopic ?? `Nhóm ${threadId}`;

const loadGroupInfoMap = async (api, groupIds) => {
  const groupsById = {};
  for (let index = 0; index < groupIds.length; index += 20) {
    const batch = groupIds.slice(index, index + 20);
    try {
      const details = await api.getGroupInfo(batch);
      Object.assign(groupsById, details.gridInfoMap ?? {});
    } catch (cause) {
      throw new Error(`Không lấy được tên nhóm ở lô ${Math.floor(index / 20) + 1}: ${cause.message}`, { cause });
    }
  }
  return groupsById;
};

export class ZaloReplyBot {
  constructor({
    allowedGroupIds,
    replyText,
    sessionFile,
    qrFile,
    enabled = true,
    activeOrder = null,
    priorityOnly = false,
    priorityRoutes = [],
    hotPathLogging = false,
    keepAliveIntervalMs = 5000,
    groupPreconnectIntervalMs = 5000,
    groupConnections = 2,
    groupWarmUpTimeoutMs = 3000,
    createGroupTransport = (options) => new WarmGroupTransport(options),
    keepAliveRequestTimeoutMs = 5000,
    httpRequestTimeoutMs = 30000,
    reconnectBaseDelayMs = 1000,
    reconnectMaxDelayMs = 30000,
    recentMessages = [],
    configUpdatedAt = null,
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
    this.groupConnections = groupConnections;
    this.groupWarmUpTimeoutMs = groupWarmUpTimeoutMs;
    this.createGroupTransport = createGroupTransport;
    this.groupTransport = null;
    this.groupTransportRetryTimer = null;
    this.groupServiceOrigin = null;
    this.reconnectBaseDelayMs = reconnectBaseDelayMs;
    this.reconnectMaxDelayMs = reconnectMaxDelayMs;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.shuttingDown = false;
    this.httpFetch = (url, options = {}) => {
      // Lệnh gửi tin nhóm → kết nối nóng riêng. Khi zca-js truyền proxy (đang test) thì giữ nguyên
      // đường fetch cũ để không đổi hành vi proxy.
      if (!options.proxy && this.groupTransport?.handles(url)) {
        return this.groupTransport.request(url, options);
      }
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
    this.activeOrder = activeOrder && typeof activeOrder === "object" ? activeOrder : null;
    this.enabled = Boolean(enabled) && !this.activeOrder;
    this.orderInFlight = false;
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
      lastGroupWarmUpAt: null,
      lastGroupWarmUpMs: null,
      lastGroupWarmUpStatus: null,
      groupWarmUpSuccesses: 0,
      groupWarmUpFailures: 0,
      groupConnections: 0,
      groupConnectionsReady: 0,
      groupReconnects: 0,
      warmSends: 0,
      coldSends: 0,
      lastSendConnectionWarm: null,
    };
    this.redis = { status: "disabled", connected: false, version: 0, lastSyncedAt: null, error: null };
    this.configUpdatedAt = configUpdatedAt;
    this.seen = new RecentMessageCache();
    this.recentOrders = new RecentMessageCache(10_000);
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
      activeOrder: this.activeOrder,
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

  startGroupPreconnect() {
    if (this.groupTransport || this.shuttingDown) return;
    const groupServiceUrl = this.api?.zpwServiceMap?.group?.[0];
    if (!groupServiceUrl) {
      // Chưa có service map (hiếm) → thử lại thay vì bỏ hẳn việc giữ nóng.
      if (this.api && !this.groupTransportRetryTimer) {
        this.groupTransportRetryTimer = setTimeout(() => {
          this.groupTransportRetryTimer = null;
          this.startGroupPreconnect();
        }, 1000);
        this.groupTransportRetryTimer.unref?.();
      }
      return;
    }
    try {
      this.groupServiceOrigin = new URL(groupServiceUrl).origin;
      this.groupTransport = this.createGroupTransport({
        origin: this.groupServiceOrigin,
        connections: this.groupConnections,
        warmIntervalMs: this.groupPreconnectIntervalMs,
        warmTimeoutMs: this.groupWarmUpTimeoutMs,
        requestTimeoutMs: this.httpRequestTimeoutMs,
        stats: this.stats,
        logger: this.hotPathLogging ? console : null,
      });
      this.groupTransport.start();
    } catch (error) {
      this.groupTransport = null;
      console.error("Starting warm group transport failed:", error.message);
    }
  }

  stopGroupPreconnect() {
    if (this.groupTransportRetryTimer) clearTimeout(this.groupTransportRetryTimer);
    this.groupTransportRetryTimer = null;
    const transport = this.groupTransport;
    this.groupTransport = null;
    transport?.close();
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
      const groupsById = await loadGroupInfoMap(this.api, [...this.allowedGroupIds]);
      for (const [groupId, group] of Object.entries(groupsById)) {
        if (group?.name) this.groupNames.set(String(groupId), group.name);
      }
    } catch (error) {
      if (this.hotPathLogging) console.warn("Loading Zalo group names failed:", error.message);
    }
  }

  configuredGroups() {
    return [...this.allowedGroupIds]
      .map((id) => ({ id, name: this.groupNames.get(id) ?? `Nhóm ${id}` }))
      .sort((left, right) => left.name.localeCompare(right.name, "vi"));
  }

  async listZaloGroups() {
    if (!this.api) {
      const error = new Error("Zalo chưa đăng nhập.");
      error.code = "ZALO_OFFLINE";
      throw error;
    }
    let response;
    try {
      response = await this.api.getAllGroups();
    } catch (cause) {
      throw new Error(`Không lấy được ID nhóm: ${cause.message}`, { cause });
    }
    const groupIds = Object.keys(response.gridVerMap ?? {});
    if (groupIds.length === 0) return [];
    const groupsById = await loadGroupInfoMap(this.api, groupIds);
    const groups = groupIds.map((id) => {
      const group = groupsById[id];
      const name = group?.name || this.groupNames.get(id) || `Nhóm ${id}`;
      this.groupNames.set(id, name);
      return { id, name };
    });
    return groups.sort((left, right) => left.name.localeCompare(right.name, "vi"));
  }

  onMessage(message) {
    const receivedAt = performance.now();
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

    if (this.orderInFlight) {
      this.emit("decision", { ...decisionBase, accepted: false, reason: "IGNORED_ORDER_IN_PROGRESS" });
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
          matchedRoute: result.route?.title ?? null,
          timings: { normalizationMs, routeMatchMs },
        });
        return;
      }
      acceptedReason = result.reason;
      matchedRoute = result.route.title;
    }

    const orderDedupeKey = getOrderDedupeKey(decisionBase.senderId, incomingText);
    if (orderDedupeKey && this.recentOrders.hasOrAdd(orderDedupeKey)) {
      this.emit("decision", {
        ...decisionBase,
        accepted: false,
        reason: "IGNORED_DUPLICATE_ORDER",
        matchedRoute,
      });
      return;
    }

    const payload = buildReplyPayload(
      message,
      decisionBase.senderName,
      decisionBase.senderId,
      this.replyText
    );
    this.orderInFlight = true;
    const networkStartedAt = performance.now();

    // Calling the async function starts request preparation synchronously up to its first await.
    const reportFailure = (error) => {
      this.orderInFlight = false;
      this.seen.delete(dedupeKey);
      if (orderDedupeKey) this.recentOrders.delete(orderDedupeKey);
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
      // Không hủy/không dùng cuốc để làm nóng: groupTransport tự chọn kết nối đã nóng và đang rảnh.
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
        this.orderInFlight = false;
        this.activeOrder = order;
        this.enabled = false;
        this.configUpdatedAt = order.sentAt;
        this.publish();
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
    this.enabled = Boolean(enabled) && !this.activeOrder;
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
    activeOrder = this.activeOrder,
    updatedAt = new Date().toISOString(),
  }) {
    if (!["all", "priority"].includes(mode)) throw new Error("Invalid acceptance mode");
    this.activeOrder = activeOrder && typeof activeOrder === "object" ? activeOrder : null;
    this.enabled = Boolean(enabled) && !this.activeOrder;
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

  setAllowedGroupIds(groupIds) {
    this.allowedGroupIds = new Set(groupIds);
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
