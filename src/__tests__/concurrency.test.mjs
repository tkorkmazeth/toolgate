/**
 * Concurrency Tests
 *
 * These tests run against the REAL compiled runtime (../../dist/index.js),
 * not an inline re-implementation. They prove the property that separates
 * Toolgate from payment-rail idempotency: N parallel identical calls
 * collapse into exactly ONE provider call and ONE charge — the rest wait
 * for the in-flight execution and replay its result.
 *
 *   1. In-memory store + runtime: 50 parallel identical calls → 1 charge.
 *   2. DbIdempotencyStore atomic claim: two "instances" sharing one DB
 *      race to claim the same key → exactly one winner. Plus the full
 *      claim → complete → replay and fail → reclaim lifecycle.
 *   3. DbIdempotencyStore through the runtime: durable, cross-instance
 *      idempotency end-to-end → 1 charge under concurrency.
 *
 * Run: npm run build && node --test src/__tests__/concurrency.test.mjs
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  ToolGate,
  InMemoryLedger,
  InMemoryIdempotencyStore,
  DbIdempotencyStore,
  usd,
  toNumber,
} from "../../dist/index.js";

// ─── Helpers ──────────────────────────────────────────────

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function seed(ledger, callerId, amount) {
  await ledger.credit(callerId, usd(amount), {
    source: "manual",
    reference: `seed-${callerId}`,
  });
}

/**
 * Minimal in-memory DbClient that faithfully models the atomic primitives
 * DbIdempotencyStore relies on (INSERT OR IGNORE, conditional UPDATE … WHERE,
 * SELECT). Mutations in run() are synchronous, so two stores sharing one
 * instance serialise exactly as a single shared database would — this is
 * what lets us simulate two server instances racing on the same DB.
 */
class MockDb {
  constructor() {
    this.rows = new Map();
  }
  prepare(sql) {
    return new MockStmt(this, sql);
  }
  _tag(sql) {
    const m = sql.match(/tg_idem_(\w+)/);
    return m ? m[1] : null;
  }
  _exec(sql, args) {
    switch (this._tag(sql)) {
      case "insert": {
        const [key, owner, lease, expires, trace, now1, now2] = args;
        if (this.rows.has(key)) return { success: true, changes: 0 };
        this.rows.set(key, {
          key,
          status: "in_progress",
          owner_id: owner,
          lease_expires_at: lease,
          expires_at: expires,
          trace_id: trace,
          result: null,
          error: null,
          created_at: now1,
          updated_at: now2,
          version: 1,
        });
        return { success: true, changes: 1 };
      }
      case "reclaim": {
        const [owner, lease, expires, trace, now, key, nowExp, nowLease] = args;
        const r = this.rows.get(key);
        if (!r) return { success: true, changes: 0 };
        const reclaimable =
          r.expires_at < nowExp ||
          r.status === "failed" ||
          (r.status === "in_progress" && r.lease_expires_at < nowLease);
        if (!reclaimable) return { success: true, changes: 0 };
        Object.assign(r, {
          status: "in_progress",
          owner_id: owner,
          lease_expires_at: lease,
          expires_at: expires,
          trace_id: trace,
          updated_at: now,
          version: r.version + 1,
          result: null,
          error: null,
        });
        return { success: true, changes: 1 };
      }
      case "complete": {
        const [result, now, key, owner] = args;
        const r = this.rows.get(key);
        if (!r || r.owner_id !== owner) return { success: true, changes: 0 };
        Object.assign(r, {
          status: "completed",
          result,
          updated_at: now,
          version: r.version + 1,
        });
        return { success: true, changes: 1 };
      }
      case "fail": {
        const [error, now, key, owner] = args;
        const r = this.rows.get(key);
        if (!r || r.owner_id !== owner) return { success: true, changes: 0 };
        Object.assign(r, {
          status: "failed",
          error,
          updated_at: now,
          version: r.version + 1,
        });
        return { success: true, changes: 1 };
      }
      case "heartbeat": {
        const [lease, now, key, owner] = args;
        const r = this.rows.get(key);
        if (!r || r.owner_id !== owner || r.status !== "in_progress")
          return { success: true, changes: 0 };
        Object.assign(r, { lease_expires_at: lease, updated_at: now });
        return { success: true, changes: 1 };
      }
      default:
        return { success: true, changes: 0 };
    }
  }
  _select(args) {
    const r = this.rows.get(args[0]);
    return r ? { ...r } : null;
  }
}

class MockStmt {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }
  bind(...values) {
    this.args = values;
    return this;
  }
  async run() {
    return this.db._exec(this.sql, this.args);
  }
  async first() {
    return this.db._select(this.args);
  }
  async all() {
    return { results: [] };
  }
}

// ─── 1. In-memory store + runtime ─────────────────────────

describe("Concurrency: in-memory runtime", () => {
  let ledger, gate;

  beforeEach(() => {
    ledger = new InMemoryLedger();
    gate = new ToolGate({
      publisherKey: "tg_test",
      ledger,
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
  });

  it("50 parallel identical calls → 1 handler call, 1 charge, 50 identical results", async () => {
    await seed(ledger, "user1", "5.00");
    let handlerCalls = 0;

    const search = gate.paidTool({
      name: "search",
      price: "0.10",
      handler: async () => {
        handlerCalls++;
        await delay(40); // widen the concurrency window
        return { result: "premium data", n: handlerCalls };
      },
    });

    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, () => search({ q: "same" }, "user1")),
    );

    // Provider hit exactly once.
    assert.equal(handlerCalls, 1, "handler must run exactly once");

    // Every caller got a successful result, all identical (replayed).
    for (const r of results) {
      assert.ok(r.success, "every concurrent caller should succeed");
      assert.deepEqual(r.output, results[0].output);
    }

    // Charged exactly once: 5.00 - 0.10 = 4.90.
    const balance = toNumber(await ledger.getBalance("user1"));
    assert.ok(
      Math.abs(balance - 4.9) < 1e-9,
      `expected balance 4.90 (one charge), got ${balance}`,
    );
  });

  it("distinct inputs run concurrently and each charges once", async () => {
    await seed(ledger, "user1", "5.00");
    let handlerCalls = 0;

    const search = gate.paidTool({
      name: "search_distinct",
      price: "0.10",
      handler: async (input) => {
        handlerCalls++;
        await delay(20);
        return { echo: input.q };
      },
    });

    await Promise.all([
      search({ q: "a" }, "user1"),
      search({ q: "b" }, "user1"),
      search({ q: "c" }, "user1"),
    ]);

    assert.equal(handlerCalls, 3, "distinct inputs are not duplicates");
    const balance = toNumber(await ledger.getBalance("user1"));
    assert.ok(Math.abs(balance - 4.7) < 1e-9, `expected 4.70, got ${balance}`);
  });
});

// ─── 2. DbIdempotencyStore atomic claim (cross-instance) ──

describe("Concurrency: DbIdempotencyStore atomic claim", () => {
  it("two instances racing on one DB → exactly one winner", async () => {
    const db = new MockDb();
    const instanceA = new DbIdempotencyStore(db);
    const instanceB = new DbIdempotencyStore(db);

    const [a, b] = await Promise.all([
      instanceA.claim({
        key: "k1",
        ownerId: "owner-a",
        leaseMs: 30_000,
        traceId: "trace-a",
      }),
      instanceB.claim({
        key: "k1",
        ownerId: "owner-b",
        leaseMs: 30_000,
        traceId: "trace-b",
      }),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(
      statuses,
      ["claimed", "in_progress"],
      "exactly one claimer wins; the other sees in_progress",
    );
  });

  it("claim → complete → replay returns cached result", async () => {
    const db = new MockDb();
    const store = new DbIdempotencyStore(db);

    const first = await store.claim({
      key: "k2",
      ownerId: "o1",
      leaseMs: 30_000,
      traceId: "t1",
    });
    assert.equal(first.status, "claimed");

    const ok = await store.complete("k2", "o1", { answer: 42 });
    assert.equal(ok, true);

    const replay = await store.claim({
      key: "k2",
      ownerId: "o2",
      leaseMs: 30_000,
      traceId: "t2",
    });
    assert.equal(replay.status, "completed");
    assert.deepEqual(replay.record.result, { answer: 42 });
  });

  it("complete() by a non-owner is rejected", async () => {
    const db = new MockDb();
    const store = new DbIdempotencyStore(db);
    await store.claim({
      key: "k3",
      ownerId: "real-owner",
      leaseMs: 30_000,
      traceId: "t",
    });
    const stolen = await store.complete("k3", "impostor", { x: 1 });
    assert.equal(stolen, false, "only the lease owner may complete");
  });

  it("failed record is reclaimable for retry", async () => {
    const db = new MockDb();
    const store = new DbIdempotencyStore(db);

    await store.claim({
      key: "k4",
      ownerId: "o1",
      leaseMs: 30_000,
      traceId: "t1",
    });
    await store.fail("k4", "o1", { message: "boom" });

    const retry = await store.claim({
      key: "k4",
      ownerId: "o2",
      leaseMs: 30_000,
      traceId: "t2",
    });
    assert.equal(retry.status, "claimed", "failed records are retryable");
  });

  it("expired lease is reclaimable; active lease is not", async () => {
    const db = new MockDb();
    const store = new DbIdempotencyStore(db);

    // Claim with a lease that is already expired (leaseMs = 0).
    await store.claim({ key: "k5", ownerId: "o1", leaseMs: 0, traceId: "t1" });
    await delay(2);

    const reclaim = await store.claim({
      key: "k5",
      ownerId: "o2",
      leaseMs: 30_000,
      traceId: "t2",
    });
    assert.equal(reclaim.status, "claimed", "dead lease should be reclaimable");

    // Now the lease is active again → a third claimer must be blocked.
    const blocked = await store.claim({
      key: "k5",
      ownerId: "o3",
      leaseMs: 30_000,
      traceId: "t3",
    });
    assert.equal(blocked.status, "in_progress", "active lease blocks reclaim");
  });
});

// ─── 3. DbIdempotencyStore through the runtime ────────────

describe("Concurrency: durable store end-to-end", () => {
  it("durable idempotency collapses parallel calls to one charge", async () => {
    const ledger = new InMemoryLedger();
    await seed(ledger, "user1", "5.00");
    const gate = new ToolGate({
      publisherKey: "tg_test",
      ledger,
      idempotencyStore: new DbIdempotencyStore(new MockDb()),
    });

    let handlerCalls = 0;
    const scrape = gate.paidTool({
      name: "scrape_url",
      price: "0.10",
      handler: async () => {
        handlerCalls++;
        await delay(40);
        return { html: "<html>…</html>" };
      },
    });

    const results = await Promise.all(
      Array.from({ length: 25 }, () => scrape({ url: "https://x.test" }, "user1")),
    );

    assert.equal(handlerCalls, 1, "durable store must dedupe to one call");
    for (const r of results) assert.ok(r.success);
    const balance = toNumber(await ledger.getBalance("user1"));
    assert.ok(
      Math.abs(balance - 4.9) < 1e-9,
      `expected one charge (4.90), got ${balance}`,
    );
  });
});
