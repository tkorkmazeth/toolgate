# x402 on Solana (SVM) — Toolgate Integration Notes

Toolgate's `X402RailAdapter` is rail-agnostic and already speaks the x402
challenge/verify/settle flow. EVM and Solana differ only in **how the client
authorizes payment** and a couple of **requirement fields**. This integration
adds first-class Solana (SVM "exact" scheme) support without a new rail.

## EVM vs Solana — what actually changes

| | EVM (existing) | Solana / SVM (this integration) |
| --- | --- | --- |
| Authorization | EIP-3009 `transferWithAuthorization`, EIP-712 signature | Client builds + **partially signs** a real SPL transfer tx |
| Gas | none (3009) | client holds no SOL; **facilitator is fee payer** |
| Uniqueness | nonce in the authorization | **Memo instruction** (random nonce or seller memo) |
| x402 version | 1 | **2** (the SVM exact scheme is defined for v2) |
| Settlement | facilitator `/settle` | facilitator co-signs fee-payer slot, then submits |

## End-to-end flow

1. **Challenge** — `X402RailAdapter.createChallenge()` emits an x402 v2
   `PaymentRequirements` with:
   - `network`: the `solana:<genesisHash>` CAIP-2 id
   - `asset`: the SPL USDC **mint** (auto-resolved from `SOLANA_USDC_ADDRESSES`)
   - `payTo`: base58 recipient
   - `extra.feePayer`: the facilitator's fee payer (set via
     `X402RailConfig.feePayer`, or fetched with `adapter.discoverFeePayer()`
     from the facilitator's `GET /supported`)

2. **Sign (client)** — `examples/x402-solana-recovery/sign-payload.mjs`
   `buildSolanaPaymentPayload()` builds a v0 transaction:
   `ComputeBudget(limit) + ComputeBudget(price ≤ 5) + TransferChecked + Memo`,
   with `payerKey = feePayer`. The client `partialSign`s its own slot, leaving
   the fee-payer signature empty, and base64-encodes it into
   `payload.transaction`.

3. **Verify** — `adapter.verifyPayment(proof, { actionId })` POSTs to the
   facilitator `/verify`. Validation only — nothing settles yet.

4. **Execute** — Toolgate runs the paid tool.

5. **Settle** — `adapter.settlePayment(proof, { actionId })` POSTs to `/settle`;
   the facilitator signs the fee-payer slot and submits to a validator. The
   Solana tx signature is surfaced as `SettlementResult.txhash`.

Verify and settle are **independent failure domains**: a payment can verify yet
fail to settle on-chain. Toolgate's recovery/trace layer makes that
`settlement_uncertain` state explicit instead of collapsing it into one bit.

## Configuring the rail for Solana

```ts
import { X402RailAdapter } from "@tkorkmaz/toolgate";

const rail = new X402RailAdapter({
  payTo: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSMQRdW", // base58
  network: { kind: "solana", caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }, // devnet
  facilitatorUrl: "https://facilitator.payai.network", // Solana-first, no API key
  // feePayer: "...",            // hardcode, or:
});
await rail.discoverFeePayer();   // pulls extra.feePayer from /supported
```

### Facilitators that support Solana

- **PayAI** — Solana-first, single drop-in endpoint, no API key.
- **Coinbase CDP** — Base + Solana; free tier (~1k tx/mo).
- **Self-hosted (Kora)** — run your own signer node / facilitator.

## Tests

- `src/__tests__/x402-solana-rail.test.mjs` — challenge shape, fee-payer
  discovery, and **verify/settle success + failure paths** (facilitator stubbed
  via a fake `fetch`; no network).
- `src/__tests__/x402-solana-sign.test.mjs` — offline signer: asserts the
  produced payload is x402 v2, the fee-payer slot is empty (partial sign), and
  the serialized tx carries the 4 expected instructions.

`@solana/web3.js` and `@solana/spl-token` are needed only for the client-side
signer (dynamically imported, dev-only) — the core SDK install stays light.
