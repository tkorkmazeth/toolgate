/**
 * Phase 2 — Idempotency Tests
 *
 * 1. InMemoryIdempotencyStore unit tests (get/set/update/delete, TTL, eviction)
 * 2. TollGate idempotency integration (duplicate detection, policies, no double-charge)
 *
 * Run: node --test src/__tests__/idempotency.test.mjs
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── InMemoryIdempotencyStore (inline) ───────────────────

class InMemoryIdempotencyStore {
  constructor(maxSize = 10_000) {
    this.store = new Map();
    this.maxSize = maxSize;
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
    if (this.store.size >= this.maxSize) this._evictExpired();
    this.store.set(record.key, record);
  }

  async update(key, updates) {
    const existing = this.store.get(key);
    if (existing) {
      this.store.set(key, { ...existing, ...updates, updatedAt: Date.now() });
    }
  }

  async delete(key) {
    this.store.delete(key);
  }

  get size() {
    return this.store.size;
  }

  _evictExpired() {
    const now = Date.now();
    for (const [key, record] of this.store) {
      if (record.expiresAt < now) this.store.delete(key);
    }
  }
}

// ─── Minimal InMemoryLedger ───────────────────────────────

class InMemoryLedger {
  constructor() {
    this.balances = new Map();
    this.usage = new Map();
  }

  async getBalance(id) {
    return this.balances.get(id) ?? 0;
  }

  async deduct(id, amount, _meta) {
    const current = this.balances.get(id) ?? 0;
    if (current < amount) return false;
    this.balances.set(id, Math.round((current - amount) * 1e6) / 1e6);
    return true;
  }

  async credit(id, amount) {
    const current = this.balances.get(id) ?? 0;
    this.balances.set(id, Math.round((current + amount) * 1e6) / 1e6);
  }

  async getUsage(_id, _tool, _period) {
    return 0;
  }
  async incrementUsage() {}
}

// ─── Minimal InMemoryTraceStore ───────────────────────────

class InMemoryTraceStore {
  constructor() {
    this.traces = [];
  }
  async save(trace) {
    this.traces.push(trace);
  }
  async get(id) {
    return this.traces.find((t) => t.traceId === id) ?? null;
  }
  async getByIdempotencyKey(key) {
    return this.traces.find((t) => t.idempotencyKey === key) ?? null;
  }
  async list() {
    return [...this.traces];
  }
  get count() {
    return this.traces.length;
  }
}

// ─── Minimal TollGate with idempotency ───────────────────

function hashSync(input) {
  const str = JSON.stringify(input) ?? "";
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (((hash << 5) + hash) ^ str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

class TollGate {
  constructor(config) {
    this.ledger = config.ledger ?? new InMemoryLedger();
    this.idempotencyStore =
      config.idempotencyStore ?? new InMemoryIdempotencyStore();
    this.traceStore = config.traceStore ?? new InMemoryTraceStore();
    this.idempotencyTtlSeconds = config.idempotencyTtlSeconds ?? 3600;
    this.publisherKey = config.publisherKey ?? "tg_test";
    this.defaultCurrency = "usd";
    this.hooks = config.hooks;
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

  async _handleDuplicate(tool, input, callerId, record, key) {
    const policy = tool.onDuplicate ?? "return_previous_result";

    if (tool.onDuplicateDetected) {
      const balance = await this.ledger.getBalance(callerId);
      await tool.onDuplicateDetected(input, record, {
        callerId,
        callId: record.traceId,
        tool: tool.name,
        tier: "premium",
        balance,
        timestamp: Date.now(),
      });
    }

    if (policy === "return_previous_result") {
      if (record.status === "in_progress") {
        return {
          success: false,
          output: {
            error:
              "Duplicate request: a previous execution is still in progress.",
            idempotencyKey: key,
          },
        };
      }
      if (record.result) return record.result;
    }

    if (policy === "block") {
      return {
        success: false,
        output: {
          error: "Duplicate request detected. Request rejected.",
          idempotencyKey: key,
        },
      };
    }

    // re_execute
    await this.idempotencyStore.delete(key);
    return this._executeTool(tool, input, callerId);
  }

  async _executeTool(tool, input, callerId) {
    const callId = `tg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const idempotencyKey = this._resolveKey(tool, input, callerId);
    const inputHash = hashSync(input);

    const existing = await this.idempotencyStore.get(idempotencyKey);
    if (existing) {
      return this._handleDuplicate(
        tool,
        input,
        callerId,
        existing,
        idempotencyKey,
      );
    }

    await this.idempotencyStore.set({
      key: idempotencyKey,
      callerId,
      toolName: tool.name,
      inputHash,
      status: "in_progress",
      traceId: callId,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.idempotencyTtlSeconds * 1000,
    });

    const ledger = this.ledger;
    const price = typeof tool.price === "number" ? tool.price : 0;
    const needsPayment = price > 0;

    if (needsPayment) {
      const deducted = await ledger.deduct(callerId, price, {
        callId,
        tool: tool.name,
        amount: price,
      });
      if (!deducted) {
        const result = {
          success: false,
          paymentRequired: {
            status: 402,
            error: "payment_required",
            tool: tool.name,
            amount: price,
            currency: "usd",
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
    }

    let output,
      success = true;
    try {
      output = await tool.handler(input, {
        callerId,
        callId,
        tool: tool.name,
        tier: "premium",
        balance: await ledger.getBalance(callerId),
        timestamp: Date.now(),
      });
    } catch (err) {
      if (needsPayment) await ledger.credit(callerId, price);
      const result = { success: false, output: { error: err.message } };
      await this.idempotencyStore.update(idempotencyKey, {
        status: "failed",
        result,
        updatedAt: Date.now(),
      });
      return result;
    }

    const balanceAfter = await ledger.getBalance(callerId);
    const result = {
      success: true,
      output,
      receipt:
        price > 0
          ? {
              callId,
              tool: tool.name,
              amount: price,
              currency: "usd",
              rail: "prepaid",
              balanceAfter,
              timestamp: Date.now(),
            }
          : undefined,
      isFallback: false,
    };

    await this.idempotencyStore.update(idempotencyKey, {
      status: "completed",
      result,
      updatedAt: Date.now(),
    });
    return result;
  }
}

// ─── Tests: InMemoryIdempotencyStore unit tests ───────────

describe("InMemoryIdempotencyStore", () => {
  it("returns null for unknown key", async () => {
    const store = new InMemoryIdempotencyStore();
    const record = await store.get("nonexistent");
    assert.equal(record, null);
  });

  it("stores and retrieves a record", async () => {
    const store = new InMemoryIdempotencyStore();
    const now = Date.now();
    await store.set({
      key: "key1",
      callerId: "user1",
      toolName: "search",
      inputHash: "abc",
      status: "in_progress",
      traceId: "tg_trace_1",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 3_600_000,
    });
    const retrieved = await store.get("key1");
    assert.ok(retrieved);
    assert.equal(retrieved.key, "key1");
    assert.equal(retrieved.status, "in_progress");
  });

  it("updates a record", async () => {
    const store = new InMemoryIdempotencyStore();
    const now = Date.now();
    await store.set({
      key: "key2",
      callerId: "user1",
      toolName: "search",
      inputHash: "abc",
      status: "in_progress",
      traceId: "tg_trace_2",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 3_600_000,
    });
    await store.update("key2", {
      status: "completed",
      result: { success: true },
    });
    const record = await store.get("key2");
    assert.equal(record.status, "completed");
    assert.ok(record.result?.success);
  });

  it("deletes a record", async () => {
    const store = new InMemoryIdempotencyStore();
    const now = Date.now();
    await store.set({
      key: "key3",
      callerId: "user1",
      toolName: "search",
      inputHash: "abc",
      status: "in_progress",
      traceId: "tg_trace_3",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 3_600_000,
    });
    await store.delete("key3");
    const record = await store.get("key3");
    assert.equal(record, null);
  });

  it("returns null for expired records", async () => {
    const store = new InMemoryIdempotencyStore();
    const now = Date.now();
    await store.set({
      key: "key_ttl",
      callerId: "user1",
      toolName: "search",
      inputHash: "abc",
      status: "completed",
      traceId: "tg_trace_ttl",
      createdAt: now - 7200_000,
      updatedAt: now - 7200_000,
      expiresAt: now - 1, // already expired
    });
    const record = await store.get("key_ttl");
    assert.equal(record, null);
  });

  it("reports correct size", async () => {
    const store = new InMemoryIdempotencyStore();
    assert.equal(store.size, 0);
    const now = Date.now();
    await store.set({
      key: "a",
      callerId: "u",
      toolName: "t",
      inputHash: "h",
      status: "in_progress",
      traceId: "tr1",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 3600_000,
    });
    assert.equal(store.size, 1);
  });

  it("does not update non-existent key", async () => {
    const store = new InMemoryIdempotencyStore();
    // should not throw
    await store.update("missing", { status: "completed" });
    const record = await store.get("missing");
    assert.equal(record, null);
  });
});

// ─── Tests: TollGate idempotency integration ─────────────

describe("Idempotency", () => {
  let ledger, gate;
  const PRICE = 0.1;

  beforeEach(() => {
    ledger = new InMemoryLedger();
    gate = new TollGate({ ledger, publisherKey: "tg_test" });
  });

  it("same idempotency key returns same result, no double charge", async () => {
    ledger.balances.set("user1", 1.0);
    let callCount = 0;

    const search = gate.paidTool({
      name: "search",
      price: PRICE,
      handler: async () => {
        callCount++;
        return { result: "premium data" };
      },
    });

    const result1 = await search({ q: "test" }, "user1");
    const result2 = await search({ q: "test" }, "user1");

    assert.ok(result1.success);
    assert.ok(result2.success);
    // Handler called only once
    assert.equal(callCount, 1);
    // Same output
    assert.deepEqual(result1.output, result2.output);
    // Balance only deducted once
    const balance = await ledger.getBalance("user1");
    assert.ok(
      Math.abs(balance - (1.0 - PRICE)) < 0.001,
      `Expected balance ~${1.0 - PRICE}, got ${balance}`,
    );
  });

  it("different inputs produce different idempotency keys → separate charges", async () => {
    ledger.balances.set("user1", 1.0);
    let callCount = 0;

    const search = gate.paidTool({
      name: "search",
      price: PRICE,
      handler: async (input) => {
        callCount++;
        return { result: input.q };
      },
    });

    await search({ q: "first" }, "user1");
    await search({ q: "second" }, "user1");

    assert.equal(callCount, 2);
    const balance = await ledger.getBalance("user1");
    assert.ok(Math.abs(balance - (1.0 - 2 * PRICE)) < 0.001);
  });

  it("onDuplicate: 'block' rejects duplicate", async () => {
    ledger.balances.set("user1", 1.0);

    const search = gate.paidTool({
      name: "search_block",
      price: PRICE,
      onDuplicate: "block",
      handler: async () => ({ result: "data" }),
    });

    await search({ q: "test" }, "user1");
    const result2 = await search({ q: "test" }, "user1");

    assert.equal(result2.success, false);
    assert.match(result2.output.error, /Duplicate request detected/);
  });

  it("onDuplicate: 're_execute' calls handler again and charges again", async () => {
    ledger.balances.set("user1", 1.0);
    let callCount = 0;

    const search = gate.paidTool({
      name: "search_reexec",
      price: PRICE,
      onDuplicate: "re_execute",
      handler: async () => {
        callCount++;
        return { result: `call-${callCount}` };
      },
    });

    const result1 = await search({ q: "test" }, "user1");
    const result2 = await search({ q: "test" }, "user1");

    assert.ok(result1.success);
    assert.ok(result2.success);
    assert.equal(callCount, 2);
    // Both calls charged
    const balance = await ledger.getBalance("user1");
    assert.ok(Math.abs(balance - (1.0 - 2 * PRICE)) < 0.001);
  });

  it("onDuplicateDetected callback fires on duplicate", async () => {
    ledger.balances.set("user1", 1.0);
    let detectedRecord = null;

    const search = gate.paidTool({
      name: "search_detect",
      price: PRICE,
      onDuplicateDetected: (_input, record) => {
        detectedRecord = record;
      },
      handler: async () => ({ result: "data" }),
    });

    await search({ q: "test" }, "user1");
    await search({ q: "test" }, "user1");

    assert.ok(detectedRecord, "onDuplicateDetected should have been called");
    assert.equal(detectedRecord.toolName, "search_detect");
    assert.equal(detectedRecord.callerId, "user1");
  });

  it("in_progress duplicate returns error message", async () => {
    const idempotencyStore = new InMemoryIdempotencyStore();
    gate = new TollGate({ ledger, idempotencyStore, publisherKey: "tg_test" });

    // Pre-insert an in_progress record
    const now = Date.now();
    await idempotencyStore.set({
      key: "auto_search_prog_user1_" + hashSync({ q: "test" }),
      callerId: "user1",
      toolName: "search_prog",
      inputHash: hashSync({ q: "test" }),
      status: "in_progress",
      traceId: "tg_in_progress_trace",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 3_600_000,
    });

    const search = gate.paidTool({
      name: "search_prog",
      price: PRICE,
      handler: async () => ({ result: "data" }),
    });

    const result = await search({ q: "test" }, "user1");
    assert.equal(result.success, false);
    assert.match(result.output.error, /in progress/);
  });

  it("custom idempotency key function used correctly", async () => {
    ledger.balances.set("user1", 1.0);
    let callCount = 0;

    const search = gate.paidTool({
      name: "search_custom_key",
      price: PRICE,
      idempotencyKey: (input) => `custom_${input.requestId}`,
      handler: async () => {
        callCount++;
        return { result: "data" };
      },
    });

    await search({ requestId: "req-001", extra: "data1" }, "user1");
    // Same requestId but different extra → should return cached (same key)
    await search({ requestId: "req-001", extra: "data2" }, "user1");

    assert.equal(
      callCount,
      1,
      "Handler should only be called once for same custom key",
    );
  });

  it("static string idempotency key always returns same result", async () => {
    ledger.balances.set("user1", 1.0);
    let callCount = 0;

    const search = gate.paidTool({
      name: "search_static",
      price: PRICE,
      idempotencyKey: "static-key-for-search",
      handler: async () => {
        callCount++;
        return { result: `call-${callCount}` };
      },
    });

    await search({ q: "first" }, "user1");
    await search({ q: "different input" }, "user1"); // different input but same static key

    assert.equal(callCount, 1);
  });
});

// ─── Helper exposed for other tests ──────────────────────
export { hashSync };
