import type { LedgerAdapter, DeductMeta, CreditMeta } from "./types.js";
import { type Money, type TransactionId, usd } from "./money.js";
import { randomUUID } from "node:crypto";

// DB abstraction layer to support multiple SQL backends (D1, Turso, SQLite).

/**
 * Minimal query interface compatible with:
 *  - Cloudflare D1:  `env.DB` implements this directly
 *  - Turso/libsql:   wrap client to match
 *  - better-sqlite3: wrap for sync→async
 *
 * Each .prepare(sql).bind(...args).run() / .first() call maps to the
 * standard D1 prepared-statement API.
 */
export interface DbClient {
  prepare(sql: string): DbStatement;
}

export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  run(): Promise<{ success: boolean; changes?: number }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

// ─── Schema ───────────────────────────────────────────────

/**
 * SQL migration to run once against your D1/Turso database.
 * Each statement is separated so you can run them individually
 * or in a migration framework.
 *
 * IMPORTANT: balance and amount are stored as INTEGER minor units (e.g. cents
 * for USD). Never REAL. SQLite INTEGER affinity stores up to 2^53 safely,
 * which is well above any realistic financial balance.
 */
export const DB_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tg_balances (
    caller_id   TEXT    PRIMARY KEY,
    balance     INTEGER NOT NULL DEFAULT 0,
    currency    TEXT    NOT NULL DEFAULT 'USD',
    decimals    INTEGER NOT NULL DEFAULT 2,
    updated_at  INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS tg_transactions (
    id           TEXT    PRIMARY KEY,
    type         TEXT    NOT NULL,    -- 'deduct' | 'credit'
    caller_id    TEXT    NOT NULL,
    amount       INTEGER NOT NULL,    -- minor units, always positive
    currency     TEXT    NOT NULL DEFAULT 'USD',
    balance_after INTEGER,            -- snapshot for audit
    tool         TEXT,                -- present for deducts
    source       TEXT,                -- present for credits: 'stripe' | 'x402' | 'manual'
    reference    TEXT,                -- callId or Stripe session ID
    trace_id     TEXT,
    created_at   INTEGER NOT NULL,
    FOREIGN KEY (caller_id) REFERENCES tg_balances(caller_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_tg_transactions_caller
    ON tg_transactions (caller_id, created_at DESC)`,

  // Partial index: only unique when reference is non-NULL (manual credits
  // with NULL reference are still allowed).
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_transactions_reference
    ON tg_transactions (reference) WHERE reference IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS tg_usage (
    caller_id   TEXT    NOT NULL,
    tool        TEXT    NOT NULL,
    period      TEXT    NOT NULL,   -- e.g. "2026-05-02" for daily
    count       INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (caller_id, tool, period)
  )`,
] as const;

/**
 * Run once on upgrade. Safe to skip if database is fresh.
 */
export const DB_MIGRATION_REAL_TO_INTEGER = [
  // Convert balance column from REAL to INTEGER minor units.
  // Assumes 2 decimal places (USD cents). Adjust multiplier for other currencies.
  `ALTER TABLE tg_balances ADD COLUMN IF NOT EXISTS balance_int INTEGER NOT NULL DEFAULT 0`,
  `UPDATE tg_balances SET balance_int = CAST(ROUND(COALESCE(balance, 0) * 100, 0) AS INTEGER)
   WHERE typeof(balance) = 'real'`,
] as const;

// ─── DbLedger ─────────────────────────────────────────────

/**
 * Production-ready ledger backed by a SQL database (D1, Turso, SQLite).
 *
 * Key guarantees:
 *  - Integer money: balances stored as minor units (cents), no float drift.
 *  - Atomic deduct: UPDATE ... WHERE balance >= amount (no race condition).
 *  - Idempotent credit: UNIQUE index on reference prevents double-credit.
 *  - Audit trail: every mutation stored in tg_transactions with balance_after.
 */
export class DbLedger implements LedgerAdapter {
  constructor(private db: DbClient) {}

  // ─── Balance ───────────────────────────────────────────

  async getBalance(callerId: string): Promise<Money> {
    const row = await this.db
      .prepare(
        "SELECT balance, currency, decimals FROM tg_balances WHERE caller_id = ?",
      )
      .bind(callerId)
      .first<{ balance: number; currency: string; decimals: number }>();

    if (!row) return usd("0.00");
    // balance stored as INTEGER minor units — construct Money directly
    return {
      minorUnits: BigInt(row.balance),
      currency: row.currency,
      decimals: row.decimals,
    };
  }

  /**
   * Atomically deduct `amount` from the caller's balance.
   * Returns {success:false} (without modifying the DB) if balance insufficient.
   *
   * SQL technique: WHERE balance >= amount makes the UPDATE a no-op when
   * insufficient; we check `changes` to know if it applied. No ROUND() needed
   * because integer arithmetic is exact.
   */
  async deduct(
    callerId: string,
    amount: Money,
    meta: DeductMeta,
  ): Promise<{ success: boolean; txId: TransactionId }> {
    const now = Date.now();
    const cents = Number(amount.minorUnits);

    // Upsert balance row (initialise to 0 if first seen).
    await this.db
      .prepare(
        `INSERT INTO tg_balances (caller_id, balance, currency, decimals, updated_at)
         VALUES (?, 0, ?, ?, ?)
         ON CONFLICT(caller_id) DO NOTHING`,
      )
      .bind(callerId, amount.currency, amount.decimals, now)
      .run();

    // Atomic conditional deduct — no ROUND() needed, integer arithmetic is exact.
    const result = await this.db
      .prepare(
        `UPDATE tg_balances
         SET balance = balance - ?, updated_at = ?
         WHERE caller_id = ? AND balance >= ?`,
      )
      .bind(cents, now, callerId, cents)
      .run();

    if (!result.success || (result.changes ?? 0) === 0) {
      return { success: false, txId: "" };
    }

    // Read balance_after for audit trail
    const balRow = await this.db
      .prepare("SELECT balance FROM tg_balances WHERE caller_id = ?")
      .bind(callerId)
      .first<{ balance: number }>();
    const balanceAfter = balRow?.balance ?? 0;

    const txId = randomUUID();
    await this.db
      .prepare(
        `INSERT INTO tg_transactions
           (id, type, caller_id, amount, currency, balance_after, tool, reference, created_at)
         VALUES (?, 'deduct', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        txId,
        callerId,
        cents,
        amount.currency,
        balanceAfter,
        meta.tool,
        meta.callId,
        now,
      )
      .run();

    return { success: true, txId };
  }

  /**
   * Credit amount to caller's balance.
   * The UNIQUE index on tg_transactions(reference) prevents double-credit.
   * Transaction is inserted first; balance is updated only if the insert
   * succeeded (not a duplicate). This makes the operation idempotent.
   */
  async credit(
    callerId: string,
    amount: Money,
    meta: CreditMeta,
  ): Promise<TransactionId> {
    const now = Date.now();
    const cents = Number(amount.minorUnits);
    const txId = randomUUID();

    // Ensure balance row exists (0 if first seen).
    await this.db
      .prepare(
        `INSERT INTO tg_balances (caller_id, balance, currency, decimals, updated_at)
         VALUES (?, 0, ?, ?, ?)
         ON CONFLICT(caller_id) DO NOTHING`,
      )
      .bind(callerId, amount.currency, amount.decimals, now)
      .run();

    // Insert transaction first — UNIQUE index on reference blocks duplicates.
    const txResult = await this.db
      .prepare(
        `INSERT OR IGNORE INTO tg_transactions
           (id, type, caller_id, amount, currency, source, reference, created_at)
         VALUES (?, 'credit', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        txId,
        callerId,
        cents,
        amount.currency,
        meta.source,
        meta.reference,
        now,
      )
      .run();

    if (!txResult.success || (txResult.changes ?? 0) === 0) {
      // Duplicate reference — no balance change.
      return txId;
    }

    // Only credit balance when the transaction was freshly inserted.
    await this.db
      .prepare(
        `UPDATE tg_balances SET balance = balance + ?, updated_at = ? WHERE caller_id = ?`,
      )
      .bind(cents, now, callerId)
      .run();

    return txId;
  }

  // ─── Usage ─────────────────────────────────────────────

  async getUsage(
    callerId: string,
    tool: string,
    period: string,
  ): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT count FROM tg_usage
         WHERE caller_id = ? AND tool = ? AND period = ?`,
      )
      .bind(callerId, tool, currentPeriod(period))
      .first<{ count: number }>();

    return row?.count ?? 0;
  }

  async incrementUsage(
    callerId: string,
    tool: string,
    period: string,
  ): Promise<void> {
    const now = Date.now();
    const p = currentPeriod(period);

    await this.db
      .prepare(
        `INSERT INTO tg_usage (caller_id, tool, period, count, updated_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(caller_id, tool, period)
         DO UPDATE SET count = count + 1, updated_at = ?`,
      )
      .bind(callerId, tool, p, now, now)
      .run();
  }

  // ─── Schema helper ─────────────────────────────────────

  /**
   * Run all schema migrations against the given DB client.
   * Safe to call on every startup (all statements are idempotent).
   */
  static async runMigrations(db: DbClient): Promise<void> {
    for (const sql of DB_SCHEMA) {
      await db.prepare(sql).run();
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────

function currentPeriod(period: string): string {
  const d = new Date();
  switch (period) {
    case "hour":
      return d.toISOString().slice(0, 13);
    case "day":
      return d.toISOString().slice(0, 10);
    case "week": {
      const start = new Date(d);
      start.setDate(d.getDate() - d.getDay());
      return `W${start.toISOString().slice(0, 10)}`;
    }
    case "month":
      return d.toISOString().slice(0, 7);
    default:
      return d.toISOString().slice(0, 10);
  }
}
