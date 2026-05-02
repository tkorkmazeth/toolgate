/**
 * Toolgate — Basic MCP Server Example
 *
 * A minimal paid MCP server showcasing:
 *   - Static per-call pricing ($0.05)
 *   - Fallback when balance is insufficient
 *   - check_balance and add_balance utility tools for testing
 *
 * Setup:
 *   npm install
 *   node index.mjs        # stdio transport (for Claude Desktop)
 *
 * Claude Desktop config (~/.claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "basic-example": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/examples/basic-server/index.mjs"]
 *       }
 *     }
 *   }
 *
 * The server pre-loads a $1.00 demo balance so you can test immediately.
 * Use `add_balance` to top up and `check_balance` to inspect the ledger.
 * In production, replace the credit() call with real Stripe top-ups.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ToolGate, createMcpAdapter } from "toolgate";

// ─── Toolgate setup ──────────────────────────────────────────

const gate = new ToolGate({
  publisherKey: process.env.TOOLGATE_PUBLISHER_KEY ?? "tg_test",
});

const mcp = createMcpAdapter(gate, {
  // Extract caller identity from the MCP session ID.
  // In production this maps to a real Toolgate account.
  getCallerId: (_args, extra) => extra?.sessionId ?? "demo-user",
});

// Pre-load $1.00 demo balance so the server works out of the box.
await gate.ledger.credit("demo-user", 1.00, {
  source: "manual",
  reference: "demo-preload",
});

// ─── Paid tool: premium_search ────────────────────────────────

mcp.paidTool("premium_search", {
  description: "AI-powered search with deep analysis.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
    },
    required: ["query"],
  },

  price: 0.05,   // $0.05 per call (static)

  handler: async ({ query }) => {
    // Replace with your real search implementation.
    return {
      results: [
        `[Premium] Top result for "${query}": Deep analysis result A`,
        `[Premium] Top result for "${query}": Deep analysis result B`,
      ],
      source: "premium-index",
      credits_used: 0.05,
    };
  },

  // Runs when caller has no balance — returns a degraded result instead of 402.
  fallback: async ({ query }) => ({
    results: [`[Free preview] Basic result for "${query}"`],
    note: "Top up your balance with `add_balance` for full results.",
  }),
});

// ─── Free utility tools ───────────────────────────────────────

const server = new McpServer({
  name: "toolgate-basic-example",
  version: "1.0.0",
});

// check_balance — inspect current balance + recent transactions
server.tool(
  "check_balance",
  { caller_id: z.string().optional().describe("Caller ID (default: demo-user)") },
  async ({ caller_id = "demo-user" }) => {
    const balance = await gate.ledger.getBalance(caller_id);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ caller_id, balance_usd: balance }, null, 2),
      }],
    };
  },
);

// add_balance — simulate a Stripe top-up for demo purposes
server.tool(
  "add_balance",
  {
    amount_usd: z.number().min(0.01).max(100).describe("Amount in USD to add"),
    caller_id: z.string().optional().describe("Caller ID (default: demo-user)"),
  },
  async ({ amount_usd, caller_id = "demo-user" }) => {
    await gate.ledger.credit(caller_id, amount_usd, {
      source: "manual",
      reference: `demo-topup-${Date.now()}`,
    });
    const balance = await gate.ledger.getBalance(caller_id);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          added_usd: amount_usd,
          new_balance_usd: balance,
          note: "In production this is triggered by a Stripe webhook.",
        }, null, 2),
      }],
    };
  },
);

// ─── Register paid tools + start server ───────────────────────

mcp.registerAll(server);

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write("[toolgate-basic] Server started. Pre-loaded $1.00 demo balance.\n");
