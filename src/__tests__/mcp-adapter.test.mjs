/**
 * MCP Adapter — Integration Tests
 *
 * Tests the full flow: TollGate SDK → MCP Adapter → MCP-compatible responses
 *
 * Scenarios:
 * 1. Paid tool with balance → success + receipt in _meta
 * 2. Paid tool without balance → 402 error with top-up URL
 * 3. Fallback tool → basic result + upgrade notice
 * 4. Tiered tool (free → premium transition)
 * 5. Dynamic pricing through MCP
 * 6. Tool description enrichment (pricing info)
 * 7. registerAll() with mock server
 * 8. Postpaid metering through MCP
 * 9. Error handling (handler throws)
 * 10. Custom caller ID extraction
 *
 * Run: node --test src/__tests__/mcp-adapter.test.mjs
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── Inline dependencies (same as paidTool tests) ──────────

class InMemoryLedger {
  constructor() {
    this.balances = new Map();
    this.usage = new Map();
    this.transactions = [];
  }
  async getBalance(id) { return this.balances.get(id) ?? 0; }
  async deduct(id, amount, meta) {
    const cur = this.balances.get(id) ?? 0;
    if (cur < amount) return false;
    this.balances.set(id, Math.round((cur - amount) * 1e6) / 1e6);
    this.transactions.push({ type: "deduct", callerId: id, amount, meta, timestamp: Date.now() });
    const key = `${id}:${meta.tool}:${new Date().toISOString().slice(0, 10)}`;
    this.usage.set(key, (this.usage.get(key) ?? 0) + 1);
    return true;
  }
  async credit(id, amount, meta) {
    const cur = this.balances.get(id) ?? 0;
    this.balances.set(id, Math.round((cur + amount) * 1e6) / 1e6);
    this.transactions.push({ type: "credit", callerId: id, amount, meta, timestamp: Date.now() });
  }
  async getUsage(id, tool, period) {
    const key = `${id}:${tool}:${new Date().toISOString().slice(0, 10)}`;
    return this.usage.get(key) ?? 0;
  }
  async incrementUsage(id, tool, period) {
    const key = `${id}:${tool}:${new Date().toISOString().slice(0, 10)}`;
    this.usage.set(key, (this.usage.get(key) ?? 0) + 1);
  }
}

// TollGate (minimal inline — same core logic as SDK)
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
  get ledger() { return this.config.ledger; }

  paidTool(tc) {
    this.tools.set(tc.name, tc);
    const execute = (input, callerId) => this._exec(tc, input, callerId);
    execute.toolName = tc.name;
    execute.config = tc;
    return execute;
  }

  async _exec(tool, input, callerId) {
    const callId = `tg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const ledger = this.config.ledger;
    this.config.hooks?.onCall?.(tool.name, callerId);

    let tier = "premium", price = 0, handler = tool.handler;
    if (tool.tiers) {
      if (tool.tiers.free) {
        const usage = await ledger.getUsage(callerId, tool.name, tool.tiers.free.period);
        if (usage < tool.tiers.free.limit) {
          tier = "free"; price = 0; handler = tool.tiers.free.handler ?? tool.handler;
        } else {
          tier = "premium";
          price = typeof tool.tiers.premium.price === "function" ? await tool.tiers.premium.price(input) : (tool.tiers.premium.price ?? 0);
          handler = tool.tiers.premium.handler ?? tool.handler;
        }
      }
    } else if (tool.price !== undefined && tool.price !== "postpaid") {
      price = typeof tool.price === "function" ? await tool.price(input) : tool.price;
    }

    const isPostpaid = tool.price === "postpaid";
    const ctx = { callerId, callId, tool: tool.name, tier, balance: await ledger.getBalance(callerId), timestamp: Date.now() };
    const needsPayment = tier === "premium" && price > 0 && !isPostpaid;

    if (needsPayment) {
      const ok = await ledger.deduct(callerId, price, { callId, tool: tool.name, amount: price });
      if (!ok) return this._payFail(tool, input, ctx, price);
      this.config.hooks?.onPayment?.(tool.name, callerId, price);
    }

    if (tool.beforeExecute) {
      const proceed = await tool.beforeExecute(input, ctx);
      if (!proceed) {
        if (needsPayment) await ledger.credit(callerId, price, { source: "manual", reference: `refund:${callId}:aborted` });
        return { success: false, output: { error: "Execution aborted by beforeExecute hook" } };
      }
    }

    const startedAt = Date.now();
    let output, metrics;
    try {
      output = await handler(input, ctx);
      const endedAt = Date.now();
      metrics = { durationMs: endedAt - startedAt, startedAt, endedAt };
    } catch (error) {
      const endedAt = Date.now();
      metrics = { durationMs: endedAt - startedAt, startedAt, endedAt };
      if (needsPayment) await ledger.credit(callerId, price, { source: "manual", reference: `refund:${callId}:error` });
      if (tool.onFail) await tool.onFail(input, error, ctx);
      return { success: false, output: { error: error.message }, metrics };
    }

    if (tier === "free" && tool.tiers?.free) {
      await ledger.incrementUsage(callerId, tool.name, tool.tiers.free.period);
    }

    if (isPostpaid && tool.meter) {
      const mr = await tool.meter(input, output, metrics);
      price = mr.amount;
      const ok = await ledger.deduct(callerId, price, { callId, tool: tool.name, amount: price });
      if (ok) this.config.hooks?.onPayment?.(tool.name, callerId, price);
    }

    if (tool.afterExecute) await tool.afterExecute(input, output, metrics);

    return {
      success: true, output,
      receipt: price > 0 ? { callId, tool: tool.name, amount: price, currency: this.config.defaultCurrency, rail: "prepaid", balanceAfter: await ledger.getBalance(callerId), timestamp: Date.now() } : undefined,
      metrics, isFallback: false,
    };
  }

  async _payFail(tool, input, ctx, req) {
    const policy = tool.onPaymentFailed ?? "block";
    if (tool.onPaymentFail) await tool.onPaymentFail(input, { code: "insufficient_balance", balance: ctx.balance, required: req });
    if (policy === "fallback" && tool.fallback) return { success: true, output: await tool.fallback(input, ctx), isFallback: true };
    if (policy === "allow_once") {
      const s = Date.now(); const o = await tool.handler(input, ctx); return { success: true, output: o, metrics: { durationMs: Date.now() - s, startedAt: s, endedAt: Date.now() }, isFallback: false };
    }
    return {
      success: false,
      paymentRequired: {
        status: 402, error: "payment_required", tool: tool.name,
        amount: req, currency: this.config.defaultCurrency,
        acceptedRails: this.config.paymentRails,
        topUpUrl: `https://pay.tollgate.dev/topup?publisher=${this.config.publisherKey}&amount=${Math.ceil(req * 100)}`,
      },
    };
  }
}

// ─── McpAdapter (inline for testing) ───────────────────────

class McpAdapter {
  constructor(gate, config) {
    this.gate = gate;
    this.config = {
      getCallerId: config?.getCallerId ?? ((_a, extra) => extra?.sessionId ?? "anonymous"),
      defaultCallerId: config?.defaultCallerId ?? "anonymous",
      includeMeta: config?.includeMeta ?? true,
    };
    this.registrations = [];
  }

  paidTool(name, config) {
    const gateTool = this.gate.paidTool({
      name, description: config.description,
      price: config.price, tiers: config.tiers,
      onPaymentFailed: config.onPaymentFailed ?? (config.fallback ? "fallback" : "block"),
      handler: async (input) => config.handler(input),
      fallback: config.fallback ? async (input) => config.fallback(input) : undefined,
      beforeExecute: config.beforeExecute,
      afterExecute: config.afterExecute,
      onFail: config.onFail,
      onPaymentFail: config.onPaymentFail,
      meter: config.meter,
    });

    const mcpHandler = async (args, extra) => {
      const callerId = this.config.getCallerId(args, extra ?? {});
      const result = await gateTool(args, callerId);
      return this._format(result, name);
    };

    const desc = this._buildDesc(name, config);
    const reg = { name, description: desc, inputSchema: config.inputSchema, handler: mcpHandler };
    this.registrations.push(reg);
    return reg;
  }

  registerAll(server) {
    for (const reg of this.registrations) {
      server.tool(reg.name, reg.inputSchema, reg.handler);
    }
  }

  getRegistrations() { return [...this.registrations]; }
  getGate() { return this.gate; }

  _format(result, toolName) {
    if (result.success) {
      const content = serialize(result.output);
      const mcpResult = { content, isError: false };
      if (this.config.includeMeta) {
        mcpResult._meta = {
          tollgate: {
            paid: !!result.receipt, isFallback: result.isFallback ?? false,
            receipt: result.receipt ?? null,
            metrics: result.metrics ? { durationMs: result.metrics.durationMs } : null,
          },
        };
      }
      if (result.isFallback) {
        content.push({ type: "text", text: "\n---\n⚡ This is a basic result. Top up your balance for the full premium version." });
      }
      return mcpResult;
    }

    if (result.paymentRequired) {
      const pr = result.paymentRequired;
      return {
        content: [{
          type: "text",
          text: `⚠️ Payment required to use "${toolName}".\n\nAmount: $${pr.amount.toFixed(4)} ${pr.currency.toUpperCase()}\nAccepted payment methods: ${pr.acceptedRails.join(", ")}\n${pr.topUpUrl ? `\nTop up balance: ${pr.topUpUrl}` : ""}\n\nTo continue, add funds to your Tollgate balance and retry.`,
        }],
        isError: true,
        _meta: this.config.includeMeta ? {
          tollgate: { paymentRequired: true, amount: pr.amount, currency: pr.currency, acceptedRails: pr.acceptedRails, topUpUrl: pr.topUpUrl ?? null },
        } : undefined,
      };
    }

    return {
      content: [{ type: "text", text: `Error executing "${toolName}": ${result.output?.error ?? "Unknown error"}` }],
      isError: true,
    };
  }

  _buildDesc(name, config) {
    const parts = [config.description];
    if (config.tiers?.free) {
      parts.push(`[Pricing: ${config.tiers.free.limit} free calls per ${config.tiers.free.period}, then paid]`);
    } else if (typeof config.price === "number") {
      parts.push(`[Pricing: $${config.price}/call]`);
    } else if (config.price === "postpaid") {
      parts.push(`[Pricing: usage-based metering]`);
    } else if (typeof config.price === "function") {
      parts.push(`[Pricing: dynamic per-call]`);
    }
    if (config.fallback) parts.push(`[Has free basic mode]`);
    return parts.join(" ");
  }
}

function serialize(output) {
  if (output == null) return [{ type: "text", text: "No output." }];
  if (typeof output === "string") return [{ type: "text", text: output }];
  if (typeof output === "object") return [{ type: "text", text: JSON.stringify(output, null, 2) }];
  return [{ type: "text", text: String(output) }];
}

// ═══════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════

describe("MCP Adapter", () => {
  let ledger, gate, mcp;

  beforeEach(() => {
    ledger = new InMemoryLedger();
    gate = new TollGate({ publisherKey: "tg_test", ledger });
    mcp = new McpAdapter(gate);
  });

  // ── 1. Paid tool with balance → MCP success ────────────

  describe("paid tool with balance", () => {
    it("returns MCP-formatted success with receipt metadata", async () => {
      await ledger.credit("session-1", 1.00, { source: "manual", reference: "test" });

      const tool = mcp.paidTool("premium_search", {
        description: "Premium web search",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string", description: "Search query" } },
          required: ["query"],
        },
        price: 0.05,
        handler: async ({ query }) => ({ results: [`Found: ${query}`] }),
      });

      const result = await tool.handler(
        { query: "AI payments" },
        { sessionId: "session-1" }
      );

      assert.equal(result.isError, false);
      assert.equal(result.content[0].type, "text");

      const output = JSON.parse(result.content[0].text);
      assert.deepEqual(output.results, ["Found: AI payments"]);

      // Check Tollgate metadata
      assert.ok(result._meta.tollgate);
      assert.equal(result._meta.tollgate.paid, true);
      assert.equal(result._meta.tollgate.isFallback, false);
      assert.equal(result._meta.tollgate.receipt.amount, 0.05);
      assert.equal(result._meta.tollgate.receipt.rail, "prepaid");
    });
  });

  // ── 2. No balance → 402 MCP error ──────────────────────

  describe("no balance → 402", () => {
    it("returns MCP error with payment required details", async () => {
      const tool = mcp.paidTool("expensive_tool", {
        description: "Expensive analysis",
        inputSchema: { type: "object", properties: { data: { type: "string" } } },
        price: 0.25,
        handler: async () => "should not run",
      });

      const result = await tool.handler({ data: "test" }, { sessionId: "broke" });

      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes("Payment required"));
      assert.ok(result.content[0].text.includes("$0.2500"));
      assert.ok(result.content[0].text.includes("tollgate.dev/topup"));

      // Structured metadata for smart agents
      assert.equal(result._meta.tollgate.paymentRequired, true);
      assert.equal(result._meta.tollgate.amount, 0.25);
      assert.deepEqual(result._meta.tollgate.acceptedRails, ["stripe"]);
    });
  });

  // ── 3. Fallback → basic result ─────────────────────────

  describe("fallback on payment failure", () => {
    it("returns basic result with upgrade notice", async () => {
      const tool = mcp.paidTool("research", {
        description: "Deep research tool",
        inputSchema: { type: "object", properties: { topic: { type: "string" } } },
        price: 0.50,
        handler: async ({ topic }) => ({ depth: "full", analysis: `Deep analysis of ${topic}` }),
        fallback: async ({ topic }) => ({ depth: "basic", summary: `Quick overview of ${topic}` }),
      });

      const result = await tool.handler({ topic: "quantum" }, { sessionId: "no-balance" });

      assert.equal(result.isError, false);
      assert.equal(result._meta.tollgate.isFallback, true);
      assert.equal(result._meta.tollgate.paid, false);

      // Output is the fallback
      const output = JSON.parse(result.content[0].text);
      assert.equal(output.depth, "basic");

      // Upgrade notice appended
      const lastContent = result.content[result.content.length - 1];
      assert.ok(lastContent.text.includes("Top up your balance"));
    });
  });

  // ── 4. Tiered access through MCP ───────────────────────

  describe("tiered access (free → premium)", () => {
    it("transitions from free to paid after limit", async () => {
      await ledger.credit("user-1", 1.00, { source: "manual", reference: "test" });

      const tool = mcp.paidTool("data_lookup", {
        description: "Data lookup service",
        inputSchema: { type: "object", properties: { id: { type: "number" } } },
        tiers: {
          free: { limit: 2, period: "day" },
          premium: { price: 0.03 },
        },
        handler: async ({ id }) => ({ record: id, data: "found" }),
      });

      // Call 1: free
      const r1 = await tool.handler({ id: 1 }, { sessionId: "user-1" });
      assert.equal(r1.isError, false);
      assert.equal(r1._meta.tollgate.paid, false); // no receipt = free

      // Call 2: free
      const r2 = await tool.handler({ id: 2 }, { sessionId: "user-1" });
      assert.equal(r2.isError, false);
      assert.equal(r2._meta.tollgate.paid, false);

      // Call 3: premium (should charge)
      const r3 = await tool.handler({ id: 3 }, { sessionId: "user-1" });
      assert.equal(r3.isError, false);
      assert.equal(r3._meta.tollgate.paid, true);
      assert.equal(r3._meta.tollgate.receipt.amount, 0.03);

      assert.equal(await ledger.getBalance("user-1"), 0.97);
    });
  });

  // ── 5. Dynamic pricing through MCP ─────────────────────

  describe("dynamic pricing", () => {
    it("resolves price from input via MCP", async () => {
      await ledger.credit("user-1", 2.00, { source: "manual", reference: "test" });

      const tool = mcp.paidTool("translate", {
        description: "AI translation",
        inputSchema: { type: "object", properties: { text: { type: "string" }, targetLang: { type: "string" } } },
        price: (input) => Math.ceil(input.text.length / 100) * 0.01,
        handler: async ({ text, targetLang }) => ({ translated: `[${targetLang}] ${text}` }),
      });

      // Short text: 1 cent
      const r1 = await tool.handler({ text: "Hello", targetLang: "tr" }, { sessionId: "user-1" });
      assert.equal(r1._meta.tollgate.receipt.amount, 0.01);

      // Longer text: 3 cents (250 chars → ceil(250/100) = 3)
      const longText = "x".repeat(250);
      const r2 = await tool.handler({ text: longText, targetLang: "de" }, { sessionId: "user-1" });
      assert.equal(r2._meta.tollgate.receipt.amount, 0.03);
    });
  });

  // ── 6. Description enrichment ──────────────────────────

  describe("description enrichment", () => {
    it("adds pricing info to tool description", () => {
      mcp.paidTool("tool_a", {
        description: "A simple tool",
        inputSchema: { type: "object", properties: {} },
        price: 0.10,
        handler: async () => "ok",
      });

      mcp.paidTool("tool_b", {
        description: "Another tool",
        inputSchema: { type: "object", properties: {} },
        tiers: { free: { limit: 5, period: "day" }, premium: { price: 0.02 } },
        handler: async () => "ok",
      });

      mcp.paidTool("tool_c", {
        description: "Tool with fallback",
        inputSchema: { type: "object", properties: {} },
        price: 0.50,
        handler: async () => "premium",
        fallback: async () => "basic",
      });

      const regs = mcp.getRegistrations();

      assert.ok(regs[0].description.includes("$0.1/call"));
      assert.ok(regs[1].description.includes("5 free calls per day"));
      assert.ok(regs[2].description.includes("$0.5/call"));
      assert.ok(regs[2].description.includes("free basic mode"));
    });
  });

  // ── 7. registerAll() with mock server ──────────────────

  describe("registerAll()", () => {
    it("registers all tools with a mock MCP server", () => {
      const registered = [];
      const mockServer = {
        tool(name, schema, handler) {
          registered.push({ name, schema, handler });
        },
      };

      mcp.paidTool("tool_1", {
        description: "First",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
        price: 0.01,
        handler: async () => "ok",
      });

      mcp.paidTool("tool_2", {
        description: "Second",
        inputSchema: { type: "object", properties: { x: { type: "number" } } },
        price: 0.02,
        handler: async () => "ok",
      });

      mcp.registerAll(mockServer);

      assert.equal(registered.length, 2);
      assert.equal(registered[0].name, "tool_1");
      assert.equal(registered[1].name, "tool_2");
      assert.equal(typeof registered[0].handler, "function");
    });
  });

  // ── 8. Postpaid metering through MCP ───────────────────

  describe("postpaid metering via MCP", () => {
    it("meters after execution and returns cost in receipt", async () => {
      await ledger.credit("user-1", 5.00, { source: "manual", reference: "test" });

      const tool = mcp.paidTool("gpu_compute", {
        description: "GPU-accelerated computation",
        inputSchema: { type: "object", properties: { data: { type: "string" } } },
        price: "postpaid",
        meter: async (_input, _output, metrics) => ({
          amount: metrics.durationMs * 0.0005,
        }),
        handler: async () => {
          await new Promise((r) => setTimeout(r, 30));
          return { computed: true };
        },
      });

      const result = await tool.handler({ data: "test" }, { sessionId: "user-1" });

      assert.equal(result.isError, false);
      assert.ok(result._meta.tollgate.paid);
      assert.ok(result._meta.tollgate.receipt.amount > 0.01); // ~30ms × 0.0005
    });
  });

  // ── 9. Error handling ──────────────────────────────────

  describe("error handling", () => {
    it("returns MCP error when handler throws", async () => {
      await ledger.credit("user-1", 1.00, { source: "manual", reference: "test" });

      const tool = mcp.paidTool("risky", {
        description: "May fail",
        inputSchema: { type: "object", properties: {} },
        price: 0.10,
        handler: async () => { throw new Error("API timeout"); },
      });

      const result = await tool.handler({}, { sessionId: "user-1" });

      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes("API timeout"));

      // Balance refunded
      assert.equal(await ledger.getBalance("user-1"), 1.00);
    });
  });

  // ── 10. Custom caller ID extraction ────────────────────

  describe("custom caller ID", () => {
    it("uses custom getCallerId for identity", async () => {
      const customMcp = new McpAdapter(gate, {
        getCallerId: (args, extra) => args._apiKey ?? extra?.sessionId ?? "anon",
      });

      await ledger.credit("key-abc123", 1.00, { source: "manual", reference: "test" });

      const tool = customMcp.paidTool("authed_tool", {
        description: "Requires API key",
        inputSchema: { type: "object", properties: { _apiKey: { type: "string" }, query: { type: "string" } } },
        price: 0.05,
        handler: async ({ query }) => `Result: ${query}`,
      });

      const result = await tool.handler(
        { _apiKey: "key-abc123", query: "test" },
        { sessionId: "fallback-session" }
      );

      assert.equal(result.isError, false);
      // Should use _apiKey as caller, not sessionId
      assert.equal(await ledger.getBalance("key-abc123"), 0.95);
      assert.equal(await ledger.getBalance("fallback-session"), 0);
    });
  });

  // ── 11. Anonymous caller (no session) ──────────────────

  describe("anonymous caller", () => {
    it("defaults to 'anonymous' when no session ID", async () => {
      await ledger.credit("anonymous", 0.50, { source: "manual", reference: "test" });

      const tool = mcp.paidTool("open_tool", {
        description: "Open tool",
        inputSchema: { type: "object", properties: {} },
        price: 0.01,
        handler: async () => "ok",
      });

      // No sessionId provided
      const result = await tool.handler({}, {});
      assert.equal(result.isError, false);
      assert.equal(await ledger.getBalance("anonymous"), 0.49);
    });
  });
});
