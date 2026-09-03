import assert from "node:assert/strict";
import test from "node:test";
import { matchesPriorityLocation, parsePriorityLocations } from "../src/priority-locations.js";

test("parses locations and ignores blank or commented lines", () => {
  assert.deepEqual(parsePriorityLocations("# ghi chú\n Quận 1 \n\nThủ Đức # gần nhà"), ["quan 1", "thu duc"]);
});

test("matches locations without requiring Vietnamese accents or letter case", () => {
  const locations = parsePriorityLocations("Sân bay Tân Sơn Nhất\nThủ Đức");
  assert.equal(matchesPriorityLocation("Don khach o THU DUC", locations), true);
  assert.equal(matchesPriorityLocation("Có cuốc từ SAN BAY TAN SON NHAT về Q1", locations), true);
  assert.equal(matchesPriorityLocation("Cuốc Bình Thạnh đi Quận 7", locations), false);
});

test("matches whole normalized phrases, not fragments inside words", () => {
  const locations = parsePriorityLocations("An");
  assert.equal(matchesPriorityLocation("Đón khách ở Dĩ An", locations), true);
  assert.equal(matchesPriorityLocation("Tin nhắn không liên quan", locations), false);
});
