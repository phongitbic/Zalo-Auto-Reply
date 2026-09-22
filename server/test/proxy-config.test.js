import assert from "node:assert/strict";
import test from "node:test";
import { resolveProxyConfig } from "../src/proxy-config.js";

test("normalizes one HTTP proxy and hides credentials from its display target", () => {
  assert.deepEqual(resolveProxyConfig("http://user:secret@proxy.example:8080"), {
    url: "http://user:secret@proxy.example:8080/",
    target: "http://proxy.example:8080",
  });
});

test("rejects unsupported proxy protocols", () => {
  assert.throws(
    () => resolveProxyConfig("socks5://proxy.example:1080"),
    /must use http:\/\/ or https:\/\//
  );
});
