export class RecentMessageCache {
  constructor(ttlMs = 60_000, maxSize = 10_000) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.items = new Map();
  }

  hasOrAdd(key, now = Date.now()) {
    if (!key) return false;
    const expiresAt = this.items.get(key);
    if (expiresAt && expiresAt > now) return true;

    this.items.set(key, now + this.ttlMs);
    if (this.items.size > this.maxSize) this.prune(now);
    return false;
  }

  prune(now = Date.now()) {
    for (const [key, expiresAt] of this.items) {
      if (expiresAt <= now || this.items.size > this.maxSize) this.items.delete(key);
    }
  }

  delete(key) {
    this.items.delete(key);
  }
}
