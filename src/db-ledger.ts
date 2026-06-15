import type { LedgerAdapter, DeductMeta, CreditMeta } from "./types.js";
import { type Money, type TransactionId, usd, toNumber } from "./money.js";
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
 */
export const DB_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tg_balances (
    caller_id   TEXT    PRIMARY KEY,
    balance     REAL    NOT NULL DEFAULT 0.0,
    updated_at  INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS tg_transactions (
    id          TEXT    PRIMARY KEY,
    type        TEXT    NOT NULL,   -- 'deduct' | 'credit'
    caller_id   TEXT    NOT NULL,
    amount      REAL    NOT NULL,
    tool        TEXT,               -- present for deducts
    source      TEXT,               -- present for credits: 'stripe' | 'x402' | 'manual'
    reference   TEXT,               -- callId or Stripe session ID
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (caller_id) REFERENCES tg_balances(caller_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_tg_transactions_caller
    ON tg_transactions (caller_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS tg_usage (
    caller_id   TEXT    NOT NULL,
    tool        TEXT    NOT NULL,
    period      TEXT    NOT NULL,   -- e.g. "2026-05-02" for daily
    count       INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (caller_id, tool, period)
  )`,
] as const;

// ─── DbLedger ─────────────────────────────────────────────

/**
 * Production-ready ledger backed by a SQL database (D1, Turso, SQLite).
 *
 * Key guarantees:
 *  - Atomic deduct: balance only decremented when it is ≥ the amount
 *    (enforced in SQL WHERE clause — no separate SELECT + UPDATE race).
 *  - Idempotent credit: double-crediting is prevented at the call site
 *    (WebhookHandler) via the processed-event set; the DB itself doesn't
 *    enforce uniqueness on the reference column to support manual credits.
 *  - 6-decimal precision stored as REAL (SQLite REAL is IEEE 754 double).
 */
export class DbLedger implements LedgerAdapter {
  constructor(private db: DbClient) {}

  // ─── Balance ───────────────────────────────────────────

  async getBalance(callerId: string): Promise<Money> {
    const row = await this.db
      .prepare("SELECT balance FROM tg_balances WHERE caller_id = ?")
      .bind(callerId)
      .first<{ balance: number }>();

    // DB stores as REAL (float). Convert to Money via toFixed to avoid drift.
    return usd((row?.balance ?? 0).toFixed(2));
  }

  /**
   * Atomically deduct `amount` from the caller's balance.
   * Returns false (without modifying the DB) if the balance is insufficient.
   *
   * SQL technique: `WHERE balance >= amount` makes the UPDATE a no-op if
   * insufficient, then we check `changes` to know if it applied.
   */
  async deduct(
    callerId: string,
    amount: Money,
    meta: DeductMeta,
  ): Promise<{ success: boolean; txId: TransactionId }> {
    const now = Date.now();
    const amountNum = toNumber(amount);

    // Upsert balance row (initialise to 0 if first seen).
    await this.db
      .prepare(
        `INSERT INTO tg_balances (caller_id, balance, updated_at)
         VALUES (?, 0.0, ?)
         ON CONFLICT(caller_id) DO NOTHING`,
      )
      .bind(callerId, now)
      .run();

    // Atomic conditional deduct.
    const result = await this.db
      .prepare(
        `UPDATE tg_balances
         SET balance    = ROUND(balance - ?, 6),
             updated_at = ?
         WHERE caller_id = ? AND balance >= ?`,
      )
      .bind(amountNum, now, callerId, amountNum)
      .run();

    if (!result.success || (result.changes ?? 0) === 0) {
      return { success: false, txId: "" };
    }

    const txId = randomUUID();
    await this.db
      .prepare(
        `INSERT INTO tg_transactions
           (id, type, caller_id, amount, tool, reference, created_at)
         VALUES (?, 'deduct', ?, ?, ?, ?, ?)`,
      )
      .bind(txId, callerId, amountNum, meta.tool, meta.callId, now)
      .run();

    return { success: true, txId };
  }

  async credit(
    callerId: string,
    amount: Money,
    meta: CreditMeta,
  ): Promise<TransactionId> {
    const now = Date.now();
    const amountNum = toNumber(amount);
    const txId = `credit_${meta.reference}_${now}`;

    // Upsert balance row.
    await this.db
      .prepare(
        `INSERT INTO tg_balances (caller_id, balance, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(caller_id)
         DO UPDATE SET balance = ROUND(balance + ?, 6), updated_at = ?`,
      )
      .bind(callerId, amountNum, now, amountNum, now)
      .run();

    // Record transaction.
    await this.db
      .prepare(
        `INSERT INTO tg_transactions
           (id, type, caller_id, amount, source, reference, created_at)
         VALUES (?, 'credit', ?, ?, ?, ?, ?)`,
      )
      .bind(txId, callerId, amountNum, meta.source, meta.reference, now)
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
