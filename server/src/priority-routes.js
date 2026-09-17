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

const cleanTerms = (values) => {
  const seen = new Set();
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
  const origins = cleanTerms(route.origin).map(normalizeLocation).sort().join("\u0001");
  const destinations = cleanTerms(route.destination).map(normalizeLocation).sort().join("\u0001");
  return `${origins}\u0000${destinations}`;
};

const validateEndpoints = (origin, destination) => {
  const origins = cleanTerms(origin);
  const destinations = cleanTerms(destination);
  if (origins.length === 0) return "Thiếu điểm đi.";
  if (destinations.length === 0) return "Thiếu điểm đến.";
  if (origins.length > 250 || destinations.length > 250) {
    return "Mỗi phía có tối đa 250 địa chỉ.";
  }
  if ([...origins, ...destinations].some((value) => value.length > 200)) {
    return "Mỗi địa chỉ tối đa 200 ký tự.";
  }
  const originSet = new Set(origins.map(normalizeLocation));
  if (destinations.some((value) => originSet.has(normalizeLocation(value)))) {
    return "Điểm đi và điểm đến không được trùng nhau.";
  }
  return null;
};

export const createPriorityRoute = ({
  id = randomUUID(),
  origin,
  destination,
  enabled = true,
  prices = [],
  excludedKeywords = [],
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

  const cleanOrigin = cleanTerms(origin).join(", ");
  const cleanDestination = cleanTerms(destination).join(", ");
  return {
    id: String(id),
    origin: cleanOrigin,
    destination: cleanDestination,
    enabled: Boolean(enabled),
    prices: cleanTerms(prices),
    excludedKeywords: cleanTerms(excludedKeywords),
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

export const compilePriorityRoutes = (routes = []) => {
  const compiledRoutes = routes.map((route, index) => ({
    index,
    route,
    priceNeedles: (route.prices ?? []).map(normalizeLocation).filter(Boolean).map((term) => ` ${term} `),
    excludedNeedles: (route.excludedKeywords ?? []).map(normalizeLocation).filter(Boolean).map((term) => ` ${term} `),
  }));
  const entriesByTerm = new Map();
  const addTerm = (term, routeIndex, side) => {
    let entry = entriesByTerm.get(term);
    if (!entry) {
      entry = { term, originRouteIndexes: [], destinationRouteIndexes: [], seenGeneration: 0 };
      entriesByTerm.set(term, entry);
    }
    entry[side].push(routeIndex);
  };
  for (const item of compiledRoutes) {
    for (const term of cleanTerms(item.route.origin).map(normalizeLocation)) {
      addTerm(term, item.index, "originRouteIndexes");
    }
    for (const term of cleanTerms(item.route.destination).map(normalizeLocation)) {
      addTerm(term, item.index, "destinationRouteIndexes");
    }
  }
  const termTrie = { children: new Map(), entry: null };
  for (const entry of entriesByTerm.values()) {
    const tokens = entry.term.split(" ");
    let node = termTrie;
    for (const token of tokens) {
      let child = node.children.get(token);
      if (!child) {
        child = { children: new Map(), entry: null };
        node.children.set(token, child);
      }
      node = child;
    }
    node.entry = entry;
  }
  return {
    routes: compiledRoutes,
    termTrie,
    termEntries: [...entriesByTerm.values()],
    matchGeneration: 0,
    originSeen: new Uint32Array(compiledRoutes.length),
    destinationSeen: new Uint32Array(compiledRoutes.length),
    originPositions: new Uint32Array(compiledRoutes.length),
    destinationPositions: new Uint32Array(compiledRoutes.length),
    candidateIndexes: [],
  };
};

const nextMatchGeneration = (compiled) => {
  const generation = (compiled.matchGeneration + 1) >>> 0;
  if (generation !== 0) {
    compiled.matchGeneration = generation;
    return generation;
  }
  compiled.originSeen.fill(0);
  compiled.destinationSeen.fill(0);
  for (const entry of compiled.termEntries) entry.seenGeneration = 0;
  compiled.matchGeneration = 1;
  return 1;
};

const findRouteCandidates = (normalizedMessage, compiled) => {
  const messageTokens = normalizedMessage.split(" ");
  const generation = nextMatchGeneration(compiled);
  const candidates = compiled.candidateIndexes;
  candidates.length = 0;
  let occurrenceCount = 0;
  for (let index = 0; index < messageTokens.length; index += 1) {
    let node = compiled.termTrie;
    for (let cursor = index; cursor < messageTokens.length; cursor += 1) {
      node = node.children.get(messageTokens[cursor]);
      if (!node) break;
      const entry = node.entry;
      if (!entry || entry.seenGeneration === generation) continue;
      entry.seenGeneration = generation;
      occurrenceCount += 1;
      for (const routeIndex of entry.originRouteIndexes) {
        if (compiled.originSeen[routeIndex] === generation) continue;
        compiled.originSeen[routeIndex] = generation;
        compiled.originPositions[routeIndex] = index;
        if (compiled.destinationSeen[routeIndex] === generation) candidates.push(routeIndex);
      }
      for (const routeIndex of entry.destinationRouteIndexes) {
        if (compiled.destinationSeen[routeIndex] === generation) continue;
        compiled.destinationSeen[routeIndex] = generation;
        compiled.destinationPositions[routeIndex] = index;
        if (compiled.originSeen[routeIndex] === generation) candidates.push(routeIndex);
      }
    }
  }
  if (candidates.length > 1) candidates.sort((left, right) => left - right);
  return occurrenceCount;
};

const includesAny = (messageWithBoundaries, needles) => {
  for (const needle of needles) {
    if (messageWithBoundaries.includes(needle)) return true;
  }
  return false;
};

export const matchPriorityRoute = (normalizedMessage, compiled) => {
  if (!normalizedMessage) return { accepted: false, reason: "IGNORED_INVALID_MESSAGE" };
  const occurrenceCount = findRouteCandidates(normalizedMessage, compiled);
  const candidates = compiled.candidateIndexes;
  let disabledMatch = null;
  let wrongDirectionMatch = null;
  let excludedKeywordMatch = null;
  let priceMismatch = null;
  let messageWithBoundaries = null;

  for (const routeIndex of candidates) {
    const item = compiled.routes[routeIndex];
    const originIndex = compiled.originPositions[routeIndex];
    const destinationIndex = compiled.destinationPositions[routeIndex];
    if (originIndex === destinationIndex) continue;

    const forward = originIndex < destinationIndex;
    if (!forward) {
      wrongDirectionMatch ??= item.route;
      continue;
    }
    if (!item.route.enabled) {
      disabledMatch ??= item.route;
      continue;
    }
    if (item.excludedNeedles.length > 0) {
      messageWithBoundaries ??= ` ${normalizedMessage} `;
      if (includesAny(messageWithBoundaries, item.excludedNeedles)) {
        excludedKeywordMatch ??= item.route;
        continue;
      }
    }
    if (item.priceNeedles.length > 0) {
      messageWithBoundaries ??= ` ${normalizedMessage} `;
      if (!includesAny(messageWithBoundaries, item.priceNeedles)) {
        priceMismatch ??= item.route;
        continue;
      }
    }
    return { accepted: true, reason: "ACCEPTED_PRIORITY", route: item.route };
  }

  if (disabledMatch) {
    return { accepted: false, reason: "IGNORED_ROUTE_DISABLED", route: disabledMatch };
  }
  if (excludedKeywordMatch) {
    return { accepted: false, reason: "IGNORED_EXCLUDED_KEYWORD", route: excludedKeywordMatch };
  }
  if (priceMismatch) {
    return { accepted: false, reason: "IGNORED_PRICE_MISMATCH", route: priceMismatch };
  }
  if (wrongDirectionMatch) {
    return { accepted: false, reason: "IGNORED_WRONG_DIRECTION", route: wrongDirectionMatch };
  }

  return {
    accepted: false,
    reason: occurrenceCount >= 2 ? "IGNORED_ROUTE_NOT_FOUND" : "IGNORED_INVALID_MESSAGE",
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
  prices: [...route.prices],
  excludedKeywords: [...route.excludedKeywords],
  sourceFile: route.sourceFile,
  uploadedAt: route.uploadedAt,
  importRouteCount: route.importRouteCount,
  updatedAt: route.updatedAt,
}));
