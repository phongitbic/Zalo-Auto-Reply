import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { resolveProxyConfig } from "../src/proxy-config.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({
  path: [path.resolve(currentDir, "../.env"), path.resolve(currentDir, "../../.env")],
  quiet: true,
});

let failed = false;
for (let number = 1; number <= 5; number += 1) {
  const instanceId = `nick${number}`;
  try {
    const proxy = resolveProxyConfig(process.env, instanceId);
    if (!proxy.url) throw new Error(`${proxy.environmentName} is empty.`);
    const response = await fetch("https://api.ipify.org", {
      proxy: proxy.url,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const address = (await response.text()).trim();
    console.log(`${instanceId}: ${proxy.target} -> ${address}`);
  } catch (error) {
    failed = true;
    console.error(`${instanceId}: FAILED - ${error.message}`);
  }
}

if (failed) process.exitCode = 1;
