/**
 * Tollgate — Advanced MCP Server Example
 *
 * Showcases all Tollgate features:
 *   1. Static pricing          — premium_search ($0.05/call + fallback)
 *   2. Dynamic pricing         — smart_translate ($0.01/100 chars)
 *   3. Free tier + premium     — data_lookup (10 free/day, then $0.03)
 *   4. Postpaid metering       — heavy_compute ($0.0001/ms of execution)
 *   5. Lifecycle hooks         — audited_action (beforeExecute, afterExecute, onFail)
 *   6. Global observability    — onCall, onPayment, onError hooks
 *   7. Utility tools           — check_balance, add_balance
 *
 * Setup:
 *   npm install
 *   node index.mjs
 *
 * Claude Desktop config:
 *   {
 *     "mcpServers": {
 *       "advanced-example": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/examples/advanced-server/index.mjs"]
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TollGate, createMcpAdapter, usd, toNumber } from "@niceberglabs/tollgate";

// ─── Observability ───────────────────────────────────────────

const stats = { calls: 0, revenue: 0, errors: 0 };

// ─── Tollgate setup with global hooks ────────────────────────

const gate = new TollGate({
  publisherKey: process.env.TOLLGATE_PUBLISHER_KEY ?? "tg_test",

  hooks: {
    onCall: (tool, callerId) => {
      stats.calls++;
      process.stderr.write(`[call] ${tool} by ${callerId}\n`);
    },
    onPayment: (tool, callerId, amount) => {
      stats.revenue += amount;
      process.stderr.write(
        `[paid] ${tool} $${amount.toFixed(4)} by ${callerId}\n`,
      );
    },
    onError: (tool, error) => {
      stats.errors++;
      process.stderr.write(`[error] ${tool}: ${error.message}\n`);
    },
  },
});

const mcp = createMcpAdapter(gate, {
  getCallerId: (_args, extra) => extra?.sessionId ?? "demo-user",
  includeMeta: true, // attach _meta.tollgate to every response
});

// Pre-load $2.00 demo balance
await gate.ledger.credit("demo-user", usd("2.00"), {
  source: "manual",
  reference: "demo-preload",
});

// ─── Tool 1: Static pricing + fallback ───────────────────────

mcp.paidTool("premium_search", {
  description: "AI-powered search with deep semantic analysis.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: {
        type: "number",
        description: "Max results (default 5)",
        default: 5,
      },
    },
    required: ["query"],
  },
  price: usd("0.05"),
  onPaymentFailed: "fallback",
  handler: async ({ query, limit = 5 }) => ({
    results: Array.from(
      { length: limit },
      (_, i) => `[Premium] Result ${i + 1} for "${query}"`,
    ),
    quality: "premium",
    price_paid: 0.05,
  }),
  fallback: async ({ query }) => ({
    results: [`[Free] Basic result for "${query}"`],
    quality: "basic",
    note: "Top up with add_balance for premium results.",
  }),
});

// ─── Tool 2: Dynamic pricing ─────────────────────────────────

mcp.paidTool("smart_translate", {
  description: "Translate text. Price: $0.01 per 100 characters.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to translate" },
      target_lang: {
        type: "string",
        description: "Target language code (e.g. 'es', 'fr', 'de')",
      },
    },
    required: ["text", "target_lang"],
  },

  // Price calculated from the input — longer text = higher price
  price: (input) => Math.max(0.01, Math.ceil(input.text.length / 100) * 0.01),

  handler: async ({ text, target_lang }) => ({
    original: text,
    translated: `[${target_lang.toUpperCase()}] ${text}`, // stub translation
    chars: text.length,
    price_usd: Math.max(0.01, Math.ceil(text.length / 100) * 0.01),
  }),
});

// ─── Tool 3: Tiered access (free → premium) ──────────────────

mcp.paidTool("data_lookup", {
  description: "Look up records. 10 free per day, then $0.03/call.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Record ID to look up" },
    },
    required: ["id"],
  },

  tiers: {
    free: { limit: 10, period: "day" },
    premium: { price: usd("0.03") },
  },

  handler: async ({ id }) => ({
    id,
    data: { name: `Record ${id}`, value: Math.random().toFixed(4) },
    timestamp: new Date().toISOString(),
  }),
});

// ─── Tool 4: Postpaid metering ────────────────────────────────

mcp.paidTool("heavy_compute", {
  description: "CPU-intensive computation. Charged $0.0001/ms of runtime.",
  inputSchema: {
    type: "object",
    properties: {
      complexity: {
        type: "number",
        description: "Complexity level 1–10 (higher = longer runtime)",
        minimum: 1,
        maximum: 10,
      },
    },
    required: ["complexity"],
  },

  price: "postpaid",

  handler: async ({ complexity }) => {
    // Simulate work proportional to complexity
    const iterations = complexity * 100_000;
    let sum = 0;
    for (let i = 0; i < iterations; i++) sum += Math.sqrt(i);
    return { result: sum.toFixed(2), complexity, iterations };
  },

  meter: async (_input, _output, metrics) => ({
    // Charge based on actual duration
    amount: Math.max(0.001, metrics.durationMs * 0.0001),
    breakdown: { duration_ms: metrics.durationMs, rate_per_ms: 0.0001 },
  }),
});

// ─── Tool 5: Full lifecycle hooks ────────────────────────────

mcp.paidTool("audited_action", {
  description: "Sensitive action with full audit trail. $0.10/call.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "Action to perform" },
      payload: { type: "string", description: "Action payload (JSON string)" },
    },
    required: ["action"],
  },
  price: usd("0.10"),

  beforeExecute: async (_input, ctx) => {
    // Require a minimum balance buffer before executing
    if (ctx.balance < 0.2) {
      process.stderr.write(
        `[audit] Blocked ${ctx.callerId}: balance too low ($${ctx.balance})\n`,
      );
      return false;
    }
    process.stderr.write(
      `[audit] Authorised ${ctx.callerId} for action. Balance: $${ctx.balance}\n`,
    );
    return true;
  },

  afterExecute: async (input, output, metrics) => {
    // Log for compliance / audit trail
    const entry = {
      action: input.action,
      duration_ms: metrics.durationMs,
      timestamp: new Date(metrics.startedAt).toISOString(),
    };
    process.stderr.write(`[audit-log] ${JSON.stringify(entry)}\n`);
  },

  onFail: async (input, error, ctx) => {
    process.stderr.write(
      `[audit-fail] ${input.action} by ${ctx.callerId}: ${error.message}\n`,
    );
  },

  onPaymentFail: async (_input, reason) => {
    if (reason.code === "insufficient_balance") {
      process.stderr.write(
        `[payment-fail] Balance: $${reason.balance}, required: $${reason.required}\n`,
      );
    }
  },

  handler: async ({ action, payload }) => {
    if (action === "fail")
      throw new Error("Simulated failure (for testing refund)");
    return {
      action,
      payload,
      status: "completed",
      at: new Date().toISOString(),
    };
  },
});

// ─── Free utility tools ───────────────────────────────────────

const server = new McpServer({
  name: "tollgate-advanced-example",
  version: "1.0.0",
});

server.tool(
  "check_balance",
  {
    caller_id: z.string().optional().describe("Caller ID (default: demo-user)"),
  },
  async ({ caller_id = "demo-user" }) => {
    const balance = await gate.ledger.getBalance(caller_id);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              caller_id,
              balance_usd: toNumber(balance),
              session_stats: stats,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  "add_balance",
  {
    amount_usd: z.number().min(0.01).max(100).describe("Amount in USD to add"),
    caller_id: z.string().optional().describe("Caller ID (default: demo-user)"),
  },
  async ({ amount_usd, caller_id = "demo-user" }) => {
    await gate.ledger.credit(caller_id, usd(amount_usd), {
      source: "manual",
      reference: `topup-${Date.now()}`,
    });
    const balance = await gate.ledger.getBalance(caller_id);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { added_usd: amount_usd, new_balance_usd: toNumber(balance) },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── Register all paid tools + start ─────────────────────────

mcp.registerAll(server);

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write(
  `[tollgate-advanced] Server started. Tools: premium_search, smart_translate, ` +
    `data_lookup, heavy_compute, audited_action. Balance: $2.00 pre-loaded.\n`,
);
