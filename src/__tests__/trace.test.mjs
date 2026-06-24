/**
 * Phase 2 — Execution Trace Tests
 *
 * 1. InMemoryTraceStore unit tests (save/get/getByIdempotencyKey/list/count)
 * 2. TollGate trace recording (trace created per call, events, chargeStatus)
 *
 * Run: node --test src/__tests__/trace.test.mjs
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── InMemoryTraceStore (inline) ─────────────────────────

class InMemoryTraceStore {
  constructor(maxSize = 100_000) {
    this.traces = [];
    this.byId = new Map();
    this.byKey = new Map();
    this.maxSize = maxSize;
  }

  async save(trace) {
    if (this.traces.length >= this.maxSize) {
      const oldest = this.traces.shift();
      if (oldest) {
        this.byId.delete(oldest.traceId);
        if (oldest.idempotencyKey) this.byKey.delete(oldest.idempotencyKey);
      }
    }
    this.traces.push(trace);
    this.byId.set(trace.traceId, trace);
    if (trace.idempotencyKey) this.byKey.set(trace.idempotencyKey, trace);
  }

  async get(traceId) {
    return this.byId.get(traceId) ?? null;
  }

  async getByIdempotencyKey(key) {
    return this.byKey.get(key) ?? null;
  }

  async list(filters = {}) {
    let result = [...this.traces];
    if (filters.callerId)
      result = result.filter((t) => t.callerId === filters.callerId);
    if (filters.toolName)
      result = result.filter((t) => t.toolName === filters.toolName);
    if (filters.limit) result = result.slice(-filters.limit);
    return result;
  }

  get count() {
    return this.traces.length;
  }
}

// ─── InMemoryIdempotencyStore (inline) ───────────────────

class InMemoryIdempotencyStore {
  constructor() {
    this.store = new Map();
  }

  async get(key) {
    const record = this.store.get(key);
    if (!record) return null;
    if (record.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return record;
  }

  async set(record) {
    this.store.set(record.key, record);
  }

  async update(key, updates) {
    const existing = this.store.get(key);
    if (existing)
      this.store.set(key, { ...existing, ...updates, updatedAt: Date.now() });
  }

  async delete(key) {
    this.store.delete(key);
  }
  get size() {
    return this.store.size;
  }
}

// ─── InMemoryLedger ───────────────────────────────────────

class InMemoryLedger {
  constructor() {
    this.balances = new Map();
  }
  async getBalance(id) {
    return this.balances.get(id) ?? 0;
  }
  async deduct(id, amount) {
    const current = this.balances.get(id) ?? 0;
    if (current < amount) return false;
    this.balances.set(id, Math.round((current - amount) * 1e6) / 1e6);
    return true;
  }
  async credit(id, amount) {
    const current = this.balances.get(id) ?? 0;
    this.balances.set(id, Math.round((current + amount) * 1e6) / 1e6);
  }
  async getUsage() {
    return 0;
  }
  async incrementUsage() {}
}

// ─── Helpers ─────────────────────────────────────────────

function hashSync(input) {
  const str = JSON.stringify(input) ?? "";
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (((hash << 5) + hash) ^ str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function makeTraceId() {
  return `tg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Minimal TollGate with trace ─────────────────────────

class TollGate {
  constructor(config) {
    this.ledger = config.ledger ?? new InMemoryLedger();
    this.idempotencyStore =
      config.idempotencyStore ?? new InMemoryIdempotencyStore();
    this.traceStore = config.traceStore ?? new InMemoryTraceStore();
    this.idempotencyTtlSeconds = config.idempotencyTtlSeconds ?? 3600;
    this.defaultCurrency = config.defaultCurrency ?? "usd";
    this.hooks = config.hooks;
  }

  get traces() {
    return this.traceStore;
  }
  get idempotency() {
    return this.idempotencyStore;
  }

  paidTool(toolConfig) {
    const execute = (input, callerId) =>
      this._executeTool(toolConfig, input, callerId);
    execute.config = toolConfig;
    return execute;
  }

  _resolveKey(tool, input, callerId) {
    if (typeof tool.idempotencyKey === "string") return tool.idempotencyKey;
    if (typeof tool.idempotencyKey === "function")
      return tool.idempotencyKey(input, callerId);
    return `auto_${tool.name}_${callerId}_${hashSync(input)}`;
  }

  async _executeTool(tool, input, callerId) {
    const traceId = makeTraceId();
    const now = Date.now();
    const idempotencyKey = this._resolveKey(tool, input, callerId);
    const inputHash = hashSync(input);

    const existing = await this.idempotencyStore.get(idempotencyKey);
    if (existing && existing.status !== "in_progress" && existing.result) {
      return existing.result;
    }

    await this.idempotencyStore.set({
      key: idempotencyKey,
      callerId,
      toolName: tool.name,
      inputHash,
      status: "in_progress",
      traceId,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.idempotencyTtlSeconds * 1000,
    });

    const price = typeof tool.price === "number" ? tool.price : 0;
    const needsPayment = price > 0;

    const trace = {
      traceId,
      idempotencyKey,
      callerId,
      toolName: tool.name,
      inputHash,
      estimatedAmount: price,
      finalAmount: 0,
      currency: this.defaultCurrency,
      decision: "execute",
      rail: "prepaid",
      chargeStatus: "none",
      createdAt: now,
      updatedAt: now,
      events: [{ timestamp: now, event: "trace_created" }],
    };

    if (needsPayment) {
      const deducted = await this.ledger.deduct(callerId, price);
      if (!deducted) {
        trace.chargeStatus = "failed";
        trace.events.push({ timestamp: Date.now(), event: "payment_failed" });
        await this.traceStore.save(trace);
        const result = {
          success: false,
          paymentRequired: {
            status: 402,
            error: "payment_required",
            tool: tool.name,
            amount: price,
            currency: this.defaultCurrency,
            acceptedRails: ["stripe"],
          },
        };
        await this.idempotencyStore.update(idempotencyKey, {
          status: "requires_payment",
          result,
          updatedAt: Date.now(),
        });
        return result;
      }
      trace.finalAmount = price;
      trace.chargeStatus = "charged";
      trace.events.push({
        timestamp: Date.now(),
        event: "payment_deducted",
        detail: String(price),
      });
    }

    trace.events.push({ timestamp: Date.now(), event: "handler_started" });

    let output;
    try {
      output = await tool.handler(input, {
        callerId,
        callId: traceId,
        tool: tool.name,
        tier: "premium",
        balance: await this.ledger.getBalance(callerId),
        timestamp: Date.now(),
      });
    } catch (err) {
      if (needsPayment) {
        await this.ledger.credit(callerId, price);
        trace.chargeStatus = "refunded";
        trace.events.push({
          timestamp: Date.now(),
          event: "refunded",
          detail: err.message,
        });
      }
      trace.decision = "error";
      trace.events.push({
        timestamp: Date.now(),
        event: "handler_error",
        detail: err.message,
      });
      await this.traceStore.save(trace);
      const result = { success: false, output: { error: err.message } };
      await this.idempotencyStore.update(idempotencyKey, {
        status: "failed",
        result,
        updatedAt: Date.now(),
      });
      return result;
    }

    trace.events.push({ timestamp: Date.now(), event: "handler_success" });
    trace.events.push({ timestamp: Date.now(), event: "call_completed" });
    await this.traceStore.save(trace);

    const balanceAfter = await this.ledger.getBalance(callerId);
    const result = {
      success: true,
      output,
      receipt:
        price > 0
          ? {
              callId: traceId,
              tool: tool.name,
              amount: price,
              currency: this.defaultCurrency,
              rail: "prepaid",
              balanceAfter,
              timestamp: Date.now(),
            }
          : undefined,
      isFallback: false,
      traceId,
    };

    await this.idempotencyStore.update(idempotencyKey, {
      status: "completed",
      result,
      updatedAt: Date.now(),
    });
    return result;
  }
}

// ─── Tests: InMemoryTraceStore unit tests ─────────────────

describe("InMemoryTraceStore", () => {
  it("returns null for unknown traceId", async () => {
    const store = new InMemoryTraceStore();
    const result = await store.get("unknown_trace");
    assert.equal(result, null);
  });

  it("saves and retrieves a trace by traceId", async () => {
    const store = new InMemoryTraceStore();
    const trace = {
      traceId: "trace-001",
      idempotencyKey: "idem-key-001",
      callerId: "user1",
      toolName: "search",
      inputHash: "abc",
      estimatedAmount: 0.1,
      finalAmount: 0.1,
      currency: "usd",
      decision: "execute",
      chargeStatus: "charged",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      events: [],
    };
    await store.save(trace);
    const retrieved = await store.get("trace-001");
    assert.ok(retrieved);
    assert.equal(retrieved.traceId, "trace-001");
    assert.equal(retrieved.callerId, "user1");
  });

  it("retrieves a trace by idempotency key", async () => {
    const store = new InMemoryTraceStore();
    const trace = {
      traceId: "trace-002",
      idempotencyKey: "idem-key-002",
      callerId: "user2",
      toolName: "lookup",
      inputHash: "def",
      estimatedAmount: 0,
      finalAmount: 0,
      currency: "usd",
      decision: "execute",
      chargeStatus: "none",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      events: [],
    };
    await store.save(trace);
    const retrieved = await store.getByIdempotencyKey("idem-key-002");
    assert.ok(retrieved);
    assert.equal(retrieved.traceId, "trace-002");
  });

  it("returns null for unknown idempotency key", async () => {
    const store = new InMemoryTraceStore();
    const result = await store.getByIdempotencyKey("not_there");
    assert.equal(result, null);
  });

  it("lists all traces", async () => {
    const store = new InMemoryTraceStore();
    for (let i = 0; i < 3; i++) {
      await store.save({
        traceId: `trace-list-${i}`,
        idempotencyKey: `key-list-${i}`,
        callerId: "user1",
        toolName: "search",
        inputHash: `h${i}`,
        estimatedAmount: 0.1,
        finalAmount: 0.1,
        currency: "usd",
        decision: "execute",
        chargeStatus: "charged",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        events: [],
      });
    }
    const all = await store.list();
    assert.equal(all.length, 3);
  });

  it("list filters by callerId", async () => {
    const store = new InMemoryTraceStore();
    await store.save({
      traceId: "t1",
      idempotencyKey: "k1",
      callerId: "alice",
      toolName: "search",
      inputHash: "h1",
      estimatedAmount: 0,
      finalAmount: 0,
      currency: "usd",
      decision: "execute",
      chargeStatus: "none",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      events: [],
    });
    await store.save({
      traceId: "t2",
      idempotencyKey: "k2",
      callerId: "bob",
      toolName: "search",
      inputHash: "h2",
      estimatedAmount: 0,
      finalAmount: 0,
      currency: "usd",
      decision: "execute",
      chargeStatus: "none",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      events: [],
    });

    const aliceTraces = await store.list({ callerId: "alice" });
    assert.equal(aliceTraces.length, 1);
    assert.equal(aliceTraces[0].callerId, "alice");
  });

  it("list filters by toolName", async () => {
    const store = new InMemoryTraceStore();
    await store.save({
      traceId: "t3",
      idempotencyKey: "k3",
      callerId: "user1",
      toolName: "search",
      inputHash: "h3",
      estimatedAmount: 0,
      finalAmount: 0,
      currency: "usd",
      decision: "execute",
      chargeStatus: "none",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      events: [],
    });
    await store.save({
      traceId: "t4",
      idempotencyKey: "k4",
      callerId: "user1",
      toolName: "lookup",
      inputHash: "h4",
      estimatedAmount: 0,
      finalAmount: 0,
      currency: "usd",
      decision: "execute",
      chargeStatus: "none",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      events: [],
    });

    const searchTraces = await store.list({ toolName: "search" });
    assert.equal(searchTraces.length, 1);
    assert.equal(searchTraces[0].toolName, "search");
  });

  it("list supports limit", async () => {
    const store = new InMemoryTraceStore();
    for (let i = 0; i < 5; i++) {
      await store.save({
        traceId: `tl-${i}`,
        idempotencyKey: `kl-${i}`,
        callerId: "user1",
        toolName: "tool",
        inputHash: `h${i}`,
        estimatedAmount: 0,
        finalAmount: 0,
        currency: "usd",
        decision: "execute",
        chargeStatus: "none",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        events: [],
      });
    }
    const limited = await store.list({ limit: 3 });
    assert.equal(limited.length, 3);
  });

  it("count returns number of traces", async () => {
    const store = new InMemoryTraceStore();
    assert.equal(store.count, 0);
    await store.save({
      traceId: "tc1",
      idempotencyKey: "kc1",
      callerId: "u",
      toolName: "t",
      inputHash: "h",
      estimatedAmount: 0,
      finalAmount: 0,
      currency: "usd",
      decision: "execute",
      chargeStatus: "none",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      events: [],
    });
    assert.equal(store.count, 1);
  });
});

// ─── Tests: TollGate trace integration ───────────────────

describe("Execution Trace", () => {
  let ledger, gate;

  beforeEach(() => {
    ledger = new InMemoryLedger();
    gate = new TollGate({ ledger, publisherKey: "tg_test" });
  });

  it("gate.traces returns the trace store", () => {
    assert.ok(gate.traces instanceof InMemoryTraceStore);
  });

  it("gate.idempotency returns the idempotency store", () => {
    assert.ok(gate.idempotency instanceof InMemoryIdempotencyStore);
  });

  it("creates a trace for every paid tool call", async () => {
    ledger.balances.set("user1", 1.0);

    const search = gate.paidTool({
      name: "search",
      price: 0.1,
      handler: async () => ({ result: "data" }),
    });

    await search({ q: "test" }, "user1");
    assert.equal(gate.traces.count, 1);
  });

  it("trace has correct traceId, callerId, toolName, currency", async () => {
    ledger.balances.set("user1", 1.0);

    const search = gate.paidTool({
      name: "search_trace",
      price: 0.1,
      handler: async () => ({ result: "ok" }),
    });

    const result = await search({ q: "hello" }, "user1");
    assert.ok(result.traceId, "Result should contain traceId");

    const trace = await gate.traces.get(result.traceId);
    assert.ok(trace);
    assert.equal(trace.callerId, "user1");
    assert.equal(trace.toolName, "search_trace");
    assert.equal(trace.currency, "usd");
  });

  it("trace events include trace_created, payment_deducted, handler_started, handler_success, call_completed", async () => {
    ledger.balances.set("user1", 1.0);

    const search = gate.paidTool({
      name: "search_events",
      price: 0.1,
      handler: async () => ({ result: "ok" }),
    });

    const result = await search({ q: "events" }, "user1");
    const trace = await gate.traces.get(result.traceId);
    assert.ok(trace);

    const eventNames = trace.events.map((e) => e.event);
    assert.ok(eventNames.includes("trace_created"), "Missing trace_created");
    assert.ok(
      eventNames.includes("payment_deducted"),
      "Missing payment_deducted",
    );
    assert.ok(
      eventNames.includes("handler_started"),
      "Missing handler_started",
    );
    assert.ok(
      eventNames.includes("handler_success"),
      "Missing handler_success",
    );
    assert.ok(eventNames.includes("call_completed"), "Missing call_completed");
  });

  it("trace chargeStatus = 'charged' after successful paid call", async () => {
    ledger.balances.set("user1", 1.0);

    const search = gate.paidTool({
      name: "search_charged",
      price: 0.1,
      handler: async () => ({ result: "ok" }),
    });

    const result = await search({ q: "hello" }, "user1");
    const trace = await gate.traces.get(result.traceId);
    assert.equal(trace.chargeStatus, "charged");
  });

  it("trace chargeStatus = 'refunded' after handler throws", async () => {
    ledger.balances.set("user1", 1.0);

    const search = gate.paidTool({
      name: "search_refunded",
      price: 0.1,
      handler: async () => {
        throw new Error("handler boom");
      },
    });

    await search({ q: "fail" }, "user1");
    const traces = await gate.traces.list({ toolName: "search_refunded" });
    assert.equal(traces.length, 1);
    assert.equal(traces[0].chargeStatus, "refunded");
  });

  it("trace chargeStatus = 'none' for free (zero price) call", async () => {
    const search = gate.paidTool({
      name: "search_free",
      price: 0,
      handler: async () => ({ result: "free" }),
    });

    const result = await search({ q: "free" }, "user_free");
    const trace = await gate.traces.get(result.traceId);
    assert.ok(trace);
    assert.equal(trace.chargeStatus, "none");
  });

  it("trace retrieved by idempotency key", async () => {
    ledger.balances.set("user1", 1.0);

    const search = gate.paidTool({
      name: "search_by_key",
      price: 0.1,
      idempotencyKey: (input) => `key_${input.q}`,
      handler: async () => ({ result: "ok" }),
    });

    await search({ q: "lookup" }, "user1");
    const trace = await gate.traces.getByIdempotencyKey("key_lookup");
    assert.ok(trace);
    assert.equal(trace.toolName, "search_by_key");
  });

  it("multiple calls from same user create multiple traces", async () => {
    ledger.balances.set("user1", 2.0);

    const search = gate.paidTool({
      name: "search_multi",
      price: 0.1,
      handler: async (input) => ({ result: input.q }),
    });

    await search({ q: "first" }, "user1");
    await search({ q: "second" }, "user1");

    const traces = await gate.traces.list({ toolName: "search_multi" });
    assert.equal(traces.length, 2);
  });

  it("trace finalAmount reflects actual charge", async () => {
    ledger.balances.set("user1", 1.0);
    const PRICE = 0.25;

    const search = gate.paidTool({
      name: "search_amount",
      price: PRICE,
      handler: async () => ({ result: "ok" }),
    });

    const result = await search({ q: "amount" }, "user1");
    const trace = await gate.traces.get(result.traceId);
    assert.ok(trace);
    assert.equal(trace.finalAmount, PRICE);
    assert.equal(trace.estimatedAmount, PRICE);
  });
});
