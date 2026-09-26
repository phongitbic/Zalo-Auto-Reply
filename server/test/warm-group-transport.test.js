import assert from "node:assert/strict";
import net from "node:net";
import zlib from "node:zlib";
import test from "node:test";
import { WarmGroupTransport } from "../src/warm-group-transport.js";
import { ThreadType } from "zca-js";
import { ZaloReplyBot } from "../src/bot.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(5);
  }
};

// Máy chủ HTTP/1.1 tối giản để kiểm soát chính xác từng socket (giống máy chủ Zalo đóng kết nối).
const createRawServer = async ({ getDelayMs = 0, getBody = "x", postHandler } = {}) => {
  const sockets = new Map();
  const requests = [];
  let nextId = 0;
  let activeGets = 0;
  let maxActiveGets = 0;
  const server = net.createServer((socket) => {
    const id = ++nextId;
    sockets.set(id, socket);
    socket.on("close", () => sockets.delete(id));
    socket.on("error", () => { });
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const head = buffer.subarray(0, headerEnd).toString();
        const length = Number(head.match(/content-length:\s*(\d+)/i)?.[1] ?? 0);
        if (buffer.length < headerEnd + 4 + length) return;
        const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString();
        buffer = buffer.subarray(headerEnd + 4 + length);
        const [method, path] = head.split(" ");
        const headers = Object.fromEntries(head.split("\r\n").slice(1).map((line) => {
          const index = line.indexOf(":");
          return [line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()];
        }));
        requests.push({ method, path, socket: id, body, headers });
        if (method === "GET") {
          activeGets += 1;
          maxActiveGets = Math.max(maxActiveGets, activeGets);
          const payload = Buffer.from(getBody);
          setTimeout(() => {
            activeGets -= 1;
            if (!socket.destroyed) {
              socket.write(`HTTP/1.1 206 Partial Content\r\nContent-Length: ${payload.length}\r\n\r\n`);
              socket.write(payload);
            }
          }, getDelayMs);
        } else {
          const response = postHandler?.({ path, body, headers }) ?? { body: "ok" };
          const payload = Buffer.from(response.body);
          const extra = (response.headers ?? []).map(([key, value]) => `${key}: ${value}\r\n`).join("");
          socket.write(`HTTP/1.1 ${response.status ?? 200} OK\r\n${extra}Content-Length: ${payload.length}\r\n\r\n`);
          socket.write(payload);
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    sockets,
    get connectionCount() { return nextId; },
    get maxActiveGets() { return maxActiveGets; },
    close: () => {
      for (const socket of sockets.values()) socket.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
};

test("YC1: opens 2 connections at login and keeps re-warming the same live sockets", async () => {
  const server = await createRawServer();
  const stats = {};
  const transport = new WarmGroupTransport({ origin: server.origin, warmIntervalMs: 80, stats });
  try {
    transport.start();
    await waitFor(() => stats.groupConnectionsReady === 2);
    await sleep(400);
    const gets = server.requests.filter((item) => item.method === "GET");
    assert.ok(gets.length >= 6, `expected repeated warm-ups, got ${gets.length}`);
    assert.equal(server.connectionCount, 2, "live sockets must be reused, not reopened");
    assert.deepEqual(new Set(gets.map((item) => item.socket)), new Set([1, 2]));
    assert.equal(stats.groupWarmUpFailures ?? 0, 0);
  } finally {
    transport.close();
    await server.close();
  }
});

test("YC2: a socket closed by Zalo is reopened and warmed immediately, not on the next cycle", async () => {
  const server = await createRawServer();
  const stats = {};
  const transport = new WarmGroupTransport({ origin: server.origin, warmIntervalMs: 60_000, stats });
  try {
    transport.start();
    await waitFor(() => stats.groupConnectionsReady === 2);
    const closedAt = performance.now();
    server.sockets.get(1).destroy();
    await waitFor(() => server.connectionCount === 3 && stats.groupConnectionsReady === 2, 1000);
    const recoveryMs = performance.now() - closedAt;
    assert.ok(recoveryMs < 500, `re-warm took ${recoveryMs} ms`);
    assert.equal(stats.groupReconnects, 1);
    assert.equal(server.requests.at(-1).method, "GET");
    assert.equal(server.requests.at(-1).socket, 3);

    // Cuốc ngay sau đó đi trên socket đã nóng, không mở socket mới.
    const response = await transport.request(`${server.origin}/api/group/sendmsg`, { method: "POST", body: "m=Ok" });
    await response.text();
    assert.equal(server.connectionCount, 3);
    assert.equal(stats.lastSendConnectionWarm, true);
  } finally {
    transport.close();
    await server.close();
  }
});

test("YC2: backs off instead of spinning when Zalo keeps refusing", async () => {
  const server = await createRawServer();
  const origin = server.origin;
  await server.close();
  const stats = {};
  const transport = new WarmGroupTransport({
    origin,
    warmIntervalMs: 60_000,
    reconnectDelaysMs: [0, 100, 400],
    stats,
  });
  try {
    transport.start();
    await sleep(350);
    // Mỗi kết nối: lần đầu + 0ms + 100ms (+ lần 400ms chưa tới) → không vượt quá ~3 lượt/kết nối.
    assert.ok(stats.groupWarmUpFailures >= 2 && stats.groupWarmUpFailures <= 8, `failures=${stats.groupWarmUpFailures}`);
    assert.equal(stats.groupConnectionsReady, 0);
  } finally {
    transport.close();
  }
});

test("YC3: an order during a warm-up uses the other warm socket and never aborts the warm-up", async () => {
  const server = await createRawServer({ getDelayMs: 150 });
  const stats = {};
  const transport = new WarmGroupTransport({ origin: server.origin, warmIntervalMs: 60_000, stats });
  try {
    transport.start();
    await waitFor(() => stats.groupConnectionsReady === 2 && (stats.groupWarmUpSuccesses ?? 0) === 2);

    const [slotA] = transport.slots;
    const warmUp = transport.warm(slotA);
    await sleep(20);
    assert.equal(slotA.warming, true);

    const startedAt = performance.now();
    const response = await transport.request(`${server.origin}/api/group/mention`, { method: "POST", body: "m=Ok" });
    await response.text();
    const sendMs = performance.now() - startedAt;

    assert.equal(await warmUp, true, "warm-up must finish, not be aborted");
    assert.equal(server.connectionCount, 2, "order must not open a cold connection");
    const post = server.requests.find((item) => item.method === "POST");
    assert.equal(post.socket, 2);
    assert.ok(sendMs < 100, `order waited behind warm-up: ${sendMs} ms`);
    assert.equal(stats.warmSends, 1);
    assert.equal(stats.coldSends, 0);
  } finally {
    transport.close();
    await server.close();
  }
});

test("YC3: background ticks never warm two connections at the same time", async () => {
  const server = await createRawServer({ getDelayMs: 40 });
  const stats = {};
  const transport = new WarmGroupTransport({ origin: server.origin, warmIntervalMs: 60, stats });
  try {
    transport.start();
    await waitFor(() => (stats.groupWarmUpSuccesses ?? 0) >= 2);
    const baseline = server.requests.length;
    let overlap = 0;
    for (let index = 0; index < 60; index += 1) {
      if (transport.slots.every((slot) => slot.warming)) overlap += 1;
      await sleep(5);
    }
    assert.ok(server.requests.length > baseline, "ticks must keep warming");
    assert.equal(overlap, 0);
  } finally {
    transport.close();
    await server.close();
  }
});

test("converts Zalo responses for zca-js: cookies, gzip, form body, no zstd", async () => {
  const server = await createRawServer({
    postHandler: ({ body, headers }) => {
      assert.equal(body, "params=abc%3D%3D");
      assert.equal(headers["content-type"], "application/x-www-form-urlencoded");
      assert.ok(!headers["accept-encoding"].includes("zstd"));
      return {
        body: zlib.gzipSync(JSON.stringify({ error_code: 0, data: "ok" })),
        headers: [["Content-Encoding", "gzip"], ["Set-Cookie", "a=1; Path=/"], ["Set-Cookie", "b=2; Path=/"]],
      };
    },
  });
  const transport = new WarmGroupTransport({ origin: server.origin, warmIntervalMs: 60_000 });
  try {
    transport.start();
    const response = await transport.request(`${server.origin}/api/group/quote?zpw_ver=1`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "Accept-Encoding": "gzip, deflate, br, zstd",
      },
      body: new URLSearchParams({ params: "abc==" }),
    });
    assert.equal(response.ok, true);
    assert.deepEqual(response.headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"]);
    assert.ok(response.headers.get("set-cookie").includes("a=1"));
    assert.deepEqual(await response.json(), { error_code: 0, data: "ok" });
    assert.equal(server.requests.find((item) => item.method === "POST").path, "/api/group/quote?zpw_ver=1");
  } finally {
    transport.close();
    await server.close();
  }
});

test("only handles group send paths on the group origin", () => {
  const transport = new WarmGroupTransport({ origin: "https://tt-group-wpa.chat.zalo.me/api/group" });
  assert.equal(transport.handles("https://tt-group-wpa.chat.zalo.me/api/group/sendmsg?zpw_ver=1"), true);
  assert.equal(transport.handles("https://tt-group-wpa.chat.zalo.me/api/group/mention"), true);
  assert.equal(transport.handles("https://tt-group-wpa.chat.zalo.me/api/group/quote"), true);
  assert.equal(transport.handles("https://tt-group-wpa.chat.zalo.me/api/group/getmg-v2"), false);
  assert.equal(transport.handles("https://other.zalo.me/api/group/sendmsg"), false);
});

test("rejects an unexpectedly large warm-up response", async () => {
  const server = await createRawServer({ getBody: "x".repeat(64 * 1024 + 1) });
  const stats = {};
  const transport = new WarmGroupTransport({ origin: server.origin, warmIntervalMs: 60_000, reconnectDelaysMs: [60_000], stats });
  try {
    transport.start();
    await waitFor(() => (stats.groupWarmUpFailures ?? 0) === 2);
    assert.equal(stats.groupWarmUpSuccesses ?? 0, 0);
  } finally {
    transport.close();
    await server.close();
  }
});

test("close stops warming and reconnecting", async () => {
  const server = await createRawServer();
  const stats = {};
  const transport = new WarmGroupTransport({ origin: server.origin, warmIntervalMs: 40, stats });
  transport.start();
  await waitFor(() => stats.groupConnectionsReady === 2);
  transport.close();
  await sleep(30);
  const count = server.requests.length;
  const connections = server.connectionCount;
  await sleep(150);
  assert.equal(server.requests.length, count);
  assert.equal(server.connectionCount, connections);
  await server.close();
});

test("end-to-end: a bot order goes out on a connection warmed at login", async () => {
  const server = await createRawServer();
  let sent;
  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(["group-1"]),
    replyText: "Ok",
    sessionFile: "unused",
    groupPreconnectIntervalMs: 60_000,
  });
  bot.api = {
    zpwServiceMap: { group: [`${server.origin}/api/group`] },
    sendMessage: () => {
      sent = bot.httpFetch(`${server.origin}/api/group/mention?zpw_ver=1`, {
        method: "POST",
        body: new URLSearchParams({ params: "x" }),
      }).then((response) => response.text());
      return sent;
    },
  };
  try {
    bot.startGroupPreconnect();
    await waitFor(() => bot.stats.groupConnectionsReady === 2);
    bot.onMessage({
      threadId: "group-1",
      type: ThreadType.Group,
      isSelf: false,
      data: { msgId: "e2e", uidFrom: "u1", dName: "Khach", content: "Bac Ninh di Ha Noi 200k" },
    });
    assert.equal(await sent, "ok");
    assert.equal(server.connectionCount, 2);
    assert.equal(bot.stats.warmSends, 1);
    assert.equal(bot.stats.coldSends, 0);
  } finally {
    bot.stopGroupPreconnect();
    await server.close();
  }
});
