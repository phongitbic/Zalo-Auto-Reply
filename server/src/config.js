import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPriorityRoutes } from "./priority-routes.js";
import { loadJsonFile } from "./persistent-json-store.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({
  path: [path.resolve(currentDir, "../.env"), path.resolve(currentDir, "../../.env")],
  quiet: true,
});

const splitIds = (value = "") =>
  new Set(
    String(value)
      .split(/[\n,;]+/)
      .map((id) => id.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean)
  );

const splitValues = (value = "") =>
  String(value).split(/[,;]+/).map((item) => item.trim()).filter(Boolean);

const botInstanceId = String(process.env.BOT_INSTANCE_ID || "").trim();
if (botInstanceId && !/^[A-Za-z0-9_-]{1,64}$/.test(botInstanceId)) {
  throw new Error("BOT_INSTANCE_ID must contain only letters, numbers, underscores or hyphens.");
}

const instanceFile = (environmentName, fallback) => {
  const configured = process.env[environmentName] || fallback;
  if (!botInstanceId) return path.resolve(currentDir, "..", configured);
  if (configured.includes("{instance}")) {
    return path.resolve(currentDir, "..", configured.replaceAll("{instance}", botInstanceId));
  }
  return path.resolve(currentDir, "..", path.dirname(configured), botInstanceId, path.basename(configured));
};

const instanceNamespace = (value) => {
  if (!botInstanceId) return value;
  return value.includes("{instance}")
    ? value.replaceAll("{instance}", botInstanceId)
    : `${value}:${botInstanceId}`;
};

const allowedGroupsFile = instanceFile("ALLOWED_GROUPS_FILE", "data/allowed-groups.json");
const storedAllowedGroupIds = loadJsonFile(
  allowedGroupsFile,
  null,
  (value) => Array.isArray(value) && value.every((id) => typeof id === "string" && id.trim())
);
const allowedGroupIds = storedAllowedGroupIds
  ? new Set(storedAllowedGroupIds.map((id) => id.trim()))
  : splitIds(process.env.ALLOWED_GROUP_IDS);

const priorityRoutesFile = instanceFile("PRIORITY_ROUTES_FILE", "data/priority-routes.json");
const botStateFile = instanceFile("BOT_STATE_FILE", "data/bot-state.json");
const defaultMode = process.env.PRIORITY_ONLY === "true" ? "priority" : "all";
const botState = loadJsonFile(
  botStateFile,
  { enabled: true, mode: defaultMode },
  (value) => value && typeof value.enabled === "boolean" && ["all", "priority"].includes(value.mode)
);
export const config = {
  botInstanceId,
  port: Number(process.env.PORT || 3001),
  serverHost: process.env.SERVER_HOST || "0.0.0.0",
  clientOrigin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
  clientOrigins: splitValues(
    process.env.CLIENT_ORIGINS ||
    `${process.env.CLIENT_ORIGIN || "http://localhost:5173"},http://localhost,https://localhost,capacitor://localhost`
  ),
  replyText: process.env.REPLY_TEXT || "Ok",
  autoStart: process.env.AUTO_START !== "false",
  adminKey: process.env.ADMIN_KEY || "",
  sessionFile: instanceFile("SESSION_FILE", "data/zca-session.json"),
  qrFile: instanceFile("QR_FILE", "data/zalo-login-qr.png"),
  allowedGroupIds,
  allowedGroupsFile,
  enabled: botState.enabled,
  mode: botState.mode,
  priorityOnly: botState.mode === "priority",
  priorityRoutesFile,
  priorityRoutes: loadPriorityRoutes(priorityRoutesFile),
  hotPathLogging: process.env.HOT_PATH_LOGGING === "true",
  keepAliveIntervalMs: Math.max(5000, Number(process.env.KEEP_ALIVE_INTERVAL_MS) || 5000),
  groupPreconnectIntervalMs: Math.max(1000, Number(process.env.GROUP_PRECONNECT_INTERVAL_MS) || 1000),
  botState,
  botStateFile,
  maxSocketConnections: Math.max(1, Number(process.env.MAX_SOCKET_CONNECTIONS) || 5),
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  redisPrefix: instanceNamespace(process.env.REDIS_PREFIX || "zalo-auto-reply"),
  redisChannel: instanceNamespace(process.env.REDIS_CHANNEL || "priority_routes_updated"),
  redisHeartbeatMs: Math.max(5000, Number(process.env.REDIS_HEARTBEAT_MS) || 15000),
  redisConnectTimeoutMs: Math.max(1000, Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 5000),
  redisPingIntervalMs: Math.max(1000, Number(process.env.REDIS_PING_INTERVAL_MS) || 10000),
  proxyAgent: process.env.ZALO_PROXY_AGENT || '',
};
