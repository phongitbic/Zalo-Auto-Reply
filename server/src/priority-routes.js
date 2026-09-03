import fs from "node:fs";
import { parsePriorityLocations } from "./priority-locations.js";

const isValidRoute = (route) =>
  route && typeof route.id === "string" && typeof route.name === "string" && Array.isArray(route.locations);

export const loadPriorityRoutes = (filePath, legacyLocations = []) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed.filter(isValidRoute) : [];
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return legacyLocations.length
      ? [{ id: "legacy", name: "Danh sach uu tien", fileName: "priority-locations.txt", enabled: true, locations: legacyLocations }]
      : [];
  }
};

export const createPriorityRoute = ({ id, name, fileName, content }) => ({
  id,
  name: String(name).trim(),
  fileName: String(fileName || "locations.txt").trim(),
  enabled: true,
  locations: parsePriorityLocations(content),
});

export const getActiveLocations = (routes) => [
  ...new Set(routes.filter((route) => route.enabled).flatMap((route) => route.locations)),
];

export const summarizePriorityRoutes = (routes) => routes.map(({ id, name, fileName, enabled, locations }) => ({
  id,
  name,
  fileName,
  enabled,
  locationCount: locations.length,
}));
