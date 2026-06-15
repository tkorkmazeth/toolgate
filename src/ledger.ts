import {
  type Money,
  type TransactionId,
  usd,
  add,
  subtract,
  gte,
} from "./money.js";
import type { LedgerAdapter, DeductMeta, CreditMeta } from "./types.js";
import { randomUUID } from "node:crypto";

/**
 * In-memory ledger for MVP / local development.
 *
 * All balances are stored as Money (bigint minor units) — no floating point.
 */
export class InMemoryLedger implements LedgerAdapter {
  private balances = new Map<string, Money>();
  private usage = new Map<string, number>(); // key: `${callerId}:${tool}:${period}`
  private transactions: Array<{
    txId: TransactionId;
    type: "deduct" | "credit";
    callerId: string;
    amount: Money;
    meta: DeductMeta | CreditMeta;
    timestamp: number;
  }> = [];

  async getBalance(callerId: string): Promise<Money> {
    return this.balances.get(callerId) ?? usd("0.00");
  }

  async deduct(
    callerId: string,
    amount: Money,
    meta: DeductMeta,
  ): Promise<{ success: boolean; txId: TransactionId }> {
    const current = this.balances.get(callerId) ?? usd("0.00");
    if (!gte(current, amount)) {
      return { success: false, txId: "" };
    }

    const newBalance = subtract(current, amount);
    this.balances.set(callerId, newBalance);
    const txId = randomUUID();
    this.transactions.push({
      txId,
      type: "deduct",
      callerId,
      amount,
      meta,
      timestamp: Date.now(),
    });
    return { success: true, txId };
  }

  async credit(
    callerId: string,
    amount: Money,
    meta: CreditMeta,
  ): Promise<TransactionId> {
    const current = this.balances.get(callerId) ?? usd("0.00");
    const newBalance = add(current, amount);
    this.balances.set(callerId, newBalance);
    const txId = randomUUID();
    this.transactions.push({
      txId,
      type: "credit",
      callerId,
      amount,
      meta,
      timestamp: Date.now(),
    });
    return txId;
  }

  async getUsage(
    callerId: string,
    tool: string,
    period: string,
  ): Promise<number> {
    const key = `${callerId}:${tool}:${currentPeriod(period)}`;
    return this.usage.get(key) ?? 0;
  }

  async incrementUsage(
    callerId: string,
    tool: string,
    period: string,
  ): Promise<void> {
    const key = `${callerId}:${tool}:${currentPeriod(period)}`;
    this.usage.set(key, (this.usage.get(key) ?? 0) + 1);
  }

  // ─── Debug helpers ─────────────────────────────────────

  getTransactions() {
    return [...this.transactions];
  }

  getAllBalances() {
    return Object.fromEntries(
      Array.from(this.balances.entries()).map(([k, v]) => [k, v]),
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────

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
