import assert from "node:assert/strict";
import test from "node:test";
import { createPriorityRoute, getActiveLocations, summarizePriorityRoutes } from "../src/priority-routes.js";

test("creates a named enabled route from an uploaded text file", () => {
  const route = createPriorityRoute({
    id: "route-1",
    name: "  Bac Ninh -> Ha Noi  ",
    fileName: "ha-noi.txt",
    content: "Tu Son\nGia Lam\n",
  });

  assert.equal(route.name, "Bac Ninh -> Ha Noi");
  assert.equal(route.enabled, true);
  assert.deepEqual(route.locations, ["tu son", "gia lam"]);
});

test("only merges locations from enabled routes and removes duplicates", () => {
  const routes = [
    { id: "1", name: "Ha Noi", enabled: true, locations: ["tu son", "gia lam"] },
    { id: "2", name: "Hai Phong", enabled: true, locations: ["tu son", "hai phong"] },
    { id: "3", name: "Disabled", enabled: false, locations: ["bac giang"] },
  ];

  assert.deepEqual(getActiveLocations(routes), ["tu son", "gia lam", "hai phong"]);
});

test("route summaries do not expose the complete location list", () => {
  const summary = summarizePriorityRoutes([
    { id: "1", name: "Ha Noi", fileName: "hn.txt", enabled: true, locations: ["tu son"] },
  ]);

  assert.deepEqual(summary, [{ id: "1", name: "Ha Noi", fileName: "hn.txt", enabled: true, locationCount: 1 }]);
});
