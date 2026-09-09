import { describe, expect, test } from "bun:test";
import { normalizeServerUrl, validateNativeServerUrl } from "./server-url.js";

describe("Android server URL policy", () => {
  test.each([
    "http://192.168.1.10:3001",
    "http://10.0.2.2:3001",
    "http://172.16.0.1:3001",
    "http://172.31.255.254:3001",
    "http://100.64.0.1:3001",
    "http://100.127.255.254:3001",
    "http://localhost:3001",
    "http://[::1]:3001",
    "http://160.191.51.229:3001",
    "http://example.com:3001",
    "https://bot.example.com",
  ])("accepts a safe endpoint: %s", (url) => {
    expect(validateNativeServerUrl(url)).toBe("");
  });

  test.each([
    "192.168.1.10:3001",
    "ftp://192.168.1.10:3001",
    "http://192.168.1.10:3001/api",
  ])("rejects an unsafe or malformed endpoint: %s", (url) => {
    expect(validateNativeServerUrl(url)).not.toBe("");
  });

  test("normalizes the address to an origin", () => {
    expect(normalizeServerUrl("  http://192.168.1.10:3001/  ")).toBe("http://192.168.1.10:3001");
  });
});
