import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const loadJsonFile = (filePath, fallback, validate = () => true) => {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return validate(value) ? value : fallback;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return fallback;
  }
};

const writeJsonAtomic = async (filePath, value) => {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsPromises.writeFile(tempFile, JSON.stringify(value, null, 2), "utf8");
    await fsPromises.rename(tempFile, filePath);
  } finally {
    await fsPromises.unlink(tempFile).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
};

export class PersistentJsonStore {
  constructor(filePath, initialValue) {
    this.filePath = filePath;
    this.value = initialValue;
    this.pending = Promise.resolve();
  }

  update(transform) {
    const operation = this.pending.then(async () => {
      const nextValue = transform(this.value);
      await writeJsonAtomic(this.filePath, nextValue);
      this.value = nextValue;
      return nextValue;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
