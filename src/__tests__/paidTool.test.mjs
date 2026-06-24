/**
 * Tollgate SDK — Integration Tests
 *
 * Tests all core flows:
 * 1. Prepaid balance → tool executes → balance deducted
 * 2. No balance → 402 Payment Required
 * 3. Fallback on payment failure
 * 4. Dynamic pricing (input-based)
 * 5. Tiered access (free + premium)
 * 6. Lifecycle hooks (beforeExecute, afterExecute, onFail, onPaymentFail)
 * 7. Postpaid metering
 * 8. Refund on execution error
 * 9. allow_once grace policy
 *
 * Run: node --test src/__tests__/paidTool.test.mjs
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── Inline implementation (no build step needed for tests) ─────

// === InMemoryLedger ===
class InMemoryLedger {
  constructor() {
    this.balances = new Map();
    this.usage = new Map();
    this.transactions = [];
  }

  async getBalance(callerId) {
    return this.balances.get(callerId) ?? 0;
  }

  async deduct(callerId, amount, meta) {
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
    const period = currentPeriod("day");
    const usageKey = `${callerId}:${meta.tool}:${period}`;
    this.usage.set(usageKey, (this.usage.get(usageKey) ?? 0) + 1);
    return true;
  }

  async credit(callerId, amount, meta) {
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

  async getUsage(callerId, tool, period) {
    const key = `${callerId}:${tool}:${currentPeriod(period)}`;
    return this.usage.get(key) ?? 0;
  }

  async incrementUsage(callerId, tool, period) {
    const key = `${callerId}:${tool}:${currentPeriod(period)}`;
    this.usage.set(key, (this.usage.get(key) ?? 0) + 1);
  }
}

function round(n) {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function currentPeriod(period) {
  const d = new Date();
  if (period === "day") return d.toISOString().slice(0, 10);
  if (period === "month") return d.toISOString().slice(0, 7);
  return d.toISOString().slice(0, 10);
}

// === TollGate ===
class TollGate {
  constructor(config) {
    this.config = {
      publisherKey: config.publisherKey,
      defaultCurrency: config.defaultCurrency ?? "usd",
      paymentRails: config.paymentRails ?? ["stripe"],
      ledger: config.ledger ?? new InMemoryLedger(),
      hooks: config.hooks,
    };
    this.tools = new Map();
  }

  get ledger() {
    return this.config.ledger;
  }

  paidTool(toolConfig) {
    this.tools.set(toolConfig.name, toolConfig);
    const execute = (input, callerId) =>
      this._executeTool(toolConfig, input, callerId);
    execute.toolName = toolConfig.name;
    execute.config = toolConfig;
    return execute;
  }

  async _executeTool(tool, input, callerId) {
    const callId = `tg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const ledger = this.config.ledger;

    this.config.hooks?.onCall?.(tool.name, callerId);

    // Determine tier and price
    let tier = "premium";
    let price = 0;
    let handler = tool.handler;

    if (tool.tiers) {
      if (tool.tiers.free) {
        const usage = await ledger.getUsage(
          callerId,
          tool.name,
          tool.tiers.free.period,
        );
        if (usage < tool.tiers.free.limit) {
          tier = "free";
          price = 0;
          handler = tool.tiers.free.handler ?? tool.handler;
        } else {
          tier = "premium";
          price = await resolvePrice(tool.tiers.premium.price, input);
          handler = tool.tiers.premium.handler ?? tool.handler;
        }
      }
    } else if (tool.price !== undefined && tool.price !== "postpaid") {
      price = await resolvePrice(tool.price, input);
    }

    const isPostpaid = tool.price === "postpaid";

    const ctx = {
      callerId,
      callId,
      tool: tool.name,
      tier,
      balance: await ledger.getBalance(callerId),
      timestamp: Date.now(),
    };

    // Payment gate
    const needsPayment = tier === "premium" && price > 0 && !isPostpaid;
    if (needsPayment) {
      const deducted = await ledger.deduct(callerId, price, {
        callId,
        tool: tool.name,
        amount: price,
      });
      if (!deducted) {
        return await this._handlePaymentFailure(tool, input, ctx, price);
      }
      this.config.hooks?.onPayment?.(tool.name, callerId, price);
    }

    // beforeExecute
    if (tool.beforeExecute) {
      const proceed = await tool.beforeExecute(input, ctx);
      if (!proceed) {
        if (needsPayment) {
          await ledger.credit(callerId, price, {
            source: "manual",
            reference: `refund:${callId}:aborted`,
          });
        }
        return {
          success: false,
          output: { error: "Execution aborted by beforeExecute hook" },
        };
      }
    }

    // Execute
    const startedAt = Date.now();
    let output, metrics;
    try {
      output = await handler(input, ctx);
      const endedAt = Date.now();
      metrics = { durationMs: endedAt - startedAt, startedAt, endedAt };
    } catch (error) {
      const endedAt = Date.now();
      metrics = { durationMs: endedAt - startedAt, startedAt, endedAt };
      if (needsPayment) {
        await ledger.credit(callerId, price, {
          source: "manual",
          reference: `refund:${callId}:error`,
        });
      }
      if (tool.onFail) await tool.onFail(input, error, ctx);
      this.config.hooks?.onError?.(tool.name, error);
      return { success: false, output: { error: error.message }, metrics };
    }

    // Track usage for free tier
    if (tier === "free" && tool.tiers?.free) {
      await ledger.incrementUsage(callerId, tool.name, tool.tiers.free.period);
    }

    // Postpaid metering
    if (isPostpaid && tool.meter) {
      const meterResult = await tool.meter(input, output, metrics);
      price = meterResult.amount;
      const deducted = await ledger.deduct(callerId, price, {
        callId,
        tool: tool.name,
        amount: price,
      });
      if (deducted) this.config.hooks?.onPayment?.(tool.name, callerId, price);
    }

    // afterExecute
    if (tool.afterExecute) await tool.afterExecute(input, output, metrics);

    const balanceAfter = await ledger.getBalance(callerId);
    return {
      success: true,
      output,
      receipt:
        price > 0
          ? {
              callId,
              tool: tool.name,
              amount: price,
              currency: this.config.defaultCurrency,
              rail: "prepaid",
              balanceAfter,
              timestamp: Date.now(),
            }
          : undefined,
      metrics,
      isFallback: false,
    };
  }

  async _handlePaymentFailure(tool, input, ctx, requiredAmount) {
    const policy = tool.onPaymentFailed ?? "block";
    if (tool.onPaymentFail) {
      await tool.onPaymentFail(input, {
        code: "insufficient_balance",
        balance: ctx.balance,
        required: requiredAmount,
      });
    }

    if (policy === "fallback" && tool.fallback) {
      const fallbackOutput = await tool.fallback(input, ctx);
      return { success: true, output: fallbackOutput, isFallback: true };
    }
    if (policy === "allow_once") {
      const startedAt = Date.now();
      const output = await tool.handler(input, ctx);
      const endedAt = Date.now();
      return {
        success: true,
        output,
        metrics: { durationMs: endedAt - startedAt, startedAt, endedAt },
        isFallback: false,
      };
    }

    return {
      success: false,
      paymentRequired: {
        status: 402,
        error: "payment_required",
        tool: tool.name,
        amount: requiredAmount,
        currency: this.config.defaultCurrency,
        acceptedRails: this.config.paymentRails,
        topUpUrl: `https://pay.tollgate.dev/topup?publisher=${this.config.publisherKey}&amount=${Math.ceil(requiredAmount * 100)}`,
      },
    };
  }
}

async function resolvePrice(spec, input) {
  if (typeof spec === "number") return spec;
  if (typeof spec === "function") return await spec(input);
  return 0;
}

// ═══════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════

describe("Tollgate SDK", () => {
  let gate;
  let ledger;

  beforeEach(() => {
    ledger = new InMemoryLedger();
    gate = new TollGate({
      publisherKey: "tg_test_pub",
      ledger,
    });
  });

  // ── 1. Happy path: prepaid balance ──────────────────────

  describe("prepaid balance flow", () => {
    it("executes tool and deducts balance", async () => {
      await ledger.credit("agent-1", 1.0, {
        source: "manual",
        reference: "test",
      });

      const search = gate.paidTool({
        name: "search",
        price: 0.05,
        handler: async (input) => ({ results: [`Result for: ${input.query}`] }),
      });

      const result = await search({ query: "AI payments" }, "agent-1");

      assert.equal(result.success, true);
      assert.deepEqual(result.output, { results: ["Result for: AI payments"] });
      assert.equal(result.receipt.amount, 0.05);
      assert.equal(result.receipt.rail, "prepaid");
      assert.equal(result.receipt.balanceAfter, 0.95);
      assert.equal(result.isFallback, false);

      const balance = await ledger.getBalance("agent-1");
      assert.equal(balance, 0.95);
    });

    it("processes multiple calls until balance exhausted", async () => {
      await ledger.credit("agent-1", 0.1, {
        source: "manual",
        reference: "test",
      });

      const tool = gate.paidTool({
        name: "lookup",
        price: 0.03,
        handler: async () => "ok",
      });

      const r1 = await tool({}, "agent-1");
      assert.equal(r1.success, true);
      assert.equal(await ledger.getBalance("agent-1"), 0.07);

      const r2 = await tool({}, "agent-1");
      assert.equal(r2.success, true);
      assert.equal(await ledger.getBalance("agent-1"), 0.04);

      const r3 = await tool({}, "agent-1");
      assert.equal(r3.success, true);
      assert.equal(await ledger.getBalance("agent-1"), 0.01);

      // 4th call: insufficient balance
      const r4 = await tool({}, "agent-1");
      assert.equal(r4.success, false);
      assert.equal(r4.paymentRequired.status, 402);
    });
  });

  // ── 2. 402 Payment Required ─────────────────────────────

  describe("402 payment required", () => {
    it("returns 402 when balance is zero", async () => {
      const tool = gate.paidTool({
        name: "premium",
        price: 0.1,
        handler: async () => "should not run",
      });

      const result = await tool({}, "broke-agent");

      assert.equal(result.success, false);
      assert.equal(result.paymentRequired.status, 402);
      assert.equal(result.paymentRequired.error, "payment_required");
      assert.equal(result.paymentRequired.amount, 0.1);
      assert.ok(result.paymentRequired.topUpUrl.includes("tollgate.dev"));
      assert.deepEqual(result.paymentRequired.acceptedRails, ["stripe"]);
    });

    it("returns 402 when balance is insufficient", async () => {
      await ledger.credit("agent-1", 0.05, {
        source: "manual",
        reference: "test",
      });

      const tool = gate.paidTool({
        name: "expensive",
        price: 0.1,
        handler: async () => "should not run",
      });

      const result = await tool({}, "agent-1");
      assert.equal(result.success, false);
      assert.equal(result.paymentRequired.amount, 0.1);

      // Balance unchanged
      assert.equal(await ledger.getBalance("agent-1"), 0.05);
    });
  });

  // ── 3. Fallback on payment failure ──────────────────────

  describe("fallback policy", () => {
    it("returns fallback response when balance insufficient", async () => {
      const tool = gate.paidTool({
        name: "research",
        price: 0.25,
        onPaymentFailed: "fallback",
        fallback: async (input) => ({
          result: `Basic result for: ${input.query}`,
          note: "Upgrade for full analysis",
        }),
        handler: async (input) => ({
          result: `Full analysis for: ${input.query}`,
        }),
      });

      const result = await tool({ query: "test" }, "no-balance-agent");

      assert.equal(result.success, true);
      assert.equal(result.isFallback, true);
      assert.ok(result.output.note.includes("Upgrade"));
    });
  });

  // ── 4. Dynamic pricing ─────────────────────────────────

  describe("dynamic pricing", () => {
    it("calculates price based on input", async () => {
      await ledger.credit("agent-1", 5.0, {
        source: "manual",
        reference: "test",
      });

      const tool = gate.paidTool({
        name: "analyze",
        price: (input) => {
          const words = input.text.split(" ").length;
          return words * 0.01; // $0.01 per word
        },
        handler: async (input) => ({
          analysis: `Analyzed ${input.text.length} chars`,
        }),
      });

      const result = await tool({ text: "hello world foo bar baz" }, "agent-1");
      assert.equal(result.success, true);
      assert.equal(result.receipt.amount, 0.05); // 5 words × $0.01
      assert.equal(await ledger.getBalance("agent-1"), 4.95);
    });

    it("blocks when dynamic price exceeds balance", async () => {
      await ledger.credit("agent-1", 0.02, {
        source: "manual",
        reference: "test",
      });

      const tool = gate.paidTool({
        name: "analyze",
        price: (input) => input.text.split(" ").length * 0.01,
        handler: async () => "should not run",
      });

      const result = await tool({ text: "one two three four five" }, "agent-1");
      assert.equal(result.success, false); // needs $0.05, has $0.02
      assert.equal(result.paymentRequired.amount, 0.05);
    });
  });

  // ── 5. Tiered access ───────────────────────────────────

  describe("tiered access (free + premium)", () => {
    it("allows free calls up to limit", async () => {
      const tool = gate.paidTool({
        name: "lookup",
        tiers: {
          free: { limit: 3, period: "day" },
          premium: { price: 0.02 },
        },
        handler: async (input) => ({ data: input.id }),
      });

      // First 3 calls free (no balance needed)
      const r1 = await tool({ id: 1 }, "agent-1");
      assert.equal(r1.success, true);
      assert.equal(r1.receipt, undefined); // no charge

      const r2 = await tool({ id: 2 }, "agent-1");
      assert.equal(r2.success, true);

      const r3 = await tool({ id: 3 }, "agent-1");
      assert.equal(r3.success, true);

      // 4th call: needs payment (no balance → 402)
      const r4 = await tool({ id: 4 }, "agent-1");
      assert.equal(r4.success, false);
      assert.equal(r4.paymentRequired.status, 402);
    });

    it("charges premium price after free limit with balance", async () => {
      await ledger.credit("agent-1", 1.0, {
        source: "manual",
        reference: "test",
      });

      const tool = gate.paidTool({
        name: "lookup",
        tiers: {
          free: { limit: 1, period: "day" },
          premium: { price: 0.05 },
        },
        handler: async () => "result",
      });

      // 1st free
      await tool({}, "agent-1");
      assert.equal(await ledger.getBalance("agent-1"), 1.0);

      // 2nd: premium
      const r2 = await tool({}, "agent-1");
      assert.equal(r2.success, true);
      assert.equal(r2.receipt.amount, 0.05);
      assert.equal(await ledger.getBalance("agent-1"), 0.95);
    });
  });

  // ── 6. Lifecycle hooks ─────────────────────────────────

  describe("lifecycle hooks", () => {
    it("calls beforeExecute and can abort", async () => {
      await ledger.credit("agent-1", 1.0, {
        source: "manual",
        reference: "test",
      });
      let hookCalled = false;

      const tool = gate.paidTool({
        name: "gated",
        price: 0.1,
        beforeExecute: async (input) => {
          hookCalled = true;
          return input.allowed === true; // only allow if input says so
        },
        handler: async () => "result",
      });

      // Blocked by hook
      const r1 = await tool({ allowed: false }, "agent-1");
      assert.equal(r1.success, false);
      assert.equal(hookCalled, true);
      // Balance refunded
      assert.equal(await ledger.getBalance("agent-1"), 1.0);

      // Allowed by hook
      const r2 = await tool({ allowed: true }, "agent-1");
      assert.equal(r2.success, true);
      assert.equal(await ledger.getBalance("agent-1"), 0.9);
    });

    it("calls afterExecute with metrics", async () => {
      await ledger.credit("agent-1", 1.0, {
        source: "manual",
        reference: "test",
      });
      let capturedMetrics = null;

      const tool = gate.paidTool({
        name: "tracked",
        price: 0.05,
        afterExecute: async (_input, _output, metrics) => {
          capturedMetrics = metrics;
        },
        handler: async () => {
          // Simulate some work
          await new Promise((r) => setTimeout(r, 10));
          return "done";
        },
      });

      await tool({}, "agent-1");
      assert.ok(capturedMetrics !== null);
      assert.ok(capturedMetrics.startedAt > 0);
      assert.ok(capturedMetrics.endedAt >= capturedMetrics.startedAt);
      assert.ok(capturedMetrics.durationMs >= 0);
      assert.equal(
        capturedMetrics.durationMs,
        capturedMetrics.endedAt - capturedMetrics.startedAt,
      );
    });

    it("calls onFail when handler throws", async () => {
      await ledger.credit("agent-1", 1.0, {
        source: "manual",
        reference: "test",
      });
      let failError = null;

      const tool = gate.paidTool({
        name: "risky",
        price: 0.1,
        onFail: async (_input, error) => {
          failError = error;
        },
        handler: async () => {
          throw new Error("External API down");
        },
      });

      const result = await tool({}, "agent-1");
      assert.equal(result.success, false);
      assert.equal(result.output.error, "External API down");
      assert.ok(failError instanceof Error);
      // Balance refunded
      assert.equal(await ledger.getBalance("agent-1"), 1.0);
    });

    it("calls onPaymentFail hook", async () => {
      let failReason = null;

      const tool = gate.paidTool({
        name: "premium",
        price: 0.5,
        onPaymentFail: async (_input, reason) => {
          failReason = reason;
        },
        handler: async () => "result",
      });

      await tool({}, "broke-agent");
      assert.ok(failReason !== null);
      assert.equal(failReason.code, "insufficient_balance");
      assert.equal(failReason.balance, 0);
      assert.equal(failReason.required, 0.5);
    });
  });

  // ── 7. Postpaid metering ────────────────────────────────

  describe("postpaid metering", () => {
    it("charges based on actual execution metrics", async () => {
      await ledger.credit("agent-1", 2.0, {
        source: "manual",
        reference: "test",
      });

      const tool = gate.paidTool({
        name: "compute",
        price: "postpaid",
        meter: async (_input, _output, metrics) => ({
          amount: metrics.durationMs * 0.001, // $0.001 per ms
          breakdown: { compute: metrics.durationMs * 0.001 },
        }),
        handler: async () => {
          await new Promise((r) => setTimeout(r, 50));
          return { computed: true };
        },
      });

      const result = await tool({}, "agent-1");
      assert.equal(result.success, true);
      assert.ok(result.receipt.amount >= 0.05); // ~50ms × $0.001
      assert.ok(result.receipt.amount < 0.15); // shouldn't take > 150ms
    });
  });

  // ── 8. Refund on error ──────────────────────────────────

  describe("refund on execution error", () => {
    it("refunds prepaid amount when handler throws", async () => {
      await ledger.credit("agent-1", 0.5, {
        source: "manual",
        reference: "test",
      });

      const tool = gate.paidTool({
        name: "fragile",
        price: 0.2,
        handler: async () => {
          throw new Error("boom");
        },
      });

      const result = await tool({}, "agent-1");
      assert.equal(result.success, false);
      // Balance fully restored
      assert.equal(await ledger.getBalance("agent-1"), 0.5);
    });
  });

  // ── 9. allow_once grace policy ──────────────────────────

  describe("allow_once policy", () => {
    it("executes once without payment as grace", async () => {
      const tool = gate.paidTool({
        name: "graceful",
        price: 0.1,
        onPaymentFailed: "allow_once",
        handler: async () => "free sample",
      });

      const result = await tool({}, "new-agent");
      assert.equal(result.success, true);
      assert.equal(result.output, "free sample");
      assert.equal(result.isFallback, false);
    });
  });

  // ── 10. Global hooks ───────────────────────────────────

  describe("global hooks", () => {
    it("fires onCall and onPayment hooks", async () => {
      const events = [];

      const gateWithHooks = new TollGate({
        publisherKey: "test",
        ledger,
        hooks: {
          onCall: (tool, callerId) =>
            events.push({ type: "call", tool, callerId }),
          onPayment: (tool, callerId, amount) =>
            events.push({ type: "payment", tool, callerId, amount }),
          onError: (tool, error) =>
            events.push({ type: "error", tool, error: error.message }),
        },
      });

      await ledger.credit("agent-1", 1.0, {
        source: "manual",
        reference: "test",
      });

      const tool = gateWithHooks.paidTool({
        name: "tracked_tool",
        price: 0.05,
        handler: async () => "ok",
      });

      await tool({}, "agent-1");

      assert.equal(events.length, 2);
      assert.equal(events[0].type, "call");
      assert.equal(events[0].tool, "tracked_tool");
      assert.equal(events[1].type, "payment");
      assert.equal(events[1].amount, 0.05);
    });
  });

  // ── 11. Isolation between callers ───────────────────────

  describe("caller isolation", () => {
    it("maintains separate balances per caller", async () => {
      await ledger.credit("alice", 1.0, {
        source: "manual",
        reference: "test",
      });
      await ledger.credit("bob", 0.5, { source: "manual", reference: "test" });

      const tool = gate.paidTool({
        name: "shared_tool",
        price: 0.1,
        handler: async () => "ok",
      });

      await tool({}, "alice");
      await tool({}, "bob");

      assert.equal(await ledger.getBalance("alice"), 0.9);
      assert.equal(await ledger.getBalance("bob"), 0.4);
    });
  });
});
