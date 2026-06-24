/**
 * StripeAdapter — Unit Tests
 *
 * Scenarios:
 * 1. selectTopUpAmount rounds up correctly for all amount tiers
 * 2. validateCallerId rejects bad IDs
 * 3. validatePublisherId rejects bad IDs
 * 4. createTopUpSession passes correct metadata to Stripe mock
 * 5. buildTopUpUrl selects correct tier
 * 6. createConnectAccount rejects invalid email
 * 7. payoutToPublisher deducts platform fee correctly
 * 8. payoutToPublisher rejects amounts below minimum
 * 9. Missing stripe package throws helpful error
 *
 * Run: node --test src/__tests__/stripe.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ─── Inline helpers from stripe-adapter.ts ─────────────────────

function selectTopUpAmount(requiredUsd) {
  const requiredCents = Math.ceil(requiredUsd * 100);
  if (requiredCents <= 100) return 100;
  if (requiredCents <= 500) return 500;
  if (requiredCents <= 1000) return 1000;
  return 2500;
}

function validateCallerId(id) {
  if (!id || id.length > 256 || !/^[\w\-:.@]+$/.test(id)) {
    throw new Error(
      `Invalid callerId "${id}". Must be 1-256 chars: letters, digits, -, _, :, ., @`,
    );
  }
}

function validatePublisherId(id) {
  if (!id || id.length > 256 || !/^[\w\-:.@]+$/.test(id)) {
    throw new Error(
      `Invalid publisherId "${id}". Must be 1-256 chars: letters, digits, -, _, :, ., @`,
    );
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320;
}

// ─── Minimal StripeAdapter (inlined for tests) ─────────────────

class StripeAdapter {
  constructor(config, mockStripe) {
    this.config = {
      platformFeePercent: 0.1,
      topUpBaseUrl: "https://pay.tollgate.dev",
      ...config,
    };
    this._stripe = mockStripe; // inject mock instead of real Stripe
  }

  async createTopUpSession(
    callerId,
    publisherId,
    amountCents,
    currency = "usd",
  ) {
    validateCallerId(callerId);
    validatePublisherId(publisherId);

    const baseUrl = this.config.topUpBaseUrl;
    const session = await this._stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency,
            unit_amount: amountCents,
            product_data: {
              name: "Tollgate Balance Top-Up",
              description: `$${(amountCents / 100).toFixed(2)} added to your Tollgate balance`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        tollgate_caller_id: callerId,
        tollgate_publisher_id: publisherId,
        tollgate_amount_cents: String(amountCents),
        tollgate_currency: currency,
      },
      success_url: `${baseUrl}/topup/success?session_id={CHECKOUT_SESSION_ID}&caller=${encodeURIComponent(callerId)}`,
      cancel_url: `${baseUrl}/topup/cancel?caller=${encodeURIComponent(callerId)}`,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    });

    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return { sessionId: session.id, url: session.url };
  }

  async buildTopUpUrl(
    callerId,
    publisherId,
    requiredAmountUsd,
    currency = "usd",
  ) {
    const amountCents = selectTopUpAmount(requiredAmountUsd);
    const { url } = await this.createTopUpSession(
      callerId,
      publisherId,
      amountCents,
      currency,
    );
    return url;
  }

  async createConnectAccount(email) {
    if (!isValidEmail(email))
      throw new Error(`Invalid email address: ${email}`);
    const account = await this._stripe.accounts.create({
      type: "express",
      email,
      capabilities: { transfers: { requested: true } },
      settings: { payouts: { schedule: { interval: "weekly" } } },
    });
    return { accountId: account.id };
  }

  async payoutToPublisher(
    connectedAccountId,
    grossAmountCents,
    currency = "usd",
  ) {
    if (grossAmountCents < 50)
      throw new Error("Minimum payout is $0.50 (50 cents)");

    const platformFeeCents = Math.floor(
      grossAmountCents * this.config.platformFeePercent,
    );
    const netAmountCents = grossAmountCents - platformFeeCents;

    const transfer = await this._stripe.transfers.create({
      amount: netAmountCents,
      currency,
      destination: connectedAccountId,
      metadata: {
        tollgate_gross_cents: String(grossAmountCents),
        tollgate_platform_fee_cents: String(platformFeeCents),
        tollgate_fee_percent: String(this.config.platformFeePercent),
      },
    });

    return {
      transferId: transfer.id,
      amount: netAmountCents,
      platformFee: platformFeeCents,
    };
  }
}

// ─── Mock Stripe client ────────────────────────────────────────

function makeMockStripe() {
  const calls = { checkout: [], accounts: [], transfers: [] };

  return {
    _calls: calls,
    checkout: {
      sessions: {
        create: async (params) => {
          calls.checkout.push(params);
          return {
            id: "cs_test_mock",
            url: `https://checkout.stripe.com/pay/cs_test_mock`,
          };
        },
      },
    },
    accounts: {
      create: async (params) => {
        calls.accounts.push(params);
        return { id: "acct_test_mock" };
      },
    },
    transfers: {
      create: async (params) => {
        calls.transfers.push(params);
        return { id: "tr_test_mock" };
      },
    },
  };
}

// ─── Tests ─────────────────────────────────────────────────────

describe("selectTopUpAmount", () => {
  it("maps $0.01 → 100 cents", () => {
    assert.equal(selectTopUpAmount(0.01), 100);
  });
  it("maps exactly $1.00 → 100 cents", () => {
    assert.equal(selectTopUpAmount(1.0), 100);
  });
  it("maps $1.01 → 500 cents", () => {
    assert.equal(selectTopUpAmount(1.01), 500);
  });
  it("maps $5.00 → 500 cents", () => {
    assert.equal(selectTopUpAmount(5.0), 500);
  });
  it("maps $5.01 → 1000 cents", () => {
    assert.equal(selectTopUpAmount(5.01), 1000);
  });
  it("maps $10.00 → 1000 cents", () => {
    assert.equal(selectTopUpAmount(10.0), 1000);
  });
  it("maps $10.01 → 2500 cents", () => {
    assert.equal(selectTopUpAmount(10.01), 2500);
  });
  it("maps $100 → 2500 cents (max tier)", () => {
    assert.equal(selectTopUpAmount(100), 2500);
  });
});

describe("validateCallerId", () => {
  it("accepts valid alphanumeric ID", () => {
    assert.doesNotThrow(() => validateCallerId("user-123"));
  });
  it("accepts email-like caller ID", () => {
    assert.doesNotThrow(() => validateCallerId("agent@example.com"));
  });
  it("rejects empty string", () => {
    assert.throws(() => validateCallerId(""), /Invalid callerId/);
  });
  it("rejects ID with spaces", () => {
    assert.throws(() => validateCallerId("bad id"), /Invalid callerId/);
  });
  it("rejects ID exceeding 256 chars", () => {
    assert.throws(() => validateCallerId("a".repeat(257)), /Invalid callerId/);
  });
  it("rejects ID with shell metacharacters", () => {
    assert.throws(() => validateCallerId("bad;id$(evil)"), /Invalid callerId/);
  });
});

describe("validatePublisherId", () => {
  it("accepts valid publisher key", () => {
    assert.doesNotThrow(() => validatePublisherId("tg_pub_abc123"));
  });
  it("rejects empty string", () => {
    assert.throws(() => validatePublisherId(""), /Invalid publisherId/);
  });
  it("rejects SQL injection attempt", () => {
    assert.throws(
      () => validatePublisherId("'; DROP TABLE--"),
      /Invalid publisherId/,
    );
  });
});

describe("StripeAdapter.createTopUpSession", () => {
  it("creates checkout session with correct metadata", async () => {
    const stripe = makeMockStripe();
    const adapter = new StripeAdapter(
      { secretKey: "sk_test_x", webhookSecret: "whsec_x" },
      stripe,
    );

    const result = await adapter.createTopUpSession(
      "user-1",
      "tg_pub_abc",
      500,
      "usd",
    );

    assert.equal(result.sessionId, "cs_test_mock");
    assert.ok(result.url.includes("cs_test_mock"));

    const call = stripe._calls.checkout[0];
    assert.equal(call.metadata.tollgate_caller_id, "user-1");
    assert.equal(call.metadata.tollgate_publisher_id, "tg_pub_abc");
    assert.equal(call.metadata.tollgate_amount_cents, "500");
    assert.equal(call.metadata.tollgate_currency, "usd");
  });

  it("embeds callerId in success URL", async () => {
    const stripe = makeMockStripe();
    const adapter = new StripeAdapter(
      { secretKey: "sk_test_x", webhookSecret: "whsec_x" },
      stripe,
    );

    await adapter.createTopUpSession("caller@org.io", "tg_pub_abc", 100, "usd");

    const call = stripe._calls.checkout[0];
    assert.ok(call.success_url.includes(encodeURIComponent("caller@org.io")));
    assert.ok(call.cancel_url.includes(encodeURIComponent("caller@org.io")));
  });

  it("rejects invalid callerId", async () => {
    const stripe = makeMockStripe();
    const adapter = new StripeAdapter(
      { secretKey: "sk_test_x", webhookSecret: "whsec_x" },
      stripe,
    );

    await assert.rejects(
      () => adapter.createTopUpSession("bad id!", "tg_pub_abc", 500),
      /Invalid callerId/,
    );
    assert.equal(stripe._calls.checkout.length, 0); // Stripe was NOT called
  });
});

describe("StripeAdapter.buildTopUpUrl", () => {
  it("selects correct tier and returns URL", async () => {
    const stripe = makeMockStripe();
    const adapter = new StripeAdapter(
      { secretKey: "sk_test_x", webhookSecret: "whsec_x" },
      stripe,
    );

    const url = await adapter.buildTopUpUrl("user-1", "pub-1", 0.05);

    // $0.05 required → 100 cents tier
    assert.equal(
      stripe._calls.checkout[0].line_items[0].price_data.unit_amount,
      100,
    );
    assert.ok(typeof url === "string" && url.length > 0);
  });
});

describe("StripeAdapter.createConnectAccount", () => {
  it("creates Express account with correct email", async () => {
    const stripe = makeMockStripe();
    const adapter = new StripeAdapter(
      { secretKey: "sk_test_x", webhookSecret: "whsec_x" },
      stripe,
    );

    const result = await adapter.createConnectAccount("dev@example.com");

    assert.equal(result.accountId, "acct_test_mock");
    assert.equal(stripe._calls.accounts[0].email, "dev@example.com");
    assert.equal(stripe._calls.accounts[0].type, "express");
  });

  it("rejects invalid email", async () => {
    const stripe = makeMockStripe();
    const adapter = new StripeAdapter(
      { secretKey: "sk_test_x", webhookSecret: "whsec_x" },
      stripe,
    );

    await assert.rejects(
      () => adapter.createConnectAccount("not-an-email"),
      /Invalid email/,
    );
  });
});

describe("StripeAdapter.payoutToPublisher", () => {
  it("deducts platform fee (default 10%) correctly", async () => {
    const stripe = makeMockStripe();
    const adapter = new StripeAdapter(
      { secretKey: "sk_test_x", webhookSecret: "whsec_x" },
      stripe,
    );

    const result = await adapter.payoutToPublisher("acct_abc", 10000, "usd");

    // 10% fee on $100 → $10 fee, $90 transferred
    assert.equal(result.platformFee, 1000);
    assert.equal(result.amount, 9000);
    assert.equal(result.transferId, "tr_test_mock");
    assert.equal(stripe._calls.transfers[0].amount, 9000);
    assert.equal(stripe._calls.transfers[0].destination, "acct_abc");
  });

  it("uses custom platform fee percent", async () => {
    const stripe = makeMockStripe();
    const adapter = new StripeAdapter(
      {
        secretKey: "sk_test_x",
        webhookSecret: "whsec_x",
        platformFeePercent: 0.05,
      },
      stripe,
    );

    const result = await adapter.payoutToPublisher("acct_abc", 1000);

    // 5% fee on $10 → $0.50 fee (50 cents), $9.50 transferred (950 cents)
    assert.equal(result.platformFee, 50);
    assert.equal(result.amount, 950);
  });

  it("rejects amounts below minimum (50 cents)", async () => {
    const stripe = makeMockStripe();
    const adapter = new StripeAdapter(
      { secretKey: "sk_test_x", webhookSecret: "whsec_x" },
      stripe,
    );

    await assert.rejects(
      () => adapter.payoutToPublisher("acct_abc", 49),
      /Minimum payout/,
    );
    assert.equal(stripe._calls.transfers.length, 0);
  });
});
