import cors from "cors";
import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Server } from "socket.io";
import { ZaloReplyBot } from "./bot.js";
import { config } from "./config.js";
import { parsePriorityLocations } from "./priority-locations.js";
import { createPriorityRoute } from "./priority-routes.js";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: config.clientOrigin } });

app.use(cors({ origin: config.clientOrigin }));
app.use(express.json({ limit: "1mb" }));

const bot = new ZaloReplyBot({
  allowedGroupIds: config.allowedGroupIds,
  replyText: config.replyText,
  sessionFile: config.sessionFile,
  priorityOnly: config.priorityOnly,
  priorityLocations: config.priorityLocations,
  priorityRoutes: config.priorityRoutes,
  hotPathLogging: config.hotPathLogging,
  keepAliveIntervalMs: config.keepAliveIntervalMs,
  emit: (event, payload) => io.emit(event, payload),
});

let priorityRoutes = config.priorityRoutes;

const savePriorityRoutes = async () => {
  await fs.mkdir(path.dirname(config.priorityRoutesFile), { recursive: true });
  await fs.writeFile(config.priorityRoutesFile, JSON.stringify(priorityRoutes, null, 2), "utf8");
  bot.setPriorityRoutes(priorityRoutes);
};

const requireAdmin = (req, res, next) => {
  if (!config.adminKey || req.get("x-admin-key") !== config.adminKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

app.get("/api/status", (_req, res) => res.json(bot.snapshot()));
app.post("/api/bot/enabled", requireAdmin, (req, res) => {
  bot.setEnabled(req.body.enabled);
  res.json(bot.snapshot());
});
app.post("/api/bot/priority-only", requireAdmin, (req, res) => {
  bot.setPriorityOnly(req.body.enabled);
  res.json(bot.snapshot());
});
app.post("/api/settings/priority-locations", requireAdmin, async (req, res) => {
  const content = req.body?.content;
  if (typeof content !== "string") {
    return res.status(400).json({ error: "File content must be text." });
  }

  const locations = parsePriorityLocations(content);
  if (locations.length === 0) {
    return res.status(400).json({ error: "The file has no valid locations." });
  }
  if (locations.length > 5000) {
    return res.status(400).json({ error: "The file may contain at most 5000 locations." });
  }

  try {
    await fs.mkdir(path.dirname(config.priorityLocationsFile), { recursive: true });
    await fs.writeFile(config.priorityLocationsFile, content, "utf8");
    bot.setPriorityLocations(locations);
    return res.json(bot.snapshot());
  } catch (error) {
    console.error("Saving priority locations failed:", error);
    return res.status(500).json({ error: "Could not save the locations file." });
  }
});
app.post("/api/settings/priority-routes", requireAdmin, async (req, res) => {
  const { name, fileName, content } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "Ten tuyen khong duoc de trong." });
  }
  if (name.trim().length > 100) {
    return res.status(400).json({ error: "Ten tuyen khong duoc qua 100 ky tu." });
  }
  if (typeof content !== "string") {
    return res.status(400).json({ error: "File content must be text." });
  }

  const route = createPriorityRoute({ id: randomUUID(), name, fileName, content });
  if (route.locations.length === 0) {
    return res.status(400).json({ error: "File khong co dia diem hop le." });
  }
  if (route.locations.length > 5000) {
    return res.status(400).json({ error: "Moi tuyen toi da 5000 dia diem." });
  }

  try {
    priorityRoutes = [...priorityRoutes, route];
    await savePriorityRoutes();
    return res.status(201).json(bot.snapshot());
  } catch (error) {
    priorityRoutes = priorityRoutes.filter((item) => item.id !== route.id);
    console.error("Saving priority route failed:", error);
    return res.status(500).json({ error: "Khong the luu tuyen uu tien." });
  }
});

app.patch("/api/settings/priority-routes/:id", requireAdmin, async (req, res) => {
  const routeIndex = priorityRoutes.findIndex((route) => route.id === req.params.id);
  if (routeIndex === -1) return res.status(404).json({ error: "Khong tim thay tuyen." });

  const previousRoutes = priorityRoutes;
  priorityRoutes = priorityRoutes.map((route, index) =>
    index === routeIndex ? { ...route, enabled: Boolean(req.body.enabled) } : route
  );
  try {
    await savePriorityRoutes();
    return res.json(bot.snapshot());
  } catch (error) {
    priorityRoutes = previousRoutes;
    console.error("Updating priority route failed:", error);
    return res.status(500).json({ error: "Khong the cap nhat tuyen uu tien." });
  }
});

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(currentDir, "../../client/dist");
app.use(express.static(clientDist));
app.get("/{*splat}", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));

io.on("connection", (socket) => socket.emit("status", bot.snapshot()));

server.listen(config.port, () => {
  console.log(`Server listening on http://localhost:${config.port}`);
  if (config.allowedGroupIds.size === 0) console.warn("ALLOWED_GROUP_IDS is empty; no group will receive replies.");
  if (config.priorityOnly && config.priorityLocations.length === 0) {
    console.warn(`Priority-only mode is enabled but ${config.priorityLocationsFile} has no locations.`);
  }
  if (config.autoStart) bot.start().catch((error) => console.error("Bot startup failed:", error));
});
