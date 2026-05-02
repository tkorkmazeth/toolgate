#!/usr/bin/env node

/**
 * Toolgate Demo MCP Server
 *
 * A working MCP server over stdio that showcases all Toolgate features.
 * Connect this to Claude Desktop to see payment-gated tools in action.
 *
 * Setup in Claude Desktop config (~/.claude/claude_desktop_config.json):
 * {
 *   "mcpServers": {
 *     "toolgate-demo": {
 *       "command": "node",
 *       "args": ["/path/to/toolgate-mvp/src/demo-server.mjs"]
 *     }
 *   }
 * }
 *
 * The demo pre-loads $1.00 balance for the "demo-user" caller.
 * Tools demonstrate: static pricing, dynamic pricing, tiered access,
 * fallback, postpaid metering, and lifecycle hooks.
 */

import { createInterface } from "node:readline";

// ═══════════════════════════════════════════════════════════
// Inline SDK (no build step needed — self-contained demo)
// ═══════════════════════════════════════════════════════════

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
    this.transactions.push({ type: "deduct", callerId: id, amount, meta, ts: Date.now() });
    const key = `${id}:${meta.tool}:${new Date().toISOString().slice(0, 10)}`;
    this.usage.set(key, (this.usage.get(key) ?? 0) + 1);
    return true;
  }
  async credit(id, amount, meta) {
    const cur = this.balances.get(id) ?? 0;
    this.balances.set(id, Math.round((cur + amount) * 1e6) / 1e6);
    this.transactions.push({ type: "credit", callerId: id, amount, meta, ts: Date.now() });
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

class ToolGate {
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
        return { success: false, output: { error: "Aborted by beforeExecute" } };
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

    if (tier === "free" && tool.tiers?.free) await ledger.incrementUsage(callerId, tool.name, tool.tiers.free.period);

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
    if (policy === "allow_once") { const s = Date.now(); const o = await tool.handler(input, ctx); return { success: true, output: o, metrics: { durationMs: Date.now() - s, startedAt: s, endedAt: Date.now() }, isFallback: false }; }
    return {
      success: false,
      paymentRequired: { status: 402, error: "payment_required", tool: tool.name, amount: req, currency: this.config.defaultCurrency, acceptedRails: this.config.paymentRails, topUpUrl: `https://pay.toolgate.dev/topup?publisher=${this.config.publisherKey}&amount=${Math.ceil(req * 100)}` },
    };
  }
}

// ═══════════════════════════════════════════════════════════
// MCP Server (JSON-RPC over stdio)
// ═══════════════════════════════════════════════════════════

const SERVER_INFO = {
  name: "toolgate-demo",
  version: "0.1.0",
};

// ─── Setup ToolGate ──────────────────────────────────────

const ledger = new InMemoryLedger();
const gate = new ToolGate({
  publisherKey: "tg_demo",
  ledger,
  hooks: {
    onCall: (tool, caller) => log(`[call] ${tool} by ${caller}`),
    onPayment: (tool, caller, amt) => log(`[payment] ${tool}: $${amt.toFixed(4)} from ${caller}`),
    onError: (tool, err) => log(`[error] ${tool}: ${err.message}`),
  },
});

// Pre-load demo balance
await ledger.credit("demo-user", 1.00, { source: "manual", reference: "demo-preload" });
log(`[init] Pre-loaded $1.00 for demo-user`);

// ─── Define Tools ────────────────────────────────────────

const tools = {};

// Tool 1: Static pricing — simple paid search
tools["premium_search"] = {
  description: "Premium web search with AI-powered analysis. [Pricing: $0.05/call] [Has free basic mode]",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
    },
    required: ["query"],
  },
  gate: gate.paidTool({
    name: "premium_search",
    price: 0.05,
    onPaymentFailed: "fallback",
    handler: async (input) => ({
      type: "premium",
      query: input.query,
      results: [
        { title: `Deep analysis: ${input.query}`, relevance: 0.98, snippet: "Comprehensive AI-powered analysis with citations and cross-references..." },
        { title: `Expert insights on ${input.query}`, relevance: 0.95, snippet: "Curated expert opinions with confidence scoring..." },
        { title: `Data-driven report: ${input.query}`, relevance: 0.91, snippet: "Statistical analysis and trend identification..." },
      ],
      totalResults: 1250,
      analysisDepth: "comprehensive",
    }),
    fallback: async (input) => ({
      type: "basic",
      query: input.query,
      results: [
        { title: `Basic result for: ${input.query}`, relevance: 0.7, snippet: "Limited preview..." },
      ],
      totalResults: "upgrade for full count",
      note: "This is a basic result. Add funds for premium AI-powered analysis.",
    }),
  }),
};

// Tool 2: Dynamic pricing — translation (price by input length)
tools["smart_translate"] = {
  description: "AI translation with quality scoring. [Pricing: dynamic per-call — $0.01 per 100 characters]",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to translate" },
      targetLang: { type: "string", description: "Target language code (e.g., 'tr', 'de', 'ja')" },
    },
    required: ["text", "targetLang"],
  },
  gate: gate.paidTool({
    name: "smart_translate",
    price: (input) => Math.max(0.01, Math.ceil(String(input.text || "").length / 100) * 0.01),
    handler: async (input) => ({
      original: input.text,
      translated: `[${input.targetLang}] ${input.text}`, // Mock translation
      targetLang: input.targetLang,
      qualityScore: 0.94,
      charCount: String(input.text || "").length,
      cost: `$${(Math.max(0.01, Math.ceil(String(input.text || "").length / 100) * 0.01)).toFixed(4)}`,
    }),
  }),
};

// Tool 3: Tiered access — data lookup (3 free/day, then paid)
tools["data_lookup"] = {
  description: "Company data enrichment lookup. [Pricing: 3 free calls per day, then $0.03/call]",
  inputSchema: {
    type: "object",
    properties: {
      company: { type: "string", description: "Company name to look up" },
    },
    required: ["company"],
  },
  gate: gate.paidTool({
    name: "data_lookup",
    tiers: {
      free: { limit: 3, period: "day" },
      premium: { price: 0.03 },
    },
    handler: async (input) => ({
      company: input.company,
      domain: `${String(input.company).toLowerCase().replace(/\s+/g, "")}.com`,
      employees: Math.floor(Math.random() * 10000) + 100,
      revenue: `$${(Math.random() * 100).toFixed(1)}M`,
      founded: 2015 + Math.floor(Math.random() * 10),
      sector: "Technology",
    }),
  }),
};

// Tool 4: Check balance — free utility tool
tools["check_balance"] = {
  description: "Check your Toolgate prepaid balance and usage stats. [Free]",
  inputSchema: {
    type: "object",
    properties: {},
  },
  gate: gate.paidTool({
    name: "check_balance",
    price: 0, // Free tool
    handler: async (_input, ctx) => {
      const txs = ledger.transactions.filter(t => t.callerId === ctx.callerId);
      const totalSpent = txs.filter(t => t.type === "deduct").reduce((sum, t) => sum + t.amount, 0);
      const totalCredited = txs.filter(t => t.type === "credit" && t.meta?.source !== "manual").reduce((sum, t) => sum + t.amount, 0);
      return {
        callerId: ctx.callerId,
        balance: `$${ctx.balance.toFixed(4)}`,
        totalSpent: `$${totalSpent.toFixed(4)}`,
        totalRefunded: `$${totalCredited.toFixed(4)}`,
        transactionCount: txs.length,
        lastTransaction: txs.length > 0 ? txs[txs.length - 1] : null,
      };
    },
  }),
};

// Tool 5: Add balance — simulate top-up (for demo purposes)
tools["add_balance"] = {
  description: "Add funds to your Toolgate balance (demo mode — instant credit). [Free]",
  inputSchema: {
    type: "object",
    properties: {
      amount: { type: "number", description: "Amount in USD to add (e.g., 1.00)" },
    },
    required: ["amount"],
  },
  gate: gate.paidTool({
    name: "add_balance",
    price: 0,
    handler: async (input, ctx) => {
      const amount = Number(input.amount) || 0;
      if (amount <= 0 || amount > 100) {
        return { error: "Amount must be between $0.01 and $100.00" };
      }
      await ledger.credit(ctx.callerId, amount, { source: "stripe", reference: `demo-topup-${Date.now()}` });
      const newBalance = await ledger.getBalance(ctx.callerId);
      return {
        credited: `$${amount.toFixed(2)}`,
        newBalance: `$${newBalance.toFixed(4)}`,
        message: "Balance topped up successfully!",
      };
    },
  }),
};

// ─── Format result for MCP ───────────────────────────────

function formatResult(toolName, result) {
  if (result.success) {
    const text = typeof result.output === "string"
      ? result.output
      : JSON.stringify(result.output, null, 2);

    const content = [{ type: "text", text }];

    if (result.isFallback) {
      content.push({
        type: "text",
        text: "\n---\n⚡ This is a basic result. Use 'add_balance' tool to top up, then retry for premium results.",
      });
    }

    if (result.receipt) {
      content.push({
        type: "text",
        text: `\n📝 Receipt: $${result.receipt.amount.toFixed(4)} charged | Balance: $${result.receipt.balanceAfter.toFixed(4)}`,
      });
    }

    return { content, isError: false };
  }

  if (result.paymentRequired) {
    const pr = result.paymentRequired;
    return {
      content: [{
        type: "text",
        text: [
          `⚠️ Payment required to use "${toolName}".`,
          `Amount needed: $${pr.amount.toFixed(4)} USD`,
          `Your balance: insufficient`,
          ``,
          `Use the "add_balance" tool to top up your balance, then retry.`,
          `Example: add_balance({ amount: 1.00 })`,
        ].join("\n"),
      }],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: `Error: ${result.output?.error ?? "Unknown error"}` }],
    isError: true,
  };
}

// ─── MCP JSON-RPC Handler ────────────────────────────────

const CALLER_ID = "demo-user"; // In production, derive from session/auth

async function handleRequest(request) {
  const { method, params, id } = request;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: SERVER_INFO,
          capabilities: {
            tools: { listChanged: false },
          },
        },
      };

    case "notifications/initialized":
      return null; // No response for notifications

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: Object.entries(tools).map(([name, t]) => ({
            name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      };

    case "tools/call": {
      const toolName = params?.name;
      const args = params?.arguments ?? {};

      if (!tools[toolName]) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
            isError: true,
          },
        };
      }

      const gateTool = tools[toolName].gate;
      const result = await gateTool(args, CALLER_ID);
      const mcpResult = formatResult(toolName, result);

      return { jsonrpc: "2.0", id, result: mcpResult };
    }

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// ─── stdio Transport ─────────────────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });
let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();

  // Parse JSON-RPC messages (newline-delimited)
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const request = JSON.parse(trimmed);
      handleRequest(request).then((response) => {
        if (response) {
          process.stdout.write(JSON.stringify(response) + "\n");
        }
      }).catch((err) => {
        log(`[error] ${err.message}`);
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32603, message: err.message },
        }) + "\n");
      });
    } catch {
      // Skip malformed JSON
    }
  }
});

function log(msg) {
  process.stderr.write(`${msg}\n`);
}

log(`[toolgate-demo] MCP server started (stdio)`);
log(`[toolgate-demo] 5 tools registered: ${Object.keys(tools).join(", ")}`);
log(`[toolgate-demo] Demo balance: $1.00 for "demo-user"`);
