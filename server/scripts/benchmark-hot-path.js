import { performance } from "node:perf_hooks";
import { ThreadType } from "zca-js";
import { ZaloReplyBot } from "../src/bot.js";
import { createPriorityRoute } from "../src/priority-routes.js";

const routeCount = 5000;
const warmupCount = 1000;
const sampleCount = 5000;
const routes = Array.from({ length: routeCount }, (_, index) => createPriorityRoute({
  id: `route-${index}`,
  origin: `Diem di ${index}`,
  destination: `Diem den ${index}`,
}));
const bot = new ZaloReplyBot({
  allowedGroupIds: new Set(["benchmark-group"]),
  replyText: "Ok",
  sessionFile: "unused",
  priorityOnly: true,
  priorityRoutes: routes,
});
const pendingSend = new Promise(() => {});
bot.api = { sendMessage: () => pendingSend };

const dispatch = (messageId) => {
  const startedAt = performance.now();
  bot.onMessage({
    threadId: "benchmark-group",
    type: ThreadType.Group,
    isSelf: false,
    data: {
      msgId: messageId,
      content: "Diem di 4999 den Diem den 4999",
      uidFrom: "benchmark-user",
      dName: "Khanh",
    },
  });
  return performance.now() - startedAt;
};

for (let index = 0; index < warmupCount; index += 1) dispatch(`warmup-${index}`);
const samples = Array.from(
  { length: sampleCount },
  (_, index) => dispatch(`sample-${index}`)
).sort((left, right) => left - right);
const average = samples.reduce((total, value) => total + value, 0) / samples.length;
const percentile = (fraction) => samples[Math.floor((samples.length - 1) * fraction)];

console.log(JSON.stringify({
  routeCount,
  sampleCount,
  averageMs: Number(average.toFixed(4)),
  p50Ms: Number(percentile(0.5).toFixed(4)),
  p95Ms: Number(percentile(0.95).toFixed(4)),
  p99Ms: Number(percentile(0.99).toFixed(4)),
  maxMs: Number(samples.at(-1).toFixed(4)),
}));

await bot.stop();
