import { config } from "../src/config.js";

const requestedLimit = Number.parseInt(process.argv[2] || "100", 10);
const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 5000) : 100;
const idleThresholdMs = Math.max(10000, Number(process.env.LATENCY_IDLE_THRESHOLD_MS) || 60000);
const numeric = (value) => typeof value === "number" && Number.isFinite(value);
const round = (value) => Number(value.toFixed(3));

const percentile = (sorted, fraction) => {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
};

const summarize = (records, field) => {
  const values = records.map((record) => record[field]).filter(numeric).sort((left, right) => left - right);
  if (values.length === 0) return null;
  const average = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + ((value - average) ** 2), 0) / values.length;
  return {
    samples: values.length,
    minMs: round(values[0]),
    averageMs: round(average),
    p50Ms: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    p99Ms: round(percentile(values, 0.99)),
    maxMs: round(values.at(-1)),
    jitterMs: round(Math.sqrt(variance)),
  };
};

const records = config.orderHistory
  .filter((record) => record?.status === "success" && numeric(record.totalMs ?? record.latencyMs))
  .slice(0, limit)
  .map((record) => ({ ...record, totalMs: record.totalMs ?? record.latencyMs }))
  .sort((left, right) => new Date(left.receivedAt || left.sentAt) - new Date(right.receivedAt || right.sentAt));

const warm = [];
const afterIdle = [];
for (let index = 1; index < records.length; index += 1) {
  const previousAt = new Date(records[index - 1].receivedAt || records[index - 1].sentAt).getTime();
  const currentAt = new Date(records[index].receivedAt || records[index].sentAt).getTime();
  if (currentAt - previousAt >= idleThresholdMs) afterIdle.push(records[index]);
  else warm.push(records[index]);
}

console.log(JSON.stringify({
  requestedSamples: limit,
  availableSamples: records.length,
  idleThresholdMs,
  total: summarize(records, "totalMs"),
  zaloNetwork: summarize(records, "networkMs"),
  dispatch: summarize(records, "dispatchMs"),
  warmTotal: summarize(warm, "totalMs"),
  afterIdleTotal: summarize(afterIdle, "totalMs"),
  warning: records.length < 50 ? "Cần tối thiểu 50 mẫu thật trước khi quyết định dùng proxy." : null,
}, null, 2));
