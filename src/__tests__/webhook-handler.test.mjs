/**
 * WebhookHandler — Unit Tests
 *
 * Scenarios:
 * 1. Valid checkout.session.completed → ledger credited
 * 2. Duplicate event → de-duplicated (no double credit)
 * 3. Invalid signature → returns error (not throws)
 * 4. Missing Toolgate metadata → skipped safely
 * 5. Payment status not "paid" → skipped safely
 * 6. Invalid amount in metadata → error returned
 * 7. Ledger credit failure → error returned
 * 8. account.updated → processed without error
 * 9. Unknown event type → processed: false
 * 10. Correct amount conversion (cents → USD for ledger)
 *
 * Run: node --test src/__tests__/webhook-handler.test.mjs
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── Inline InMemoryLedger ─────────────────────────────────────

class InMemoryLedger {
  constructor() {
    this.balances = new Map();
    this.credits = []; // record all credit() calls for assertions
  }
  async getBalance(id) {
    return this.balances.get(id) ?? 0;
  }
  async deduct(id, amount) {
    const cur = this.balances.get(id) ?? 0;
    if (cur < amount) return false;
    this.balances.set(id, Math.round((cur - amount) * 1e6) / 1e6);
    return true;
  }
  async credit(id, amount, meta) {
    const cur = this.balances.get(id) ?? 0;
    this.balances.set(id, Math.round((cur + amount) * 1e6) / 1e6);
    this.credits.push({ callerId: id, amount, meta });
  }
  async getUsage() {
    return 0;
  }
  async incrementUsage() {}
}

// ─── Inline WebhookHandler ─────────────────────────────────────

class WebhookHandler {
  constructor(options) {
    this.stripe = options.stripeClient;
    this.webhookSecret = options.webhookSecret;
    this.ledger = options.ledger;
    this.processedEventIds = new Set();
  }

  async handle(rawBody, signature) {
    let event;
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.webhookSecret,
      );
    } catch (err) {
      return {
        processed: false,
        eventType: "unknown",
        error: `Signature verification failed: ${err.message}`,
      };
    }

    if (this.processedEventIds.has(event.id)) {
      return { processed: true, eventType: event.type, duplicate: true };
    }

    let result;

    switch (event.type) {
      case "checkout.session.completed":
        result = await this._handleCheckout(event, event.data.object);
        break;
      case "account.updated":
        result = this._handleAccountUpdated(event, event.data.object);
        break;
      default:
        result = { processed: false, eventType: event.type };
    }

    if (result.processed && !result.error) {
      this.processedEventIds.add(event.id);
      if (this.processedEventIds.size > 10_000) {
        const first = this.processedEventIds.values().next().value;
        if (first) this.processedEventIds.delete(first);
      }
    }

    return result;
  }

  async _handleCheckout(event, session) {
    const { metadata } = session;

    if (
      !metadata?.toolgate_caller_id ||
      !metadata?.toolgate_publisher_id ||
      !metadata?.toolgate_amount_cents ||
      !metadata?.toolgate_currency
    ) {
      return {
        processed: false,
        eventType: event.type,
        error: "Missing Toolgate metadata in checkout session — skipping",
      };
    }

    if (session.payment_status !== "paid") {
      return {
        processed: false,
        eventType: event.type,
        error: `Payment not completed (status: ${session.payment_status})`,
      };
    }

    const callerId = metadata.toolgate_caller_id;
    const amountCents = parseInt(metadata.toolgate_amount_cents, 10);

    if (isNaN(amountCents) || amountCents <= 0) {
      return {
        processed: false,
        eventType: event.type,
        error: `Invalid amount in metadata: ${metadata.toolgate_amount_cents}`,
      };
    }

    const amountUsd = amountCents / 100;

    try {
      await this.ledger.credit(callerId, amountUsd, {
        source: "stripe",
        reference: session.id,
      });
    } catch (err) {
      return {
        processed: false,
        eventType: event.type,
        error: `Ledger credit failed: ${err.message}`,
      };
    }

    return { processed: true, eventType: event.type };
  }

  _handleAccountUpdated(event) {
    return { processed: true, eventType: event.type };
  }
}

// ─── Mock Stripe (constructEvent) ─────────────────────────────

function makeMockStripe(verifyOk = true, overrideEvent = null) {
  return {
    webhooks: {
      constructEvent: (rawBody, signature, secret) => {
        if (!verifyOk)
          throw new Error(
            "No signatures found matching the expected signature for payload",
          );

        // Default: echo the rawBody parsed as JSON, or use overrideEvent
        const parsed = overrideEvent ?? JSON.parse(rawBody.toString());
        return parsed;
      },
    },
  };
}

function makeCheckoutEvent(overrides = {}) {
  return {
    id: "evt_test_checkout_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_session_1",
        payment_status: "paid",
        metadata: {
          toolgate_caller_id: "user-abc",
          toolgate_publisher_id: "tg_pub_xyz",
          toolgate_amount_cents: "500",
          toolgate_currency: "usd",
        },
        ...overrides,
      },
    },
  };
}

// ─── Tests ─────────────────────────────────────────────────────

describe("WebhookHandler — checkout.session.completed", () => {
  it("credits ledger with correct USD amount on success", async () => {
    const ledger = new InMemoryLedger();
    const stripe = makeMockStripe(true);
    const handler = new WebhookHandler({
      stripeClient: stripe,
      webhookSecret: "whsec_x",
      ledger,
    });

    const event = makeCheckoutEvent();
    const result = await handler.handle(JSON.stringify(event), "t=1,v1=sig");

    assert.equal(result.processed, true);
    assert.equal(result.eventType, "checkout.session.completed");
    assert.equal(result.duplicate, undefined);

    // 500 cents → $5.00
    assert.equal(ledger.credits.length, 1);
    assert.equal(ledger.credits[0].callerId, "user-abc");
    assert.equal(ledger.credits[0].amount, 5.0);
    assert.equal(ledger.credits[0].meta.source, "stripe");
    assert.equal(ledger.credits[0].meta.reference, "cs_test_session_1");

    assert.equal(await ledger.getBalance("user-abc"), 5.0);
  });

  it("de-duplicates identical event IDs (idempotency)", async () => {
    const ledger = new InMemoryLedger();
    const event = makeCheckoutEvent();
    const stripe = makeMockStripe(true, event);
    const handler = new WebhookHandler({
      stripeClient: stripe,
      webhookSecret: "whsec_x",
      ledger,
    });

    const r1 = await handler.handle("irrelevant", "sig1");
    const r2 = await handler.handle("irrelevant", "sig2");

    assert.equal(r1.processed, true);
    assert.equal(r1.duplicate, undefined);

    assert.equal(r2.processed, true);
    assert.equal(r2.duplicate, true);

    // Balance credited only once
    assert.equal(ledger.credits.length, 1);
    assert.equal(await ledger.getBalance("user-abc"), 5.0);
  });

  it("returns error when signature verification fails", async () => {
    const ledger = new InMemoryLedger();
    const stripe = makeMockStripe(false); // will throw
    const handler = new WebhookHandler({
      stripeClient: stripe,
      webhookSecret: "bad",
      ledger,
    });

    const result = await handler.handle("body", "invalid-sig");

    assert.equal(result.processed, false);
    assert.equal(result.eventType, "unknown");
    assert.ok(result.error?.includes("Signature verification failed"));
    assert.equal(ledger.credits.length, 0); // no credit happened
  });

  it("skips events missing Toolgate metadata", async () => {
    const ledger = new InMemoryLedger();
    const event = {
      id: "evt_foreign",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_foreign",
          payment_status: "paid",
          metadata: {}, // no toolgate_ fields
        },
      },
    };
    const stripe = makeMockStripe(true, event);
    const handler = new WebhookHandler({
      stripeClient: stripe,
      webhookSecret: "whsec_x",
      ledger,
    });

    const result = await handler.handle("x", "sig");

    assert.equal(result.processed, false);
    assert.ok(result.error?.includes("Missing Toolgate metadata"));
    assert.equal(ledger.credits.length, 0);
  });

  it("skips sessions where payment_status is not paid", async () => {
    const ledger = new InMemoryLedger();
    const event = makeCheckoutEvent({ payment_status: "unpaid" });
    const stripe = makeMockStripe(true, event);
    const handler = new WebhookHandler({
      stripeClient: stripe,
      webhookSecret: "whsec_x",
      ledger,
    });

    const result = await handler.handle("x", "sig");

    assert.equal(result.processed, false);
    assert.ok(result.error?.includes("Payment not completed"));
    assert.equal(ledger.credits.length, 0);
  });

  it("returns error for invalid amount in metadata", async () => {
    const ledger = new InMemoryLedger();
    const event = makeCheckoutEvent({
      metadata: {
        toolgate_caller_id: "user-x",
        toolgate_publisher_id: "pub-x",
        toolgate_amount_cents: "not-a-number",
        toolgate_currency: "usd",
      },
    });
    const stripe = makeMockStripe(true, event);
    const handler = new WebhookHandler({
      stripeClient: stripe,
      webhookSecret: "whsec_x",
      ledger,
    });

    const result = await handler.handle("x", "sig");

    assert.equal(result.processed, false);
    assert.ok(result.error?.includes("Invalid amount"));
    assert.equal(ledger.credits.length, 0);
  });

  it("returns error when ledger.credit throws", async () => {
    const ledger = new InMemoryLedger();
    ledger.credit = async () => {
      throw new Error("DB is offline");
    };

    const event = makeCheckoutEvent();
    const stripe = makeMockStripe(true, event);
    const handler = new WebhookHandler({
      stripeClient: stripe,
      webhookSecret: "whsec_x",
      ledger,
    });

    const result = await handler.handle("x", "sig");

    assert.equal(result.processed, false);
    assert.ok(result.error?.includes("Ledger credit failed"));
    assert.ok(result.error?.includes("DB is offline"));
  });

  it("converts cents → USD correctly for $10.00 (1000 cents)", async () => {
    const ledger = new InMemoryLedger();
    const event = makeCheckoutEvent({
      metadata: {
        toolgate_caller_id: "caller-x",
        toolgate_publisher_id: "pub-x",
        toolgate_amount_cents: "1000",
        toolgate_currency: "usd",
      },
    });
    const stripe = makeMockStripe(true, event);
    const handler = new WebhookHandler({
      stripeClient: stripe,
      webhookSecret: "whsec_x",
      ledger,
    });

    await handler.handle("x", "sig");

    assert.equal(ledger.credits[0].amount, 10.0);
  });
});

describe("WebhookHandler — account.updated", () => {
  it("acknowledges Connect account updates without error", async () => {
    const ledger = new InMemoryLedger();
    const event = {
      id: "evt_account_1",
      type: "account.updated",
      data: {
        object: {
          id: "acct_abc",
          payouts_enabled: true,
          charges_enabled: true,
        },
      },
    };
    const stripe = makeMockStripe(true, event);
    const handler = new WebhookHandler({
      stripeClient: stripe,
      webhookSecret: "whsec_x",
      ledger,
    });

    const result = await handler.handle("x", "sig");

    assert.equal(result.processed, true);
    assert.equal(result.eventType, "account.updated");
    assert.equal(result.error, undefined);
  });
});

describe("WebhookHandler — unknown event types", () => {
  it("returns processed:false without error for unknown events", async () => {
    const ledger = new InMemoryLedger();
    const event = {
      id: "evt_unknown",
      type: "customer.created",
      data: { object: {} },
    };
    const stripe = makeMockStripe(true, event);
    const handler = new WebhookHandler({
      stripeClient: stripe,
      webhookSecret: "whsec_x",
      ledger,
    });

    const result = await handler.handle("x", "sig");

    assert.equal(result.processed, false);
    assert.equal(result.eventType, "customer.created");
    assert.equal(result.error, undefined);
  });
});
