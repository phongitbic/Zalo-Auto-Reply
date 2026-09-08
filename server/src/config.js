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

const priorityRoutesFile = path.resolve(
  currentDir,
  "..",
  process.env.PRIORITY_ROUTES_FILE || "data/priority-routes.json"
);
const botStateFile = path.resolve(currentDir, "..", process.env.BOT_STATE_FILE || "data/bot-state.json");
const orderHistoryFile = path.resolve(currentDir, "..", process.env.ORDER_HISTORY_FILE || "data/order-history.json");
const defaultMode = process.env.PRIORITY_ONLY === "true" ? "priority" : "all";
const botState = loadJsonFile(
  botStateFile,
  { enabled: true, mode: defaultMode },
  (value) => value && typeof value.enabled === "boolean" && ["all", "priority"].includes(value.mode)
);
const orderHistory = loadJsonFile(orderHistoryFile, [], Array.isArray);

export const config = {
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
  sessionFile: path.resolve(currentDir, "..", process.env.SESSION_FILE || "data/zca-session.json"),
  qrFile: path.resolve(currentDir, "..", process.env.QR_FILE || "data/zalo-login-qr.png"),
  allowedGroupIds: splitIds(process.env.ALLOWED_GROUP_IDS),
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
  orderHistory,
  orderHistoryFile,
  maxOrderHistory: Math.max(20, Number(process.env.MAX_ORDER_HISTORY) || 500),
  maxSocketConnections: Math.max(1, Number(process.env.MAX_SOCKET_CONNECTIONS) || 5),
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  redisPrefix: process.env.REDIS_PREFIX || "zalo-auto-reply",
  redisChannel: process.env.REDIS_CHANNEL || "priority_routes_updated",
  redisHeartbeatMs: Math.max(5000, Number(process.env.REDIS_HEARTBEAT_MS) || 15000),
  redisConnectTimeoutMs: Math.max(1000, Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 5000),
  redisPingIntervalMs: Math.max(1000, Number(process.env.REDIS_PING_INTERVAL_MS) || 10000),
  proxyAgent: process.env.ZALO_PROXY_AGENT || '',
};
