import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { config } from "../src/config.js";

const socketOptions = {
  connectTimeout: config.redisConnectTimeoutMs,
  keepAlive: true,
  noDelay: true,
  reconnectStrategy: false,
};
const command = createClient({ url: config.redisUrl, RESP: 2, socket: socketOptions });
const subscriber = command.duplicate();
command.on("error", () => {});
subscriber.on("error", () => {});

const suffix = `${process.pid}-${randomUUID()}`;
const valueKey = `${config.redisPrefix}:diagnostic:value:${suffix}`;
const sortedKey = `${config.redisPrefix}:diagnostic:sorted:${suffix}`;
const versionKey = `${config.redisPrefix}:diagnostic:version:${suffix}`;
let receivedMessage;
let pubSubTimer;

try {
  await Promise.all([command.connect(), subscriber.connect()]);
  const messageReceived = new Promise((resolve) => {
    receivedMessage = resolve;
  });
  await subscriber.subscribe(config.redisChannel, (message) => receivedMessage(message));

  await command.sendCommand(["SET", valueKey, "ok", "EX", "10"]);
  const storedValue = await command.get(valueKey);
  await command.sendCommand(["ZADD", sortedKey, String(Date.now()), "message"]);
  const sortedValues = await command.sendCommand(["ZRANGEBYSCORE", sortedKey, "-inf", "+inf"]);
  await command.sendCommand(["ZREMRANGEBYSCORE", sortedKey, "-inf", "+inf"]);
  const transaction = command.multi();
  transaction.set(versionKey, "0");
  transaction.incr(versionKey);
  const transactionResult = await transaction.exec();
  await command.publish(config.redisChannel, JSON.stringify({
    sourceId: `diagnostic-${suffix}`,
    version: 0,
  }));
  await Promise.race([
    messageReceived,
    new Promise((_, reject) => {
      pubSubTimer = setTimeout(() => reject(new Error("Pub/Sub timeout")), 2000);
    }),
  ]);
  clearTimeout(pubSubTimer);

  const [ping, serverInfo] = await Promise.all([command.ping(), command.info("server")]);
  if (ping !== "PONG" || storedValue !== "ok" || sortedValues[0] !== "message" || transactionResult.at(-1) !== 1) {
    throw new Error("Redis returned an unexpected diagnostic result");
  }
  const version = serverInfo.match(/^redis_version:([^\r\n]+)/m)?.[1] ?? "unknown";
  console.log(`Redis ${version} OK via RESP2: command, transaction, sorted set and Pub/Sub are operational.`);
} catch (error) {
  const code = error?.code ? `${error.code}: ` : "";
  console.error(`Redis check failed: ${code}${error?.message ?? String(error)}`);
  console.error("Check redis-server, REDIS_URL, bind/protected-mode or the Redis 5 requirepass password.");
  process.exitCode = 1;
} finally {
  clearTimeout(pubSubTimer);
  if (command.isReady) await command.del([valueKey, sortedKey, versionKey]).catch(() => {});
  await Promise.all([
    subscriber.isOpen ? subscriber.close().catch(() => {}) : null,
    command.isOpen ? command.close().catch(() => {}) : null,
  ]);
}
