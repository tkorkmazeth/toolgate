/**
 * x402 EVM Rail Adapter — EIP-712 domain injection.
 *
 * The EVM "exact" scheme (EIP-3009) requires the token's EIP-712 domain
 * (name + version) in PaymentRequirements.extra, or the facilitator rejects
 * verify with `invalid_exact_evm_missing_eip712_domain`. These tests assert the
 * rail injects it for known USDC networks, honours an explicit override, and
 * forwards it to the facilitator — all offline (fetch stubbed).
 *
 * Run: node --test src/__tests__/x402-evm-rail.test.mjs
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  X402RailAdapter,
  EVM_USDC_ADDRESSES,
} from "../../dist/rail-adapters/x402-rail.js";

const BASE = "eip155:8453";
const BASE_SEPOLIA = "eip155:84532";
const PAY_TO = "0x179516864079FA14a0a718cF767cCDc2483324b6";
const FACILITATOR = "https://facilitator.example.test";

const PARAMS = {
  callerId: "0xCaller",
  amount: 0.001,
  currency: "usd",
  toolName: "evm_tool",
  publisherKey: "tg_evm",
};

function makeAdapter(overrides = {}) {
  return new X402RailAdapter({
    payTo: PAY_TO,
    network: { kind: "evm", caip2: BASE },
    facilitatorUrl: FACILITATOR,
    x402Version: 2,
    ...overrides,
  });
}

describe("x402 EVM — EIP-712 domain in challenge", () => {
  it("auto-injects USD Coin v2 for Base mainnet USDC", async () => {
    const action = await makeAdapter().createChallenge(PARAMS);
    const req = action.x402PaymentRequired.accepts[0];
    assert.equal(req.asset, EVM_USDC_ADDRESSES[BASE]);
    assert.equal(req.extra.name, "USD Coin");
    assert.equal(req.extra.version, "2");
  });

  it("uses USDC v2 for Base Sepolia testnet", async () => {
    const action = await makeAdapter({
      network: { kind: "evm", caip2: BASE_SEPOLIA },
    }).createChallenge(PARAMS);
    const req = action.x402PaymentRequired.accepts[0];
    assert.equal(req.extra.name, "USDC");
    assert.equal(req.extra.version, "2");
  });

  it("honours an explicit eip712Domain override (custom token)", async () => {
    const action = await makeAdapter({
      network: { kind: "evm", caip2: "eip155:99999", asset: "0xabc" },
      eip712Domain: { name: "MyToken", version: "1" },
    }).createChallenge(PARAMS);
    const req = action.x402PaymentRequired.accepts[0];
    assert.equal(req.extra.name, "MyToken");
    assert.equal(req.extra.version, "1");
  });

  it("does not attach feePayer for EVM", async () => {
    const action = await makeAdapter().createChallenge(PARAMS);
    assert.equal(
      action.x402PaymentRequired.accepts[0].extra.feePayer,
      undefined,
    );
  });
});

describe("x402 EVM — domain forwarded to the facilitator", () => {
  const realFetch = globalThis.fetch;
  let captured;

  beforeEach(() => {
    captured = [];
    globalThis.fetch = async (url, init) => {
      captured.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, async json() { return { isValid: true, payer: PAY_TO }; } };
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("verify sends extra.name/version in paymentRequirements", async () => {
    const adapter = makeAdapter();
    const action = await adapter.createChallenge(PARAMS);
    const proof = { rail: "x402", x402PaymentPayload: { x402Version: 2 } };

    const result = await adapter.verifyPayment(proof, {
      actionId: action.actionId,
    });
    assert.ok(result?.verified);
    const sent = captured.find((c) => c.url.endsWith("/verify"));
    assert.ok(sent, "verify was called");
    assert.equal(sent.body.paymentRequirements.extra.name, "USD Coin");
    assert.equal(sent.body.paymentRequirements.extra.version, "2");
  });
});
