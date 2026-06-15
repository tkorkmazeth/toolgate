import type {
  IdempotencyStore,
  IdempotencyRecord,
  ClaimResult,
  SerializedError,
} from "./types.js";

/**
 * In-memory atomic idempotency store.
 *
 * Safe for single-process Node.js (event loop is single-threaded, so the
 * synchronous Map.has() + Map.set() pair is effectively atomic here).
 * For multi-instance deployments, use the Postgres adapter (Phase 1C).
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private records = new Map<string, IdempotencyRecord>();
  private maxSize: number;

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  // ─── Read-only access (no ownership side-effects) ─────

  async peek(key: string): Promise<IdempotencyRecord | null> {
    return this.records.get(key) ?? null;
  }

  // ─── Atomic claim ─────────────────────────────────────

  async claim(input: {
    key: string;
    ownerId: string;
    leaseMs: number;
    traceId: string;
  }): Promise<ClaimResult> {
    this.evictIfNeeded();

    const existing = this.records.get(input.key);

    if (!existing) {
      const record: IdempotencyRecord = {
        key: input.key,
        status: "in_progress",
        ownerId: input.ownerId,
        leaseExpiresAt: Date.now() + input.leaseMs,
        traceId: input.traceId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1,
      };
      this.records.set(input.key, record);
      return { status: "claimed", record };
    }

    if (existing.status === "completed") {
      return { status: "completed", record: existing };
    }

    if (existing.status === "failed") {
      // Failed records are retryable — reclaim with new owner
      const reclaimed: IdempotencyRecord = {
        ...existing,
        status: "in_progress",
        ownerId: input.ownerId,
        leaseExpiresAt: Date.now() + input.leaseMs,
        traceId: input.traceId,
        updatedAt: Date.now(),
        version: existing.version + 1,
        error: undefined,
      };
      this.records.set(input.key, reclaimed);
      return { status: "claimed", record: reclaimed };
    }

    // in_progress — check if the lease is still active
    if (existing.leaseExpiresAt < Date.now()) {
      // Lease expired — reclaim
      const reclaimed: IdempotencyRecord = {
        ...existing,
        ownerId: input.ownerId,
        leaseExpiresAt: Date.now() + input.leaseMs,
        traceId: input.traceId,
        updatedAt: Date.now(),
        version: existing.version + 1,
      };
      this.records.set(input.key, reclaimed);
      return { status: "claimed", record: reclaimed };
    }

    // Active lease held by another owner
    return { status: "in_progress", record: existing };
  }

  // ─── Lease heartbeat ──────────────────────────────────

  async heartbeat(
    key: string,
    ownerId: string,
    extendMs: number,
  ): Promise<boolean> {
    const record = this.records.get(key);
    if (
      !record ||
      record.ownerId !== ownerId ||
      record.status !== "in_progress"
    ) {
      return false;
    }
    this.records.set(key, {
      ...record,
      leaseExpiresAt: Date.now() + extendMs,
      updatedAt: Date.now(),
    });
    return true;
  }

  // ─── Complete ─────────────────────────────────────────

  async complete(
    key: string,
    ownerId: string,
    result: unknown,
  ): Promise<boolean> {
    const record = this.records.get(key);
    if (!record || record.ownerId !== ownerId) return false;

    this.records.set(key, {
      ...record,
      status: "completed",
      result,
      updatedAt: Date.now(),
      version: record.version + 1,
    });
    return true;
  }

  // ─── Fail ─────────────────────────────────────────────

  async fail(
    key: string,
    ownerId: string,
    error: SerializedError,
  ): Promise<boolean> {
    const record = this.records.get(key);
    if (!record || record.ownerId !== ownerId) return false;

    this.records.set(key, {
      ...record,
      status: "failed",
      error,
      updatedAt: Date.now(),
      version: record.version + 1,
    });
    return true;
  }

  // ─── Internal helpers ─────────────────────────────────

  private evictIfNeeded(): void {
    if (this.records.size < this.maxSize) return;
    // Evict oldest entries (first in the Map iteration order)
    const toEvict = Math.ceil(this.maxSize * 0.1); // evict 10%
    let evicted = 0;
    for (const key of this.records.keys()) {
      if (evicted >= toEvict) break;
      this.records.delete(key);
      evicted++;
    }
  }

  /** Get store size (for testing) */
  get size(): number {
    return this.records.size;
  }
}
