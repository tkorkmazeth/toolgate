# MCP Quickstart

Wrap an existing MCP tool with Tollgate so it handles pricing, fallback, idempotency,
recovery, and traces — without rewriting your tool. Start local-first, add payment rails later.

All imports use the public package API (`@niceberglabs/tollgate`).

## 1. Wrap a tool with `createMcpAdapter`

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TollGate, createMcpAdapter, usd } from "@niceberglabs/tollgate";

const server = new McpServer({ name: "my-tools", version: "1.0.0" });

const gate = new TollGate({ publisherKey: "tg_local_demo" });
const mcp = createMcpAdapter(gate, {
  // Map an MCP session to a Tollgate caller identity.
  getCallerId: (_args, extra) => extra?.sessionId ?? "demo-user",
  // Attach Tollgate metadata to responses (default true).
  includeMeta: true,
});

mcp.paidTool("premium_search", {
  description: "AI-powered search with deep analysis.",
  price: usd("0.05"),
  onPaymentFailed: "fallback",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  handler: async (args) => ({ results: [`deep results for ${args.query}`] }),
  fallback: async (args) => ({ results: [`basic result for ${args.query}`] }),
});

// Register the wrapped tool(s) with your MCP server.
mcp.registerAll(server);
```

If you omit `fallback`, the tool defaults to `onPaymentFailed: "block"` and returns a
`payment_required` response instead of a degraded result.

## 2. How fallback appears in MCP output

When the caller can't pay and a `fallback` is defined, the tool still returns a successful
MCP result — the degraded payload plus a notice appended to the content:

```
⚡ This is a basic result. Top up your balance for the full premium version.
```

No charge is made. With `onPaymentFailed: "block"` (no fallback) the call returns
`isError: true` with a "Payment required" message, the amount, accepted rails, and a top-up URL.

## 3. What `_meta.tollgate` contains

On a normal/fallback result (`includeMeta: true`):

```jsonc
{
  "_meta": {
    "tollgate": {
      "paid": true,            // false when served from fallback
      "isFallback": false,
      "receipt": {             // null when nothing was charged
        "amount": 0.05,
        "currency": "usd",
        "rail": "prepaid",
        "balanceAfter": 0.95
      },
      "metrics": { "durationMs": 12 }
    }
  }
}
```

On a `payment_required` (402) result:

```jsonc
{
  "_meta": {
    "tollgate": {
      "paymentRequired": true,
      "amount": 0.05,
      "currency": "usd",
      "acceptedRails": ["stripe"],
      "topUpUrl": "https://your-topup-endpoint.example/pay?..."
    }
  }
}
```

Agents that understand Tollgate can read `_meta.tollgate` to decide whether to top up and retry.

## 4. Start local-first, add rails later

You do **not** need Stripe, x402, or MPP to develop and test. Use the in-memory ledger and
credit callers directly:

```ts
import { InMemoryLedger, usd } from "@niceberglabs/tollgate";

const ledger = new InMemoryLedger();
const gate = new TollGate({ publisherKey: "tg_local_demo", ledger });

await ledger.credit("demo-user", usd("1.00"), {
  source: "manual",
  reference: "dev-credit",
});
```

When you're ready for real money, add a rail adapter (`StripeRailAdapter`, `X402RailAdapter`,
or `MppRailAdapter`) to the `TollGate` config and switch the ledger to `DbLedger`. See the
README "Advanced payment rails" and "Production status" sections for maturity and limitations.

For a runnable, no-env demo of the full lifecycle:

```bash
npm run example:local
```
