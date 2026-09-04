import fs from "node:fs";
import { randomUUID } from "node:crypto";

export const normalizeLocation = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

const cleanLabel = (value) => String(value ?? "").trim().replace(/\s+/g, " ");

const cleanAliases = (values, primary) => {
  const seen = new Set([normalizeLocation(primary)]);
  return (Array.isArray(values) ? values : String(values ?? "").split(/[,;\n]+/))
    .map(cleanLabel)
    .filter((value) => {
      const normalized = normalizeLocation(value);
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
};

export const priorityRouteKey = (route) => {
  const endpoints = [normalizeLocation(route.origin), normalizeLocation(route.destination)].sort();
  return endpoints.join("\u0000");
};

const validateEndpoints = (origin, destination) => {
  const cleanOrigin = cleanLabel(origin);
  const cleanDestination = cleanLabel(destination);
  if (!normalizeLocation(cleanOrigin)) return "Thiếu điểm đi.";
  if (!normalizeLocation(cleanDestination)) return "Thiếu điểm đến.";
  if (cleanOrigin.length > 200 || cleanDestination.length > 200) {
    return "Điểm đi và điểm đến tối đa 200 ký tự.";
  }
  if (normalizeLocation(cleanOrigin) === normalizeLocation(cleanDestination)) {
    return "Điểm đi và điểm đến không được trùng nhau.";
  }
  return null;
};

export const createPriorityRoute = ({
  id = randomUUID(),
  origin,
  destination,
  enabled = true,
  twoWay = true,
  originAliases = [],
  destinationAliases = [],
  sourceFile = null,
  uploadedAt = null,
  importRouteCount = null,
  updatedAt = new Date().toISOString(),
}) => {
  const endpointError = validateEndpoints(origin, destination);
  if (endpointError) {
    const error = new Error(endpointError);
    error.code = "INVALID_ROUTE";
    throw error;
  }

  const cleanOrigin = cleanLabel(origin);
  const cleanDestination = cleanLabel(destination);
  return {
    id: String(id),
    origin: cleanOrigin,
    destination: cleanDestination,
    enabled: Boolean(enabled),
    twoWay: Boolean(twoWay),
    originAliases: cleanAliases(originAliases, cleanOrigin),
    destinationAliases: cleanAliases(destinationAliases, cleanDestination),
    sourceFile: sourceFile ? cleanLabel(sourceFile) : null,
    uploadedAt: uploadedAt || null,
    importRouteCount: Number.isInteger(importRouteCount) ? importRouteCount : null,
    updatedAt,
  };
};

export const parsePriorityRouteFile = (
  content = "",
  { fileName = "priority-routes.txt", now = new Date().toISOString(), idFactory = randomUUID } = {}
) => {
  const candidates = [];
  const errors = [];
  const duplicates = [];
  const seen = new Set();

  String(content).split(/\r?\n/).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line) return;
    const parts = line.split("|");
    if (parts.length !== 2) {
      errors.push({ line: lineNumber, content: rawLine, reason: "Mỗi dòng phải có đúng một dấu |." });
      return;
    }
    const [origin, destination] = parts.map(cleanLabel);
    const endpointError = validateEndpoints(origin, destination);
    if (endpointError) {
      errors.push({ line: lineNumber, content: rawLine, reason: endpointError });
      return;
    }
    const route = createPriorityRoute({
      id: idFactory(),
      origin,
      destination,
      sourceFile: fileName,
      uploadedAt: now,
      updatedAt: now,
    });
    const key = priorityRouteKey(route);
    if (seen.has(key)) {
      duplicates.push({ line: lineNumber, content: rawLine, reason: "Tuyến bị trùng trong file." });
      return;
    }
    seen.add(key);
    candidates.push({ ...route, sourceLine: lineNumber });
  });

  const routes = candidates.map((route) => ({
    ...route,
    importRouteCount: candidates.length,
  }));
  return { routes, errors, duplicates, validRouteCount: routes.length };
};

const sanitizeRoute = (route) => {
  if (!route || typeof route !== "object" || typeof route.id !== "string") return null;
  try {
    return createPriorityRoute(route);
  } catch {
    return null;
  }
};

export const sanitizePriorityRoutes = (routes = []) => {
  const seen = new Set();
  return (Array.isArray(routes) ? routes : []).map(sanitizeRoute).filter((route) => {
    if (!route) return false;
    const key = priorityRouteKey(route);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const loadPriorityRoutes = (filePath) => {
  let source;
  try {
    source = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    source = [];
  }

  const storedRoutes = Array.isArray(source) ? source : source?.routes;
  return sanitizePriorityRoutes(storedRoutes);
};

const compileTerms = (primary, aliases) =>
  [...new Set([primary, ...aliases].map(normalizeLocation).filter(Boolean))];

export const compilePriorityRoutes = (routes = []) => {
  const compiledRoutes = routes.map((route, index) => ({
    index,
    route,
    originTerms: compileTerms(route.origin, route.originAliases),
    destinationTerms: compileTerms(route.destination, route.destinationAliases),
  }));
  const locationTerms = new Set();
  const routeIndexesByTerm = new Map();
  for (const route of compiledRoutes) {
    for (const term of new Set([...route.originTerms, ...route.destinationTerms])) {
      locationTerms.add(term);
      const routeIndexes = routeIndexesByTerm.get(term) ?? [];
      routeIndexes.push(route.index);
      routeIndexesByTerm.set(term, routeIndexes);
    }
  }
  const termTrie = { children: new Map(), term: null };
  for (const term of locationTerms) {
    const tokens = term.split(" ");
    let node = termTrie;
    for (const token of tokens) {
      let child = node.children.get(token);
      if (!child) {
        child = { children: new Map(), term: null };
        node.children.set(token, child);
      }
      node = child;
    }
    node.term = term;
  }
  return {
    routes: compiledRoutes,
    locationTerms: [...locationTerms],
    termTrie,
    routeIndexesByTerm,
  };
};

const findTermOccurrences = (normalizedMessage, termTrie) => {
  const messageTokens = normalizedMessage.split(" ");
  const occurrences = new Map();
  for (let index = 0; index < messageTokens.length; index += 1) {
    let node = termTrie;
    for (let cursor = index; cursor < messageTokens.length; cursor += 1) {
      node = node.children.get(messageTokens[cursor]);
      if (!node) break;
      if (node.term && !occurrences.has(node.term)) occurrences.set(node.term, index);
    }
  }
  return occurrences;
};

const termIndex = (occurrences, terms) => {
  let best = -1;
  for (const term of terms) {
    const index = occurrences.get(term);
    if (index !== undefined && (best === -1 || index < best)) best = index;
  }
  return best;
};

export const matchPriorityRoute = (normalizedMessage, compiled) => {
  if (!normalizedMessage) return { accepted: false, reason: "IGNORED_INVALID_MESSAGE" };
  const occurrences = findTermOccurrences(normalizedMessage, compiled.termTrie);
  const candidateIndexes = new Set();
  for (const term of occurrences.keys()) {
    for (const routeIndex of compiled.routeIndexesByTerm.get(term) ?? []) {
      candidateIndexes.add(routeIndex);
    }
  }
  let disabledMatch = null;
  let wrongDirectionMatch = null;

  for (const routeIndex of [...candidateIndexes].sort((left, right) => left - right)) {
    const item = compiled.routes[routeIndex];
    const originIndex = termIndex(occurrences, item.originTerms);
    const destinationIndex = termIndex(occurrences, item.destinationTerms);
    if (originIndex === -1 || destinationIndex === -1 || originIndex === destinationIndex) continue;

    const forward = originIndex < destinationIndex;
    if (!forward && !item.route.twoWay) {
      wrongDirectionMatch ??= item.route;
      continue;
    }
    if (!item.route.enabled) {
      disabledMatch ??= item.route;
      continue;
    }
    return { accepted: true, reason: "ACCEPTED_PRIORITY", route: item.route };
  }

  if (disabledMatch) {
    return { accepted: false, reason: "IGNORED_ROUTE_DISABLED", route: disabledMatch };
  }
  if (wrongDirectionMatch) {
    return { accepted: false, reason: "IGNORED_WRONG_DIRECTION", route: wrongDirectionMatch };
  }

  return {
    accepted: false,
    reason: occurrences.size >= 2 ? "IGNORED_ROUTE_NOT_FOUND" : "IGNORED_INVALID_MESSAGE",
  };
};

export const getPriorityRouteStats = (routes = []) => ({
  total: routes.length,
  enabled: routes.filter((route) => route.enabled).length,
  disabled: routes.filter((route) => !route.enabled).length,
});

export const summarizePriorityRoutes = (routes = []) => routes.map((route) => ({
  id: route.id,
  origin: route.origin,
  destination: route.destination,
  enabled: route.enabled,
  twoWay: route.twoWay,
  originAliases: [...route.originAliases],
  destinationAliases: [...route.destinationAliases],
  sourceFile: route.sourceFile,
  uploadedAt: route.uploadedAt,
  importRouteCount: route.importRouteCount,
  updatedAt: route.updatedAt,
}));
