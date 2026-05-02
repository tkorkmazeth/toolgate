import type { LedgerAdapter, DeductMeta, CreditMeta } from "./types.js";

/**
 * In-memory ledger for MVP / local development.
 * Replace with DB-backed adapter (Turso, D1, Postgres) for production.
 */
export class InMemoryLedger implements LedgerAdapter {
  private balances = new Map<string, number>();
  private usage = new Map<string, number>(); // key: `${callerId}:${tool}:${period}`
  private transactions: Array<{
    type: "deduct" | "credit";
    callerId: string;
    amount: number;
    meta: DeductMeta | CreditMeta;
    timestamp: number;
  }> = [];

  async getBalance(callerId: string): Promise<number> {
    return this.balances.get(callerId) ?? 0;
  }

  async deduct(callerId: string, amount: number, meta: DeductMeta): Promise<boolean> {
    const current = this.balances.get(callerId) ?? 0;
    if (current < amount) return false;

    this.balances.set(callerId, round(current - amount));
    this.transactions.push({
      type: "deduct",
      callerId,
      amount,
      meta,
      timestamp: Date.now(),
    });

    // Increment usage counter
    const period = currentPeriod("day");
    const usageKey = `${callerId}:${meta.tool}:${period}`;
    this.usage.set(usageKey, (this.usage.get(usageKey) ?? 0) + 1);

    return true;
  }

  async credit(callerId: string, amount: number, meta: CreditMeta): Promise<void> {
    const current = this.balances.get(callerId) ?? 0;
    this.balances.set(callerId, round(current + amount));
    this.transactions.push({
      type: "credit",
      callerId,
      amount,
      meta,
      timestamp: Date.now(),
    });
  }

  async getUsage(callerId: string, tool: string, period: string): Promise<number> {
    const key = `${callerId}:${tool}:${currentPeriod(period)}`;
    return this.usage.get(key) ?? 0;
  }

  async incrementUsage(callerId: string, tool: string, period: string): Promise<void> {
    const key = `${callerId}:${tool}:${currentPeriod(period)}`;
    this.usage.set(key, (this.usage.get(key) ?? 0) + 1);
  }

  // ─── Debug helpers ─────────────────────────────────────

  getTransactions() {
    return [...this.transactions];
  }

  getAllBalances() {
    return Object.fromEntries(this.balances);
  }
}

// ─── Helpers ─────────────────────────────────────────────

function round(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000; // 6 decimal places
}

function currentPeriod(period: string): string {
  const d = new Date();
  switch (period) {
    case "hour":
      return `${d.toISOString().slice(0, 13)}`;
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
