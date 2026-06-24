/**
 * Protocol Compliance Tests — MppRailAdapter & X402RailAdapter (v2)
 *
 * v2 changes:
 *   - X402Network typed union (evm/solana)
 *   - facilitatorUrl REQUIRED, no default
 *   - X402RailAdapter: pending map, settlePayment(), actionId, configurable decimals/resourceUrl/x402Version
 *   - EVM_USDC_ADDRESSES + SOLANA_USDC_ADDRESSES (replaces USDC_ADDRESSES)
 *   - MppRailAdapter: settlePayment() stub
 *   - verify body: { x402Version, paymentPayload, paymentRequirements }
 *
 * Run: node --test src/__tests__/protocol-compliance.test.mjs
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

// ─── Inline: EVM_USDC_ADDRESSES ───────────────────────────

const EVM_USDC_ADDRESSES = {
  "eip155:8453":  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
  "eip155:1":     "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Ethereum
  "eip155:137":   "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // Polygon
  "eip155:42161": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Arbitrum
  "eip155:10":    "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // Optimism
};

const SOLANA_USDC_ADDRESSES = {
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1":  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

// ─── Inline: MppRailAdapter (v2) ──────────────────────────

class MppRailAdapter {
  constructor(config) {
    if (!config.methods || config.methods.length === 0) {
      throw new Error("MppRailConfig requires at least one payment method");
    }
    this.rail = "mpp";
    this.config = config;
  }

  async createChallenge(params) {
    const challengeId = `tg_mpp_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;

    const challenges = this.config.methods.map((method, index) => {
      const requestPayload = {
        amount: this.convertAmount(params.amount, method),
        currency: this.getCurrencyForRequest(method),
        recipient: this.getRecipient(method),
        description: params.toolName,
        metadata: { toolName: params.toolName, callerId: params.callerId },
      };
      const requestBase64 = Buffer.from(JSON.stringify(requestPayload)).toString("base64url");
      return {
        id: `${challengeId}_${index}`,
        realm: "tollgate",
        method: method.name,
        intent: "charge",
        request: requestBase64,
      };
    });

    const wwwAuthenticate = challenges.map(
      (ch) =>
        `Payment id="${ch.id}", realm="${ch.realm}", method="${ch.method}", intent="${ch.intent}", request="${ch.request}"`,
    );

    return {
      rail: "mpp",
      mppChallenge: { protocol: "mpp", challenges, wwwAuthenticate },
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  }

  async verifyPayment(proof) {
    if (!proof.mppPaymentHeader || !this.config.mppxInstance) return null;
    return null;
  }

  async settlePayment(_proof, _context) {
    // MPP settlement happens via webhook or mppx internally.
    return null;
  }

  convertAmount(amount, method) {
    if (method.name === "tempo") return Math.round(amount * 1e6);
    if (method.name === "stripe") return Math.round(amount * 100);
    return amount;
  }

  getCurrencyForRequest(method) {
    if (method.name === "tempo") return method.currency;
    return "usd";
  }

  getRecipient(method) {
    if (method.name === "tempo") return method.recipient;
    return undefined;
  }
}

// ─── Inline: X402RailAdapter (v2) ─────────────────────────

class X402RailAdapter {
  constructor(config) {
    if (!config.facilitatorUrl) {
      throw new Error(
        'X402RailAdapter requires facilitatorUrl. Example: "https://x402.org/facilitator"',
      );
    }
    this.rail = "x402";
    this.config = config;
    this.pending = new Map();
  }

  get pendingCount() {
    return this.pending.size;
  }

  getAssetAddress() {
    const network = this.config.network;
    if (network.asset) return network.asset;

    if (network.kind === "evm") {
      const addr = EVM_USDC_ADDRESSES[network.caip2];
      if (addr) return addr;
    }

    if (network.kind === "solana") {
      const addr = SOLANA_USDC_ADDRESSES[network.caip2];
      if (addr) return addr;
    }

    const allNetworks = [
      ...Object.keys(EVM_USDC_ADDRESSES),
      ...Object.keys(SOLANA_USDC_ADDRESSES),
    ];
    throw new Error(
      `No known USDC address for network "${network.caip2}". ` +
        `Provide network.asset explicitly. ` +
        `Supported auto-detect: ${allNetworks.join(", ")}`,
    );
  }

  async createChallenge(params) {
    const decimals = this.config.network.decimals ?? 6;
    const amountAtomic = String(Math.round(params.amount * Math.pow(10, decimals)));
    const timeout = this.config.maxTimeoutSeconds ?? 300;
    const actionId = `x402_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;

    const resource =
      this.config.resourceUrl ??
      `tollgate://${params.publisherKey}/${params.toolName}`;

    const paymentRequirement = {
      scheme: this.config.scheme ?? "exact",
      network: this.config.network.caip2,
      maxAmountRequired: amountAtomic,
      resource,
      description: `Payment for ${params.toolName}: $${params.amount.toFixed(4)} ${(params.currency ?? "usd").toUpperCase()}`,
      payTo: this.config.payTo,
      asset: this.getAssetAddress(),
      maxTimeoutSeconds: timeout,
      extra: {
        tollgate_caller_id: params.callerId,
        tollgate_tool: params.toolName,
        tollgate_publisher: params.publisherKey,
      },
    };

    this.pending.set(actionId, paymentRequirement);
    setTimeout(() => this.pending.delete(actionId), (timeout + 60) * 1000);

    return {
      rail: "x402",
      actionId,
      x402PaymentRequired: {
        x402Version: this.config.x402Version ?? 1,
        accepts: [paymentRequirement],
      },
      expiresAt: Math.floor(Date.now() / 1000) + timeout,
    };
  }

  async verifyPayment(proof, context) {
    if (!proof.x402PaymentPayload) return null;

    const requirements =
      context?.paymentRequirements ??
      (context?.actionId ? this.pending.get(context.actionId) : undefined);

    if (!requirements) return null;

    try {
      const response = await fetch(`${this.config.facilitatorUrl}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x402Version: this.config.x402Version ?? 1,
          paymentPayload: proof.x402PaymentPayload,
          paymentRequirements: requirements,
        }),
      });

      if (!response.ok) return null;

      const result = await response.json();
      const isValid = result.valid ?? result.isValid ?? false;
      if (!isValid) return null;

      const decimals = this.config.network.decimals ?? 6;
      return {
        verified: true,
        rail: "x402",
        amount: Number(requirements.maxAmountRequired) / Math.pow(10, decimals),
        currency: "usd",
        receiptId: `x402_verify_${Date.now().toString(36)}`,
      };
    } catch {
      return null;
    }
  }

  async settlePayment(proof, context) {
    if (!proof.x402PaymentPayload) return null;

    const requirements =
      context?.paymentRequirements ??
      (context?.actionId ? this.pending.get(context.actionId) : undefined);

    if (!requirements) return null;

    try {
      const response = await fetch(`${this.config.facilitatorUrl}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x402Version: this.config.x402Version ?? 1,
          paymentPayload: proof.x402PaymentPayload,
          paymentRequirements: requirements,
        }),
      });

      if (!response.ok) return null;

      const result = await response.json();
      if (!result.success) return null;

      const decimals = this.config.network.decimals ?? 6;
      if (context?.actionId) this.pending.delete(context.actionId);

      return {
        settled: true,
        rail: "x402",
        txHash: result.txHash,
        amount: Number(requirements.maxAmountRequired) / Math.pow(10, decimals),
        currency: "usd",
        receiptId: result.txHash ?? `x402_settle_${Date.now().toString(36)}`,
      };
    } catch {
      return null;
    }
  }
}

// ─── Test fixtures ─────────────────────────────────────────

const BASE_PARAMS = {
  callerId:     "user_test",
  amount:       0.05,
  currency:     "usd",
  toolName:     "echo",
  publisherKey: "pub_test",
};

const EVM_NETWORK = { kind: "evm", caip2: "eip155:8453" };
const FACILITATOR  = "https://x402.org/facilitator";

// ═══════════════════════════════════════════════════════════
// MppRailAdapter — protocol compliance (v2)
// ═══════════════════════════════════════════════════════════

describe("MppRailAdapter — protocol compliance", () => {
  it("throws if methods array is empty", () => {
    assert.throws(
      () => new MppRailAdapter({ methods: [] }),
      /at least one payment method/i,
    );
  });

  it("challenge contains required fields (id, realm, method, intent, request)", async () => {
    const adapter = new MppRailAdapter({
      methods: [{ name: "tempo", currency: "0xTOKEN", recipient: "0xRECIPIENT" }],
    });
    const settlement = await adapter.createChallenge(BASE_PARAMS);
    assert.ok(settlement.mppChallenge, "mppChallenge must be present");
    const ch = settlement.mppChallenge.challenges[0];
    assert.ok(ch.id, "challenge.id required");
    assert.equal(ch.realm, "tollgate");
    assert.equal(ch.method, "tempo");
    assert.equal(ch.intent, "charge");
    assert.ok(ch.request, "challenge.request (base64url) required");
  });

  it("challenge.request decodes to valid JSON payload", async () => {
    const adapter = new MppRailAdapter({
      methods: [{ name: "tempo", currency: "0xTOKEN", recipient: "0xRECIP" }],
    });
    const settlement = await adapter.createChallenge(BASE_PARAMS);
    const raw = settlement.mppChallenge.challenges[0].request;
    const decoded = JSON.parse(Buffer.from(raw, "base64url").toString());
    assert.ok(decoded.amount !== undefined, "payload.amount required");
    assert.ok(decoded.currency, "payload.currency required");
    assert.equal(decoded.description, BASE_PARAMS.toolName);
    assert.equal(decoded.metadata.toolName, BASE_PARAMS.toolName);
    assert.equal(decoded.metadata.callerId, BASE_PARAMS.callerId);
  });

  it("tempo method: amount is converted to micro-units (* 1e6)", async () => {
    const adapter = new MppRailAdapter({
      methods: [{ name: "tempo", currency: "0xTOKEN", recipient: "0xRECIP" }],
    });
    const settlement = await adapter.createChallenge({ ...BASE_PARAMS, amount: 0.05 });
    const raw = settlement.mppChallenge.challenges[0].request;
    const decoded = JSON.parse(Buffer.from(raw, "base64url").toString());
    assert.equal(decoded.amount, 50000); // 0.05 * 1e6
  });

  it("stripe method: amount is converted to cents (* 100)", async () => {
    const adapter = new MppRailAdapter({ methods: [{ name: "stripe" }] });
    const settlement = await adapter.createChallenge({ ...BASE_PARAMS, amount: 0.05 });
    const raw = settlement.mppChallenge.challenges[0].request;
    const decoded = JSON.parse(Buffer.from(raw, "base64url").toString());
    assert.equal(decoded.amount, 5); // 0.05 * 100
  });

  it("multi-method: one challenge entry per method", async () => {
    const adapter = new MppRailAdapter({
      methods: [
        { name: "tempo", currency: "0xTOKEN", recipient: "0xRECIP" },
        { name: "stripe" },
      ],
    });
    const settlement = await adapter.createChallenge(BASE_PARAMS);
    assert.equal(settlement.mppChallenge.challenges.length, 2);
    assert.equal(settlement.mppChallenge.challenges[0].method, "tempo");
    assert.equal(settlement.mppChallenge.challenges[1].method, "stripe");
  });

  it("wwwAuthenticate array matches challenges and has correct format", async () => {
    const adapter = new MppRailAdapter({
      methods: [
        { name: "tempo", currency: "0xTOKEN", recipient: "0xRECIP" },
        { name: "stripe" },
      ],
    });
    const settlement = await adapter.createChallenge(BASE_PARAMS);
    const { challenges, wwwAuthenticate } = settlement.mppChallenge;
    assert.equal(wwwAuthenticate.length, challenges.length);
    for (let i = 0; i < challenges.length; i++) {
      const ch = challenges[i];
      assert.ok(wwwAuthenticate[i].includes(`id="${ch.id}"`));
      assert.ok(wwwAuthenticate[i].includes(`realm="${ch.realm}"`));
      assert.ok(wwwAuthenticate[i].includes(`method="${ch.method}"`));
      assert.ok(wwwAuthenticate[i].includes(`intent="${ch.intent}"`));
      assert.ok(wwwAuthenticate[i].includes(`request="${ch.request}"`));
    }
  });

  it("verifyPayment returns null when mppPaymentHeader is missing", async () => {
    const adapter = new MppRailAdapter({
      methods: [{ name: "tempo", currency: "0xTOKEN", recipient: "0xRECIP" }],
    });
    assert.equal(await adapter.verifyPayment({ rail: "mpp" }), null);
  });

  it("verifyPayment returns null when mppxInstance is not configured", async () => {
    const adapter = new MppRailAdapter({
      methods: [{ name: "tempo", currency: "0xTOKEN", recipient: "0xRECIP" }],
    });
    assert.equal(
      await adapter.verifyPayment({ rail: "mpp", mppPaymentHeader: "sometoken" }),
      null,
    );
  });

  it("settlePayment stub always returns null", async () => {
    const adapter = new MppRailAdapter({
      methods: [{ name: "tempo", currency: "0xTOKEN", recipient: "0xRECIP" }],
    });
    const result = await adapter.settlePayment({ rail: "mpp", mppPaymentHeader: "tok" }, {});
    assert.equal(result, null);
  });

  it("settlement.expiresAt is approx now + 3600s", async () => {
    const adapter = new MppRailAdapter({
      methods: [{ name: "tempo", currency: "0xTOKEN", recipient: "0xRECIP" }],
    });
    const before = Math.floor(Date.now() / 1000);
    const settlement = await adapter.createChallenge(BASE_PARAMS);
    const after = Math.floor(Date.now() / 1000);
    assert.ok(settlement.expiresAt >= before + 3599);
    assert.ok(settlement.expiresAt <= after + 3601);
  });
});

// ═══════════════════════════════════════════════════════════
// X402RailAdapter — protocol compliance (v2)
// ═══════════════════════════════════════════════════════════

describe("X402RailAdapter — protocol compliance", () => {

  // ── Constructor ─────────────────────────────────────────

  it("throws if facilitatorUrl is missing", () => {
    assert.throws(
      () => new X402RailAdapter({ payTo: "0xABCD", network: EVM_NETWORK }),
      /facilitatorUrl/i,
    );
  });

  it("does not throw when facilitatorUrl is provided", () => {
    assert.doesNotThrow(() =>
      new X402RailAdapter({ payTo: "0xABCD", network: EVM_NETWORK, facilitatorUrl: FACILITATOR }),
    );
  });

  // ── createChallenge basics ──────────────────────────────

  it("x402PaymentRequired has x402Version=1 and accepts array", async () => {
    const adapter = new X402RailAdapter({ payTo: "0xABCD", network: EVM_NETWORK, facilitatorUrl: FACILITATOR });
    const settlement = await adapter.createChallenge(BASE_PARAMS);
    assert.ok(settlement.x402PaymentRequired, "x402PaymentRequired must be present");
    assert.equal(settlement.x402PaymentRequired.x402Version, 1);
    assert.ok(Array.isArray(settlement.x402PaymentRequired.accepts));
    assert.equal(settlement.x402PaymentRequired.accepts.length, 1);
  });

  it("x402Version: 2 is respected when configured", async () => {
    const adapter = new X402RailAdapter({ payTo: "0xABCD", network: EVM_NETWORK, facilitatorUrl: FACILITATOR, x402Version: 2 });
    const settlement = await adapter.createChallenge(BASE_PARAMS);
    assert.equal(settlement.x402PaymentRequired.x402Version, 2);
  });

  it("maxAmountRequired uses 6-decimal atomic units ($0.05 -> '50000')", async () => {
    const adapter = new X402RailAdapter({ payTo: "0xABCD", network: EVM_NETWORK, facilitatorUrl: FACILITATOR });
    const settlement = await adapter.createChallenge({ ...BASE_PARAMS, amount: 0.05 });
    assert.equal(settlement.x402PaymentRequired.accepts[0].maxAmountRequired, "50000");
  });

  it("custom decimals: 8 decimals ($0.05 -> '5000000')", async () => {
    const adapter = new X402RailAdapter({
      payTo: "0xABCD",
      network: { kind: "evm", caip2: "eip155:8453", asset: "0xCustomToken", decimals: 8 },
      facilitatorUrl: FACILITATOR,
    });
    const settlement = await adapter.createChallenge({ ...BASE_PARAMS, amount: 0.05 });
    // 0.05 * 10^8 = 5_000_000
    assert.equal(settlement.x402PaymentRequired.accepts[0].maxAmountRequired, "5000000");
  });

  it("actionId is returned in settlement", async () => {
    const adapter = new X402RailAdapter({ payTo: "0xABCD", network: EVM_NETWORK, facilitatorUrl: FACILITATOR });
    const settlement = await adapter.createChallenge(BASE_PARAMS);
    assert.ok(typeof settlement.actionId === "string", "actionId must be a string");
    assert.ok(settlement.actionId.length > 0, "actionId must be non-empty");
  });

  it("pendingCount increments after createChallenge", async () => {
    const adapter = new X402RailAdapter({ payTo: "0xABCD", network: EVM_NETWORK, facilitatorUrl: FACILITATOR });
    assert.equal(adapter.pendingCount, 0);
    await adapter.createChallenge(BASE_PARAMS);
    assert.equal(adapter.pendingCount, 1);
    await adapter.createChallenge(BASE_PARAMS);
    assert.equal(adapter.pendingCount, 2);
  });

  it("custom resourceUrl is used in payment requirement", async () => {
    const customUrl = "https://myapi.example.com/tool/echo";
    const adapter = new X402RailAdapter({
      payTo: "0xABCD",
      network: EVM_NETWORK,
      facilitatorUrl: FACILITATOR,
      resourceUrl: customUrl,
    });
    const settlement = await adapter.createChallenge(BASE_PARAMS);
    assert.equal(settlement.x402PaymentRequired.accepts[0].resource, customUrl);
  });

  it("default resourceUrl is tollgate://{publisherKey}/{toolName}", async () => {
    const adapter = new X402RailAdapter({ payTo: "0xABCD", network: EVM_NETWORK, facilitatorUrl: FACILITATOR });
    const settlement = await adapter.createChallenge(BASE_PARAMS);
    assert.equal(
      settlement.x402PaymentRequired.accepts[0].resource,
      `tollgate://${BASE_PARAMS.publisherKey}/${BASE_PARAMS.toolName}`,
    );
  });

  it("settlement.expiresAt matches maxTimeoutSeconds", async () => {
    const adapter = new X402RailAdapter({
      payTo: "0xABCD",
      network: EVM_NETWORK,
      facilitatorUrl: FACILITATOR,
      maxTimeoutSeconds: 600,
    });
    const before = Math.floor(Date.now() / 1000);
    const settlement = await adapter.createChallenge(BASE_PARAMS);
    const after = Math.floor(Date.now() / 1000);
    assert.ok(settlement.expiresAt >= before + 599);
    assert.ok(settlement.expiresAt <= after + 601);
  });

  it("accepts entry contains all required x402 fields", async () => {
    const adapter = new X402RailAdapter({ payTo: "0xABCD", network: EVM_NETWORK, facilitatorUrl: FACILITATOR });
    const settlement = await adapter.createChallenge(BASE_PARAMS);
    const req = settlement.x402PaymentRequired.accepts[0];
    assert.ok(req.scheme,            "scheme required");
    assert.ok(req.network,           "network required");
    assert.ok(req.maxAmountRequired, "maxAmountRequired required");
    assert.ok(req.resource,          "resource required");
    assert.ok(req.description,       "description required");
    assert.ok(req.payTo,             "payTo required");
    assert.ok(req.asset,             "asset required");
    assert.ok(req.maxTimeoutSeconds > 0, "maxTimeoutSeconds required");
  });

  // ── getAssetAddress — EVM ───────────────────────────────

  it("auto-resolves USDC for Base (eip155:8453)", () => {
    const adapter = new X402RailAdapter({
      payTo: "0xABCD",
      network: { kind: "evm", caip2: "eip155:8453" },
      facilitatorUrl: FACILITATOR,
    });
    assert.equal(adapter.getAssetAddress(), EVM_USDC_ADDRESSES["eip155:8453"]);
  });

  it("auto-resolves USDC for Base Sepolia (eip155:84532)", () => {
    const adapter = new X402RailAdapter({
      payTo: "0xABCD",
      network: { kind: "evm", caip2: "eip155:84532" },
      facilitatorUrl: FACILITATOR,
    });
    assert.equal(adapter.getAssetAddress(), EVM_USDC_ADDRESSES["eip155:84532"]);
  });

  it("auto-resolves USDC for Ethereum (eip155:1)", () => {
    const adapter = new X402RailAdapter({
      payTo: "0xABCD",
      network: { kind: "evm", caip2: "eip155:1" },
      facilitatorUrl: FACILITATOR,
    });
    assert.equal(adapter.getAssetAddress(), EVM_USDC_ADDRESSES["eip155:1"]);
  });

  it("auto-resolves USDC for Polygon (eip155:137)", () => {
    const adapter = new X402RailAdapter({
      payTo: "0xABCD",
      network: { kind: "evm", caip2: "eip155:137" },
      facilitatorUrl: FACILITATOR,
    });
    assert.equal(adapter.getAssetAddress(), EVM_USDC_ADDRESSES["eip155:137"]);
  });

  it("auto-resolves USDC for Arbitrum (eip155:42161)", () => {
    const adapter = new X402RailAdapter({
      payTo: "0xABCD",
      network: { kind: "evm", caip2: "eip155:42161" },
      facilitatorUrl: FACILITATOR,
    });
    assert.equal(adapter.getAssetAddress(), EVM_USDC_ADDRESSES["eip155:42161"]);
  });

  it("auto-resolves USDC for Optimism (eip155:10)", () => {
    const adapter = new X402RailAdapter({
      payTo: "0xABCD",
      network: { kind: "evm", caip2: "eip155:10" },
      facilitatorUrl: FACILITATOR,
    });
    assert.equal(adapter.getAssetAddress(), EVM_USDC_ADDRESSES["eip155:10"]);
  });

  it("explicit EVM asset overrides USDC map lookup", () => {
    const customAsset = "0xCustomToken000000000000000000000000000000";
    const adapter = new X402RailAdapter({
      payTo: "0xABCD",
      network: { kind: "evm", caip2: "eip155:9999", asset: customAsset },
      facilitatorUrl: FACILITATOR,
    });
    assert.equal(adapter.getAssetAddress(), customAsset);
  });

  it("throws on unknown EVM network without explicit asset", () => {
    const adapter = new X402RailAdapter({
      payTo: "0xABCD",
      network: { kind: "evm", caip2: "eip155:9999" },
      facilitatorUrl: FACILITATOR,
    });
    assert.throws(() => adapter.getAssetAddress(), /No known USDC address/i);
  });

  // ── getAssetAddress — Solana ────────────────────────────

  it("auto-resolves USDC for Solana mainnet", () => {
    const adapter = new X402RailAdapter({
      payTo: "SolanaPayToAddress",
      network: { kind: "solana", caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
      facilitatorUrl: FACILITATOR,
    });
    assert.equal(
      adapter.getAssetAddress(),
      SOLANA_USDC_ADDRESSES["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
    );
  });

  it("auto-resolves USDC for Solana devnet", () => {
    const adapter = new X402RailAdapter({
      payTo: "SolanaPayToAddress",
      network: { kind: "solana", caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" },
      facilitatorUrl: FACILITATOR,
    });
    assert.equal(
      adapter.getAssetAddress(),
      SOLANA_USDC_ADDRESSES["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"],
    );
  });

  // ── EVM_USDC_ADDRESSES / SOLANA_USDC_ADDRESSES maps ─────

  it("EVM_USDC_ADDRESSES contains 6 chains with valid 0x addresses", () => {
    const expectedNetworks = [
      "eip155:8453", "eip155:84532", "eip155:1",
      "eip155:137",  "eip155:42161", "eip155:10",
    ];
    for (const net of expectedNetworks) {
      assert.ok(EVM_USDC_ADDRESSES[net], `Missing EVM_USDC_ADDRESSES entry for ${net}`);
      assert.match(EVM_USDC_ADDRESSES[net], /^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("SOLANA_USDC_ADDRESSES contains mainnet and devnet entries", () => {
    assert.ok(
      SOLANA_USDC_ADDRESSES["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
      "Solana mainnet USDC required",
    );
    assert.ok(
      SOLANA_USDC_ADDRESSES["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"],
      "Solana devnet USDC required",
    );
  });

  // ── verifyPayment ────────────────────────────────────────

  it("verifyPayment returns null when x402PaymentPayload is missing", async () => {
    const adapter = new X402RailAdapter({ payTo: "0xABCD", network: EVM_NETWORK, facilitatorUrl: FACILITATOR });
    const result = await adapter.verifyPayment({ rail: "x402" }, {});
    assert.equal(result, null);
  });

  it("verifyPayment returns null when no pending or context requirements", async () => {
    const adapter = new X402RailAdapter({ payTo: "0xABCD", network: EVM_NETWORK, facilitatorUrl: FACILITATOR });
    const result = await adapter.verifyPayment(
      { rail: "x402", x402PaymentPayload: { token: "abc" } },
      { actionId: "nonexistent" },
    );
    assert.equal(result, null);
  });

  it("verifyPayment sends correct body to facilitator /verify", async () => {
    const adapter = new X402RailAdapter({
      payTo: "0xABCD",
      network: EVM_NETWORK,
      facilitatorUrl: FACILITATOR,
    });

    const settlement = await adapter.createChallenge(BASE_PARAMS);
    const { actionId } = settlement;
    const fakePayload = { token: "signed_payment_token" };

    // Mock fetch to capture request body
    let capturedBody;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      capturedBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ valid: true }) };
    };

    try {
      await adapter.verifyPayment(
        { rail: "x402", x402PaymentPayload: fakePayload },
        { actionId },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok(capturedBody, "fetch body must be captured");
    assert.deepEqual(capturedBody.paymentPayload, fakePayload);
    assert.ok(capturedBody.paymentRequirements, "paymentRequirements must be included");
    assert.equal(capturedBody.x402Version, 1);
  });

  it("verifyPayment hits /verify endpoint (not /settle)", async () => {
    const adapter = new X402RailAdapter({ payTo: "0xABCD", network: EVM_NETWORK, facilitatorUrl: FACILITATOR });
    const settlement = await adapter.createChallenge(BASE_PARAMS);

    let calledUrl;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      calledUrl = url;
      return { ok: true, json: async () => ({ valid: true }) };
    };

    try {
      await adapter.verifyPayment(
        { rail: "x402", x402PaymentPayload: { token: "t" } },
        { actionId: settlement.actionId },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok(calledUrl?.endsWith("/verify"), `Expected /verify, got: ${calledUrl}`);
  });

  // ── settlePayment ────────────────────────────────────────

  it("settlePayment returns null when x402PaymentPayload is missing", async () => {
    const adapter = new X402RailAdapter({ payTo: "0xABCD", network: EVM_NETWORK, facilitatorUrl: FACILITATOR });
    const result = await adapter.settlePayment({ rail: "x402" }, {});
    assert.equal(result, null);
  });

  it("settlePayment returns null when no pending or context requirements", async () => {
    const adapter = new X402RailAdapter({ payTo: "0xABCD", network: EVM_NETWORK, facilitatorUrl: FACILITATOR });
    const result = await adapter.settlePayment(
      { rail: "x402", x402PaymentPayload: { token: "abc" } },
      { actionId: "nonexistent" },
    );
    assert.equal(result, null);
  });

  it("settlePayment hits /settle endpoint (not /verify)", async () => {
    const adapter = new X402RailAdapter({ payTo: "0xABCD", network: EVM_NETWORK, facilitatorUrl: FACILITATOR });
    const settlement = await adapter.createChallenge(BASE_PARAMS);

    let calledUrl;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      calledUrl = url;
      return { ok: true, json: async () => ({ success: true, txHash: "0xabc" }) };
    };

    try {
      await adapter.settlePayment(
        { rail: "x402", x402PaymentPayload: { token: "t" } },
        { actionId: settlement.actionId },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok(calledUrl?.endsWith("/settle"), `Expected /settle, got: ${calledUrl}`);
  });

  it("settlePayment removes actionId from pending on success", async () => {
    const adapter = new X402RailAdapter({ payTo: "0xABCD", network: EVM_NETWORK, facilitatorUrl: FACILITATOR });
    const settlement = await adapter.createChallenge(BASE_PARAMS);
    assert.equal(adapter.pendingCount, 1);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ success: true, txHash: "0xdeadbeef" }),
    });

    try {
      const result = await adapter.settlePayment(
        { rail: "x402", x402PaymentPayload: { token: "t" } },
        { actionId: settlement.actionId },
      );
      assert.ok(result?.settled === true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(adapter.pendingCount, 0, "pending should be cleared after settle");
  });

  it("settlePayment returns SettlementResult with settled:true and txHash", async () => {
    const adapter = new X402RailAdapter({ payTo: "0xABCD", network: EVM_NETWORK, facilitatorUrl: FACILITATOR });
    const settlement = await adapter.createChallenge(BASE_PARAMS);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ success: true, txHash: "0xdeadbeef123" }),
    });

    let result;
    try {
      result = await adapter.settlePayment(
        { rail: "x402", x402PaymentPayload: { token: "t" } },
        { actionId: settlement.actionId },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok(result, "settlePayment must return a result");
    assert.equal(result.settled, true);
    assert.equal(result.rail, "x402");
    assert.equal(result.txHash, "0xdeadbeef123");
    assert.ok(result.amount > 0, "amount must be positive");
    assert.ok(result.receiptId, "receiptId required");
  });
});
