import path from "node:path";
import { randomUUID } from "node:crypto";
import { ZaloReplyBot } from "./bot.js";
import {
  createPriorityRoute,
  parsePriorityRouteFile,
  priorityRouteKey,
  sanitizePriorityRoutes,
} from "./priority-routes.js";
import { PersistentJsonStore } from "./persistent-json-store.js";
import { RedisCoordinator } from "./redis-coordinator.js";

export const createBackendRuntime = ({ config, broadcast = () => {} }) => {
  const stateStore = new PersistentJsonStore(config.botStateFile, config.botState);
  const successfulHistory = config.orderHistory.filter((item) => item.status === "success");
  const historyStore = new PersistentJsonStore(config.orderHistoryFile, successfulHistory);
  const routesStore = new PersistentJsonStore(config.priorityRoutesFile, config.priorityRoutes);
  let priorityRoutes = config.priorityRoutes;
  let priorityRoutesMutation = Promise.resolve();
  let redisCoordinator;

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
    priorityRoutes,
    recentMessages: successfulHistory,
    configUpdatedAt: config.botState.updatedAt ?? null,
    hotPathLogging: config.hotPathLogging,
    keepAliveIntervalMs: config.keepAliveIntervalMs,
    emit: (event, payload) => {
      if (event === "ORDER_ACCEPTED") {
        recordOrder(payload);
        void redisCoordinator?.recordProcessed(payload.groupId, payload.messageId);
      }
      if (event === "decision") {
        if (config.hotPathLogging) {
          console.log(`[decision] group=${payload.groupId} message=${payload.messageId ?? "unknown"} accepted=${payload.accepted} reason=${payload.reason} route=${payload.matchedRoute ?? "-"}`);
        }
        return;
      }
      broadcast(event, payload);
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
    connectTimeoutMs: config.redisConnectTimeoutMs,
    pingIntervalMs: config.redisPingIntervalMs,
    getLocalConfig: () => ({ state: stateStore.value, routes: priorityRoutes }),
    onRemoteConfig: applyRemoteConfiguration,
    onStatus: (status) => bot.setInfrastructureStatus(status),
  });
  bot.setInfrastructureStatus(redisCoordinator.snapshot());

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
    const parsed = parsePriorityRouteFile(content, {
      fileName: path.basename(fileName || "priority-routes.txt"),
    });
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

  return {
    bot,
    redisCoordinator,
    snapshot: () => bot.snapshot(),
    bootstrap: () => ({ status: bot.snapshot(), orders: historyStore.value }),
    orders: (limit) => historyStore.value.slice(0, limit),
    getPriorityRoutes: () => priorityRoutes,
    persistControl,
    importPreview,
    updatePriorityRoutes,
    validateRouteRequest,
    async importPriorityRoutes(parsed, fileName) {
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
      return { parsed, response };
    },
    async start() {
      void redisCoordinator.start();
      if (config.autoStart) {
        bot.start().catch((error) => console.error("Bot startup failed; retry scheduled:", error));
      }
    },
    async stop() {
      await Promise.all([bot.stop(), redisCoordinator.stop()]);
    },
  };
};
