import type {
  PaymentRail,
  PaymentProof,
  VerificationContext,
  SettlementResult,
  RailAdapter,
} from "./types.js";

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
  enqueuedAt: number;
  updatedAt: number;
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
  settled: Array<{ id: string; settlement: SettlementResult }>;
  failures: Array<{ id: string; error: string }>;
  remaining: number;
}

/**
 * Drains a PendingSettlementStore by retrying each queued settlement through its
 * rail adapter. Settled entries are removed; still-failing entries stay queued
 * with their attempt count and last error updated for the next pass.
 */
export class SettlementReconciler {
  constructor(
    private resolveAdapter: (rail: PaymentRail) => RailAdapter | undefined,
    private store: PendingSettlementStore,
    private options: SettleRetryOptions = {},
  ) {}

  async reconcileOnce(): Promise<ReconcileResult> {
    const items = await this.store.list();
    const settled: ReconcileResult["settled"] = [];
    const failures: ReconcileResult["failures"] = [];

    for (const item of items) {
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

      if (outcome.result) {
        settled.push({ id: item.id, settlement: outcome.result });
        await this.store.remove(item.id);
      } else {
        failures.push({
          id: item.id,
          error: outcome.lastError ?? "settle_failed",
        });
        await this.store.update(item.id, {
          attempts: item.attempts + outcome.attempts,
          lastError: outcome.lastError,
        });
      }
    }

    return { settled, failures, remaining: (await this.store.list()).length };
  }
}
