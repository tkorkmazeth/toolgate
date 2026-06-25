import type {
  PaymentRail,
  PaymentProof,
  VerificationContext,
  SettlementResult,
  RailAdapter,
} from "./types.js";
import type { DbClient } from "./db-ledger.js";

// ─── Settlement Recovery ──────────────────────────────────
//
// In x402-style rails, settlement happens AFTER execution and can fail
// independently (RPC blip, facilitator timeout) while the payment was already
// verified and the caller credited. A bare `settlePayment` call that returns
// null leaves money authorized but unsettled — the provider isn't paid.
//
// This module turns that "settlement_uncertain" dead-end into a recovery loop:
//   1. settleWithRetry — absorb transient failures with bounded backoff.
//   2. PendingSettlementStore — durably queue what still didn't settle.
//   3. SettlementReconciler — drain the queue later until it does.

export interface SettleRetryOptions {
  /** Extra attempts after the first (default 3 → up to 4 tries). */
  retries?: number;
  /** Base backoff in ms (default 250). */
  baseDelayMs?: number;
  /** Backoff ceiling in ms (default 4000). */
  maxDelayMs?: number;
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

export interface SettleAttemptOutcome {
  result: SettlementResult | null;
  attempts: number;
  lastError?: string;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Call `adapter.settlePayment` repeatedly until it returns a settlement or the
 * retry budget is exhausted. A thrown error or a null result both count as a
 * failed attempt. Returns the outcome plus how many attempts were spent.
 */
export async function settleWithRetry(
  adapter: Pick<RailAdapter, "settlePayment">,
  proof: PaymentProof,
  context: VerificationContext | undefined,
  options: SettleRetryOptions = {},
): Promise<SettleAttemptOutcome> {
  const retries = options.retries ?? 3;
  const base = options.baseDelayMs ?? 250;
  const max = options.maxDelayMs ?? 4000;
  const sleep = options.sleep ?? defaultSleep;

  let attempts = 0;
  let lastError: string | undefined;

  while (attempts <= retries) {
    attempts++;
    try {
      const result = (await adapter.settlePayment?.(proof, context)) ?? null;
      if (result) return { result, attempts, lastError };
      lastError = "settle_returned_null";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempts <= retries) {
      await sleep(Math.min(max, base * 2 ** (attempts - 1)));
    }
  }

  return { result: null, attempts, lastError };
}

// ─── Pending settlement store ─────────────────────────────

export interface PendingSettlement {
  /** Stable id — the rail actionId when available, else generated. */
  id: string;
  rail: PaymentRail;
  proof: PaymentProof;
  context?: VerificationContext;
  toolName?: string;
  callerId?: string;
  amount?: number;
  attempts: number;
  lastError?: string;
  /**
   * Tx hash returned by a successful settle that is awaiting on-chain
   * confirmation. When set, the reconciler re-checks confirmation instead of
   * re-submitting — so a landed-but-unconfirmed payment is never double-settled.
   */
  submittedTxHash?: string;
  enqueuedAt: number;
  updatedAt: number;
}

/**
 * Confirms that a settlement tx actually landed on-chain. Implement per chain
 * (EVM: `eth_getTransactionReceipt`; Solana: `getSignatureStatuses`). Lets the
 * reconciler promote a "submitted" settlement to "confirmed".
 */
export interface ChainConfirmer {
  isConfirmed(rail: PaymentRail, txHash: string): Promise<boolean>;
}

export type PendingSettlementInput = Omit<
  PendingSettlement,
  "attempts" | "enqueuedAt" | "updatedAt"
> & { attempts?: number };

export interface PendingSettlementStore {
  enqueue(item: PendingSettlementInput): Promise<void>;
  list(): Promise<PendingSettlement[]>;
  get(id: string): Promise<PendingSettlement | null>;
  remove(id: string): Promise<void>;
  update(id: string, patch: Partial<PendingSettlement>): Promise<void>;
}

export class InMemoryPendingSettlementStore implements PendingSettlementStore {
  private items = new Map<string, PendingSettlement>();

  async enqueue(item: PendingSettlementInput): Promise<void> {
    const now = Date.now();
    const existing = this.items.get(item.id);
    this.items.set(item.id, {
      ...item,
      attempts: item.attempts ?? existing?.attempts ?? 0,
      enqueuedAt: existing?.enqueuedAt ?? now,
      updatedAt: now,
    });
  }

  async list(): Promise<PendingSettlement[]> {
    return Array.from(this.items.values()).sort(
      (a, b) => a.enqueuedAt - b.enqueuedAt,
    );
  }

  async get(id: string): Promise<PendingSettlement | null> {
    return this.items.get(id) ?? null;
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }

  async update(id: string, patch: Partial<PendingSettlement>): Promise<void> {
    const existing = this.items.get(id);
    if (!existing) return;
    this.items.set(id, { ...existing, ...patch, updatedAt: Date.now() });
  }

  /** Count of queued settlements (testing/monitoring). */
  get size(): number {
    return this.items.size;
  }
}

// ─── Reconciler ───────────────────────────────────────────

export interface ReconcileResult {
  settled: Array<{ id: string; settlement?: SettlementResult; txHash?: string }>;
  /** Settled but not yet confirmed on-chain — kept queued for re-check. */
  pendingConfirmation: Array<{ id: string; txHash?: string }>;
  failures: Array<{ id: string; error: string }>;
  remaining: number;
}

export interface ReconcilerOptions extends SettleRetryOptions {
  /** Optional on-chain confirmer; when present, only confirmed settles dequeue. */
  confirmer?: ChainConfirmer;
}

/**
 * Drains a PendingSettlementStore by retrying each queued settlement through its
 * rail adapter. Settled entries are removed; still-failing entries stay queued
 * with their attempt count and last error updated for the next pass.
 *
 * With a {@link ChainConfirmer}, settlement becomes two-phase: a successful
 * settle records its tx hash and stays queued until the tx is confirmed
 * on-chain — and a queued item that already has a tx hash is re-checked for
 * confirmation instead of being settled again.
 */
export class SettlementReconciler {
  private confirmer?: ChainConfirmer;

  constructor(
    private resolveAdapter: (rail: PaymentRail) => RailAdapter | undefined,
    private store: PendingSettlementStore,
    private options: ReconcilerOptions = {},
  ) {
    this.confirmer = options.confirmer;
  }

  async reconcileOnce(): Promise<ReconcileResult> {
    const items = await this.store.list();
    const settled: ReconcileResult["settled"] = [];
    const pendingConfirmation: ReconcileResult["pendingConfirmation"] = [];
    const failures: ReconcileResult["failures"] = [];

    for (const item of items) {
      // Phase 2: a prior pass already settled this; just confirm on-chain.
      if (item.submittedTxHash && this.confirmer) {
        const ok = await this.confirmer
          .isConfirmed(item.rail, item.submittedTxHash)
          .catch(() => false);
        if (ok) {
          settled.push({ id: item.id, txHash: item.submittedTxHash });
          await this.store.remove(item.id);
        } else {
          pendingConfirmation.push({ id: item.id, txHash: item.submittedTxHash });
          await this.store.update(item.id, { lastError: "awaiting_confirmation" });
        }
        continue;
      }

      const adapter = this.resolveAdapter(item.rail);
      if (!adapter?.settlePayment) {
        failures.push({ id: item.id, error: "no_adapter_for_rail" });
        await this.store.update(item.id, { lastError: "no_adapter_for_rail" });
        continue;
      }

      const outcome = await settleWithRetry(
        adapter,
        item.proof,
        item.context,
        this.options,
      );

      if (!outcome.result) {
        failures.push({
          id: item.id,
          error: outcome.lastError ?? "settle_failed",
        });
        await this.store.update(item.id, {
          attempts: item.attempts + outcome.attempts,
          lastError: outcome.lastError,
        });
        continue;
      }

      const txHash = outcome.result.txHash;
      if (this.confirmer && txHash) {
        const ok = await this.confirmer
          .isConfirmed(item.rail, txHash)
          .catch(() => false);
        if (ok) {
          settled.push({ id: item.id, settlement: outcome.result, txHash });
          await this.store.remove(item.id);
        } else {
          // Landed but unconfirmed — remember the tx so we don't re-submit.
          pendingConfirmation.push({ id: item.id, txHash });
          await this.store.update(item.id, {
            attempts: item.attempts + outcome.attempts,
            submittedTxHash: txHash,
            lastError: "awaiting_confirmation",
          });
        }
      } else {
        settled.push({ id: item.id, settlement: outcome.result, txHash });
        await this.store.remove(item.id);
      }
    }

    return {
      settled,
      pendingConfirmation,
      failures,
      remaining: (await this.store.list()).length,
    };
  }
}

// ─── Scheduled reconciler loop ────────────────────────────

export interface ReconcilerLoopHandle {
  /** Stop the loop. */
  stop(): void;
  /** Run one pass immediately (also used internally on each tick). */
  tick(): Promise<ReconcileResult | null>;
}

/**
 * Run `reconcile` on a fixed interval until stopped. Overlapping ticks are
 * skipped (a slow pass won't pile up). Returns a handle with `stop()` and a
 * `tick()` for manual/triggered runs.
 */
export function startSettlementReconciler(
  reconcile: () => Promise<ReconcileResult>,
  options: {
    intervalMs: number;
    onResult?: (result: ReconcileResult) => void;
    onError?: (error: unknown) => void;
  },
): ReconcilerLoopHandle {
  let running = false;
  let stopped = false;

  const tick = async (): Promise<ReconcileResult | null> => {
    if (running || stopped) return null;
    running = true;
    try {
      const result = await reconcile();
      options.onResult?.(result);
      return result;
    } catch (error) {
      options.onError?.(error);
      return null;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, options.intervalMs);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    tick,
  };
}

// ─── Durable (D1 / Turso / SQLite) pending store ──────────

/**
 * SQL migration for the durable pending-settlement queue. Run once against your
 * D1/Turso/SQLite database (mirrors DB_IDEMPOTENCY_SCHEMA conventions).
 */
export const DB_PENDING_SETTLEMENT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tg_pending_settlements (
    id                 TEXT    PRIMARY KEY,
    rail               TEXT    NOT NULL,
    proof              TEXT    NOT NULL,
    context            TEXT,
    tool_name          TEXT,
    caller_id          TEXT,
    amount             REAL,
    attempts           INTEGER NOT NULL DEFAULT 0,
    last_error         TEXT,
    submitted_tx_hash  TEXT,
    enqueued_at        INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS tg_pending_settlements_enqueued_at
     ON tg_pending_settlements (enqueued_at)`,
];

interface PendingSettlementRow {
  id: string;
  rail: string;
  proof: string;
  context: string | null;
  tool_name: string | null;
  caller_id: string | null;
  amount: number | null;
  attempts: number;
  last_error: string | null;
  submitted_tx_hash: string | null;
  enqueued_at: number;
  updated_at: number;
}

/**
 * Durable, cross-instance pending-settlement store backed by a SQL database.
 * The multi-instance counterpart to {@link InMemoryPendingSettlementStore}: a
 * settlement queued by one worker survives restarts and can be reconciled by
 * any worker sharing the database.
 */
export class DbPendingSettlementStore implements PendingSettlementStore {
  constructor(private db: DbClient) {}

  static async applySchema(db: DbClient): Promise<void> {
    for (const sql of DB_PENDING_SETTLEMENT_SCHEMA) {
      await db.prepare(sql).run();
    }
  }

  private rowToItem(row: PendingSettlementRow): PendingSettlement {
    return {
      id: row.id,
      rail: row.rail as PaymentRail,
      proof: JSON.parse(row.proof) as PaymentProof,
      context: row.context
        ? (JSON.parse(row.context) as VerificationContext)
        : undefined,
      toolName: row.tool_name ?? undefined,
      callerId: row.caller_id ?? undefined,
      amount: row.amount ?? undefined,
      attempts: row.attempts,
      lastError: row.last_error ?? undefined,
      submittedTxHash: row.submitted_tx_hash ?? undefined,
      enqueuedAt: row.enqueued_at,
      updatedAt: row.updated_at,
    };
  }

  async enqueue(item: PendingSettlementInput): Promise<void> {
    const now = Date.now();
    // Upsert: on conflict, keep the original enqueued_at, refresh the rest.
    await this.db
      .prepare(
        `/* tg_settle_upsert */
         INSERT INTO tg_pending_settlements
           (id, rail, proof, context, tool_name, caller_id, amount, attempts,
            last_error, submitted_tx_hash, enqueued_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           rail = excluded.rail,
           proof = excluded.proof,
           context = excluded.context,
           tool_name = excluded.tool_name,
           caller_id = excluded.caller_id,
           amount = excluded.amount,
           attempts = excluded.attempts,
           last_error = excluded.last_error,
           submitted_tx_hash = excluded.submitted_tx_hash,
           updated_at = excluded.updated_at`,
      )
      .bind(
        item.id,
        item.rail,
        JSON.stringify(item.proof),
        item.context ? JSON.stringify(item.context) : null,
        item.toolName ?? null,
        item.callerId ?? null,
        item.amount ?? null,
        item.attempts ?? 0,
        item.lastError ?? null,
        item.submittedTxHash ?? null,
        now,
        now,
      )
      .run();
  }

  async list(): Promise<PendingSettlement[]> {
    const { results } = await this.db
      .prepare(
        `/* tg_settle_list */
         SELECT * FROM tg_pending_settlements ORDER BY enqueued_at ASC`,
      )
      .all<PendingSettlementRow>();
    return results.map((r) => this.rowToItem(r));
  }

  async get(id: string): Promise<PendingSettlement | null> {
    const row = await this.db
      .prepare(
        `/* tg_settle_get */ SELECT * FROM tg_pending_settlements WHERE id = ?`,
      )
      .bind(id)
      .first<PendingSettlementRow>();
    return row ? this.rowToItem(row) : null;
  }

  async remove(id: string): Promise<void> {
    await this.db
      .prepare(
        `/* tg_settle_delete */ DELETE FROM tg_pending_settlements WHERE id = ?`,
      )
      .bind(id)
      .run();
  }

  async update(id: string, patch: Partial<PendingSettlement>): Promise<void> {
    const existing = await this.get(id);
    if (!existing) return;
    const merged = { ...existing, ...patch };
    await this.enqueue(merged); // upsert preserves enqueued_at on conflict
  }
}
