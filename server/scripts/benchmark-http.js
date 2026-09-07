import { config } from "../src/config.js";

const target = new URL(process.argv[2] || `http://127.0.0.1:${config.port}`);
const warmupCount = 100;
const sampleCount = 1000;
const requestStatus = async () => {
  const startedAt = performance.now();
  const response = await fetch(new URL("/api/status", target), {
    keepalive: true,
    headers: { authorization: `Bearer ${config.adminKey}` },
  });
  await response.bytes();
  if (response.status !== 200) throw new Error(`Unexpected HTTP ${response.status}`);
  return performance.now() - startedAt;
};

for (let index = 0; index < warmupCount; index += 1) await requestStatus();
const startedAt = performance.now();
const samples = [];
for (let index = 0; index < sampleCount; index += 1) samples.push(await requestStatus());
const elapsedMs = performance.now() - startedAt;
samples.sort((left, right) => left - right);
const average = samples.reduce((total, value) => total + value, 0) / samples.length;
const percentile = (fraction) => samples[Math.floor((samples.length - 1) * fraction)];
console.log(JSON.stringify({
  target: target.origin,
  sampleCount,
  requestsPerSecond: Number((sampleCount / (elapsedMs / 1000)).toFixed(1)),
  averageMs: Number(average.toFixed(4)),
  p50Ms: Number(percentile(0.5).toFixed(4)),
  p95Ms: Number(percentile(0.95).toFixed(4)),
  p99Ms: Number(percentile(0.99).toFixed(4)),
  maxMs: Number(samples.at(-1).toFixed(4)),
}));
