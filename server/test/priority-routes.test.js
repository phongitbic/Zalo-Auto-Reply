import assert from "node:assert/strict";
import test from "node:test";
import {
  compilePriorityRoutes,
  createPriorityRoute,
  matchPriorityRoute,
  normalizeLocation,
  parsePriorityRouteFile,
} from "../src/priority-routes.js";

const route = (overrides = {}) => createPriorityRoute({
  id: overrides.id ?? "route-1",
  origin: overrides.origin ?? "Bắc Ninh",
  destination: overrides.destination ?? "Hà Nội",
  enabled: overrides.enabled ?? true,
  prices: overrides.prices ?? [],
  excludedKeywords: overrides.excludedKeywords ?? [],
});

const match = (message, routes) => matchPriorityRoute(
  normalizeLocation(message),
  compilePriorityRoutes(routes)
);

test("normalizes Vietnamese accents, punctuation, case and whitespace", () => {
  assert.equal(normalizeLocation("  TP. BẮC   NINH!!! "), "tp bac ninh");
});

test("parses TXT routes as enabled one-way routes", () => {
  const result = parsePriorityRouteFile("Bắc Ninh | Hà Nội\n\nVõ Cường | Cầu Giấy", {
    fileName: "tuyen.txt",
    now: "2026-09-04T00:00:00.000Z",
    idFactory: (() => { let id = 0; return () => `route-${++id}`; })(),
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.validRouteCount, 2);
  assert.equal("twoWay" in result.routes[0], false);
  assert.equal(result.routes[0].enabled, true);
  assert.deepEqual(result.routes[0].prices, []);
  assert.deepEqual(result.routes[0].excludedKeywords, []);
  assert.equal(result.routes[0].sourceFile, "tuyen.txt");
  assert.equal(result.routes[0].importRouteCount, 2);
});

test("reports every malformed TXT line with exact line and reason", () => {
  const result = parsePriorityRouteFile("Bắc Ninh Hà Nội\nA | B | C\n | Hà Nội\nBắc Ninh | Bắc Ninh");
  assert.deepEqual(result.errors.map(({ line, reason }) => ({ line, reason })), [
    { line: 1, reason: "Mỗi dòng phải có đúng một dấu |." },
    { line: 2, reason: "Mỗi dòng phải có đúng một dấu |." },
    { line: 3, reason: "Thiếu điểm đi." },
    { line: 4, reason: "Điểm đi và điểm đến không được trùng nhau." },
  ]);
});

test("a malformed file leaves the live route array untouched", () => {
  const liveRoutes = [route()];
  const result = parsePriorityRouteFile("Bắc Ninh - Hà Nội");
  const nextRoutes = result.errors.length ? liveRoutes : result.routes;
  assert.strictEqual(nextRoutes, liveRoutes);
  assert.equal(nextRoutes[0].destination, "Hà Nội");
});

test("does not create a duplicate route with accents", () => {
  const result = parsePriorityRouteFile("Bắc Ninh | Hà Nội\nbac ninh | ha noi");
  assert.equal(result.routes.length, 1);
  assert.equal(result.duplicates[0].line, 2);
});

test("allows an explicitly configured reverse route", () => {
  const result = parsePriorityRouteFile("Bắc Ninh | Hà Nội\nHà Nội | Bắc Ninh");
  assert.equal(result.routes.length, 2);
  assert.equal(result.duplicates.length, 0);
});

test("accepts an enabled forward priority route", () => {
  assert.equal(match("Có khách từ Bắc Ninh đi Hà Nội", [route()]).reason, "ACCEPTED_PRIORITY");
});

test("rejects the reverse direction even when legacy data enables two-way", () => {
  const legacyRoute = createPriorityRoute({
    id: "legacy-route",
    origin: "Bắc Ninh",
    destination: "Hà Nội",
    twoWay: true,
  });
  assert.equal("twoWay" in legacyRoute, false);
  assert.equal(match("Hà Nội về Bắc Ninh", [legacyRoute]).reason, "IGNORED_WRONG_DIRECTION");
});

test("rejects a disabled matching route", () => {
  assert.equal(match("Bắc Ninh đi Hà Nội", [route({ enabled: false })]).reason, "IGNORED_ROUTE_DISABLED");
});

test("accepts any price when optional filters are empty", () => {
  assert.equal(match("Bắc Ninh đi Hà Nội 150k", [route()]).reason, "ACCEPTED_PRIORITY");
});

test("accepts only an explicitly configured price as a complete term", () => {
  const configured = route({ prices: ["200k", "250k"] });
  assert.equal(match("Bắc Ninh đi Hà Nội 200k", [configured]).reason, "ACCEPTED_PRIORITY");
  assert.equal(match("Bắc Ninh đi Hà Nội 250K", [configured]).reason, "ACCEPTED_PRIORITY");
  assert.equal(match("Bắc Ninh đi Hà Nội 150k", [configured]).reason, "IGNORED_PRICE_MISMATCH");
  assert.equal(match("Bắc Ninh đi Hà Nội 1200k", [configured]).reason, "IGNORED_PRICE_MISMATCH");
});

test("rejects a route containing any configured excluded keyword", () => {
  const configured = route({ prices: ["200k"], excludedKeywords: ["chó", "mèo"] });
  assert.equal(match("Bắc Ninh Hà Nội 200k, chó mèo", [configured]).reason, "IGNORED_EXCLUDED_KEYWORD");
  assert.equal(match("Bắc Ninh Hà Nội 200k, hành lý", [configured]).reason, "ACCEPTED_PRIORITY");
});

test("ignores legacy alias fields instead of treating them as new filters", () => {
  const legacyRoute = createPriorityRoute({
    id: "legacy-aliases",
    origin: "Bắc Ninh",
    destination: "Hà Nội",
    originAliases: ["BN"],
    destinationAliases: ["HN"],
  });
  assert.equal("originAliases" in legacyRoute, false);
  assert.equal("destinationAliases" in legacyRoute, false);
  assert.equal(match("BN đi HN", [legacyRoute]).reason, "IGNORED_INVALID_MESSAGE");
});

test("distinguishes an unknown pair from a message without a complete route", () => {
  const routes = [
    route(),
    route({ id: "route-2", origin: "Hải Phòng", destination: "Quảng Ninh" }),
  ];
  assert.equal(match("Bắc Ninh đi Quảng Ninh", routes).reason, "IGNORED_ROUTE_NOT_FOUND");
  assert.equal(match("Chỉ nhắc tới Quảng Ninh", routes).reason, "IGNORED_INVALID_MESSAGE");
});

test("indexes route candidates instead of scanning every configured route", () => {
  const routes = Array.from({ length: 5000 }, (_, index) => route({
    id: `route-${index}`,
    origin: `Diem di ${index}`,
    destination: `Diem den ${index}`,
  }));
  const compiled = compilePriorityRoutes(routes);

  assert.deepEqual(compiled.routeIndexesByTerm.get("diem di 4999"), [4999]);
  const result = matchPriorityRoute("diem di 4999 den diem den 4999", compiled);
  assert.equal(result.accepted, true);
  assert.equal(result.route.id, "route-4999");
});
