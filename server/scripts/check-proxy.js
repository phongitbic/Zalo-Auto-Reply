import { config } from "../src/config.js";

if (!config.proxyUrl) {
  console.error("ZALO_PROXY_AGENT is empty in server/.env.");
  process.exit(1);
}

try {
  const response = await fetch("https://api.ipify.org", {
    proxy: config.proxyUrl,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const address = (await response.text()).trim();
  console.log(`${config.proxyTarget} -> ${address}`);
} catch (error) {
  const safeMessage = String(error.message).replaceAll(config.proxyUrl, config.proxyTarget);
  console.error(`${config.proxyTarget}: FAILED - ${safeMessage}`);
  process.exitCode = 1;
}
