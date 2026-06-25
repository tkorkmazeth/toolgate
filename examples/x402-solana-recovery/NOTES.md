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

Server side — wrap the paid tool and advertise the Solana challenge:

```ts
import { X402RailAdapter } from "@niceberglabs/tollgate";

const rail = new X402RailAdapter({
  payTo: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSMQRdW", // base58
  network: { kind: "solana", caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }, // devnet
  facilitatorUrl: "https://facilitator.payai.network", // Solana-first, no API key
  // feePayer: "...",            // hardcode, or:
});
await rail.discoverFeePayer();   // pulls extra.feePayer from /supported
```

Client side — the signer ships in the package (install `@solana/web3.js` and
`@solana/spl-token` to use it):

```ts
import { buildSolanaPaymentPayload } from "@niceberglabs/tollgate";

const { paymentPayload } = await buildSolanaPaymentPayload({
  challenge,                  // the 402 / x402PaymentRequired block
  payerSecretKey,             // 64-byte Uint8Array
  rpcUrl: "https://api.devnet.solana.com",
});
// retry the tool call with paymentPayload as the x402 proof
```

### Facilitators that support Solana

- **PayAI** — Solana-first, single drop-in endpoint, no API key.
- **Coinbase CDP** — Base + Solana; free tier (~1k tx/mo).
- **Self-hosted (Kora)** — run your own signer node / facilitator.

## Verified on devnet

Run end-to-end against PayAI + Solana devnet with `devnet-settle.mjs`
(self-transfer smoke test; fund the printed address once at
https://faucet.circle.com → "Solana Devnet"):

```bash
node examples/x402-solana-recovery/devnet-settle.mjs
# … /verify → VALID ✅   /settle → SETTLED ✅
# tx: 5JeSK1je6xrt3HouPUSKheawqiwJhVPtSufqyzNgyqCLBKSZ11KrvtyE5PoxQKEzMKCNfyRTuezVuv39j93TqdGx
```

A confirmed devnet settle (`err: None`) had its **fee paid by the facilitator's
fee payer, not the client** — the gasless SVM design working as intended.

**Mainnet smoke (real USDC):** the same flow settled on Solana **mainnet-beta**
via PayAI, self-transfer, `err: None`, fee paid by the facilitator
(tx `3d9k5PACqnSqYk42xMjyvkdzZZNfDPjysRyHGVzpxxCYu1womD6eMAGQx2neZcNCerLNkbjDoy15Y31pdqysaLTn`).
Run it with `SOLANA_NETWORK=mainnet` (see `devnet-settle.mjs`).

A real cross-account transfer (set `PAY_TO` to a second funded wallet) moved
exactly 0.001 USDC payer → recipient on devnet, gas paid by the facilitator:
payer 20 → 19.999, recipient 20 → 20.001
(tx `de6S852jpFTJ1hHLNMBPAaWqrkkMXzjq8XqPbbCf3LD4s1Mm6ZDAU3ah6dxUZueyN19U2FXP58E7CstHGctSncG`).
Note: the SVM "exact" scheme has a fixed instruction layout (no ATA creation),
so the recipient's token account must already exist before settle.

### Protocol details learned from a live facilitator

The SVM "exact" v2 wire format is stricter than the EVM path. Getting verify to
pass required:

- The `paymentPayload` must embed the agreed requirement under **`accepted`**,
  and the amount there is an **atomic string** field named **`amount`** (not
  `maxAmountRequired`). The signer emits this shape.
- The transaction's **compute-unit limit is bounded**: too high (~50k+) is
  rejected (`compute_limit_too_high`), and too low (≤10k) fails simulation. The
  signer defaults to 30k, with compute-unit price clamped to ≤ 5.
- The fee payer must be account[0] and a non-participant in the transfer.

The rail's `verify`/`settle` request bodies were already correct for v2 — the
fixes were entirely client-side in the signer.

## Tests

- `src/__tests__/x402-solana-rail.test.mjs` — challenge shape, fee-payer
  discovery, and **verify/settle success + failure paths** (facilitator stubbed
  via a fake `fetch`; no network).
- `src/__tests__/x402-solana-sign.test.mjs` — offline signer: asserts the
  produced payload is x402 v2, the fee-payer slot is empty (partial sign), and
  the serialized tx carries the 4 expected instructions.
- `src/__tests__/x402-solana-e2e.test.mjs` — full lifecycle through the MCP
  adapter against a fake in-process facilitator: 402 discovery → sign → verify →
  credit → execute → settle, asserting the trace records `rail_payment_verified`
  and `rail_payment_settled` with the on-chain tx signature.

`@solana/web3.js` and `@solana/spl-token` are optional peer dependencies, needed
only for the client-side signer (`buildSolanaPaymentPayload`, dynamically
imported) — the core SDK install stays light for callers that never sign on Solana.
