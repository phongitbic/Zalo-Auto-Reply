import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { decodeBotState, encodeBotState, RedisCoordinator } from "../src/redis-coordinator.js";

test("encodes the three official modes and preserves the selected mode while stopped", () => {
  assert.equal(encodeBotState({ enabled: true, mode: "all" }).operationMode, "ALL");
  assert.equal(encodeBotState({ enabled: true, mode: "priority" }).operationMode, "PRIORITY");
  const stopped = encodeBotState({ enabled: false, mode: "priority" }, "now");
  assert.equal(stopped.operationMode, "STOPPED");
  assert.deepEqual(decodeBotState(stopped, null), { enabled: false, mode: "priority", updatedAt: "now" });
});

test("queues local configuration for resync when Redis is unavailable", async () => {
  const local = { state: { enabled: true, mode: "priority" }, routes: [] };
  const coordinator = new RedisCoordinator({
    url: "redis://unavailable",
    getLocalConfig: () => local,
  });
  const result = await coordinator.saveConfiguration(["routes", "state"]);
  assert.equal(result.pending, true);
  assert.deepEqual([...coordinator.dirty].sort(), ["routes", "state"]);
  assert.equal(local.state.mode, "priority");
});

class FakeRedisBackend {
  constructor() {
    this.values = new Map();
    this.sortedSets = new Map();
    this.subscribers = new Map();
  }
}

class FakeRedisClient extends EventEmitter {
  constructor(backend) {
    super();
    this.backend = backend;
    this.isOpen = false;
    this.isReady = false;
  }

  duplicate() { return new FakeRedisClient(this.backend); }
  async connect() {
    this.isOpen = true;
    this.isReady = true;
    queueMicrotask(() => this.emit("ready"));
  }
  async close() { this.isReady = false; this.isOpen = false; }
  async get(key) { return this.backend.values.get(key) ?? null; }
  async set(key, value) { this.backend.values.set(key, String(value)); return "OK"; }
  async del(key) { return this.backend.values.delete(key) ? 1 : 0; }
  async subscribe(channel, callback) {
    const callbacks = this.backend.subscribers.get(channel) ?? new Set();
    callbacks.add(callback);
    this.backend.subscribers.set(channel, callbacks);
  }
  async publish(channel, message) {
    for (const callback of this.backend.subscribers.get(channel) ?? []) callback(message);
    return this.backend.subscribers.get(channel)?.size ?? 0;
  }
  async sendCommand(parts) {
    const [command, key, value, option] = parts;
    if (command === "SET") {
      if (option === "NX" && this.backend.values.has(key)) return null;
      this.backend.values.set(key, String(value));
      return "OK";
    }
    if (command === "ZRANGEBYSCORE") return [...(this.backend.sortedSets.get(key) ?? new Map()).keys()];
    if (command === "ZADD") {
      const set = this.backend.sortedSets.get(key) ?? new Map();
      set.set(parts[3], Number(parts[2]));
      this.backend.sortedSets.set(key, set);
      return 1;
    }
    if (command === "ZREMRANGEBYSCORE") return 0;
    throw new Error(`Unsupported fake command: ${command}`);
  }
  multi() {
    const operations = [];
    return {
      set: (key, value) => { operations.push(["set", key, value]); return this; },
      incr: (key) => { operations.push(["incr", key]); return this; },
      exec: async () => operations.map(([command, key, value]) => {
        if (command === "set") {
          this.backend.values.set(key, String(value));
          return "OK";
        }
        const next = Number(this.backend.values.get(key) ?? 0) + 1;
        this.backend.values.set(key, String(next));
        return next;
      }),
    };
  }
}

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for synchronized configuration");
};

test("Pub/Sub and config version synchronize a route change to every bot process", async () => {
  const backend = new FakeRedisBackend();
  const first = { state: { enabled: true, mode: "priority" }, routes: [] };
  const second = { state: { enabled: true, mode: "priority" }, routes: [] };
  const makeCoordinator = (local, instanceId) => new RedisCoordinator({
    url: "redis://fake",
    instanceId,
    heartbeatMs: 60000,
    clientFactory: () => new FakeRedisClient(backend),
    getLocalConfig: () => local,
    onRemoteConfig: async (remote) => {
      local.state = remote.state;
      local.routes = remote.routes;
    },
  });
  const processOne = makeCoordinator(first, "process-one");
  const processTwo = makeCoordinator(second, "process-two");
  await Promise.all([processOne.start(), processTwo.start()]);
  await waitFor(() => processOne.snapshot().connected && processTwo.snapshot().connected);

  first.routes = [{ id: "route-synced", origin: "Bắc Ninh", destination: "Hà Nội" }];
  const save = await processOne.saveConfiguration(["routes"]);
  assert.equal(save.persisted, true);
  await waitFor(() => second.routes[0]?.id === "route-synced");
  assert.ok(processTwo.snapshot().version >= save.version);

  await Promise.all([processOne.stop(), processTwo.stop()]);
});

test("keeps command health online when only the Pub/Sub connection drops", async () => {
  const backend = new FakeRedisBackend();
  const local = { state: { enabled: true, mode: "priority" }, routes: [] };
  let clientOptions;
  let syncCount = 0;
  const coordinator = new RedisCoordinator({
    url: "redis://user:secret@127.0.0.1:6379/2",
    heartbeatMs: 60000,
    connectTimeoutMs: 4321,
    pingIntervalMs: 8765,
    clientFactory: (options) => {
      clientOptions = options;
      return new FakeRedisClient(backend);
    },
    getLocalConfig: () => local,
    onRemoteConfig: async () => { syncCount += 1; },
  });

  await coordinator.start();
  await waitFor(() => syncCount === 1 && coordinator.snapshot().subscriberConnected);
  assert.equal(syncCount, 1);
  assert.equal(clientOptions.RESP, 2);
  assert.equal(clientOptions.socket.connectTimeout, 4321);
  assert.equal(clientOptions.socket.keepAlive, true);
  assert.equal(clientOptions.socket.noDelay, true);
  assert.equal(clientOptions.pingInterval, 8765);
  assert.ok(clientOptions.socket.reconnectStrategy(20) <= 2099);
  assert.equal(coordinator.snapshot().server, "redis://127.0.0.1:6379/2");
  assert.equal(coordinator.snapshot().protocol, "RESP2");

  const outage = Object.assign(new Error("subscriber unavailable"), { code: "ECONNRESET" });
  coordinator.subscriber.emit("error", outage);
  assert.equal(coordinator.snapshot().connected, true);
  assert.equal(coordinator.snapshot().commandConnected, true);
  assert.equal(coordinator.snapshot().subscriberConnected, false);
  assert.equal(coordinator.snapshot().status, "degraded");
  assert.equal(coordinator.snapshot().errorCode, "ECONNRESET");

  coordinator.subscriber.emit("ready");
  assert.equal(coordinator.snapshot().status, "ready");
  assert.equal(coordinator.snapshot().subscriberConnected, true);
  await coordinator.stop();
});
