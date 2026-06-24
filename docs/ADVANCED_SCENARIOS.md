# Advanced Scenarios and Payment Rails

This page collects scenario runners and external-service setup notes that are useful after
the local runtime example is working.

Start with the local example first:

```bash
npm run example:local
```

## Scenario runners

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

These runners cover:

- payment missing to fallback or `payment_required`,
- paid execution after local credit or payment verification,
- duplicate request replay without double charge,
- handler failure recovery,
- execution trace inspection.

## Environment-gated scenarios

### Stripe test mode

`scenario:stripe` uses Stripe test mode plus Stripe CLI webhook forwarding.

Required:

- `STRIPE_SECRET_KEY`

### Firecrawl live mode

`scenario:firecrawl:live` uses the real Firecrawl API.

Required:

- `FIRECRAWL_API_KEY`

### x402 testnet

`scenario:x402-testnet` uses an explicit x402 facilitator and a payment proof from an
external signer or client flow.

Required:

- `X402_FACILITATOR_URL`
- `X402_PAY_TO`
- `X402_PAYMENT_PROOF_JSON`

Optional for a separate `settlement_uncertain` run:

- `X402_PAYMENT_UNCERTAIN_PROOF_JSON`

Helper commands:

```bash
npm run scenario:x402-testnet:challenge
npm run scenario:x402-testnet:sign -- <challenge.json>
```

## x402 testnet signing flow

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

The flow separates challenge generation from payment proof creation:

- `challenge.mjs` produces the Tollgate-generated x402 challenge.
- `sign-payload.mjs` produces the x402 client or signer-generated proof.
- `scenario:x402-testnet` validates verify, settle, duplicate replay, fallback, and recovery behavior.

## Rail status

| Rail              | Status             | Notes                                                                  |
| ----------------- | ------------------ | ---------------------------------------------------------------------- |
| Prepaid ledger    | Developer preview  | Integer money, idempotency, trace recording, and credit-back recovery. |
| Stripe test mode  | Validated          | Requires `sk_test_` credentials and webhook forwarding.                |
| Stripe production | Beta               | Validate your own webhook and deployment path before use.              |
| x402              | Experimental       | Settlement can be uncertain; requires external signer/client flow.     |
| x402 mainnet      | Not tested         | Do not use with real funds without independent validation.             |
| MPP               | Mocked / spec-path | Verify against a real `mppx` integration before relying on it.         |

## Self-hosted top-up endpoint

By default, payment-required responses can include a top-up URL. To use your own endpoint:

```ts
const gate = new TollGate({
  publisherKey: "tg_your_key",
  topUpBaseUrl: "https://api.yourapp.com/tollgate/pay",
});
```

The endpoint receives `?publisher=...&caller=...&amount=...` and should redirect to your
checkout or payment flow.

## Firecrawl integration

The Firecrawl integration lives in `integrations/firecrawl-mcp-tollgate/`.

- `scenario-fake.mjs`: deterministic regression coverage.
- `scenario-live.mjs`: live Firecrawl API path.
- `scenario-mcp-e2e.mjs`: MCP SDK server/client E2E over stdio.
