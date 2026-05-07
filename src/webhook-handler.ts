import type Stripe from "stripe";
import type { LedgerAdapter } from "./types.js";

// ─── Result types ──────────────────────────────────────────

export interface WebhookResult {
  /** Whether the event was fully processed (or was a no-op for known types). */
  processed: boolean;
  /** Stripe event type, e.g. "checkout.session.completed". */
  eventType: string;
  /** Set when the event was skipped due to idempotency de-duplication. */
  duplicate?: boolean;
  /** Human-readable error message (processing still returns 200 to Stripe). */
  error?: string;
}

// ─── WebhookHandler ────────────────────────────────────────

/**
 * Processes incoming Stripe webhook events.
 *
 * Responsibilities:
 *  - Verifies the Stripe-Signature header to prevent spoofing.
 *  - De-duplicates events (idempotency) so a retry doesn't double-credit.
 *  - Credits the caller's Toolgate ledger balance on successful top-up.
 *  - Stores connect account status updates (extensible).
 */
export class WebhookHandler {
  private stripe: Stripe;
  private webhookSecret: string;
  private ledger: LedgerAdapter;
  /**
   * In-memory idempotency set. For production, persist processed IDs in the
   * same DB as the ledger (store in a `processed_events` table) so restarts
   * don't lose the de-duplication state.
   */
  private processedEventIds = new Set<string>();

  constructor(options: {
    stripeClient: Stripe;
    webhookSecret: string;
    ledger: LedgerAdapter;
  }) {
    this.stripe = options.stripeClient;
    this.webhookSecret = options.webhookSecret;
    this.ledger = options.ledger;
  }

  /**
   * Main entry point — call this in your HTTP handler (Cloudflare Worker,
   * Express route, etc.).
   *
   * @param rawBody   The raw request body as a string or Buffer.
   *                  Must NOT be parsed to JSON first (Stripe verifies bytes).
   * @param signature The value of the `stripe-signature` HTTP header.
   */
  async handle(
    rawBody: string | Buffer,
    signature: string,
  ): Promise<WebhookResult> {
    // ── Verify signature ────────────────────────────────────
    let event: Stripe.Event;
    try {
      event = await this.stripe.webhooks.constructEventAsync(
        rawBody,
        signature,
        this.webhookSecret,
      );
    } catch (err) {
      // Return a structured error; callers should respond with HTTP 400.
      return {
        processed: false,
        eventType: "unknown",
        error: `Signature verification failed: ${(err as Error).message}`,
      };
    }

    // ── Idempotency check ───────────────────────────────────
    if (this.processedEventIds.has(event.id)) {
      return { processed: true, eventType: event.type, duplicate: true };
    }

    // ── Dispatch ────────────────────────────────────────────
    let result: WebhookResult;

    switch (event.type) {
      case "checkout.session.completed":
        result = await this.handleCheckoutCompleted(
          event,
          event.data.object as Stripe.Checkout.Session,
        );
        break;

      case "account.updated":
        result = this.handleAccountUpdated(
          event,
          event.data.object as Stripe.Account,
        );
        break;

      default:
        // Unknown event type — acknowledge without processing.
        result = { processed: false, eventType: event.type };
    }

    // Mark as processed only after successful handling.
    if (result.processed && !result.error) {
      this.processedEventIds.add(event.id);
      // Cap in-memory set to avoid unbounded growth in long-running processes.
      if (this.processedEventIds.size > 10_000) {
        const first = this.processedEventIds.values().next().value;
        if (first) this.processedEventIds.delete(first);
      }
    }

    return result;
  }

  // ─── Event Handlers ──────────────────────────────────────

  private async handleCheckoutCompleted(
    event: Stripe.Event,
    session: Stripe.Checkout.Session,
  ): Promise<WebhookResult> {
    const { metadata } = session;

    // Validate required Toolgate metadata fields.
    if (
      !metadata?.toolgate_caller_id ||
      !metadata?.toolgate_publisher_id ||
      !metadata?.toolgate_amount_cents ||
      !metadata?.toolgate_currency
    ) {
      // Not a Toolgate checkout — could be another product using the same
      // Stripe account. Acknowledge safely without processing.
      return {
        processed: false,
        eventType: event.type,
        error: "Missing Toolgate metadata in checkout session — skipping",
      };
    }

    // Ensure the payment status is actually paid.
    if (session.payment_status !== "paid") {
      return {
        processed: false,
        eventType: event.type,
        error: `Payment not completed (status: ${session.payment_status})`,
      };
    }

    const callerId = metadata.toolgate_caller_id;
    const amountCents = parseInt(metadata.toolgate_amount_cents, 10);
    const currency = metadata.toolgate_currency;

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
        error: `Ledger credit failed: ${(err as Error).message}`,
      };
    }

    return { processed: true, eventType: event.type };
  }

  private handleAccountUpdated(
    event: Stripe.Event,
    account: Stripe.Account,
  ): WebhookResult {
    // Publisher Connect account status changed (e.g. onboarding completed,
    // payouts enabled). Log or notify as needed — extend this as the
    // publisher dashboard is built out.
    const payoutsEnabled = account.payouts_enabled ?? false;
    const chargesEnabled = account.charges_enabled ?? false;

    // Nothing to persist yet in Phase 1 (no DB publisher table).
    // Return processed=true so the event ID is recorded and not retried.
    void payoutsEnabled; // suppress unused-variable lint
    void chargesEnabled;

    return { processed: true, eventType: event.type };
  }
}

// ─── Factory ─────────────────────────────────────────────

/**
 * Convenience factory — constructs a WebhookHandler from a StripeAdapter
 * and ledger without needing to reach into the adapter internals.
 */
export function createWebhookHandler(options: {
  stripeClient: Stripe;
  webhookSecret: string;
  ledger: LedgerAdapter;
}): WebhookHandler {
  return new WebhookHandler(options);
}
