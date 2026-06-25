/**
 * Settlement-uncertainty recovery (Phase B).
 *
 * Unit: settleWithRetry backoff, the in-memory pending store, and the reconciler.
 * Integration: a flaky x402 rail whose settle fails after execution gets queued
 * by the MCP adapter, then drained by gate.reconcileSettlements().
 *
 * Run: node --test src/__tests__/settlement-recovery.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ToolGate,
  InMemoryLedger,
  createMcpAdapter,
  usd,
  settleWithRetry,
  InMemoryPendingSettlementStore,
  DbPendingSettlementStore,
  SettlementReconciler,
  startSettlementReconciler,
} from "../../dist/index.js";
import { tryCreateSqliteClient } from "./_sqlite-client.mjs";

const noSleep = async () => {};
const SETTLEMENT = {
  settled: true,
  rail: "x402",
  txHash: "0xSETTLED",
  amount: 0.05,
  currency: "usd",
  receiptId: "0xSETTLED",
};

/** A settlePayment that fails (null/throw) `failTimes` times, then succeeds. */
function flakySettler({ failTimes, mode = "null" }) {
  let calls = 0;
  return {
    rail: "x402",
    calls: () => calls,
    async settlePayment() {
      calls++;
      if (calls <= failTimes) {
        if (mode === "throw") throw new Error("facilitator_timeout");
        return null;
      }
      return SETTLEMENT;
    },
  };
}

// ─── settleWithRetry ──────────────────────────────────────

describe("settleWithRetry", () => {
  it("absorbs transient failures and settles", async () => {
    const a = flakySettler({ failTimes: 2 });
    const out = await settleWithRetry(a, {}, undefined, {
      retries: 3,
      sleep: noSleep,
    });
    assert.equal(out.result?.txHash, "0xSETTLED");
    assert.equal(out.attempts, 3, "two failures + one success");
  });

  it("gives up after the retry budget, surfacing attempts + lastError", async () => {
    const a = flakySettler({ failTimes: 99, mode: "throw" });
    const out = await settleWithRetry(a, {}, undefined, {
      retries: 2,
      sleep: noSleep,
    });
    assert.equal(out.result, null);
    assert.equal(out.attempts, 3, "1 + 2 retries");
    assert.equal(out.lastError, "facilitator_timeout");
  });
});

// ─── store + reconciler ───────────────────────────────────

describe("InMemoryPendingSettlementStore", () => {
  it("enqueues, updates, and removes", async () => {
    const store = new InMemoryPendingSettlementStore();
    await store.enqueue({ id: "a", rail: "x402", proof: {} });
    await store.enqueue({ id: "b", rail: "x402", proof: {} });
    assert.equal(store.size, 2);
    await store.update("a", { attempts: 5, lastError: "x" });
    assert.equal((await store.get("a")).attempts, 5);
    await store.remove("b");
    assert.equal(store.size, 1);
    assert.equal((await store.list()).length, 1);
  });
});

describe("SettlementReconciler", () => {
  it("drains the queue when the adapter settles", async () => {
    const store = new InMemoryPendingSettlementStore();
    await store.enqueue({ id: "a", rail: "x402", proof: {} });
    await store.enqueue({ id: "b", rail: "x402", proof: {} });

    const adapter = flakySettler({ failTimes: 0 });
    const reconciler = new SettlementReconciler(() => adapter, store, {
      sleep: noSleep,
    });
    const r = await reconciler.reconcileOnce();

    assert.equal(r.settled.length, 2);
    assert.equal(r.remaining, 0);
    assert.equal(store.size, 0);
  });

  it("keeps failing entries queued with attempts accumulated", async () => {
    const store = new InMemoryPendingSettlementStore();
    await store.enqueue({ id: "a", rail: "x402", proof: {} });

    const adapter = flakySettler({ failTimes: 99, mode: "throw" });
    const reconciler = new SettlementReconciler(() => adapter, store, {
      retries: 1,
      sleep: noSleep,
    });

    const r1 = await reconciler.reconcileOnce();
    assert.equal(r1.settled.length, 0);
    assert.equal(r1.failures[0].error, "facilitator_timeout");
    assert.equal(r1.remaining, 1);
    assert.equal((await store.get("a")).attempts, 2);

    await reconciler.reconcileOnce();
    assert.equal((await store.get("a")).attempts, 4, "attempts accumulate across passes");
  });

  it("flags items whose rail has no adapter", async () => {
    const store = new InMemoryPendingSettlementStore();
    await store.enqueue({ id: "a", rail: "x402", proof: {} });
    const reconciler = new SettlementReconciler(() => undefined, store, {
      sleep: noSleep,
    });
    const r = await reconciler.reconcileOnce();
    assert.equal(r.failures[0].error, "no_adapter_for_rail");
    assert.equal(r.remaining, 1);
  });
});

// ─── integration: MCP settle fails → queued → reconciled ──

function buildGate(rail, settleRetry) {
  const gate = new ToolGate({
    publisherKey: "tg_recovery",
    ledger: new InMemoryLedger(),
    paymentRails: ["x402"],
    railAdapters: [rail],
  });
  const mcp = createMcpAdapter(gate, {
    getCallerId: () => "c1",
    settleRetry,
  });
  const tool = mcp.paidTool("t", {
    description: "paid",
    price: usd("0.05"),
    onPaymentFailed: "block",
    inputSchema: { type: "object", properties: { requestId: { type: "string" } } },
    idempotencyKey: (args) => `t:${args.requestId}`,
    handler: async () => ({ ok: true }),
  });
  return { gate, tool };
}

describe("recovery loop through TollGate + MCP adapter", () => {
  it("queues an unsettled payment and reconciles it later", async () => {
    // settle fails twice; MCP retries once (2 attempts) → both fail → queued
    const rail = {
      ...flakySettler({ failTimes: 2 }),
      async verifyPayment() {
        return {
          verified: true,
          rail: "x402",
          amount: 0.05,
          currency: "usd",
          receiptId: "vrfy",
        };
      },
    };
    const { gate, tool } = buildGate(rail, { retries: 1, sleep: noSleep });

    const res = await tool.handler(
      { requestId: "r1" },
      {
        _meta: {
          tollgate: { x402Payment: { x402Version: 2 }, x402ActionId: "act-1" },
        },
      },
    );

    assert.notEqual(res.isError, true, "tool executed");
    const queued = await gate.pendingSettlements.list();
    assert.equal(queued.length, 1, "unsettled payment was queued");
    assert.equal(queued[0].id, "act-1");
    assert.equal(queued[0].rail, "x402");

    // The trace marks it uncertain + queued.
    const trace = await gate.traces.findByIdempotencyKey("t:r1");
    const events = trace.events.map((e) => e.event);
    assert.ok(events.includes("settlement_uncertain"));

    // Now reconcile — the 3rd settle attempt succeeds.
    const result = await gate.reconcileSettlements({ retries: 0, sleep: noSleep });
    assert.equal(result.settled.length, 1);
    assert.equal(result.settled[0].settlement.txHash, "0xSETTLED");
    assert.equal(result.remaining, 0);
    assert.equal((await gate.pendingSettlements.list()).length, 0);
  });
});

// ─── B+ : on-chain confirmation (two-phase) ───────────────

describe("SettlementReconciler with a ChainConfirmer", () => {
  it("settles once, awaits confirmation, then dequeues — never re-settling", async () => {
    const store = new InMemoryPendingSettlementStore();
    await store.enqueue({ id: "x", rail: "x402", proof: {} });

    const adapter = flakySettler({ failTimes: 0 }); // settles → txHash 0xSETTLED
    let confirmCalls = 0;
    const confirmer = {
      isConfirmed: async () => {
        confirmCalls++;
        return confirmCalls >= 2; // not confirmed on first check
      },
    };
    const reconciler = new SettlementReconciler(() => adapter, store, {
      sleep: noSleep,
      confirmer,
    });

    const r1 = await reconciler.reconcileOnce();
    assert.equal(r1.settled.length, 0);
    assert.equal(r1.pendingConfirmation.length, 1);
    assert.equal(r1.remaining, 1);
    assert.equal(adapter.calls(), 1, "settled exactly once");
    assert.equal((await store.get("x")).submittedTxHash, "0xSETTLED");

    const r2 = await reconciler.reconcileOnce();
    assert.equal(r2.settled.length, 1);
    assert.equal(r2.settled[0].txHash, "0xSETTLED");
    assert.equal(r2.remaining, 0);
    assert.equal(
      adapter.calls(),
      1,
      "second pass only confirmed — did NOT re-submit the tx",
    );
  });
});

// ─── B+ : durable SQLite store ────────────────────────────

describe("DbPendingSettlementStore (sqlite)", () => {
  it("persists with JSON round-trip; update preserves enqueuedAt", async (t) => {
    const db = await tryCreateSqliteClient();
    if (!db) {
      t.skip("better-sqlite3 unavailable");
      return;
    }
    await DbPendingSettlementStore.applySchema(db);
    const store = new DbPendingSettlementStore(db);

    await store.enqueue({
      id: "a",
      rail: "x402",
      proof: { rail: "x402", x402PaymentPayload: { foo: 1 } },
      context: { actionId: "act-a" },
      toolName: "search",
      callerId: "c1",
      amount: 0.05,
    });

    const got = await store.get("a");
    assert.equal(got.rail, "x402");
    assert.deepEqual(got.proof, { rail: "x402", x402PaymentPayload: { foo: 1 } });
    assert.equal(got.context.actionId, "act-a");
    assert.equal(got.amount, 0.05);
    const enqueuedAt = got.enqueuedAt;

    await store.update("a", {
      attempts: 3,
      submittedTxHash: "0xabc",
      lastError: "boom",
    });
    const updated = await store.get("a");
    assert.equal(updated.attempts, 3);
    assert.equal(updated.submittedTxHash, "0xabc");
    assert.equal(updated.lastError, "boom");
    assert.equal(updated.enqueuedAt, enqueuedAt, "enqueuedAt preserved");

    await store.enqueue({ id: "b", rail: "x402", proof: {} });
    assert.equal((await store.list()).length, 2);
    await store.remove("a");
    const rest = await store.list();
    assert.equal(rest.length, 1);
    assert.equal(rest[0].id, "b");
  });

  it("reconciles a durable queue end-to-end", async (t) => {
    const db = await tryCreateSqliteClient();
    if (!db) {
      t.skip("better-sqlite3 unavailable");
      return;
    }
    await DbPendingSettlementStore.applySchema(db);
    const store = new DbPendingSettlementStore(db);
    await store.enqueue({ id: "q", rail: "x402", proof: {} });

    const adapter = flakySettler({ failTimes: 1 });
    const reconciler = new SettlementReconciler(() => adapter, store, {
      retries: 0,
      sleep: noSleep,
    });

    const r1 = await reconciler.reconcileOnce(); // 1 attempt, fails → stays
    assert.equal(r1.remaining, 1);
    const r2 = await reconciler.reconcileOnce(); // succeeds → dequeued
    assert.equal(r2.settled.length, 1);
    assert.equal(r2.remaining, 0);
  });
});

// ─── B+ : scheduled loop ──────────────────────────────────

describe("startSettlementReconciler", () => {
  const empty = {
    settled: [],
    pendingConfirmation: [],
    failures: [],
    remaining: 0,
  };

  it("ticks on demand and stops cleanly", async () => {
    let count = 0;
    const handle = startSettlementReconciler(
      async () => {
        count++;
        return empty;
      },
      { intervalMs: 5 },
    );
    await handle.tick();
    await handle.tick();
    assert.ok(count >= 2);
    handle.stop();
    const after = count;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(count, after, "no ticks after stop()");
  });

  it("skips overlapping ticks", async () => {
    let active = 0;
    let maxActive = 0;
    const handle = startSettlementReconciler(
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return empty;
      },
      { intervalMs: 1 },
    );
    const p1 = handle.tick();
    const p2 = handle.tick(); // running → skipped (resolves null)
    await Promise.all([p1, p2]);
    handle.stop();
    assert.equal(maxActive, 1, "no overlapping reconcile passes");
  });
});
