import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { io as createSocket } from "socket.io-client";
import { createPriorityRoute } from "../src/priority-routes.js";

const isBun = Boolean(process.versions.bun);

const waitForSocket = (socket, event) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 3000);
  socket.once(event, (...args) => {
    clearTimeout(timer);
    resolve(args);
  });
});

test("Bun/Elysia preserves the HTTP and Socket.IO contracts", { skip: !isBun }, async () => {
  const { createBunApp, MAX_REQUEST_BODY_SIZE } = await import("../src/bun-app.js");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zalo-bun-server-"));
  const adminKey = "a".repeat(32);
  const clientDist = path.join(directory, "client-dist");
  await fs.mkdir(path.join(clientDist, "assets"), { recursive: true });
  await fs.writeFile(path.join(clientDist, "index.html"), "<!doctype html><title>test</title>");
  await fs.writeFile(path.join(clientDist, "assets", "app.js"), "console.log('test')");
  const initialRoute = createPriorityRoute({
    id: "route-initial",
    origin: "Bắc Ninh",
    destination: "Hà Nội",
  });
  const config = {
    port: 0,
    clientOrigins: ["http://localhost:5173", "capacitor://localhost"],
    replyText: "Ok",
    autoStart: false,
    adminKey,
    sessionFile: path.join(directory, "session.json"),
    qrFile: path.join(directory, "qr.png"),
    allowedGroupIds: new Set(["group-1"]),
    enabled: true,
    priorityOnly: false,
    priorityRoutes: [initialRoute],
    hotPathLogging: false,
    keepAliveIntervalMs: 15000,
    botState: { enabled: true, mode: "all" },
    botStateFile: path.join(directory, "bot-state.json"),
    maxSocketConnections: 1,
    priorityRoutesFile: path.join(directory, "priority-routes.json"),
    redisUrl: "",
    redisPrefix: "test",
    redisChannel: "test-updated",
    redisHeartbeatMs: 15000,
    redisConnectTimeoutMs: 5000,
    redisPingIntervalMs: 10000,
  };
  const { app, runtime, realtime } = createBunApp(config, { clientDist });
  app.listen({ port: 0, ...realtime.handler(), maxRequestBodySize: MAX_REQUEST_BODY_SIZE });
  const baseUrl = `http://127.0.0.1:${app.server.port}`;
  const headers = { authorization: `Bearer ${adminKey}`, "content-type": "application/json" };
  const request = (endpoint, options = {}) => fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  let socket;

  try {
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/status`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/status`, {
      headers: { "x-admin-key": adminKey },
    })).status, 200);
    const corsResponse = await fetch(`${baseUrl}/api/status`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
      },
    });
    assert.equal(corsResponse.headers.get("access-control-allow-origin"), "http://localhost:5173");

    const bootstrapResponse = await request("/api/bootstrap");
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = await bootstrapResponse.json();
    assert.equal(bootstrap.status.operationMode, "ALL");
    assert.equal(bootstrap.orders, undefined);
    const removedOrdersResponse = await request("/api/orders?limit=1");
    assert.doesNotMatch(removedOrdersResponse.headers.get("content-type") || "", /application\/json/i);
    assert.equal((await request("/api/zalo/qr")).status, 404);
    assert.equal((await request("/api/bot/control", {
      method: "POST",
      body: JSON.stringify({ action: "invalid" }),
    })).status, 400);
    assert.equal((await request("/api/bot/enabled", { method: "POST", body: undefined })).status, 500);
    assert.equal((await request("/api/bot/priority-only", { method: "POST", body: undefined })).status, 500);

    const stopped = await request("/api/bot/enabled", {
      method: "POST",
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json()).operationMode, "STOPPED");
    const priority = await request("/api/bot/control", {
      method: "POST",
      body: JSON.stringify({ action: "start", mode: "priority" }),
    });
    assert.equal(priority.status, 200);
    assert.equal((await priority.json()).operationMode, "PRIORITY");

    const preview = await request("/api/settings/priority-routes/preview", {
      method: "POST",
      body: JSON.stringify({ fileName: "routes.txt", content: "Võ Cường | Cầu Giấy" }),
    });
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).preview.newRouteCount, 1);
    assert.equal((await request("/api/settings/priority-routes/preview", {
      method: "POST",
      body: JSON.stringify({ fileName: "routes.csv", content: "A | B" }),
    })).status, 400);
    assert.equal((await request("/api/settings/priority-routes/preview", {
      method: "POST",
      body: JSON.stringify({ fileName: "routes.txt", content: "x".repeat(1024 * 1024) }),
    })).status, 413);
    const oversizedStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({
          fileName: "routes.txt",
          content: "x".repeat(1024 * 1024),
        })));
        controller.close();
      },
    });
    assert.equal((await request("/api/settings/priority-routes/preview", {
      method: "POST",
      body: oversizedStream,
    })).status, 413);

    const imported = await request("/api/settings/priority-routes/import", {
      method: "POST",
      body: JSON.stringify({ fileName: "routes.txt", content: "Võ Cường | Cầu Giấy" }),
    });
    assert.equal(imported.status, 201);
    assert.equal((await imported.json()).import.added, 1);

    const created = await request("/api/settings/priority-routes", {
      method: "POST",
      body: JSON.stringify({
        origin: "Hải Phòng",
        destination: "Quảng Ninh",
        prices: ["200k"],
        excludedKeywords: ["chó", "mèo"],
      }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    const createdRoute = createdBody.priorityRoutes.find((route) => route.origin === "Hải Phòng");
    assert.ok(createdRoute?.id);
    assert.deepEqual(createdRoute.prices, ["200k"]);
    assert.deepEqual(createdRoute.excludedKeywords, ["chó", "mèo"]);
    const reverseCreated = await request("/api/settings/priority-routes", {
      method: "POST",
      body: JSON.stringify({ origin: "Quảng Ninh", destination: "Hải Phòng" }),
    });
    assert.equal(reverseCreated.status, 201);
    assert.equal((await request("/api/settings/priority-routes", {
      method: "POST",
      body: JSON.stringify({ origin: "Hải Phòng", destination: "Quảng Ninh" }),
    })).status, 400);
    assert.equal((await request("/api/settings/priority-routes", {
      method: "POST",
      body: JSON.stringify({ origin: "Hải Phòng" }),
    })).status, 400);

    assert.equal((await request(`/api/settings/priority-routes/${createdRoute.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    })).status, 200);
    assert.equal((await request("/api/settings/priority-routes/missing", {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    })).status, 404);
    assert.equal((await request("/api/settings/priority-routes", {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    })).status, 200);

    const exported = await request("/api/settings/priority-routes/export");
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-disposition"), /^attachment;/);
    assert.equal((await exported.json()).routes.length, 4);
    assert.equal((await request(`/api/settings/priority-routes/${createdRoute.id}`, {
      method: "DELETE",
    })).status, 200);
    assert.equal((await request(`/api/settings/priority-routes/${createdRoute.id}`, {
      method: "DELETE",
    })).status, 404);

    socket = createSocket(baseUrl, {
      auth: { token: adminKey },
      transports: ["websocket"],
      reconnection: false,
      timeout: 3000,
    });
    let ordersReceived = false;
    socket.on("orders", () => { ordersReceived = true; });
    const statusPromise = waitForSocket(socket, "status");
    const statusArgs = await statusPromise;
    assert.equal(statusArgs[0].operationMode, "PRIORITY");
    await Bun.sleep(50);
    assert.equal(ordersReceived, false);

    const acceptedPromise = waitForSocket(socket, "ORDER_ACCEPTED");
    realtime.broadcast("ORDER_ACCEPTED", { eventId: "event-live", status: "success" });
    assert.equal((await acceptedPromise)[0].eventId, "event-live");

    const overLimit = createSocket(baseUrl, {
      auth: { token: adminKey },
      transports: ["websocket"],
      reconnection: false,
      timeout: 3000,
    });
    const [limitError] = await waitForSocket(overLimit, "connect_error");
    assert.equal(limitError.message, "Too many connections");
    overLimit.disconnect();

    socket.disconnect();

    const rejected = createSocket(baseUrl, {
      auth: { token: "invalid" },
      transports: ["websocket"],
      reconnection: false,
      timeout: 3000,
    });
    const [authError] = await waitForSocket(rejected, "connect_error");
    assert.equal(authError.message, "Unauthorized");
    rejected.disconnect();

    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>test<\/title>/);
    const asset = await fetch(`${baseUrl}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), "console.log('test')");
  } finally {
    socket?.disconnect();
    await realtime.close();
    await Promise.all([runtime.stop(), app.stop()]);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
