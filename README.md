# Toolgate

**Toolgate — Paid-action runtime for MCP tools.**
Execution, billing, recovery, and idempotency for paid AI agent tool calls.

Toolgate sits above payment rails and MCP transports. It adds fallback behavior, idempotent replay, execution traces, and refund or no-charge outcomes when the paid path fails.

## What's New in 0.3.0-beta.0

- **Integer money** — All billing uses `Money` (bigint minor units). No more `0.1 + 0.2 = 0.30000000000000004` in production billing.
- **Atomic idempotency** — `claim() / complete() / fail()` with lease expiry. Concurrent requests with the same key are safely blocked instead of double-charging.
- **Rail-aware recovery** — `determineRecovery()` selects the correct recovery action per payment rail (prepaid credit-back, Stripe refund, x402 compensation).

**Breaking changes from 0.2.x:**

- `LedgerAdapter.getBalance()` now returns `Money` (not `number`)
- `LedgerAdapter.credit()` now takes `Money` and returns `TransactionId`
- `LedgerAdapter.deduct()` now takes `Money` and returns `{success, txId}`
- `IdempotencyStore` interface replaced with atomic `claim/complete/fail/peek`
- `price: 0.1` still works but logs a deprecation warning; use `usd("0.10")` instead

## Quickstart

```bash
npm install
npm run build
npm test
```

## Acceptance Scenarios

```bash
npm run scenario:ledger
npm run scenario:stripe
npm run scenario:firecrawl
npm run scenario:firecrawl:live -- <url>
npm run scenario:mcp-e2e
npm run scenario:mpp
npm run scenario:x402
npm run scenario:x402-testnet
```

What the current runners cover:

- payment missing to fallback or payment_required
- paid execution after recovery
- duplicate request replay without double charge
- handler failure refund or no_charge behavior
- execution trace inspection

## Environment-Gated Runs

`scenario:stripe` uses real Stripe test mode plus Stripe CLI webhook forwarding.

Required:

- `STRIPE_SECRET_KEY`

`scenario:x402-testnet` uses an explicit x402 facilitator and a real payment proof from an external signer or client flow.

Required:

- `X402_FACILITATOR_URL`
- `X402_PAY_TO`
- `X402_PAYMENT_PROOF_JSON`

Optional for a separate `settlement_uncertain` run:

- `X402_PAYMENT_UNCERTAIN_PROOF_JSON`

Helper flow:

- `npm run scenario:x402-testnet:challenge` creates a Toolgate x402 challenge JSON
- `npm run scenario:x402-testnet:sign -- <challenge.json>` signs that challenge with `X402_SIGNER_PRIVATE_KEY` and `X402_RPC_URL`
- feed the resulting `{ actionId, payload }` JSON into `X402_PAYMENT_PROOF_JSON`

`scenario:firecrawl:live` uses the real Firecrawl API.

Required:

- `FIRECRAWL_API_KEY`

## x402 Testnet Flow

This repo validates Toolgate's x402 challenge, verify/settle, duplicate replay, and recovery lifecycle. The actual x402 payment payload is produced by the x402 client or signer helper using a test wallet.

```bash
export X402_NETWORK_CAIP2="eip155:84532"
export X402_FACILITATOR_URL="https://..."
export X402_PAY_TO="0xReceiver"
export X402_RPC_URL="https://..."
export X402_SIGNER_PRIVATE_KEY="0xTestWalletPrivateKey"

node examples/x402-testnet-recovery/challenge.mjs --request-id x402-paid-001 > challenge.json

node examples/x402-testnet-recovery/sign-payload.mjs challenge.json > proof.json

export X402_PAYMENT_PROOF_JSON="$(cat proof.json)"

npm run scenario:x402-testnet
```

For `settlement_uncertain`:

```bash
node examples/x402-testnet-recovery/challenge.mjs --request-id x402-uncertain-001 > challenge-uncertain.json

node examples/x402-testnet-recovery/sign-payload.mjs challenge-uncertain.json > proof-uncertain.json

export X402_PAYMENT_UNCERTAIN_PROOF_JSON="$(cat proof-uncertain.json)"

npm run scenario:x402-testnet
```

The flow is intentionally explicit:

- `challenge.mjs` produces the Toolgate-generated x402 challenge.
- `sign-payload.mjs` produces the x402 client or signer-generated proof.
- `scenario:x402-testnet` validates Toolgate verify, settle, duplicate replay, fallback, and recovery behavior with that proof.

## Support Matrix

| Rail                | Status                   | What's tested                                                                                                     | Guarantee                                                     |
| ------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Prepaid ledger      | **Production candidate** | Integer money (no float drift), atomic idempotency, webhook-safe credit, audit trail. SQLite/D1 backed.           | No double-charge. No float drift. Refund = instant credit-back. |
| Stripe test mode    | **Validated**            | Real Stripe API. Checkout session creation, webhook signature verification, balance credit, duplicate protection. | Works with `sk_test_` keys.                                   |
| Stripe production   | **Beta**                 | Same code as test mode. Requires production webhook endpoint deployment.                                          | Use at your own risk until design partner validation.         |
| x402 (Base Sepolia) | **Experimental**         | Real USDC on Base Sepolia testnet. EIP-3009 signing, Coinbase facilitator verify+settle.                          | Settlement can be uncertain. Requires external wallet signer. |
| x402 (mainnet)      | **Not tested**           | No mainnet testing performed.                                                                                     | Do not use with real funds without independent audit.         |
| MPP                 | **Mocked**               | Adapter verification path and recovery behavior validated.                                                        | Spec-compliant mock only.                                     |

> **Postgres adapter**: interface is designed and stable (`LedgerAdapter`, `IdempotencyStore`, `TraceStore`). Implementation ships in a future `@tkorkmaz/toolgate-postgres` package. Current production path is SQLite via `DbLedger` + `InMemoryIdempotencyStore` (safe for single-process deployments).

## Self-Hosting

By default the SDK links to the hosted Toolgate top-up API for Stripe checkout redirects.
To self-host, point to your own endpoint:

```ts
// Option A: env var (works without code changes)
process.env.TOOLGATE_TOPUP_URL = "https://api.yourapp.com/toolgate/pay";

// Option B: constructor option
const gate = new ToolGate({
  publisherKey: "tg_your_key",
  topUpBaseUrl: "https://api.yourapp.com/toolgate/pay",
});
```

The endpoint receives `?publisher=...&caller=...&amount=...` and must redirect to a Stripe Checkout session.

## Outreach Gate

Outreach remains blocked until both of these are true:

1. `npm run scenario:stripe` passes with real Stripe test-mode credentials
2. `npm run scenario:mcp-e2e` passes

At the moment, MCP SDK E2E is green. Stripe test mode is implemented but still depends on `STRIPE_SECRET_KEY` being present in the shell that runs the scenario.

## Firecrawl Integration

The first real MCP integration target lives in `integrations/firecrawl-mcp-toolgate/`.

It now has three distinct surfaces:

- `scenario-fake.mjs`: deterministic regression coverage
- `scenario-live.mjs`: live Firecrawl API path
- `scenario-mcp-e2e.mjs`: official MCP SDK server and client E2E over stdio

## x402 Disclaimer

x402 remains experimental here for one practical reason: proving a real testnet payment still requires an external signer or x402 client flow. The acceptance runner now splits that dependency into challenge generation plus proof signing instead of hiding it behind mocked credits.

## License

MIT
