/**
 * x402 Solana (SVM) Rail Adapter Tests
 *
 * Covers the Solana-specific surface of X402RailAdapter without touching the
 * network or a real validator — the facilitator's /verify, /settle, and
 * /supported endpoints are stubbed via a fake global.fetch.
 *
 * Verify and settle are exercised SEPARATELY, and each is tested for BOTH the
 * success and the failure path (per-call asserts), because in x402 the two
 * phases fail independently: a payment can verify yet fail to settle on-chain.
 *
 *  1. createChallenge → Solana payment requirement shape (network, asset mint,
 *     payTo, x402Version=2, extra.feePayer)
 *  2. createChallenge → omits feePayer when not configured
 *  3. discoverFeePayer → reads facilitator /supported and caches it
 *  4. verifyPayment SUCCESS → facilitator says valid → VerificationResult
 *  5. verifyPayment FAIL    → facilitator says invalid → null
 *  6. verifyPayment FAIL    → facilitator non-200 → null
 *  7. settlePayment SUCCESS → facilitator settles → SettlementResult + txHash
 *  8. settlePayment FAIL    → facilitator success:false → null
 *  9. settlePayment FAIL    → facilitator throws/network error → null
 * 10. settle → sends x402Version 2 + SVM requirement body to facilitator
 *
 * Run: node --test src/__tests__/x402-solana-rail.test.mjs
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { X402RailAdapter } from "../../dist/rail-adapters/x402-rail.js";

// Solana devnet CAIP-2 + its auto-detected USDC mint (from SOLANA_USDC_ADDRESSES)
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const SOLANA_DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PAY_TO = "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSMQRdW";
const FEE_PAYER = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpDq9TC5GtoY8N";
const FACILITATOR = "https://facilitator.example.test";

// ─── fetch stub plumbing ──────────────────────────────────

const realFetch = globalThis.fetch;
let fetchCalls; // [{ url, body }]
let fetchHandler; // (url, init) => { ok, json }

function installFetch() {
  fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    fetchCalls.push({ url: String(url), body });
    const res = await fetchHandler(String(url), body);
    return {
      ok: res.ok ?? true,
      async json() {
        return res.json ?? {};
      },
    };
  };
}

function restoreFetch() {
  globalThis.fetch = realFetch;
}

function makeAdapter(overrides = {}) {
  return new X402RailAdapter({
    payTo: PAY_TO,
    network: { kind: "solana", caip2: SOLANA_DEVNET },
    facilitatorUrl: FACILITATOR,
    feePayer: FEE_PAYER,
    ...overrides,
  });
}

const CHALLENGE_PARAMS = {
  callerId: "agent_sol_1",
  amount: 0.05,
  currency: "usd",
  toolName: "premium_search",
  publisherKey: "tg_pub_test",
};

// A minimal x402 SVM proof — the rail forwards payload.transaction verbatim,
// so the exact bytes don't matter for the adapter-level contract.
const SOL_PROOF = {
  rail: "x402",
  x402PaymentPayload: {
    x402Version: 2,
    scheme: "exact",
    network: SOLANA_DEVNET,
    payload: { transaction: "BASE64_PARTIALLY_SIGNED_TX" },
  },
};

// ─── Challenge shape ──────────────────────────────────────

describe("x402 Solana — createChallenge", () => {
  it("builds an SVM payment requirement with mint, payTo, v2 and feePayer", async () => {
    const adapter = makeAdapter();
    const action = await adapter.createChallenge(CHALLENGE_PARAMS);

    assert.equal(action.rail, "x402");
    assert.ok(action.actionId, "actionId should be present");
    assert.equal(
      action.x402PaymentRequired.x402Version,
      2,
      "Solana forces x402Version 2 (SVM exact scheme)",
    );

    const req = action.x402PaymentRequired.accepts[0];
    assert.equal(req.scheme, "exact");
    assert.equal(req.network, SOLANA_DEVNET, "network is the Solana caip2");
    assert.equal(
      req.asset,
      SOLANA_DEVNET_USDC,
      "asset auto-resolves to devnet USDC mint",
    );
    assert.equal(req.payTo, PAY_TO);
    assert.equal(
      req.maxAmountRequired,
      "50000",
      "0.05 USDC at 6 decimals = 50000 atomic units",
    );
    assert.equal(
      req.extra.feePayer,
      FEE_PAYER,
      "fee payer is surfaced to the client via extra.feePayer",
    );
  });

  it("omits extra.feePayer when none is configured/discovered", async () => {
    const adapter = makeAdapter({ feePayer: undefined });
    const action = await adapter.createChallenge(CHALLENGE_PARAMS);
    const req = action.x402PaymentRequired.accepts[0];
    assert.equal(
      req.extra.feePayer,
      undefined,
      "no feePayer key when not configured",
    );
  });
});

// ─── Fee payer discovery ──────────────────────────────────

describe("x402 Solana — discoverFeePayer", () => {
  beforeEach(installFetch);
  afterEach(restoreFetch);

  it("reads the fee payer from facilitator /supported and caches it", async () => {
    const adapter = makeAdapter({ feePayer: undefined });
    fetchHandler = async (url) => {
      assert.ok(url.endsWith("/supported"), "hits /supported endpoint");
      return {
        ok: true,
        json: {
          kinds: [
            { network: "eip155:8453", extra: {} },
            { network: SOLANA_DEVNET, extra: { feePayer: FEE_PAYER } },
          ],
        },
      };
    };

    const discovered = await adapter.discoverFeePayer();
    assert.equal(discovered, FEE_PAYER);
    assert.equal(adapter.feePayer, FEE_PAYER, "cached on the adapter");

    // Now feePayer flows into subsequent challenges
    const action = await adapter.createChallenge(CHALLENGE_PARAMS);
    assert.equal(action.x402PaymentRequired.accepts[0].extra.feePayer, FEE_PAYER);
  });

  it("returns null when the facilitator advertises no SVM fee payer", async () => {
    const adapter = makeAdapter({ feePayer: undefined });
    fetchHandler = async () => ({
      ok: true,
      json: { kinds: [{ network: "eip155:8453", extra: {} }] },
    });
    assert.equal(await adapter.discoverFeePayer(), null);
  });
});

// ─── verifyPayment — success AND failure, in isolation ────

describe("x402 Solana — verifyPayment", () => {
  let adapter;
  let actionId;

  beforeEach(async () => {
    installFetch();
    adapter = makeAdapter();
    const action = await adapter.createChallenge(CHALLENGE_PARAMS);
    actionId = action.actionId;
  });
  afterEach(restoreFetch);

  it("SUCCESS: facilitator validates the proof → VerificationResult", async () => {
    fetchHandler = async (url) => {
      assert.ok(url.endsWith("/verify"), "verify hits /verify (not /settle)");
      return { ok: true, json: { isValid: true, payer: PAY_TO } };
    };

    const result = await adapter.verifyPayment(SOL_PROOF, { actionId });
    assert.ok(result, "verify should return a result");
    assert.equal(result.verified, true);
    assert.equal(result.rail, "x402");
    assert.equal(result.amount, 0.05, "atomic amount decoded back to 0.05");
    assert.equal(result.currency, "usd");
    assert.equal(fetchCalls.length, 1, "verify does NOT call settle");
  });

  it("FAIL: facilitator rejects the proof → null", async () => {
    fetchHandler = async () => ({ ok: true, json: { isValid: false } });
    const result = await adapter.verifyPayment(SOL_PROOF, { actionId });
    assert.equal(result, null, "invalid proof yields null, not a throw");
  });

  it("FAIL: facilitator returns non-200 → null", async () => {
    fetchHandler = async () => ({ ok: false, json: {} });
    const result = await adapter.verifyPayment(SOL_PROOF, { actionId });
    assert.equal(result, null);
  });
});

// ─── settlePayment — success AND failure, in isolation ────

describe("x402 Solana — settlePayment", () => {
  let adapter;
  let actionId;

  beforeEach(async () => {
    installFetch();
    adapter = makeAdapter();
    const action = await adapter.createChallenge(CHALLENGE_PARAMS);
    actionId = action.actionId;
  });
  afterEach(restoreFetch);

  it("SUCCESS: facilitator settles on-chain → SettlementResult with txHash", async () => {
    const SIG =
      "5wHu1qwD4kT2example9signatureBase58oNSolanaDevnet11111111111";
    fetchHandler = async (url, body) => {
      assert.ok(url.endsWith("/settle"), "settle hits /settle endpoint");
      assert.equal(body.x402Version, 2, "settle body carries SVM v2");
      // SVM v2 requirement body forwarded to facilitator
      assert.equal(body.paymentRequirements.network, SOLANA_DEVNET);
      assert.equal(body.paymentRequirements.asset, SOLANA_DEVNET_USDC);
      assert.equal(body.paymentRequirements.extra.feePayer, FEE_PAYER);
      return { ok: true, json: { success: true, transaction: SIG } };
    };

    const result = await adapter.settlePayment(SOL_PROOF, { actionId });
    assert.ok(result, "settle should return a result");
    assert.equal(result.settled, true);
    assert.equal(result.rail, "x402");
    assert.equal(result.txHash, SIG, "Solana tx signature surfaced as txHash");
    assert.equal(result.amount, 0.05);
    assert.equal(
      adapter.pendingCount,
      0,
      "successful settle clears the pending requirement",
    );
  });

  it("FAIL: facilitator reports success:false → null", async () => {
    fetchHandler = async () => ({ ok: true, json: { success: false } });
    const result = await adapter.settlePayment(SOL_PROOF, { actionId });
    assert.equal(result, null, "failed settlement yields null");
  });

  it("FAIL: facilitator network error → null (settlement uncertain)", async () => {
    fetchHandler = async () => {
      throw new Error("ECONNRESET");
    };
    const result = await adapter.settlePayment(SOL_PROOF, { actionId });
    assert.equal(result, null, "network error is swallowed into null");
  });
});
