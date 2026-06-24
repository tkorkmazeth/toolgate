# Toolgate

Toolgate is an open-source runtime for reliable paid or quota-limited MCP/tool calls.
It handles fallback, idempotent retries, metering, recovery, and execution traces so
tool calls do not break or double-charge on edge cases.

## Quickstart

```bash
npm install
npm run build
npm run example:local
```

The local example runs in-memory with `InMemoryLedger`. It does not require Stripe,
x402, MPP, wallets, webhooks, hosted APIs, or environment variables.

## Features

- Fallback responses when a caller cannot pay.
- Idempotent replay for retried requests.
- Integer-money accounting with `Money` helpers such as `usd()`.
- Metering hooks for usage-based tools.
- Execution traces for paid tool calls.
- Prepaid recovery when execution fails after charge.
- Optional Stripe, x402, and MPP rail adapters.

## Minimal usage

```ts
import { ToolGate, InMemoryLedger, usd } from "@tkorkmaz/toolgate";

const ledger = new InMemoryLedger();
const gate = new ToolGate({ publisherKey: "tg_local_demo", ledger });

const search = gate.paidTool({
  name: "premium_search",
  price: usd("0.05"),
  onPaymentFailed: "fallback",
  idempotencyKey: (input) => `premium_search:${input.requestId}`,
  handler: async (input) => ({ tier: "premium", query: input.query }),
  fallback: async (input) => ({ tier: "free", query: input.query }),
});

// No balance: returns fallback, no charge.
await search({ query: "vector dbs", requestId: "r1" }, "caller-1");

await ledger.credit("caller-1", usd("1.00"), {
  source: "manual",
  reference: "dev-credit",
});

// Paid call: deducts $0.05 and returns a receipt.
const result = await search(
  { query: "vector dbs", requestId: "r2" },
  "caller-1",
);
console.log(result.receipt);

// Same requestId: replays the previous result without a second deduct.
await search({ query: "vector dbs", requestId: "r2" }, "caller-1");
```

## MCP usage

```ts
import { ToolGate, createMcpAdapter, usd } from "@tkorkmaz/toolgate";

const gate = new ToolGate({ publisherKey: "tg_local_demo" });
const mcp = createMcpAdapter(gate, {
  getCallerId: (_args, extra) => extra?.sessionId ?? "demo-user",
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
```

See [docs/MCP_QUICKSTART.md](docs/MCP_QUICKSTART.md) for MCP response metadata and fallback behavior.

## Status

Current version: `0.3.0-beta.0`.

| Area                         | Status                                                          |
| ---------------------------- | --------------------------------------------------------------- |
| Core runtime                 | Developer preview                                               |
| In-memory ledger/idempotency | Local development and single-process prototypes                 |
| SQLite / D1 ledger           | Local and single-process paths                                  |
| Stripe test mode             | Validated with configured test credentials                      |
| Stripe production            | Beta; validate your webhook and deployment path                 |
| x402 (EVM)                   | Experimental                                                    |
| x402 (Solana / SVM)          | Experimental; SVM "exact" scheme, facilitator verify/settle ([notes](examples/x402-solana-recovery/NOTES.md)) |
| x402 mainnet                 | Not tested                                                      |
| MPP                          | Mocked / spec-path unless verified with real `mppx` integration |
| Multi-instance production    | Requires durable idempotency; future work                       |

Payment rails are optional adapters. The first-run path uses the local prepaid ledger.

See [Known limitations](docs/KNOWN_LIMITATIONS.md) for the current boundaries around durable
idempotency, Stripe production, x402 mainnet, and MPP.

## Docs

- [MCP quickstart](docs/MCP_QUICKSTART.md)
- [Advanced scenarios and payment rails](docs/ADVANCED_SCENARIOS.md)
- [Known limitations](docs/KNOWN_LIMITATIONS.md)
- [Recommended demo: paid Firecrawl-style extraction](docs/DEMO_USE_CASE.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Local runtime example](examples/local-first-runtime/scenario.mjs)

## License

MIT
