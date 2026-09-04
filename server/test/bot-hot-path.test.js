import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ThreadType } from "zca-js";
import { containsOkWord, ZaloReplyBot } from "../src/bot.js";
import { createPriorityRoute } from "../src/priority-routes.js";

const makeMessage = (overrides = {}) => ({
  threadId: "group-1",
  type: ThreadType.Group,
  isSelf: false,
  data: { msgId: "message-1", content: "Don khach tai Thu Duc" },
  ...overrides,
});

test("detects Ok as a standalone word anywhere in a message", () => {
  assert.equal(containsOkWord("Ok"), true);
  assert.equal(containsOkWord("OK nhan cuoc nhe"), true);
  assert.equal(containsOkWord("Da ok."), true);
  assert.equal(containsOkWord("booking"), false);
});

test("does not auto-reply to a message containing Ok", () => {
  let calls = 0;
  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(["group-1"]),
    replyText: "Ok",
    sessionFile: "unused",
  });
  bot.api = { sendMessage: () => { calls += 1; return Promise.resolve(); } };

  bot.onMessage(makeMessage({ data: { msgId: "message-ok", content: "OK co nguoi nhan roi" } }));
  assert.equal(calls, 0);
});

test("does not auto-reply to an empty or non-text message", () => {
  let calls = 0;
  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(["group-1"]),
    replyText: "Ok",
    sessionFile: "unused",
  });
  bot.api = { sendMessage: () => { calls += 1; return Promise.resolve(); } };

  bot.onMessage(makeMessage({ data: { msgId: "empty-message", content: "" } }));
  assert.equal(calls, 0);
});

test("dispatches an eligible reply synchronously without waiting for network completion", async () => {
  let calls = 0;
  let finishRequest;
  const pendingRequest = new Promise((resolve) => { finishRequest = resolve; });
  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(["group-1"]),
    replyText: "Ok",
    sessionFile: "unused",
  });
  bot.api = { sendMessage: () => { calls += 1; return pendingRequest; } };

  bot.onMessage(makeMessage());
  assert.equal(calls, 1);
  assert.equal(bot.stats.sent, 0);
  assert.equal(typeof bot.stats.lastDispatchMs, "number");

  finishRequest();
  await pendingRequest;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bot.stats.sent, 1);
});

test("quotes the message and mentions the sender before the reply", () => {
  let sentPayload;
  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(["group-1"]),
    replyText: "Ok",
    sessionFile: "unused",
  });
  bot.api = {
    sendMessage: (payload) => {
      sentPayload = payload;
      return Promise.resolve();
    },
  };

  bot.onMessage(makeMessage({
    data: {
      msgId: "message-with-sender",
      content: "Tpbn - cau giay 200k",
      uidFrom: "user-khanh",
      dName: "Khánh",
    },
  }));

  assert.equal(sentPayload.msg, "@Khánh Ok");
  assert.deepEqual(sentPayload.mentions, [
    { pos: 0, uid: "user-khanh", len: 6 },
  ]);
  assert.equal(sentPayload.quote.uidFrom, "user-khanh");
});

test("uses alternate sender fields when Zalo omits dName and uidFrom", () => {
  let sentPayload;
  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(["group-1"]),
    replyText: "Ok",
    sessionFile: "unused",
  });
  bot.api = { sendMessage: (payload) => { sentPayload = payload; return Promise.resolve(); } };

  bot.onMessage(makeMessage({
    data: {
      msgId: "alternate-sender",
      content: "Tpbn - cầu giấy 200k",
      fromUid: "user-khanh",
      displayName: "Khánh",
    },
  }));

  assert.equal(sentPayload.msg, "@Khánh Ok");
  assert.equal(sentPayload.mentions[0].uid, "user-khanh");
});

test("reports a synchronous send failure without throwing from the listener", () => {
  const events = [];
  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(["group-1"]),
    replyText: "Ok",
    sessionFile: "unused",
    emit: (event, payload) => events.push({ event, payload }),
  });
  bot.api = { sendMessage: () => { throw new Error("sync failure"); } };

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => bot.onMessage(makeMessage({ data: { msgId: "sync-failure", content: "Cầu Giấy" } })));
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(events.some((item) => item.event === "ORDER_ACCEPTED"), false);
  assert.equal(events.find((item) => item.event === "ORDER_FAILED")?.payload.error, "sync failure");
});

test("emits ORDER_ACCEPTED only after the reply succeeds", async () => {
  const events = [];
  let finishRequest;
  const pendingRequest = new Promise((resolve) => { finishRequest = resolve; });
  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(["group-1"]),
    replyText: "Ok",
    sessionFile: "unused",
    emit: (event, payload) => events.push({ event, payload }),
  });
  bot.api = { sendMessage: () => pendingRequest };

  bot.onMessage(makeMessage({ data: {
    msgId: "accepted-message",
    content: "Cầu Giấy 200k",
    uidFrom: "user-khanh",
    dName: "Khánh",
    groupName: "Nhóm tài xế",
  } }));
  assert.equal(events.some((item) => item.event === "ORDER_ACCEPTED"), false);

  bot.setPriorityOnly(true);
  finishRequest();
  await pendingRequest;
  await new Promise((resolve) => setImmediate(resolve));
  const accepted = events.find((item) => item.event === "ORDER_ACCEPTED")?.payload;
  assert.equal(accepted.messageId, "accepted-message");
  assert.equal(accepted.senderId, "user-khanh");
  assert.equal(accepted.senderName, "Khánh");
  assert.equal(accepted.originalContent, "Cầu Giấy 200k");
  assert.equal(accepted.mode, "all");
  assert.equal(accepted.status, "success");
});

test("deduplicates recently accepted messages restored after a restart", () => {
  let calls = 0;
  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(["group-1"]),
    replyText: "Ok",
    sessionFile: "unused",
    recentMessages: [{ groupId: "group-1", messageId: "restored-message", status: "success" }],
  });
  bot.api = { sendMessage: () => { calls += 1; return Promise.resolve(); } };

  bot.onMessage(makeMessage({ data: { msgId: "restored-message", content: "Cầu Giấy 200k" } }));
  assert.equal(calls, 0);
});

test("deduplicates before scanning priority locations", () => {
  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(["group-1"]),
    replyText: "Ok",
    sessionFile: "unused",
    priorityOnly: true,
    priorityLocations: ["thu duc"],
  });
  bot.api = { sendMessage: () => Promise.resolve() };
  const message = makeMessage({ data: { msgId: "duplicate", content: "Quan 7" } });

  bot.onMessage(message);
  bot.onMessage(message);
  assert.equal(bot.stats.prioritySkipped, 1);
});

test("starts one Zalo keep-alive request immediately without overlapping", async () => {
  let calls = 0;
  let finishRequest;
  const pendingRequest = new Promise((resolve) => { finishRequest = resolve; });
  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(),
    replyText: "Ok",
    sessionFile: "unused",
    keepAliveIntervalMs: 5000,
  });
  bot.api = { keepAlive: () => { calls += 1; return pendingRequest; } };

  bot.startKeepAlive();
  bot.startKeepAlive();
  assert.equal(calls, 1);

  bot.stopKeepAlive();
  finishRequest();
  await pendingRequest;
});

test("caps and reuses HTTP connections for sequential requests", async () => {
  const sockets = new Set();
  const server = http.createServer((_req, res) => res.end("ok"));
  server.on("connection", (socket) => sockets.add(socket));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(),
    replyText: "Ok",
    sessionFile: "unused",
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/group-message`;

  try {
    for (let index = 0; index < 8; index += 1) {
      const response = await bot.httpFetch(url, { method: "POST", body: "message=Ok" });
      await response.text();
    }

    assert.ok(sockets.size <= 4);
    assert.ok(sockets.size < 8);
  } finally {
    await bot.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("does not queue a reply behind another in-flight HTTP request", async () => {
  let firstResponse;
  let markSecondRequest;
  const secondRequestSeen = new Promise((resolve) => { markSecondRequest = resolve; });
  const server = http.createServer((_req, res) => {
    if (!firstResponse) {
      firstResponse = res;
      return;
    }
    res.end("second");
    markSecondRequest();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bot = new ZaloReplyBot({ allowedGroupIds: new Set(), replyText: "Ok", sessionFile: "unused" });
  const url = `http://127.0.0.1:${server.address().port}/group-message`;

  try {
    const first = bot.httpFetch(url, { method: "POST", body: "first" });
    const second = bot.httpFetch(url, { method: "POST", body: "second" });
    await Promise.race([
      secondRequestSeen,
      new Promise((_, reject) => setTimeout(() => reject(new Error("second request was queued")), 500)),
    ]);
    firstResponse.end("first");
    await (await first).text();
    await (await second).text();
  } finally {
    await bot.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("times out a stalled Zalo keep-alive request", async () => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(),
    replyText: "Ok",
    sessionFile: "unused",
    keepAliveRequestTimeoutMs: 20,
  });
  const { port } = server.address();

  try {
    await assert.rejects(bot.httpFetch(`http://127.0.0.1:${port}/keepalive`), {
      name: "TimeoutError",
    });
  } finally {
    await bot.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("reconnects after the Zalo listener closes permanently", async () => {
  let loginCalls = 0;
  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(),
    replyText: "Ok",
    sessionFile: "unused",
    keepAliveIntervalMs: 100000,
    reconnectBaseDelayMs: 1,
    reconnectMaxDelayMs: 1,
  });
  bot.login = async () => {
    loginCalls += 1;
    const callbacks = {};
    return {
      keepAlive: () => Promise.resolve(),
      listener: {
        on: (event, callback) => { callbacks[event] = callback; },
        start: () => {
          if (loginCalls === 1) setImmediate(() => callbacks.closed());
        },
        stop: () => {},
      },
    };
  };

  await bot.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(loginCalls, 2);
  await bot.stop();
});

test("retries when initial Zalo login fails", async () => {
  let loginCalls = 0;
  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(),
    replyText: "Ok",
    sessionFile: "unused",
    keepAliveIntervalMs: 100000,
    reconnectBaseDelayMs: 1,
    reconnectMaxDelayMs: 1,
  });
  bot.login = async () => {
    loginCalls += 1;
    if (loginCalls === 1) throw new Error("temporary login failure");
    return {
      keepAlive: () => Promise.resolve(),
      listener: { on: () => {}, start: () => {}, stop: () => {} },
    };
  };

  await assert.rejects(bot.start(), /temporary login failure/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(loginCalls, 2);
  await bot.stop();
});

const mandatoryRoutes = () => [
  createPriorityRoute({ id: "bn-hn", origin: "Bắc Ninh", destination: "Hà Nội", enabled: true, twoWay: true }),
  createPriorityRoute({ id: "bn-qn", origin: "Bắc Ninh", destination: "Quảng Ninh", enabled: false, twoWay: true }),
  createPriorityRoute({ id: "vc-cg", origin: "Võ Cường", destination: "Cầu Giấy", enabled: true, twoWay: true }),
];

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

test("ALL mode bypasses priority route status and accepts both mandatory trips", async () => {
  const decisions = [];
  let calls = 0;
  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(["group-1"]),
    replyText: "Ok",
    sessionFile: "unused",
    priorityRoutes: mandatoryRoutes(),
    emit: (event, payload) => { if (event === "decision") decisions.push(payload); },
  });
  bot.api = { sendMessage: () => { calls += 1; return Promise.resolve(); } };
  bot.onMessage(makeMessage({ data: { msgId: "all-1", content: "Bắc Ninh đi Hà Nội" } }));
  bot.onMessage(makeMessage({ data: { msgId: "all-2", content: "Bắc Ninh đi Quảng Ninh" } }));
  await flushPromises();
  assert.equal(calls, 2);
  assert.deepEqual(decisions.filter((item) => item.accepted).map((item) => item.reason), ["ACCEPTED_ALL", "ACCEPTED_ALL"]);
});

test("PRIORITY mode accepts forward and reverse directions of an enabled two-way route", async () => {
  const decisions = [];
  let calls = 0;
  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(["group-1"]), replyText: "Ok", sessionFile: "unused",
    priorityOnly: true, priorityRoutes: mandatoryRoutes(),
    emit: (event, payload) => { if (event === "decision") decisions.push(payload); },
  });
  bot.api = { sendMessage: () => { calls += 1; return Promise.resolve(); } };
  bot.onMessage(makeMessage({ data: { msgId: "priority-forward", content: "Bắc Ninh đi Hà Nội" } }));
  bot.onMessage(makeMessage({ data: { msgId: "priority-reverse", content: "Hà Nội về Bắc Ninh" } }));
  await flushPromises();
  assert.equal(calls, 2);
  assert.equal(decisions.filter((item) => item.reason === "ACCEPTED_PRIORITY").length, 2);
});

test("PRIORITY mode responds immediately to enabled changes without a restart", async () => {
  const decisions = [];
  let calls = 0;
  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(["group-1"]), replyText: "Ok", sessionFile: "unused",
    priorityOnly: true, priorityRoutes: mandatoryRoutes(),
    emit: (event, payload) => { if (event === "decision") decisions.push(payload); },
  });
  bot.api = { sendMessage: () => { calls += 1; return Promise.resolve(); } };
  bot.onMessage(makeMessage({ data: { msgId: "disabled-before", content: "Bắc Ninh đi Quảng Ninh" } }));
  assert.equal(decisions.at(-1).reason, "IGNORED_ROUTE_DISABLED");
  bot.setPriorityRoutes(mandatoryRoutes().map((item) => item.id === "bn-qn" ? { ...item, enabled: true } : item));
  bot.onMessage(makeMessage({ data: { msgId: "enabled-after", content: "Bắc Ninh đi Quảng Ninh" } }));
  await flushPromises();
  assert.equal(calls, 1);
  assert.equal(decisions.at(-1).reason, "ACCEPTED_PRIORITY");
  bot.setPriorityRoutes(mandatoryRoutes());
  bot.onMessage(makeMessage({ data: { msgId: "disabled-again", content: "Bắc Ninh đi Quảng Ninh" } }));
  assert.equal(decisions.at(-1).reason, "IGNORED_ROUTE_DISABLED");
});

test("PRIORITY mode rejects an unrelated pair and a reversed one-way route", () => {
  const decisions = [];
  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(["group-1"]), replyText: "Ok", sessionFile: "unused",
    priorityOnly: true,
    priorityRoutes: [createPriorityRoute({ id: "one-way", origin: "Bắc Ninh", destination: "Hà Nội", twoWay: false })],
    emit: (event, payload) => { if (event === "decision") decisions.push(payload); },
  });
  bot.api = { sendMessage: () => { throw new Error("must not send"); } };
  bot.onMessage(makeMessage({ data: { msgId: "wrong-way", content: "Hà Nội về Bắc Ninh" } }));
  bot.onMessage(makeMessage({ data: { msgId: "unrelated", content: "Hải Phòng đi Nam Định" } }));
  assert.deepEqual(decisions.map((item) => item.reason), ["IGNORED_WRONG_DIRECTION", "IGNORED_INVALID_MESSAGE"]);
});

test("a processed message is replied to and announced only once", async () => {
  const events = [];
  let calls = 0;
  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(["group-1"]), replyText: "Ok", sessionFile: "unused",
    emit: (event, payload) => events.push({ event, payload }),
  });
  bot.api = { sendMessage: () => { calls += 1; return Promise.resolve(); } };
  const message = makeMessage({ data: { msgId: "only-once", content: "Bắc Ninh đi Hà Nội" } });
  bot.onMessage(message);
  bot.onMessage(message);
  await flushPromises();
  assert.equal(calls, 1);
  assert.equal(events.filter((item) => item.event === "ORDER_ACCEPTED").length, 1);
  assert.equal(events.find((item) => item.payload.reason === "IGNORED_DUPLICATE")?.payload.accepted, false);
});

test("releases the in-memory dedupe reservation when sending fails", async () => {
  let calls = 0;
  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(["group-1"]), replyText: "Ok", sessionFile: "unused",
  });
  bot.api = { sendMessage: () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary failure");
    return Promise.resolve();
  } };
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const message = makeMessage({ data: { msgId: "retry-after-failure", content: "Bắc Ninh đi Hà Nội" } });
    bot.onMessage(message);
    bot.onMessage(message);
    await flushPromises();
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(calls, 2);
  assert.equal(bot.stats.sent, 1);
});

test("a Redis outage changes infrastructure status but never changes PRIORITY to ALL", () => {
  const bot = new ZaloReplyBot({
    allowedGroupIds: new Set(), replyText: "Ok", sessionFile: "unused",
    priorityOnly: true, priorityRoutes: mandatoryRoutes(),
  });
  bot.setInfrastructureStatus({ status: "error", connected: false, error: "offline" });
  assert.equal(bot.snapshot().operationMode, "PRIORITY");
  assert.equal(bot.snapshot().redis.connected, false);
});
