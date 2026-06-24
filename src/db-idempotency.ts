import type {
  IdempotencyStore,
  IdempotencyRecord,
  ClaimResult,
  SerializedError,
} from "./types.js";
import type { DbClient } from "./db-ledger.js";

/**
 * Durable, cross-instance idempotency store backed by a SQL database
 * (Cloudflare D1, Turso/libsql, SQLite). This is the multi-instance
 * counterpart to {@link InMemoryIdempotencyStore}: the in-memory store
 * only coordinates duplicate calls inside one Node.js process, whereas
 * this store coordinates across every worker/region/restart that shares
 * the same database.
 *
 * Atomicity model (same idioms as {@link DbLedger}):
 *  - First call wins via `INSERT OR IGNORE` (atomic insert-if-absent).
 *  - Stale records (TTL expired, previous failure, or a dead lease) are
 *    reclaimed via a single conditional `UPDATE … WHERE`, whose `changes`
 *    count tells us whether we won the reclaim.
 *  - Concurrent claimers therefore collapse to exactly one owner; the DB
 *    serialises the conditional writes, so there is no check-then-act race.
 *
 * SQL statements carry a leading tag comment (e.g. "tg_idem_insert") purely
 * so test doubles can dispatch deterministically. Real databases ignore SQL
 * comments, so this has no production effect.
 */
export class DbIdempotencyStore implements IdempotencyStore {
  private readonly ttlMs: number;

  constructor(
    private db: DbClient,
    options: { ttlSeconds?: number } = {},
  ) {
    this.ttlMs = (options.ttlSeconds ?? 3600) * 1000;
  }

  // ─── Atomic claim ─────────────────────────────────────

  async claim(input: {
    key: string;
    ownerId: string;
    leaseMs: number;
    traceId: string;
  }): Promise<ClaimResult> {
    const now = Date.now();
    const leaseExpiresAt = now + input.leaseMs;
    const expiresAt = now + this.ttlMs;

    // ── Step 1: insert-if-absent (the common, uncontended path) ──
    const inserted = await this.db
      .prepare(
        `/* tg_idem_insert */
         INSERT OR IGNORE INTO tg_idempotency
           (key, status, owner_id, lease_expires_at, expires_at, trace_id,
            result, error, created_at, updated_at, version)
         VALUES (?, 'in_progress', ?, ?, ?, ?, NULL, NULL, ?, ?, 1)`,
      )
      .bind(
        input.key,
        input.ownerId,
        leaseExpiresAt,
        expiresAt,
        input.traceId,
        now,
        now,
      )
      .run();

    if (inserted.success && (inserted.changes ?? 0) === 1) {
      const record = await this.read(input.key);
      return { status: "claimed", record: record! };
    }

    // ── Step 2: row exists — try to reclaim it if it is stale ──
    // Reclaimable when: TTL fully expired, OR the previous attempt failed,
    // OR it is in_progress but the lease is dead. Completed records within
    // TTL never match, so they are replayed instead of re-executed.
    const reclaimed = await this.db
      .prepare(
        `/* tg_idem_reclaim */
         UPDATE tg_idempotency
            SET status = 'in_progress',
                owner_id = ?,
                lease_expires_at = ?,
                expires_at = ?,
                trace_id = ?,
                updated_at = ?,
                version = version + 1,
                result = NULL,
                error = NULL
          WHERE key = ?
            AND ( expires_at < ?
                  OR status = 'failed'
                  OR (status = 'in_progress' AND lease_expires_at < ?) )`,
      )
      .bind(
        input.ownerId,
        leaseExpiresAt,
        expiresAt,
        input.traceId,
        now,
        input.key,
        now,
        now,
      )
      .run();

    if (reclaimed.success && (reclaimed.changes ?? 0) === 1) {
      const record = await this.read(input.key);
      return { status: "claimed", record: record! };
    }

    // ── Step 3: someone else owns it, or it is already completed ──
    const record = await this.read(input.key);
    if (!record) {
      // Extremely rare: row was deleted between the writes above. Treat as a
      // dead lease so the caller can decide (the next claim will re-insert).
      return {
        status: "in_progress",
        record: {
          key: input.key,
          status: "in_progress",
          ownerId: "",
          leaseExpiresAt: 0,
          traceId: input.traceId,
          createdAt: now,
          updatedAt: now,
          version: 0,
        },
      };
    }

    if (record.status === "completed") {
      return { status: "completed", record };
    }
    return { status: "in_progress", record };
  }

  // ─── Read-only access ─────────────────────────────────

  async peek(key: string): Promise<IdempotencyRecord | null> {
    return this.read(key);
  }

  // ─── Lease heartbeat ──────────────────────────────────

  async heartbeat(
    key: string,
    ownerId: string,
    extendMs: number,
  ): Promise<boolean> {
    const now = Date.now();
    const res = await this.db
      .prepare(
        `/* tg_idem_heartbeat */
         UPDATE tg_idempotency
            SET lease_expires_at = ?, updated_at = ?
          WHERE key = ? AND owner_id = ? AND status = 'in_progress'`,
      )
      .bind(now + extendMs, now, key, ownerId)
      .run();
    return res.success && (res.changes ?? 0) === 1;
  }

  // ─── Complete ─────────────────────────────────────────

  async complete(
    key: string,
    ownerId: string,
    result: unknown,
  ): Promise<boolean> {
    const now = Date.now();
    const res = await this.db
      .prepare(
        `/* tg_idem_complete */
         UPDATE tg_idempotency
            SET status = 'completed', result = ?, updated_at = ?, version = version + 1
          WHERE key = ? AND owner_id = ?`,
      )
      .bind(JSON.stringify(result ?? null), now, key, ownerId)
      .run();
    return res.success && (res.changes ?? 0) === 1;
  }

  // ─── Fail ─────────────────────────────────────────────

  async fail(
    key: string,
    ownerId: string,
    error: SerializedError,
  ): Promise<boolean> {
    const now = Date.now();
    const res = await this.db
      .prepare(
        `/* tg_idem_fail */
         UPDATE tg_idempotency
            SET status = 'failed', error = ?, updated_at = ?, version = version + 1
          WHERE key = ? AND owner_id = ?`,
      )
      .bind(JSON.stringify(error), now, key, ownerId)
      .run();
    return res.success && (res.changes ?? 0) === 1;
  }

  // ─── Internal ─────────────────────────────────────────

  private async read(key: string): Promise<IdempotencyRecord | null> {
    const row = await this.db
      .prepare(`/* tg_idem_select */ SELECT * FROM tg_idempotency WHERE key = ?`)
      .bind(key)
      .first<IdempotencyRow>();
    return row ? rowToRecord(row) : null;
  }

  /**
   * Run the idempotency schema migration. Safe to call on every startup
   * (the statement is idempotent).
   */
  static async runMigrations(db: DbClient): Promise<void> {
    for (const sql of DB_IDEMPOTENCY_SCHEMA) {
      await db.prepare(sql).run();
    }
  }
}

// ─── Schema ───────────────────────────────────────────────

/**
 * SQL migration for the durable idempotency table. Run once against your
 * D1/Turso/SQLite database (or via {@link DbIdempotencyStore.runMigrations}).
 */
export const DB_IDEMPOTENCY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tg_idempotency (
    key              TEXT    PRIMARY KEY,
    status           TEXT    NOT NULL,    -- 'in_progress' | 'completed' | 'failed'
    owner_id         TEXT    NOT NULL,
    lease_expires_at INTEGER NOT NULL,
    expires_at       INTEGER NOT NULL,    -- TTL: record is stale once passed
    trace_id         TEXT    NOT NULL,
    result           TEXT,                -- JSON, present when completed
    error            TEXT,                -- JSON, present when failed
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    version          INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tg_idempotency_expires
    ON tg_idempotency (expires_at)`,
] as const;

// ─── Row mapping ──────────────────────────────────────────

interface IdempotencyRow {
  key: string;
  status: "in_progress" | "completed" | "failed";
  owner_id: string;
  lease_expires_at: number;
  expires_at: number;
  trace_id: string;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  version: number;
}

function rowToRecord(row: IdempotencyRow): IdempotencyRecord {
  return {
    key: row.key,
    status: row.status,
    ownerId: row.owner_id,
    leaseExpiresAt: row.lease_expires_at,
    traceId: row.trace_id,
    result: row.result != null ? JSON.parse(row.result) : undefined,
    error: row.error != null ? (JSON.parse(row.error) as SerializedError) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}
