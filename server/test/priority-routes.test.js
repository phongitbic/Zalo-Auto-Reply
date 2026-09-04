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
  twoWay: overrides.twoWay ?? true,
  originAliases: overrides.originAliases ?? [],
  destinationAliases: overrides.destinationAliases ?? [],
});

const match = (message, routes) => matchPriorityRoute(
  normalizeLocation(message),
  compilePriorityRoutes(routes)
);

test("normalizes Vietnamese accents, punctuation, case and whitespace", () => {
  assert.equal(normalizeLocation("  TP. BẮC   NINH!!! "), "tp bac ninh");
});

test("parses TXT routes, ignores blank lines and enables two-way by default", () => {
  const result = parsePriorityRouteFile("Bắc Ninh | Hà Nội\n\nVõ Cường | Cầu Giấy", {
    fileName: "tuyen.txt",
    now: "2026-09-04T00:00:00.000Z",
    idFactory: (() => { let id = 0; return () => `route-${++id}`; })(),
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.validRouteCount, 2);
  assert.equal(result.routes[0].twoWay, true);
  assert.equal(result.routes[0].enabled, true);
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

test("does not create duplicate routes with accents or reversed endpoints", () => {
  const result = parsePriorityRouteFile("Bắc Ninh | Hà Nội\nha noi | bac ninh");
  assert.equal(result.routes.length, 1);
  assert.equal(result.duplicates[0].line, 2);
});

test("accepts an enabled forward priority route", () => {
  assert.equal(match("Có khách từ Bắc Ninh đi Hà Nội", [route()]).reason, "ACCEPTED_PRIORITY");
});

test("accepts the reverse direction for a two-way route", () => {
  assert.equal(match("Hà Nội về Bắc Ninh", [route()]).reason, "ACCEPTED_PRIORITY");
});

test("rejects the reverse direction for a one-way route", () => {
  assert.equal(match("Hà Nội về Bắc Ninh", [route({ twoWay: false })]).reason, "IGNORED_WRONG_DIRECTION");
});

test("rejects a disabled matching route", () => {
  assert.equal(match("Bắc Ninh đi Hà Nội", [route({ enabled: false })]).reason, "IGNORED_ROUTE_DISABLED");
});

test("uses only explicitly configured aliases", () => {
  const configured = route({ originAliases: ["BN"], destinationAliases: ["HN"] });
  assert.equal(match("BN đi HN", [configured]).reason, "ACCEPTED_PRIORITY");
  assert.equal(match("BN đi HN", [route()]).reason, "IGNORED_INVALID_MESSAGE");
});

test("distinguishes an unknown pair from a message without a complete route", () => {
  const routes = [
    route(),
    route({ id: "route-2", origin: "Hải Phòng", destination: "Quảng Ninh" }),
  ];
  assert.equal(match("Bắc Ninh đi Quảng Ninh", routes).reason, "IGNORED_ROUTE_NOT_FOUND");
  assert.equal(match("Chỉ nhắc tới Quảng Ninh", routes).reason, "IGNORED_INVALID_MESSAGE");
});
