# Toolgate

Monetize your MCP tools with usage-based payments — 5 lines of code, no proxy, full control.

```
npm install toolgate
```

---

## Quick Start

Works immediately with the built-in in-memory ledger — no Stripe account needed to test:

```typescript
import { ToolGate } from "toolgate";

const gate = new ToolGate({ publisherKey: "tg_test" });

// Pre-load a test balance
await gate.ledger.credit("user-1", 1.0, {
  source: "manual",
  reference: "test",
});

// Wrap any function with payment enforcement
const search = gate.paidTool({
  name: "premium_search",
  price: 0.05, // $0.05 per call
  handler: async (input) => {
    return { results: [`Premium result for: ${input.query}`] };
  },
  fallback: async (input) => {
    return { results: ["Free preview. Top up for full results."] };
  },
});

// Call it
const result = await search({ query: "hello" }, "user-1");
// → {
//     success: true,
//     output: { results: ["Premium result for: hello"] },
//     receipt: { callId: "tg_xxx", amount: 0.05, balanceAfter: 0.95, ... }
//   }
```

## What Just Happened?

When you call `search(input, callerId)`, Toolgate runs this pipeline:

```
1. Check balance    – does "user-1" have ≥ $0.05?
2. Deduct atomically – $0.05 removed *before* execution
3. Run your handler  – only on successful payment
4. Return a receipt  – callId, amount, balanceAfter, durationMs
5. Refund on error   – if handler throws, $0.05 is automatically returned
```

If the balance is insufficient:

- With `fallback` → runs the fallback handler and returns `isFallback: true`
- Without `fallback` → returns `{ paymentRequired: { status: 402, topUpUrl: "..." } }`

---

## Features

### Dynamic Pricing

Price based on input complexity — translate $0.01 per 100 chars, compute by duration, etc:

```typescript
const translate = gate.paidTool({
  name: "smart_translate",
  price: (input) => Math.ceil(input.text.length / 100) * 0.01,
  handler: async ({ text, targetLang }) => translate(text, targetLang),
});
```

### Free Tier + Premium Access

Give users N free calls per period, then charge:

```typescript
const lookup = gate.paidTool({
  name: "data_lookup",
  tiers: {
    free: { limit: 10, period: "day" }, // 10 free calls/day
    premium: { price: 0.03 }, // $0.03 after that
  },
  handler: async ({ id }) => fetchData(id),
});
```

### Graceful Fallback

Return a degraded result instead of a hard block:

```typescript
const research = gate.paidTool({
  name: "deep_research",
  price: 0.25,
  onPaymentFailed: "fallback",
  handler: async (input) => deepAnalysis(input),
  fallback: async (input) => quickSummary(input), // runs when balance < $0.25
});
```

### Postpaid Metering

Charge based on actual resource consumption (tokens, duration, API cost):

```typescript
const compute = gate.paidTool({
  name: "heavy_compute",
  price: "postpaid",
  handler: async (input) => doWork(input),
  meter: async (input, output, metrics) => ({
    amount: metrics.durationMs * 0.0001, // $0.0001/ms
  }),
});
```

### Lifecycle Hooks

Full control over every step:

```typescript
const gated = gate.paidTool({
  name: "gated_tool",
  price: 0.1,
  beforeExecute: async (input, ctx) => {
    // Custom gate — require minimum balance for high-value calls
    return ctx.balance >= 0.5;
  },
  afterExecute: async (input, output, metrics) => {
    await logToAnalytics({ tool: "gated_tool", ms: metrics.durationMs });
  },
  onFail: async (input, error, ctx) => {
    await alertTeam(error);
  },
  onPaymentFail: async (input, reason) => {
    if (reason.code === "insufficient_balance") {
      await notifyUser(
        `Balance: $${reason.balance}. Required: $${reason.required}`,
      );
    }
  },
  handler: async (input) => doWork(input),
});
```

### Global Observability

Hook into every call, payment, and error across all tools:

```typescript
const gate = new ToolGate({
  publisherKey: "tg_pub_xxx",
  hooks: {
    onCall: (tool, callerId) => metrics.increment(`calls.${tool}`),
    onPayment: (tool, callerId, amount) => metrics.gauge("revenue", amount),
    onError: (tool, error) => Sentry.captureException(error),
  },
});
```

---

## MCP Adapter

Use Toolgate with the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk):

```bash
npm install toolgate @modelcontextprotocol/sdk
```

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ToolGate, createMcpAdapter } from "toolgate";

const gate = new ToolGate({ publisherKey: "tg_test" });
const mcp = createMcpAdapter(gate);

// Pre-load test balance (replace with real Stripe in production)
await gate.ledger.credit("test-user", 1.0, {
  source: "manual",
  reference: "demo",
});

const server = new McpServer({ name: "my-paid-tools", version: "1.0.0" });

mcp.paidTool("premium_search", {
  description: "AI-powered search",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "Search query" } },
    required: ["query"],
  },
  price: 0.05,
  handler: async ({ query }) => ({ results: [`Premium: ${query}`] }),
  fallback: async ({ query }) => ({
    results: [`Free preview for: ${query}`],
    note: "Top up your balance for full results",
  }),
});

mcp.registerAll(server); // batch-registers all tools

const transport = new StdioServerTransport();
await server.connect(transport);
```

**Auto-enriched descriptions** — pricing is appended automatically:

```
premium_search — AI-powered search [Price: $0.05/call]
```

**Structured response metadata** — every call returns a `_meta.toolgate` block:

```json
{
  "_meta": {
    "toolgate": {
      "receipt": {
        "callId": "tg_abc123",
        "amount": 0.05,
        "balanceAfter": 0.95
      },
      "metrics": { "durationMs": 142 }
    }
  }
}
```

**Payment Required response** (when no fallback and balance is zero):

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "Payment required: $0.05 to call premium_search. Top up: https://checkout.stripe.com/..."
    }
  ]
}
```

See [`examples/basic-server/`](examples/basic-server/) for a runnable demo.

---

## Stripe Integration

Wire up real payments in 3 steps.

### Step 1 — Create a Checkout session when balance is low

```typescript
import { StripeAdapter } from "toolgate";

const stripe = new StripeAdapter({
  secretKey: process.env.STRIPE_SECRET_KEY!,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
});

// Returns a Stripe Checkout URL pre-filled with the right amount
const { url } = await stripe.buildTopUpUrl("user-1", "tg_pub_xxx", 0.05);
// → https://checkout.stripe.com/pay/cs_live_...
// Pass this URL back in the 402 response so the caller can top up
```

Top-up tiers: **$1 · $5 · $10 · $25** (auto-selects the smallest tier ≥ required amount).

### Step 2 — Handle the webhook to credit balances

```typescript
import { WebhookHandler } from "toolgate";

const webhook = new WebhookHandler({
  stripeClient: stripe.client,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  ledger: gate.ledger,
});

// In your HTTP handler (Express, Cloudflare Worker, etc.):
app.post("/webhooks/stripe", async (req, res) => {
  const result = await webhook.handle(
    req.rawBody, // must be raw Buffer, not parsed JSON
    req.headers["stripe-signature"]!,
  );
  res.status(result.processed ? 200 : 400).json(result);
});
```

`WebhookHandler` automatically:

- Verifies the `Stripe-Signature` HMAC — rejects spoofed requests
- De-duplicates event IDs — prevents double-credits on Stripe retries
- Converts cents → USD and credits the ledger atomically

### Step 3 — Publisher payouts via Stripe Connect

```typescript
// Onboard a publisher
const { accountId } = await stripe.createConnectAccount(
  "publisher@example.com",
);
const { url } = await stripe.createAccountLink(
  accountId,
  returnUrl,
  refreshUrl,
);
// → redirect publisher to url for KYC + bank details

// Schedule weekly payouts (3–10% platform fee retained)
await stripe.payoutToPublisher(accountId, grossAmountCents);
```

### Step 4 — Production ledger (Cloudflare D1 / Turso / SQLite)

Swap `InMemoryLedger` for `DbLedger` — same API, persistent across restarts:

```typescript
import { DbLedger, ToolGate } from "toolgate";

// Run once on startup (idempotent — safe to call every time)
await DbLedger.runMigrations(db); // db = Cloudflare D1 env.DB, Turso client, etc.

const gate = new ToolGate({
  publisherKey: process.env.TOOLGATE_PUBLISHER_KEY!,
  ledger: new DbLedger(db),
});
```

Schema created: `tg_balances`, `tg_transactions`, `tg_usage`.

---

## Payment Flow

```
Caller                 Toolgate SDK              Stripe
──────                 ────────────              ──────
Top up          ──→   Checkout session  ──→   Stripe Checkout
                       Webhook received ──←   checkout.session.completed
                       Credit ledger

Tool called     ──→   Balance check
                       Deduct atomically
                       Run handler       ──→   Your code
                       Return receipt    ──←   Result

No balance      ──→   Run fallback  OR  Return 402 + topUpUrl
Handler throws  ──→   Refund balance, return error
```

---

## LedgerAdapter (custom storage)

Implement this interface to use any storage backend:

```typescript
interface LedgerAdapter {
  getBalance(callerId: string): Promise<number>;
  deduct(callerId: string, amount: number, meta: DeductMeta): Promise<boolean>;
  credit(callerId: string, amount: number, meta: CreditMeta): Promise<void>;
  getUsage(callerId: string, tool: string, period: string): Promise<number>;
  incrementUsage(callerId: string, tool: string, period: string): Promise<void>;
}
```

`deduct` must return `false` (not throw) when the balance is insufficient.

---

## Pricing

| Tier         | Calls/month | Platform fee |
| ------------ | ----------- | ------------ |
| Free         | 1,000       | 10%          |
| Pro $29/mo   | 50,000      | 5%           |
| Scale $99/mo | Unlimited   | 3%           |

[Sign up at toolgate.dev →](https://toolgate.dev)

---

## License

MIT — see [LICENSE](LICENSE).
