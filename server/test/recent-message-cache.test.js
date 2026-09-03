import assert from "node:assert/strict";
import test from "node:test";
import { RecentMessageCache } from "../src/recent-message-cache.js";

test("detects duplicates until TTL expires", () => {
  const cache = new RecentMessageCache(1000);
  assert.equal(cache.hasOrAdd("message-1", 100), false);
  assert.equal(cache.hasOrAdd("message-1", 500), true);
  assert.equal(cache.hasOrAdd("message-1", 1101), false);
});
