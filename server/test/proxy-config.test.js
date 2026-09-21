import assert from "node:assert/strict";
import test from "node:test";
import { resolveProxyConfig } from "../src/proxy-config.js";

test("selects one HTTP proxy per bot instance without sharing the fallback", () => {
  const environment = {
    ZALO_PROXY_AGENT: "http://shared.example:8000",
    ZALO_PROXY_AGENT_NICK1: "http://user:secret@proxy-one.example:8101",
    ZALO_PROXY_AGENT_NICK2: "https://proxy-two.example:8102",
  };

  const first = resolveProxyConfig(environment, "nick1");
  const second = resolveProxyConfig(environment, "nick2");
  const missing = resolveProxyConfig(environment, "nick3");

  assert.equal(first.url, "http://user:secret@proxy-one.example:8101/");
  assert.equal(first.target, "http://proxy-one.example:8101");
  assert.equal(second.url, "https://proxy-two.example:8102/");
  assert.equal(second.target, "https://proxy-two.example:8102");
  assert.equal(missing.url, "");
});

test("rejects unsupported or malformed proxy values without echoing credentials", () => {
  assert.throws(
    () => resolveProxyConfig({ ZALO_PROXY_AGENT_NICK1: "socks5://user:secret@proxy.example:1080" }, "nick1"),
    /must use http:\/\/ or https:\/\//
  );
  assert.throws(
    () => resolveProxyConfig({ ZALO_PROXY_AGENT_NICK1: "not a proxy" }, "nick1"),
    (error) => !error.message.includes("not a proxy") && !error.message.includes("secret")
  );
});
