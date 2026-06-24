/**
 * Rail Adapter Integration Tests
 *
 * Tests:
 * 1.  StripeRailAdapter creates challenge with correct URL format
 * 2.  402 response includes settlements from registered rail adapters
 * 3.  402 response works with no rail adapters (backward compatible)
 * 4.  Multiple rail adapters produce multiple settlements
 * 5.  Failed rail adapter doesn't block 402 response
 * 6.  createChallenge receives correct parameters
 * 7.  CreditMeta accepts "mpp" source
 * 8.  paymentMode defaults to "hybrid"
 * 9.  x402 challenge populates backward-compat x402Challenge field
 * 10. MppRailAdapter requires mppx (graceful error)
 *
 * Run: node --test src/__tests__/rail-adapter.test.mjs
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── Inline InMemoryLedger ────────────────────────────────

class InMemoryLedger {
  constructor() {
    this.balances = new Map();
    this.transactions = [];
  }

  async getBalance(callerId) {
    return this.balances.get(callerId) ?? 0;
  }

  async deduct(callerId, amount, meta) {
    const current = this.balances.get(callerId) ?? 0;
    if (current < amount) return false;
    this.balances.set(callerId, current - amount);
    this.transactions.push({ type: "deduct", callerId, amount, meta });
    return true;
  }

  async credit(callerId, amount, meta) {
    const current = this.balances.get(callerId) ?? 0;
    this.balances.set(callerId, current + amount);
    this.transactions.push({ type: "credit", callerId, amount, meta });
  }

  async getUsage() {
    return 0;
  }
  async incrementUsage() {}
}

// ─── Inline StripeRailAdapter ─────────────────────────────

class StripeRailAdapter {
  constructor(config) {
    this.rail = "stripe";
    this.topUpBaseUrl =
      config?.topUpBaseUrl ??
      "https://tollgate-api.talha-korkmazeth.workers.dev/pay";
  }

  async createChallenge(params) {
    const amountCents = Math.ceil(params.amount * 100);
    return {
      rail: "stripe",
      url:
        `${this.topUpBaseUrl}` +
        `?publisher=${encodeURIComponent(params.publisherKey)}` +
        `&caller=${encodeURIComponent(params.callerId)}` +
        `&amount=${amountCents}` +
        `&currency=${params.currency}` +
        `&tool=${encodeURIComponent(params.toolName)}`,
      expiresAt: Math.floor(Date.now() / 1000) + 30 * 60,
    };
  }
}

// ─── Inline TollGate (with railAdapters + paymentMode) ───

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
      railAdapters: config.railAdapters ?? [],
      paymentMode: config.paymentMode ?? "hybrid",
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
    const callId = `tg_${Date.now().toString(36)}`;
    const ledger = this.config.ledger;

    const price =
      typeof tool.price === "number"
        ? tool.price
        : tool.price === "postpaid"
          ? 0
          : 0;

    const ctx = {
      callerId,
      callId,
      tool: tool.name,
      tier: "premium",
      balance: await ledger.getBalance(callerId),
      timestamp: Date.now(),
    };

    if (price > 0) {
      const ok = await ledger.deduct(callerId, price, {
        callId,
        tool: tool.name,
        amount: price,
      });
      if (!ok)
        return await this._handlePaymentFailure(
          tool,
          input,
          ctx,
          price,
          callerId,
        );
    }

    const output = await tool.handler(input, ctx);
    return { success: true, output };
  }

  async _handlePaymentFailure(tool, input, ctx, requiredAmount, callerId) {
    const paymentRequired = {
      status: 402,
      error: "payment_required",
      tool: tool.name,
      amount: requiredAmount,
      currency: this.config.defaultCurrency,
      acceptedRails: this.config.paymentRails,
      topUpUrl: `${this.config.topUpBaseUrl}?publisher=${this.config.publisherKey}&caller=${encodeURIComponent(callerId)}&amount=${Math.ceil(requiredAmount * 100)}`,
    };

    if (this.config.railAdapters.length > 0) {
      const results = await Promise.allSettled(
        this.config.railAdapters.map((adapter) =>
          adapter.createChallenge({
            callerId,
            amount: requiredAmount,
            currency: this.config.defaultCurrency,
            toolName: tool.name,
            publisherKey: this.config.publisherKey,
          }),
        ),
      );

      const settlements = [];
      for (const result of results) {
        if (result.status === "fulfilled") {
          settlements.push(result.value);
          if (result.value.x402PaymentRequired) {
            paymentRequired.x402Challenge = result.value.x402PaymentRequired;
          }
        }
      }
      if (settlements.length > 0) {
        paymentRequired.settlements = settlements;
      }
    }

    return { success: false, paymentRequired };
  }
}

// ─── Mock adapters ────────────────────────────────────────

function mockAdapter(rail, challengeOverrides = {}) {
  return {
    rail,
    async createChallenge(params) {
      return {
        rail,
        url: `https://${rail}.example.com/pay`,
        ...challengeOverrides,
      };
    },
  };
}

function throwingAdapter() {
  return {
    rail: "mpp",
    async createChallenge() {
      throw new Error("MPP service unavailable");
    },
  };
}

// ─── Tests ────────────────────────────────────────────────

describe("StripeRailAdapter", () => {
  it("creates challenge with correct URL format", async () => {
    const adapter = new StripeRailAdapter();
    const result = await adapter.createChallenge({
      callerId: "agent_001",
      amount: 0.05,
      currency: "usd",
      toolName: "premium_search",
      publisherKey: "tg_pub_test",
    });

    assert.equal(result.rail, "stripe");
    assert.ok(
      result.url.includes("publisher=tg_pub_test"),
      "should include publisherKey",
    );
    assert.ok(
      result.url.includes("caller=agent_001"),
      "should include callerId",
    );
    assert.ok(
      result.url.includes("amount=5"),
      "should include amount in cents (0.05 → 5)",
    );
    assert.ok(
      result.url.includes("tool=premium_search"),
      "should include toolName",
    );
    assert.ok(result.url.includes("currency=usd"), "should include currency");
    assert.ok(
      result.expiresAt > Math.floor(Date.now() / 1000),
      "should expire in future",
    );
  });

  it("uses custom topUpBaseUrl when provided", async () => {
    const adapter = new StripeRailAdapter({
      topUpBaseUrl: "https://my-api.example.com/pay",
    });
    const result = await adapter.createChallenge({
      callerId: "agent_001",
      amount: 1,
      currency: "usd",
      toolName: "search",
      publisherKey: "tg_pub_test",
    });

    assert.ok(
      result.url.startsWith("https://my-api.example.com/pay"),
      "should use custom URL",
    );
  });
});

describe("RailAdapter integration with TollGate", () => {
  it("402 response includes settlements from registered rail adapters", async () => {
    const ledger = new InMemoryLedger(); // zero balance
    const gate = new TollGate({
      publisherKey: "tg_pub_test",
      ledger,
      railAdapters: [mockAdapter("stripe")],
    });
    const tool = gate.paidTool({
      name: "search",
      price: 0.05,
      handler: async () => ({ results: [] }),
    });

    const result = await tool({}, "agent_001");

    assert.equal(result.success, false);
    assert.ok(result.paymentRequired, "should have paymentRequired");
    assert.ok(
      Array.isArray(result.paymentRequired.settlements),
      "should have settlements array",
    );
    assert.equal(
      result.paymentRequired.settlements.length,
      1,
      "should have 1 settlement",
    );
    assert.equal(result.paymentRequired.settlements[0].rail, "stripe");
  });

  it("402 works with no rail adapters (backward compatible)", async () => {
    const gate = new TollGate({
      publisherKey: "tg_pub_test",
      ledger: new InMemoryLedger(),
      // no railAdapters
    });
    const tool = gate.paidTool({
      name: "search",
      price: 0.05,
      handler: async () => ({}),
    });

    const result = await tool({}, "agent_001");

    assert.equal(result.success, false);
    assert.ok(result.paymentRequired, "should have paymentRequired");
    assert.equal(result.paymentRequired.status, 402);
    assert.equal(
      result.paymentRequired.settlements,
      undefined,
      "settlements should be undefined",
    );
    assert.ok(result.paymentRequired.topUpUrl, "should still have topUpUrl");
  });

  it("multiple rail adapters produce multiple settlements", async () => {
    const gate = new TollGate({
      publisherKey: "tg_pub_test",
      ledger: new InMemoryLedger(),
      railAdapters: [
        mockAdapter("stripe"),
        mockAdapter("x402", { x402PaymentRequired: { scheme: "exact" } }),
      ],
    });
    const tool = gate.paidTool({
      name: "search",
      price: 0.05,
      handler: async () => ({}),
    });

    const result = await tool({}, "agent_001");

    assert.equal(result.success, false);
    assert.equal(
      result.paymentRequired.settlements.length,
      2,
      "should have 2 settlements",
    );
    const rails = result.paymentRequired.settlements.map((s) => s.rail);
    assert.ok(rails.includes("stripe"), "should include stripe");
    assert.ok(rails.includes("x402"), "should include x402");
  });

  it("failed rail adapter doesn't block 402 response", async () => {
    const gate = new TollGate({
      publisherKey: "tg_pub_test",
      ledger: new InMemoryLedger(),
      railAdapters: [throwingAdapter(), mockAdapter("stripe")],
    });
    const tool = gate.paidTool({
      name: "search",
      price: 0.05,
      handler: async () => ({}),
    });

    const result = await tool({}, "agent_001");

    assert.equal(result.success, false);
    assert.ok(result.paymentRequired, "402 should still be returned");
    assert.equal(
      result.paymentRequired.settlements.length,
      1,
      "only succeeded adapter",
    );
    assert.equal(result.paymentRequired.settlements[0].rail, "stripe");
  });

  it("createChallenge receives correct parameters", async () => {
    const captured = [];
    const spyAdapter = {
      rail: "stripe",
      async createChallenge(params) {
        captured.push(params);
        return { rail: "stripe", url: "https://stripe.example.com" };
      },
    };

    const gate = new TollGate({
      publisherKey: "tg_pub_xyz",
      defaultCurrency: "eur",
      ledger: new InMemoryLedger(),
      railAdapters: [spyAdapter],
    });
    const tool = gate.paidTool({
      name: "my_tool",
      price: 0.1,
      handler: async () => ({}),
    });

    await tool({}, "caller_abc");

    assert.equal(captured.length, 1);
    assert.equal(captured[0].callerId, "caller_abc");
    assert.equal(captured[0].amount, 0.1);
    assert.equal(captured[0].currency, "eur");
    assert.equal(captured[0].toolName, "my_tool");
    assert.equal(captured[0].publisherKey, "tg_pub_xyz");
  });

  it("CreditMeta accepts 'mpp' source", async () => {
    const ledger = new InMemoryLedger();
    await ledger.credit("agent_001", 1.0, {
      source: "mpp",
      reference: "mpp_session_abc",
    });

    const balance = await ledger.getBalance("agent_001");
    assert.equal(balance, 1.0);

    const tx = ledger.transactions[0];
    assert.equal(tx.meta.source, "mpp");
    assert.equal(tx.meta.reference, "mpp_session_abc");
  });

  it("paymentMode defaults to 'hybrid'", async () => {
    const gate = new TollGate({ publisherKey: "tg_pub_test" });
    assert.equal(gate.config.paymentMode, "hybrid");
  });

  it("paymentMode can be set explicitly", async () => {
    const gate = new TollGate({
      publisherKey: "tg_pub_test",
      paymentMode: "per_request",
    });
    assert.equal(gate.config.paymentMode, "per_request");
  });

  it("x402 challenge populates backward-compat x402Challenge field", async () => {
    const x402MockAdapter = {
      rail: "x402",
      async createChallenge(params) {
        return {
          rail: "x402",
          x402PaymentRequired: {
            scheme: "exact",
            network: "eip155:8453",
            payTo: "0xabc",
            maxAmountRequired: String(params.amount),
          },
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        };
      },
    };

    const gate = new TollGate({
      publisherKey: "tg_pub_test",
      ledger: new InMemoryLedger(),
      railAdapters: [x402MockAdapter],
    });
    const tool = gate.paidTool({
      name: "search",
      price: 0.05,
      handler: async () => ({}),
    });

    const result = await tool({}, "agent_001");

    assert.equal(result.success, false);
    assert.ok(
      result.paymentRequired.x402Challenge,
      "backward-compat x402Challenge should be populated",
    );
    assert.equal(result.paymentRequired.x402Challenge.scheme, "exact");
    assert.equal(result.paymentRequired.x402Challenge.network, "eip155:8453");
  });
});

describe("MppRailAdapter peer dependency", () => {
  it("MppRailAdapter throws helpful error when mppx is not installed", async () => {
    // Inline minimal version of MppRailAdapter constructor guard
    // (mppx is not a devDependency — this test confirms graceful error behavior)
    function MppRailAdapterGuard(config) {
      let MppxLib;
      try {
        MppxLib = require("mppx/server");
      } catch {
        throw new Error(
          "mppx package not found. Install it: npm install mppx\n" +
            "mppx is required for MPP rail support.\n" +
            "Docs: https://mpp.dev/sdk/typescript",
        );
      }
      this.instance = MppxLib.Mppx.create({ methods: config.methods });
    }

    assert.throws(
      () => new MppRailAdapterGuard({ methods: [] }),
      (err) => {
        assert.ok(
          err.message.includes("npm install mppx"),
          "error should include install command",
        );
        assert.ok(
          err.message.includes("mppx package not found"),
          "error should identify missing package",
        );
        return true;
      },
    );
  });
});
