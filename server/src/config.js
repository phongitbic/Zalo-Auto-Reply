import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePriorityLocations } from "./priority-locations.js";
import { loadPriorityRoutes } from "./priority-routes.js";

const splitIds = (value = "") =>
  new Set(
    String(value)
      .split(/[\n,;]+/)
      .map((id) => id.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean)
  );

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const priorityLocationsFile = path.resolve(
  currentDir,
  "..",
  process.env.PRIORITY_LOCATIONS_FILE || "data/priority-locations.txt"
);

const loadPriorityLocations = () => {
  try {
    return parsePriorityLocations(fs.readFileSync(priorityLocationsFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return [];
  }
};

const priorityLocations = loadPriorityLocations();
const priorityRoutesFile = path.resolve(
  currentDir,
  "..",
  process.env.PRIORITY_ROUTES_FILE || "data/priority-routes.json"
);

export const config = {
  port: Number(process.env.PORT || 3001),
  clientOrigin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
  replyText: process.env.REPLY_TEXT || "Ok",
  autoStart: process.env.AUTO_START !== "false",
  adminKey: process.env.ADMIN_KEY || "",
  sessionFile: process.env.SESSION_FILE || "./data/zca-session.json",
  allowedGroupIds: splitIds(process.env.ALLOWED_GROUP_IDS),
  priorityOnly: process.env.PRIORITY_ONLY === "true",
  priorityLocations,
  priorityLocationsFile,
  priorityRoutesFile,
  priorityRoutes: loadPriorityRoutes(priorityRoutesFile, priorityLocations),
  hotPathLogging: process.env.HOT_PATH_LOGGING === "true",
};
