import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PersistentJsonStore, loadJsonFile } from "../src/persistent-json-store.js";

test("persists queued JSON updates without losing state", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zalo-store-"));
  const filePath = path.join(directory, "state.json");
  const store = new PersistentJsonStore(filePath, { count: 0 });

  try {
    await Promise.all([
      store.update((value) => ({ count: value.count + 1 })),
      store.update((value) => ({ count: value.count + 1 })),
    ]);
    assert.deepEqual(loadJsonFile(filePath, null), { count: 2 });
    assert.equal((await fs.readdir(directory)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
