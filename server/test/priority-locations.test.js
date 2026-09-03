import assert from "node:assert/strict";
import test from "node:test";
import { matchesPriorityLocation, parsePriorityLocations } from "../src/priority-locations.js";

test("parses locations and ignores blank or commented lines", () => {
  assert.deepEqual(parsePriorityLocations("# ghi chu\n Quan 1 \n\nThu Duc # gan nha"), ["quan 1", "thu duc"]);
});

test("matches locations without requiring Vietnamese accents or letter case", () => {
  const locations = parsePriorityLocations("Sân bay Tân Sơn Nhất\nThủ Đức");
  assert.equal(matchesPriorityLocation("Co cuoc tu SAN BAY TAN SON NHAT ve Q1", locations), true);
  assert.equal(matchesPriorityLocation("Don khach o THU DUC", locations), true);
  assert.equal(matchesPriorityLocation("Cuoc Binh Thanh di Quan 7", locations), false);
});

test("matches whole normalized phrases, not fragments inside words", () => {
  const locations = parsePriorityLocations("An");
  assert.equal(matchesPriorityLocation("Don khach o Di An", locations), true);
  assert.equal(matchesPriorityLocation("Tin nhan khong lien quan", locations), false);
});
