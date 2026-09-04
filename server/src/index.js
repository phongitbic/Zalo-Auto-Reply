import cors from "cors";
import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Server } from "socket.io";
import { ZaloReplyBot } from "./bot.js";
import { config } from "./config.js";
import {
  createPriorityRoute,
  parsePriorityRouteFile,
  priorityRouteKey,
  sanitizePriorityRoutes,
} from "./priority-routes.js";
import { PersistentJsonStore } from "./persistent-json-store.js";
import { RedisCoordinator } from "./redis-coordinator.js";

const insecureAdminKey = !config.adminKey ||
  config.adminKey === "change-this-long-random-value" ||
  config.adminKey.length < 32;
if (process.env.NODE_ENV === "production" && insecureAdminKey) {
  throw new Error("ADMIN_KEY must be a unique random value with at least 32 characters in production.");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: config.clientOrigins },
  pingInterval: 20000,
  pingTimeout: 10000,
});

app.use(cors({ origin: config.clientOrigins }));
app.use(express.json({ limit: "1mb" }));

const stateStore = new PersistentJsonStore(config.botStateFile, config.botState);
const successfulHistory = config.orderHistory.filter((item) => item.status === "success");
const historyStore = new PersistentJsonStore(config.orderHistoryFile, successfulHistory);
const routesStore = new PersistentJsonStore(config.priorityRoutesFile, config.priorityRoutes);
let priorityRoutes = config.priorityRoutes;
let priorityRoutesMutation = Promise.resolve();
let redisCoordinator;

const tokenMatches = (token) => {
  if (!config.adminKey || typeof token !== "string") return false;
  const expected = Buffer.from(config.adminKey);
  const received = Buffer.from(token);
  return expected.length === received.length && timingSafeEqual(expected, received);
};

const requestToken = (req) => {
  const authorization = req.get("authorization");
  return authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : req.get("x-admin-key");
};

const recordOrder = (order) => {
  void historyStore.update((records) => {
    if (records.some((item) => item.eventId === order.eventId)) return records;
    return [order, ...records].slice(0, config.maxOrderHistory);
  }).catch((error) => console.error("Saving order history failed:", error));
};

const bot = new ZaloReplyBot({
  allowedGroupIds: config.allowedGroupIds,
  replyText: config.replyText,
  sessionFile: config.sessionFile,
  qrFile: config.qrFile,
  enabled: config.enabled,
  priorityOnly: config.priorityOnly,
  priorityLocations: config.priorityLocations,
  priorityRoutes,
  recentMessages: successfulHistory,
  configUpdatedAt: config.botState.updatedAt ?? null,
  hotPathLogging: config.hotPathLogging,
  keepAliveIntervalMs: config.keepAliveIntervalMs,
  httpConnections: config.httpConnections,
  emit: (event, payload) => {
    if (event === "ORDER_ACCEPTED") {
      recordOrder(payload);
      void redisCoordinator?.recordProcessed(payload.groupId, payload.messageId);
    }
    if (event === "decision") {
      console.log(`[decision] group=${payload.groupId} message=${payload.messageId ?? "unknown"} accepted=${payload.accepted} reason=${payload.reason} route=${payload.matchedRoute ?? "-"}`);
    }
    io.emit(event, payload);
  },
});

const updatePriorityRoutes = (transform, { publishRedis = true } = {}) => {
  const operation = priorityRoutesMutation.then(async () => {
    const transformed = transform(priorityRoutes);
    const nextRoutes = sanitizePriorityRoutes(transformed.routes ?? transformed);
    await routesStore.update(() => nextRoutes);
    priorityRoutes = nextRoutes;
    bot.setPriorityRoutes(priorityRoutes);
    const redisSave = publishRedis
      ? await redisCoordinator.saveConfiguration(["routes"])
      : { persisted: true, pending: false, remote: true };
    return { status: bot.snapshot(), save: redisSave, result: transformed.result ?? null };
  });
  priorityRoutesMutation = operation.catch(() => {});
  return operation;
};

const applyRemoteConfiguration = async ({ state, routes, recentMessageKeys }) => {
  if (Array.isArray(routes)) await updatePriorityRoutes(() => routes, { publishRedis: false });
  if (state && typeof state.enabled === "boolean" && ["all", "priority"].includes(state.mode)) {
    const saved = await stateStore.update(() => ({
      enabled: state.enabled,
      mode: state.mode,
      updatedAt: state.updatedAt || new Date().toISOString(),
    }));
    bot.setControl(saved);
  }
  bot.seedRecentMessages(recentMessageKeys);
};

redisCoordinator = new RedisCoordinator({
  url: config.redisUrl,
  prefix: config.redisPrefix,
  channel: config.redisChannel,
  heartbeatMs: config.redisHeartbeatMs,
  getLocalConfig: () => ({ state: stateStore.value, routes: priorityRoutes }),
  onRemoteConfig: applyRemoteConfiguration,
  onStatus: (status) => bot.setInfrastructureStatus(status),
});
bot.setInfrastructureStatus(redisCoordinator.snapshot());

const requireAdmin = (req, res, next) => {
  if (!tokenMatches(requestToken(req))) return res.status(401).json({ error: "Unauthorized" });
  next();
};

const persistControl = async ({ enabled, mode }) => {
  const state = await stateStore.update((current) => ({
    enabled: enabled ?? current.enabled,
    mode: mode ?? current.mode,
    updatedAt: new Date().toISOString(),
  }));
  bot.setControl(state);
  const save = await redisCoordinator.saveConfiguration(["state"]);
  return { ...bot.snapshot(), save };
};

const importPreview = (content, fileName) => {
  const parsed = parsePriorityRouteFile(content, { fileName: path.basename(fileName || "priority-routes.txt") });
  const existing = new Set(priorityRoutes.map(priorityRouteKey));
  const routes = [];
  const duplicates = [...parsed.duplicates];
  for (const route of parsed.routes) {
    if (existing.has(priorityRouteKey(route))) {
      duplicates.push({
        line: route.sourceLine,
        content: `${route.origin} | ${route.destination}`,
        reason: "Tuyến đã có trong danh sách hiện tại.",
      });
    } else {
      existing.add(priorityRouteKey(route));
      routes.push(route);
    }
  }
  return { ...parsed, routes, duplicates, newRouteCount: routes.length };
};

const validateRouteRequest = (body, existing = {}) => {
  if (String(body.origin ?? existing.origin ?? "").trim().length > 200 ||
      String(body.destination ?? existing.destination ?? "").trim().length > 200) {
    const error = new Error("Điểm đi và điểm đến tối đa 200 ký tự.");
    error.code = "INVALID_ROUTE";
    throw error;
  }
  const originAliases = body.originAliases ?? existing.originAliases ?? [];
  const destinationAliases = body.destinationAliases ?? existing.destinationAliases ?? [];
  if (!Array.isArray(originAliases) || !Array.isArray(destinationAliases)) {
    const error = new Error("Danh sách tên thay thế không hợp lệ.");
    error.code = "INVALID_ROUTE";
    throw error;
  }
  if (originAliases.length > 50 || destinationAliases.length > 50) {
    const error = new Error("Mỗi địa điểm có tối đa 50 tên thay thế.");
    error.code = "INVALID_ROUTE";
    throw error;
  }
  if ([...originAliases, ...destinationAliases].some((alias) => String(alias).trim().length > 200)) {
    const error = new Error("Mỗi tên thay thế tối đa 200 ký tự.");
    error.code = "INVALID_ROUTE";
    throw error;
  }
  return createPriorityRoute({
    ...existing,
    origin: body.origin ?? existing.origin,
    destination: body.destination ?? existing.destination,
    enabled: body.enabled ?? existing.enabled ?? true,
    twoWay: body.twoWay ?? existing.twoWay ?? true,
    originAliases,
    destinationAliases,
    updatedAt: new Date().toISOString(),
  });
};

app.get("/api/status", requireAdmin, (_req, res) => res.json(bot.snapshot()));
app.get("/api/bootstrap", requireAdmin, (_req, res) => {
  res.json({ status: bot.snapshot(), orders: historyStore.value });
});
app.get("/api/orders", requireAdmin, (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  res.json(historyStore.value.slice(0, limit));
});
app.get("/api/zalo/qr", requireAdmin, async (_req, res) => {
  try {
    await fs.access(config.qrFile);
    res.set("cache-control", "no-store");
    return res.sendFile(config.qrFile);
  } catch (error) {
    if (error.code === "ENOENT") return res.status(404).json({ error: "QR is not currently required." });
    return res.status(500).json({ error: "Could not read the QR code." });
  }
});

app.post("/api/bot/control", requireAdmin, async (req, res) => {
  const action = req.body?.action;
  const mode = req.body?.mode;
  if (!["start", "stop"].includes(action) || (mode && !["all", "priority"].includes(mode))) {
    return res.status(400).json({ error: "Thao tác hoặc chế độ không hợp lệ." });
  }
  try {
    return res.json(await persistControl({ enabled: action === "start", mode }));
  } catch (error) {
    console.error("Saving bot control state failed:", error);
    return res.status(500).json({ error: "Không thể lưu trạng thái bot." });
  }
});
app.post("/api/bot/enabled", requireAdmin, async (req, res) => {
  try {
    return res.json(await persistControl({ enabled: Boolean(req.body.enabled) }));
  } catch {
    return res.status(500).json({ error: "Không thể lưu trạng thái bot." });
  }
});
app.post("/api/bot/priority-only", requireAdmin, async (req, res) => {
  try {
    return res.json(await persistControl({ mode: req.body.enabled ? "priority" : "all" }));
  } catch {
    return res.status(500).json({ error: "Không thể lưu chế độ bot." });
  }
});

app.post("/api/settings/priority-routes/preview", requireAdmin, (req, res) => {
  const { content, fileName } = req.body ?? {};
  if (typeof content !== "string") return res.status(400).json({ error: "Nội dung file phải là văn bản." });
  if (!String(fileName || "").toLowerCase().endsWith(".txt")) {
    return res.status(400).json({ error: "Chỉ chấp nhận file .txt." });
  }
  const preview = importPreview(content, fileName);
  if (preview.errors.length) {
    return res.status(400).json({ error: "File có dòng không hợp lệ.", preview });
  }
  if (!preview.validRouteCount) return res.status(400).json({ error: "File không có tuyến hợp lệ.", preview });
  if (preview.validRouteCount > 5000) return res.status(400).json({ error: "Mỗi file có tối đa 5.000 tuyến.", preview });
  return res.json({ preview });
});

app.post("/api/settings/priority-routes/import", requireAdmin, async (req, res) => {
  const { content, fileName } = req.body ?? {};
  if (typeof content !== "string" || !String(fileName || "").toLowerCase().endsWith(".txt")) {
    return res.status(400).json({ error: "Cần cung cấp file .txt hợp lệ." });
  }
  const parsed = parsePriorityRouteFile(content, { fileName: path.basename(fileName) });
  if (parsed.errors.length) {
    return res.status(400).json({ error: "File có dòng không hợp lệ; cấu hình hiện tại không thay đổi.", preview: parsed });
  }
  if (!parsed.validRouteCount) return res.status(400).json({ error: "File không có tuyến hợp lệ." });
  if (parsed.validRouteCount > 5000) return res.status(400).json({ error: "Mỗi file có tối đa 5.000 tuyến." });
  try {
    const response = await updatePriorityRoutes((current) => {
      const existing = new Set(current.map(priorityRouteKey));
      const added = [];
      const duplicates = [...parsed.duplicates];
      for (const candidate of parsed.routes) {
        if (existing.has(priorityRouteKey(candidate))) {
          duplicates.push({
            line: candidate.sourceLine,
            content: `${candidate.origin} | ${candidate.destination}`,
            reason: "Tuyến đã có trong danh sách hiện tại.",
          });
          continue;
        }
        existing.add(priorityRouteKey(candidate));
        added.push(candidate);
      }
      return {
        routes: [...current, ...added],
        result: { added: added.length, duplicates, fileName: path.basename(fileName) },
      };
    });
    return res.status(201).json({ ...response.status, save: response.save, import: response.result });
  } catch (error) {
    console.error("Importing priority routes failed:", error);
    return res.status(500).json({ error: "Không thể lưu danh sách tuyến ưu tiên." });
  }
});

app.post("/api/settings/priority-routes", requireAdmin, async (req, res) => {
  try {
    const route = validateRouteRequest(req.body ?? {}, { id: randomUUID() });
    const response = await updatePriorityRoutes((current) => {
      if (current.some((item) => priorityRouteKey(item) === priorityRouteKey(route))) {
        const error = new Error("Tuyến này đã tồn tại.");
        error.code = "DUPLICATE_ROUTE";
        throw error;
      }
      return [...current, route];
    });
    return res.status(201).json({ ...response.status, save: response.save });
  } catch (error) {
    const status = ["INVALID_ROUTE", "DUPLICATE_ROUTE"].includes(error.code) ? 400 : 500;
    return res.status(status).json({ error: error.message || "Không thể thêm tuyến." });
  }
});

app.patch("/api/settings/priority-routes", requireAdmin, async (req, res) => {
  if (typeof req.body?.enabled !== "boolean") {
    return res.status(400).json({ error: "Trạng thái bật/tắt không hợp lệ." });
  }
  try {
    const response = await updatePriorityRoutes((current) => current.map((route) => ({
      ...route,
      enabled: req.body.enabled,
      updatedAt: new Date().toISOString(),
    })));
    return res.json({ ...response.status, save: response.save });
  } catch {
    return res.status(500).json({ error: "Không thể cập nhật tất cả tuyến." });
  }
});

app.patch("/api/settings/priority-routes/:id", requireAdmin, async (req, res) => {
  try {
    const response = await updatePriorityRoutes((current) => {
      const index = current.findIndex((route) => route.id === req.params.id);
      if (index === -1) {
        const error = new Error("Không tìm thấy tuyến.");
        error.code = "ROUTE_NOT_FOUND";
        throw error;
      }
      const changed = validateRouteRequest(req.body ?? {}, current[index]);
      if (current.some((item, itemIndex) => itemIndex !== index && priorityRouteKey(item) === priorityRouteKey(changed))) {
        const error = new Error("Tuyến này bị trùng với tuyến đã có.");
        error.code = "DUPLICATE_ROUTE";
        throw error;
      }
      return current.map((route, itemIndex) => itemIndex === index ? changed : route);
    });
    return res.json({ ...response.status, save: response.save });
  } catch (error) {
    if (error.code === "ROUTE_NOT_FOUND") return res.status(404).json({ error: error.message });
    if (["INVALID_ROUTE", "DUPLICATE_ROUTE"].includes(error.code)) return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: error.message || "Không thể cập nhật tuyến." });
  }
});

app.delete("/api/settings/priority-routes/:id", requireAdmin, async (req, res) => {
  try {
    const response = await updatePriorityRoutes((current) => {
      if (!current.some((route) => route.id === req.params.id)) {
        const error = new Error("Không tìm thấy tuyến.");
        error.code = "ROUTE_NOT_FOUND";
        throw error;
      }
      return current.filter((route) => route.id !== req.params.id);
    });
    return res.json({ ...response.status, save: response.save });
  } catch (error) {
    if (error.code === "ROUTE_NOT_FOUND") return res.status(404).json({ error: error.message });
    return res.status(500).json({ error: "Không thể xóa tuyến." });
  }
});

app.get("/api/settings/priority-routes/export", requireAdmin, (_req, res) => {
  const exportedAt = new Date().toISOString();
  res.attachment(`priority-routes-${exportedAt.slice(0, 10)}.json`);
  res.json({ exportedAt, routes: priorityRoutes });
});

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(currentDir, "../../client/dist");
app.use(express.static(clientDist));
app.get("/{*splat}", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));

io.use((socket, next) => {
  const token = socket.handshake.auth?.token ?? socket.handshake.headers["x-admin-key"];
  if (!tokenMatches(token)) return next(new Error("Unauthorized"));
  if (io.of("/").sockets.size >= config.maxSocketConnections) return next(new Error("Too many connections"));
  return next();
});

io.on("connection", (socket) => {
  socket.emit("status", bot.snapshot());
  socket.emit("orders", historyStore.value);
});

server.listen(config.port, () => {
  console.log(`Server listening on http://localhost:${config.port}`);
  if (insecureAdminKey) console.warn("ADMIN_KEY is missing or shorter than 32 characters; remote control is not secure.");
  if (config.allowedGroupIds.size === 0) console.warn("ALLOWED_GROUP_IDS is empty; no group will receive replies.");
  if (config.priorityOnly && priorityRoutes.length === 0) {
    console.warn("Priority mode is enabled but no priority route is configured.");
  }
  void redisCoordinator.start();
  if (config.autoStart) bot.start().catch((error) => console.error("Bot startup failed; retry scheduled:", error));
});

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down gracefully`);
  const forceExit = setTimeout(() => {
    console.error("Graceful shutdown timed out");
    process.exit(1);
  }, 10000);
  forceExit.unref?.();
  try {
    const serverClosed = new Promise((resolve) => server.close(resolve));
    io.close();
    await Promise.all([bot.stop(), redisCoordinator.stop(), serverClosed]);
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    console.error("Graceful shutdown failed:", error);
    process.exit(1);
  }
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
