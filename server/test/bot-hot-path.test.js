import assert from "node:assert/strict";
import test from "node:test";
import { ThreadType } from "zca-js";
import { containsOkWord, ZaloReplyBot } from "../src/bot.js";

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
