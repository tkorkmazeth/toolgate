/**
 * TollGate SDK — ExecutionPolicy Tests
 *
 * Tests all policy decision paths:
 * 1. Policy "execute" → normal paid flow
 * 2. Policy "fallback" → fallback runs, no charge
 * 3. Policy "payment_required" → 402 response
 * 4. Policy "allow_once" → handler runs without charge
 * 5. Policy "estimate" → cost estimate returned
 * 6. Dynamic decision based on caller balance
 * 7. Input-aware policy logic
 * 8. Policy + tiered access (free tier bypasses policy)
 * 9. onFallback hook fires with correct reason
 * 10. No policy → existing behavior unchanged
 *
 * Run: node --test src/__tests__/policy.test.mjs
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── Inline implementations (no build step needed) ──────────────

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
    this.transactions.push({ type: "deduct", callerId, amount, meta });
    return true;
  }

  async credit(callerId, amount, meta) {
    const current = this.balances.get(callerId) ?? 0;
    this.balances.set(callerId, round(current + amount));
    this.transactions.push({ type: "credit", callerId, amount, meta });
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

class TollGate {
  constructor(config) {
    this.config = {
      publisherKey: config.publisherKey,
      defaultCurrency: config.defaultCurrency ?? "usd",
      paymentRails: config.paymentRails ?? ["stripe"],
      topUpBaseUrl:
        config.topUpBaseUrl ??
        "https://tollgate-api.talha-korkmazeth.workers.dev/pay",
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

    // ── Step 1: Determine tier and price ────────────────────
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

    // ── Step 2: Build execution context ────────────────────
    const ctx = {
      callerId,
      callId,
      tool: tool.name,
      tier,
      balance: await ledger.getBalance(callerId),
      timestamp: Date.now(),
    };

    // ── Step 2.5: Policy evaluation ─────────────────────────
    let skipPaymentGate = false;
    if (tool.policy) {
      const isPostpaidForPolicy = tool.price === "postpaid";
      const estimatedPrice = isPostpaidForPolicy ? 0 : price;
      const usageToday = await ledger.getUsage(callerId, tool.name, "day");
      const policyCtx = {
        callerId,
        tier,
        balance: ctx.balance,
        estimatedPrice,
        input,
        tool: tool.name,
        usageToday,
      };

      const decision = await tool.policy.decide(policyCtx);

      if (decision === "fallback") {
        if (tool.onFallback) await tool.onFallback(input, "fallback", ctx);
        if (tool.fallback) {
          const fallbackOutput = await tool.fallback(input, ctx);
          return { success: true, output: fallbackOutput, isFallback: true };
        }
        return await this._handlePaymentFailure(
          tool,
          input,
          ctx,
          price,
          callerId,
        );
      }

      if (decision === "payment_required") {
        return await this._handlePaymentFailure(
          tool,
          input,
          ctx,
          price,
          callerId,
        );
      }

      if (decision === "allow_once") {
        skipPaymentGate = true;
      }

      if (decision === "estimate") {
        const estimateCtx = {
          callerId,
          tier,
          balance: ctx.balance,
          input,
          tool: tool.name,
          usageToday,
        };
        const costEstimate = tool.estimate
          ? await tool.estimate(input, estimateCtx)
          : { estimatedPrice: price, currency: this.config.defaultCurrency };
        return {
          success: true,
          output: { type: "cost_estimate", ...costEstimate },
          isFallback: false,
        };
      }
      // "execute" → continue with normal payment gate
    }

    // ── Step 3: Payment gate ────────────────────────────────
    const isPostpaid = tool.price === "postpaid";
    const needsPayment =
      tier === "premium" && price > 0 && !isPostpaid && !skipPaymentGate;

    if (needsPayment) {
      const deducted = await ledger.deduct(callerId, price, {
        callId,
        tool: tool.name,
        amount: price,
      });
      if (!deducted) {
        return await this._handlePaymentFailure(
          tool,
          input,
          ctx,
          price,
          callerId,
        );
      }
      this.config.hooks?.onPayment?.(tool.name, callerId, price);
    }

    // ── Step 4: beforeExecute hook ──────────────────────────
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

    // ── Step 5: Execute handler ─────────────────────────────
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

    if (tier === "free" && tool.tiers?.free) {
      await ledger.incrementUsage(callerId, tool.name, tool.tiers.free.period);
    }

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

  async _handlePaymentFailure(tool, input, ctx, requiredAmount, callerId) {
    const policy = tool.onPaymentFailed ?? "block";

    if (tool.onPaymentFail) {
      await tool.onPaymentFail(input, {
        code: "insufficient_balance",
        balance: ctx.balance,
        required: requiredAmount,
      });
    }

    if (policy === "fallback" && tool.fallback) {
      if (tool.onFallback)
        await tool.onFallback(input, "insufficient_balance", ctx);
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

    const callerId_ = callerId ?? ctx.callerId;
    return {
      success: false,
      paymentRequired: {
        status: 402,
        error: "payment_required",
        tool: tool.name,
        amount: requiredAmount,
        currency: this.config.defaultCurrency,
        acceptedRails: this.config.paymentRails,
        topUpUrl: `${this.config.topUpBaseUrl}?publisher=${this.config.publisherKey}&caller=${encodeURIComponent(callerId_)}&amount=${Math.ceil(requiredAmount * 100)}`,
      },
    };
  }
}

async function resolvePrice(spec, input) {
  if (typeof spec === "number") return spec;
  if (typeof spec === "function") return await spec(input);
  return 0;
}

// ═══════════════════════════════════════════════════════════════
// POLICY TESTS
// ═══════════════════════════════════════════════════════════════

describe("ExecutionPolicy", () => {
  let gate;
  let ledger;

  beforeEach(() => {
    ledger = new InMemoryLedger();
    gate = new TollGate({ publisherKey: "tg_test_pub", ledger });
  });

  // ── 1. Policy "execute" → normal paid flow ──────────────────

  it("policy 'execute' continues to normal paid flow", async () => {
    await ledger.credit("agent-1", 1.0, {
      source: "manual",
      reference: "test",
    });

    const tool = gate.paidTool({
      name: "search",
      price: 0.05,
      handler: async () => "premium result",
      policy: { decide: async () => "execute" },
    });

    const result = await tool({}, "agent-1");

    assert.equal(result.success, true);
    assert.equal(result.output, "premium result");
    assert.equal(result.receipt?.amount, 0.05);
    assert.equal(result.isFallback, false);
    assert.equal(await ledger.getBalance("agent-1"), 0.95);
  });

  // ── 2. Policy "fallback" → fallback handler runs, no charge ───

  it("policy 'fallback' runs fallback handler without charging", async () => {
    await ledger.credit("agent-1", 1.0, {
      source: "manual",
      reference: "test",
    });

    const tool = gate.paidTool({
      name: "search",
      price: 0.05,
      handler: async () => "premium result",
      fallback: async () => "basic result",
      policy: { decide: async () => "fallback" },
    });

    const result = await tool({}, "agent-1");

    assert.equal(result.success, true);
    assert.equal(result.output, "basic result");
    assert.equal(result.isFallback, true);
    // No charge — balance unchanged
    assert.equal(await ledger.getBalance("agent-1"), 1.0);
  });

  // ── 3. Policy "payment_required" → 402 response ────────────────

  it("policy 'payment_required' returns 402 regardless of balance", async () => {
    await ledger.credit("agent-1", 5.0, {
      source: "manual",
      reference: "test",
    });

    const tool = gate.paidTool({
      name: "restricted",
      price: 0.1,
      handler: async () => "should not run",
      policy: { decide: async () => "payment_required" },
    });

    const result = await tool({}, "agent-1");

    assert.equal(result.success, false);
    assert.ok(result.paymentRequired);
    assert.equal(result.paymentRequired.status, 402);
    assert.equal(result.paymentRequired.amount, 0.1);
    // Balance untouched
    assert.equal(await ledger.getBalance("agent-1"), 5.0);
  });

  // ── 4. Policy "allow_once" → handler runs without charge ───────

  it("policy 'allow_once' executes handler without deducting balance", async () => {
    // No balance, but allow_once should still run
    const tool = gate.paidTool({
      name: "trial",
      price: 0.5,
      handler: async () => "trial output",
      policy: { decide: async () => "allow_once" },
    });

    const result = await tool({}, "agent-1");

    assert.equal(result.success, true);
    assert.equal(result.output, "trial output");
    // No charge incurred
    assert.equal(await ledger.getBalance("agent-1"), 0);
  });

  // ── 5. Policy "estimate" → cost estimate returned ───────────────

  it("policy 'estimate' returns cost estimate without executing", async () => {
    const tool = gate.paidTool({
      name: "analysis",
      price: 0.2,
      handler: async () => {
        throw new Error("should not execute");
      },
      policy: { decide: async () => "estimate" },
      estimate: async (input, ctx) => ({
        estimatedPrice: 0.2,
        currency: "usd",
        reason: "Standard analysis rate",
      }),
    });

    const result = await tool({}, "agent-1");

    assert.equal(result.success, true);
    assert.equal(result.output.type, "cost_estimate");
    assert.equal(result.output.estimatedPrice, 0.2);
    assert.equal(result.output.currency, "usd");
    assert.equal(result.output.reason, "Standard analysis rate");
    assert.equal(result.isFallback, false);
  });

  // ── 6. Dynamic decision based on caller balance ─────────────────

  it("policy dynamically decides based on caller balance", async () => {
    const policy = {
      decide: async (ctx) => (ctx.balance >= 0.5 ? "execute" : "fallback"),
    };

    const richTool = gate.paidTool({
      name: "rich-search",
      price: 0.1,
      handler: async () => "premium",
      fallback: async () => "basic",
      policy,
    });

    // Rich caller (1.00 balance) → execute
    await ledger.credit("rich", 1.0, { source: "manual", reference: "test" });
    const richResult = await richTool({}, "rich");
    assert.equal(richResult.output, "premium");
    assert.equal(richResult.isFallback, false);

    // Poor caller (0.00 balance) → fallback
    const poorResult = await richTool({}, "poor");
    assert.equal(poorResult.output, "basic");
    assert.equal(poorResult.isFallback, true);
  });

  // ── 7. Input-aware policy logic ──────────────────────────────────

  it("policy inspects input to make decision", async () => {
    const tool = gate.paidTool({
      name: "deep-search",
      price: 0.1,
      handler: async (input) => `deep result for: ${input.query}`,
      fallback: async (input) => `shallow result for: ${input.query}`,
      policy: {
        decide: async (ctx) =>
          ctx.input?.depth === "deep" ? "execute" : "fallback",
      },
    });

    await ledger.credit("agent-1", 1.0, {
      source: "manual",
      reference: "test",
    });

    // Deep query → execute (charge applies)
    const deepResult = await tool({ query: "AI", depth: "deep" }, "agent-1");
    assert.equal(deepResult.output, "deep result for: AI");
    assert.equal(deepResult.isFallback, false);

    // Shallow query → fallback (no charge)
    const shallowResult = await tool(
      { query: "AI", depth: "shallow" },
      "agent-1",
    );
    assert.equal(shallowResult.output, "shallow result for: AI");
    assert.equal(shallowResult.isFallback, true);
  });

  // ── 8. Policy receives tier info so it can differentiate free vs premium ──

  it("policy context includes tier so policy can allow free callers through", async () => {
    let policyCallCount = 0;

    const tool = gate.paidTool({
      name: "tiered-tool",
      tiers: {
        free: { limit: 3, period: "day" },
        premium: { price: 0.1 },
      },
      handler: async () => "result",
      policy: {
        decide: async (ctx) => {
          policyCallCount++;
          // Free callers execute freely; premium callers need balance
          return ctx.tier === "free" ? "execute" : "payment_required";
        },
      },
    });

    // Free tier call → policy sees tier="free" → returns "execute" → success
    const result = await tool({}, "agent-1");
    assert.equal(result.success, true);
    assert.equal(result.output, "result");
    assert.equal(result.isFallback, false);
    assert.ok(policyCallCount >= 1, "policy.decide should have been called");

    // Premium caller (limit exhausted, no balance) → policy returns "payment_required"
    // Drain free tier
    await tool({}, "agent-1");
    await tool({}, "agent-1");
    const premiumResult = await tool({}, "agent-1");
    assert.equal(premiumResult.success, false);
    assert.equal(premiumResult.paymentRequired?.status, 402);
  });

  // ── 9. onFallback hook fires with correct reason ─────────────────

  it("onFallback hook fires with reason='fallback' when policy decides fallback", async () => {
    const fallbackCalls = [];

    const tool = gate.paidTool({
      name: "monitored",
      price: 0.05,
      handler: async () => "premium",
      fallback: async () => "basic",
      onFallback: async (input, reason, ctx) => {
        fallbackCalls.push({ input, reason, callerId: ctx.callerId });
      },
      policy: { decide: async () => "fallback" },
    });

    await tool({ q: "test" }, "agent-1");

    assert.equal(fallbackCalls.length, 1);
    assert.equal(fallbackCalls[0].reason, "fallback");
    assert.equal(fallbackCalls[0].callerId, "agent-1");
  });

  it("onFallback hook fires with reason='insufficient_balance' when balance runs out", async () => {
    const fallbackCalls = [];

    const tool = gate.paidTool({
      name: "balance-monitored",
      price: 0.5,
      handler: async () => "premium",
      fallback: async () => "basic",
      onPaymentFailed: "fallback",
      onFallback: async (input, reason, ctx) => {
        fallbackCalls.push({ reason });
      },
    });

    // No balance → payment fails → fallback → onFallback fires with "insufficient_balance"
    const result = await tool({}, "agent-1");

    assert.equal(result.success, true);
    assert.equal(result.isFallback, true);
    assert.equal(fallbackCalls.length, 1);
    assert.equal(fallbackCalls[0].reason, "insufficient_balance");
  });

  // ── 10. No policy → existing behavior unchanged ──────────────────

  it("no policy defined → existing payment gate behavior unchanged", async () => {
    const tool = gate.paidTool({
      name: "legacy-tool",
      price: 0.1,
      handler: async () => "result",
      // No policy field
    });

    // No balance → 402
    const noBalanceResult = await tool({}, "agent-1");
    assert.equal(noBalanceResult.success, false);
    assert.equal(noBalanceResult.paymentRequired.status, 402);

    // Credit balance → success
    await ledger.credit("agent-1", 1.0, {
      source: "manual",
      reference: "test",
    });
    const paidResult = await tool({}, "agent-1");
    assert.equal(paidResult.success, true);
    assert.equal(paidResult.output, "result");
    assert.equal(paidResult.receipt.amount, 0.1);
  });
});
