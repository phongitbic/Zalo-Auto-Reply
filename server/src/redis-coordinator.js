import { randomUUID } from "node:crypto";
import { createClient } from "redis";

const safeJson = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

const reconnectDelay = (retries) =>
  Math.min(100 * (2 ** Math.min(retries, 5)), 2000) + Math.floor(Math.random() * 100);

const safeRedisTarget = (url) => {
  try {
    const parsed = new URL(url);
    const database = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
    return `${parsed.protocol}//${parsed.host || `${parsed.hostname}:6379`}${database}`;
  } catch {
    return "configured";
  }
};

const safeError = (error, url) => {
  let message = error?.message ?? String(error);
  try {
    const parsed = new URL(url);
    for (const secret of [parsed.username, parsed.password]) {
      if (secret) message = message.replaceAll(secret, "***");
    }
  } catch {
    // The URL itself is validated by node-redis; keep its parse error useful.
  }
  return message;
};

export const encodeBotState = ({ enabled, mode }, updatedAt = new Date().toISOString()) => ({
  operationMode: enabled ? (mode === "priority" ? "PRIORITY" : "ALL") : "STOPPED",
  lastActiveMode: mode === "priority" ? "PRIORITY" : "ALL",
  updatedAt,
});

export const decodeBotState = (value, fallback) => {
  if (!value || !["STOPPED", "ALL", "PRIORITY"].includes(value.operationMode)) return fallback;
  const activeMode = value.operationMode === "STOPPED" ? value.lastActiveMode : value.operationMode;
  return {
    enabled: value.operationMode !== "STOPPED",
    mode: activeMode === "PRIORITY" ? "priority" : "all",
    updatedAt: value.updatedAt || null,
  };
};

export class RedisCoordinator {
  constructor({
    url,
    prefix = "zalo-auto-reply",
    channel = "priority_routes_updated",
    instanceId = `${process.pid}-${randomUUID()}`,
    getLocalConfig,
    onRemoteConfig = async () => {},
    onStatus = () => {},
    clientFactory = createClient,
    heartbeatMs = 15000,
    connectTimeoutMs = 5000,
    pingIntervalMs = 10000,
    processedTtlMs = 24 * 60 * 60 * 1000,
  }) {
    this.url = url;
    this.prefix = prefix;
    this.channel = channel;
    this.instanceId = instanceId;
    this.getLocalConfig = getLocalConfig;
    this.onRemoteConfig = onRemoteConfig;
    this.onStatus = onStatus;
    this.clientFactory = clientFactory;
    this.heartbeatMs = heartbeatMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.pingIntervalMs = pingIntervalMs;
    this.processedTtlMs = processedTtlMs;
    this.client = null;
    this.subscriber = null;
    this.subscriberSubscribed = false;
    this.subscriberOperational = false;
    this.heartbeatTimer = null;
    this.stopping = false;
    this.syncPromise = Promise.resolve();
    this.dirty = new Set();
    this.state = {
      status: url ? "disconnected" : "disabled",
      connected: false,
      commandConnected: false,
      subscriberConnected: false,
      server: url ? safeRedisTarget(url) : null,
      protocol: "RESP2",
      version: 0,
      lastSyncedAt: null,
      error: null,
      errorCode: null,
      lastErrorAt: null,
    };
    this.keys = {
      state: `${prefix}:bot:state`,
      routes: `${prefix}:priority:routes`,
      version: `${prefix}:priority:config_version`,
      processed: `${prefix}:processed:messages`,
      instance: `${prefix}:bot:instances:${instanceId}`,
    };
  }

  snapshot() {
    return { ...this.state };
  }

  updateStatus(patch) {
    const previous = JSON.stringify(this.state);
    this.state = { ...this.state, ...patch };
    if (JSON.stringify(this.state) !== previous) this.onStatus(this.snapshot());
  }

  async start() {
    if (!this.url || this.client || this.stopping) return;
    this.updateStatus({
      status: "connecting",
      connected: false,
      commandConnected: false,
      subscriberConnected: false,
      error: null,
      errorCode: null,
    });
    this.client = this.clientFactory({
      url: this.url,
      RESP: 2,
      pingInterval: this.pingIntervalMs,
      socket: {
        connectTimeout: this.connectTimeoutMs,
        keepAlive: true,
        noDelay: true,
        reconnectStrategy: reconnectDelay,
      },
    });
    this.subscriber = this.client.duplicate();
    this.bindCommandClientEvents(this.client);
    this.bindSubscriberEvents(this.subscriber);

    void this.client.connect()
      .catch((error) => this.handleError(error, "command"));
    void this.subscriber.connect()
      .then(() => this.subscriber.subscribe(this.channel, (message) => this.handlePublishedUpdate(message)))
      .then(() => {
        this.subscriberSubscribed = true;
        this.markSubscriberReady();
      })
      .catch((error) => this.handleError(error, "subscriber"));
  }

  bindCommandClientEvents(client) {
    client.on("ready", () => {
      this.updateStatus({
        status: this.subscriberOperational ? "ready" : "degraded",
        connected: true,
        commandConnected: true,
        subscriberConnected: this.subscriberOperational,
        error: null,
        errorCode: null,
      });
      void this.synchronize().catch((error) => this.handleError(error, "command"));
    });
    client.on("reconnecting", () => this.updateStatus({
      status: "reconnecting",
      connected: false,
      commandConnected: false,
    }));
    client.on("end", () => this.updateStatus({
      status: "disconnected",
      connected: false,
      commandConnected: false,
    }));
    client.on("error", (error) => this.handleError(error, "command"));
  }

  bindSubscriberEvents(subscriber) {
    subscriber.on("ready", () => {
      if (this.subscriberSubscribed) this.markSubscriberReady();
    });
    subscriber.on("reconnecting", () => this.markSubscriberUnavailable("reconnecting"));
    subscriber.on("end", () => this.markSubscriberUnavailable("disconnected"));
    subscriber.on("error", (error) => this.handleError(error, "subscriber"));
  }

  markSubscriberReady() {
    if (this.stopping) return;
    this.subscriberOperational = true;
    const commandConnected = Boolean(this.state.commandConnected && this.client?.isReady);
    this.updateStatus({
      status: commandConnected ? "ready" : this.state.status,
      connected: commandConnected,
      commandConnected,
      subscriberConnected: true,
      ...(commandConnected ? { error: null, errorCode: null } : {}),
    });
  }

  markSubscriberUnavailable(fallbackStatus) {
    if (this.stopping) return;
    this.subscriberOperational = false;
    const commandConnected = Boolean(this.state.commandConnected && this.client?.isReady);
    this.updateStatus({
      status: commandConnected ? "degraded" : fallbackStatus,
      connected: commandConnected,
      commandConnected,
      subscriberConnected: false,
    });
  }

  handleError(error, role = "command") {
    if (this.stopping) return;
    if (role === "subscriber") this.subscriberOperational = false;
    const commandConnected = role === "subscriber" &&
      Boolean(this.state.commandConnected && this.client?.isReady);
    this.updateStatus({
      status: commandConnected ? "degraded" : "error",
      connected: commandConnected,
      commandConnected,
      ...(role === "subscriber" ? { subscriberConnected: false } : {}),
      error: safeError(error, this.url),
      errorCode: error?.code ?? null,
      lastErrorAt: new Date().toISOString(),
    });
  }

  synchronize() {
    const operation = this.syncPromise.then(() => this.synchronizeNow());
    this.syncPromise = operation.catch(() => {});
    return operation;
  }

  async synchronizeNow() {
    if (!this.client?.isReady || this.stopping) return;
    const local = this.getLocalConfig();

    if (this.dirty.size) {
      const sections = [...this.dirty];
      this.dirty.clear();
      try {
        await this.writeConfiguration(local, sections);
      } catch (error) {
        sections.forEach((section) => this.dirty.add(section));
        throw error;
      }
    } else {
      await Promise.all([
        this.client.sendCommand(["SET", this.keys.state, JSON.stringify(encodeBotState(local.state)), "NX"]),
        this.client.sendCommand(["SET", this.keys.routes, JSON.stringify(local.routes), "NX"]),
        this.client.sendCommand(["SET", this.keys.version, "1", "NX"]),
      ]);
    }

    const [stateJson, routesJson, versionText, recentKeys] = await Promise.all([
      this.client.get(this.keys.state),
      this.client.get(this.keys.routes),
      this.client.get(this.keys.version),
      this.client.sendCommand([
        "ZRANGEBYSCORE",
        this.keys.processed,
        String(Date.now() - this.processedTtlMs),
        "+inf",
      ]),
    ]);
    const version = Number(versionText) || 1;
    await this.onRemoteConfig({
      state: decodeBotState(safeJson(stateJson, null), local.state),
      routes: safeJson(routesJson, local.routes),
      version,
      recentMessageKeys: Array.isArray(recentKeys) ? recentKeys : [],
    });
    this.updateStatus({
      status: this.subscriberOperational ? "ready" : "degraded",
      connected: true,
      commandConnected: true,
      subscriberConnected: this.subscriberOperational,
      version,
      lastSyncedAt: new Date().toISOString(),
      error: null,
      errorCode: null,
    });
    this.startHeartbeat();
  }

  async handlePublishedUpdate(message) {
    const payload = safeJson(message, {});
    const publishedVersion = Number(payload.version);
    if (Number.isFinite(publishedVersion) && publishedVersion <= this.state.version) return;
    await this.synchronize().catch((error) => this.handleError(error, "command"));
  }

  async writeConfiguration(local, sections) {
    if (!this.client?.isReady) throw new Error("Redis chưa kết nối.");
    const transaction = this.client.multi();
    if (sections.includes("state")) {
      transaction.set(this.keys.state, JSON.stringify(encodeBotState(local.state)));
    }
    if (sections.includes("routes")) transaction.set(this.keys.routes, JSON.stringify(local.routes));
    transaction.incr(this.keys.version);
    const replies = await transaction.exec();
    const version = Number(replies.at(-1)) || this.state.version + 1;
    await this.client.publish(this.channel, JSON.stringify({
      sections,
      version,
      sourceId: this.instanceId,
    }));
    this.updateStatus({
      status: this.subscriberOperational ? "ready" : "degraded",
      connected: true,
      commandConnected: true,
      subscriberConnected: this.subscriberOperational,
      version,
      lastSyncedAt: new Date().toISOString(),
      error: null,
      errorCode: null,
    });
    return version;
  }

  async saveConfiguration(sections) {
    const uniqueSections = [...new Set(sections)].filter((section) => ["state", "routes"].includes(section));
    if (!this.client?.isReady) {
      uniqueSections.forEach((section) => this.dirty.add(section));
      return { persisted: false, pending: true, version: this.state.version };
    }
    try {
      const version = await this.writeConfiguration(this.getLocalConfig(), uniqueSections);
      return { persisted: true, pending: false, version };
    } catch (error) {
      uniqueSections.forEach((section) => this.dirty.add(section));
      this.handleError(error, "command");
      return { persisted: false, pending: true, version: this.state.version, error: error.message };
    }
  }

  async recordProcessed(groupId, messageId) {
    if (!this.client?.isReady || !groupId || !messageId) return false;
    const now = Date.now();
    try {
      await Promise.all([
        this.client.sendCommand(["ZADD", this.keys.processed, String(now), `${groupId}:${messageId}`]),
        this.client.sendCommand([
          "ZREMRANGEBYSCORE",
          this.keys.processed,
          "-inf",
          String(now - this.processedTtlMs),
        ]),
      ]);
      return true;
    } catch (error) {
      this.handleError(error, "command");
      return false;
    }
  }

  startHeartbeat() {
    if (this.heartbeatTimer) return;
    const beat = async () => {
      if (!this.client?.isReady) return;
      try {
        const instance = JSON.stringify({
          instanceId: this.instanceId,
          pid: process.pid,
          updatedAt: new Date().toISOString(),
        });
        const [, versionText] = await Promise.all([
          this.client.sendCommand(["SET", this.keys.instance, instance, "EX", "45"]),
          this.client.get(this.keys.version),
        ]);
        if ((Number(versionText) || 0) > this.state.version) await this.synchronize();
      } catch (error) {
        this.handleError(error, "command");
      }
    };
    void beat();
    this.heartbeatTimer = setInterval(beat, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  async stop() {
    this.stopping = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.client?.isReady) await this.client.del(this.keys.instance).catch(() => {});
    await Promise.all([
      this.subscriber?.isOpen ? this.subscriber.close().catch(() => {}) : null,
      this.client?.isOpen ? this.client.close().catch(() => {}) : null,
    ]);
    this.updateStatus({
      status: "disconnected",
      connected: false,
      commandConnected: false,
      subscriberConnected: false,
    });
    this.subscriberOperational = false;
  }
}
