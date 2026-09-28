import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";
import { ThreadType } from "zca-js";
import { ZaloReplyBot } from "../src/bot.js";
import { buildGroupQuoteParams, FastGroupSender } from "../src/fast-sender.js";

const KEY = crypto.randomBytes(32);
const IV = Buffer.alloc(16);
const encrypt = (text) => {
  const cipher = crypto.createCipheriv("aes-256-cbc", KEY, IV);
  return Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("base64");
};
const decrypt = (base64) => {
  const decipher = crypto.createDecipheriv("aes-256-cbc", KEY, IV);
  return Buffer.concat([decipher.update(Buffer.from(base64, "base64")), decipher.final()]).toString("utf8");
};

const payload = {
  msg: "@Taxi Hoàng Nam Ok",
  mentions: [{ pos: 0, uid: "111", len: 15 }],
  quote: {
    uidFrom: "111",
    msgId: "8314031960288",
    cliMsgId: "1790000000000",
    ts: "1790586000000",
    msgType: "webchat",
    content: "Luôn tpbn đi san bay t2 xe đag tpbn nhận 350k",
    ttl: 0,
  },
};

const makeApi = (groupBase) => ({
  zpwServiceMap: { group: [groupBase] },
  getContext: () => ({
    secretKey: KEY.toString("base64"),
    userAgent: "UA-test",
    API_VERSION: 671,
    API_TYPE: 30,
    cookie: {
      getCookieString: async () => "zpw_sek=abc",
      setCookie: async () => { },
    },
  }),
});

test("builds the same group quote params as zca-js handleMessage", () => {
  const params = buildGroupQuoteParams(payload, "9015082336605620652", 42);
  assert.deepEqual(params, {
    grid: "9015082336605620652",
    message: "@Taxi Hoàng Nam Ok",
    clientId: 42,
    mentionInfo: JSON.stringify([{ pos: 0, uid: "111", len: 15, type: 0 }]),
    qmsgOwner: "111",
    qmsgId: "8314031960288",
    qmsgCliId: "1790000000000",
    qmsgType: 1,
    qmsgTs: "1790586000000",
    qmsg: "Luôn tpbn đi san bay t2 xe đag tpbn nhận 350k",
    visibility: 0,
    qmsgTTL: 0,
    ttl: 0,
  });
});

test("sends an encrypted quote request with prebuilt headers and decodes the reply", async () => {
  let seen;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen = { url: req.url, method: req.method, headers: req.headers, body };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        error_code: 0,
        data: encrypt(JSON.stringify({ error_code: 0, data: { msgId: 999 } })),
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sender = await new FastGroupSender({ api: makeApi(base), fetch }).init();
  try {
    assert.equal(sender.canSend(payload), true);
    const result = await sender.send(payload, "9015082336605620652");
    assert.deepEqual(result, { msgId: 999 });
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/api/group/quote?nretry=0&zpw_ver=671&zpw_type=30");
    assert.equal(seen.headers.cookie, "zpw_sek=abc");
    assert.equal(seen.headers["user-agent"], "UA-test");
    assert.equal(seen.headers["content-type"], "application/x-www-form-urlencoded");
    const encrypted = new URLSearchParams(seen.body).get("params");
    const params = JSON.parse(decrypt(encrypted));
    assert.equal(params.grid, "9015082336605620652");
    assert.equal(params.qmsgId, "8314031960288");
    assert.equal(params.message, "@Taxi Hoàng Nam Ok");
  } finally {
    sender.dispose();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("rejects a Zalo error so the order is reported as failed", async () => {
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ error_code: 114, error_message: "bad" })));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const sender = await new FastGroupSender({
    api: makeApi(`http://127.0.0.1:${server.address().port}`),
    fetch,
  }).init();
  try {
    await assert.rejects(sender.send(payload, "1"), /bad/);
  } finally {
    sender.dispose();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("leaves non-text quotes to zca-js", async () => {
  const sender = await new FastGroupSender({ api: makeApi("https://group.example.test"), fetch }).init();
  assert.equal(sender.canSend({ ...payload, quote: { ...payload.quote, msgType: "chat.photo" } }), false);
  assert.equal(sender.canSend({ ...payload, quote: { ...payload.quote, content: { href: "x" } } }), false);
  assert.equal(sender.canSend("Ok"), false);
  sender.rehearse();
  sender.dispose();
});

test("bot uses the fast sender instead of zca-js when it can", async () => {
  const calls = [];
  const bot = new ZaloReplyBot({ allowedGroupIds: new Set(["group-1"]), replyText: "Ok", sessionFile: "unused" });
  bot.api = { sendMessage: () => { calls.push("zca"); return Promise.resolve(); } };
  bot.fastSender = {
    canSend: () => true,
    send: (_payload, threadId) => { calls.push(`fast:${threadId}`); return Promise.resolve(); },
    dispose: () => { },
  };
  bot.onMessage({
    threadId: "group-1",
    type: ThreadType.Group,
    isSelf: false,
    data: { msgId: "m-fast", cliMsgId: "c-1", uidFrom: "u1", dName: "Khach", ts: "1", msgType: "webchat", content: "Don khach tai Thu Duc" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["fast:group-1"]);
  assert.equal(bot.stats.lastSendPath, "fast");
  clearTimeout(bot.raceWatch?.timer);
});
