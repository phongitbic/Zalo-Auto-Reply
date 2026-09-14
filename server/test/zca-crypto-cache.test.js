import { expect, test } from "bun:test";
import { decodeEventData } from "../../node_modules/zca-js/dist/utils.js";

const encoder = new TextEncoder();

const createEncryptedEvent = async (value, keyBytes, importKey) => {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const additionalData = crypto.getRandomValues(new Uint8Array(16));
  const cryptoKey = await importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData, tagLength: 128 },
    cryptoKey,
    encoder.encode(JSON.stringify(value))
  );
  const data = Buffer.concat([
    Buffer.from(iv),
    Buffer.from(additionalData),
    Buffer.from(encrypted),
  ]).toString("base64");
  return {
    cipherKey: Buffer.from(keyBytes).toString("base64"),
    parsed: { data, encrypt: 3 },
  };
};

test("zca-js imports one CryptoKey per active Socket cipher key", async () => {
  const originalImportKey = crypto.subtle.importKey.bind(crypto.subtle);
  const first = await createEncryptedEvent(
    { data: { message: "first" } },
    crypto.getRandomValues(new Uint8Array(32)),
    originalImportKey
  );
  const second = await createEncryptedEvent(
    { data: { message: "second" } },
    crypto.getRandomValues(new Uint8Array(32)),
    originalImportKey
  );
  let importCount = 0;
  crypto.subtle.importKey = (...args) => {
    importCount += 1;
    return originalImportKey(...args);
  };

  try {
    const [decodedFirst, decodedFirstAgain] = await Promise.all([
      decodeEventData(first.parsed, first.cipherKey),
      decodeEventData(first.parsed, first.cipherKey),
    ]);
    expect(decodedFirst).toEqual({ data: { message: "first" } });
    expect(decodedFirstAgain).toEqual(decodedFirst);
    expect(importCount).toBe(1);

    expect(await decodeEventData(second.parsed, second.cipherKey)).toEqual({
      data: { message: "second" },
    });
    expect(importCount).toBe(2);
  } finally {
    crypto.subtle.importKey = originalImportKey;
  }
});
