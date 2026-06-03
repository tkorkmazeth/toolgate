import type { IdempotencyStore, IdempotencyRecord } from "./types.js";

/**
 * In-memory idempotency store. For development and testing.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private store = new Map<string, IdempotencyRecord>();
  private maxSize: number;

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    const record = this.store.get(key);
    if (!record) return null;
    // Check TTL — expired records are treated as non-existent
    if (record.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return record;
  }

  async set(record: IdempotencyRecord): Promise<void> {
    // Evict expired entries if at capacity
    if (this.store.size >= this.maxSize) {
      this.evictExpired();
    }
    this.store.set(record.key, record);
  }

  async update(
    key: string,
    updates: Partial<IdempotencyRecord>,
  ): Promise<void> {
    const existing = this.store.get(key);
    if (existing) {
      this.store.set(key, { ...existing, ...updates, updatedAt: Date.now() });
    }
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** Get store size (for testing) */
  get size(): number {
    return this.store.size;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, record] of this.store) {
      if (record.expiresAt < now) {
        this.store.delete(key);
      }
    }
  }
}
