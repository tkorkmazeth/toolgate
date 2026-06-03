import type Stripe from "stripe";

// ─── Config ────────────────────────────────────────────────

export interface StripeAdapterConfig {
  /** Stripe secret key (sk_live_... or sk_test_...) */
  secretKey: string;
  /** Stripe webhook signing secret (whsec_...) */
  webhookSecret: string;
  /**
   * Platform fee percentage taken from each payout to publishers.
   * e.g. 0.10 = 10%. Applied during Connect transfers.
   */
  platformFeePercent?: number;
  /**
   * Base URL for the top-up Checkout success/cancel pages.
   * e.g. "https://pay.toolgate.dev"
   */
  topUpBaseUrl?: string;
}

// ─── Checkout ──────────────────────────────────────────────

export type TopUpAmount = 100 | 500 | 1000 | 2500; // cents

export interface CheckoutSessionResult {
  sessionId: string;
  url: string;
}

// ─── Payout ────────────────────────────────────────────────

export interface PayoutResult {
  transferId: string;
  amount: number; // cents transferred (after platform fee)
  platformFee: number; // cents retained by platform
}

// ─── Connect Account ───────────────────────────────────────

export interface ConnectAccountResult {
  accountId: string;
}

export interface AccountLinkResult {
  url: string;
  expiresAt: number;
}

// ─── StripeAdapter ─────────────────────────────────────────

export class StripeAdapter {
  private _stripe: Stripe | null = null;
  private config: Required<StripeAdapterConfig>;

  constructor(config: StripeAdapterConfig) {
    this.config = {
      platformFeePercent: 0.1,
      topUpBaseUrl: "https://pay.toolgate.dev",
      ...config,
    };
  }

  /**
   * Lazy-init the Stripe client on first use.
   * Uses dynamic import() because the package is ESM ("type": "module")
   * and stripe is an optional peer dependency.
   */
  private async getStripe(): Promise<Stripe> {
    if (this._stripe) return this._stripe;

    let StripeLib: typeof Stripe;
    try {
      const mod = await import("stripe");
      StripeLib = (mod.default ?? mod) as typeof Stripe;
    } catch {
      throw new Error(
        "stripe package not found. Install it: npm install stripe",
      );
    }

    this._stripe = new StripeLib(this.config.secretKey, {
      apiVersion: "2025-02-24.acacia",
      typescript: true,
    });
    return this._stripe;
  }

  // ─── Balance Top-Up ──────────────────────────────────────

  /**
   * Create a Stripe Checkout session so a caller can top up their
   * Toolgate balance. On payment completion Stripe fires a webhook
   * that credits the ledger (handled by WebhookHandler).
   *
   * @param callerId   Toolgate caller identifier (credited on success)
   * @param publisherId Toolgate publisher key (for Connect routing)
   * @param amountCents Amount in cents (100 | 500 | 1000 | 2500)
   * @param currency    ISO 4217 lowercase (default "usd")
   */
  async createTopUpSession(
    callerId: string,
    publisherId: string,
    amountCents: TopUpAmount,
    currency = "usd",
  ): Promise<CheckoutSessionResult> {
    validateCallerId(callerId);
    validatePublisherId(publisherId);

    const baseUrl = this.config.topUpBaseUrl;
    const stripe = await this.getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency,
            unit_amount: amountCents,
            product_data: {
              name: "Toolgate Balance Top-Up",
              description: `$${(amountCents / 100).toFixed(2)} added to your Toolgate balance`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        toolgate_caller_id: callerId,
        toolgate_publisher_id: publisherId,
        toolgate_amount_cents: String(amountCents),
        toolgate_currency: currency,
      },
      success_url: `${baseUrl}/topup/success?session_id={CHECKOUT_SESSION_ID}&caller=${encodeURIComponent(callerId)}`,
      cancel_url: `${baseUrl}/topup/cancel?caller=${encodeURIComponent(callerId)}`,
      // Prevent the session from being reused after abandonment.
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60, // 30 minutes
    });

    if (!session.url) {
      throw new Error("Stripe did not return a checkout URL");
    }

    return { sessionId: session.id, url: session.url };
  }

  /**
   * Build a top-up URL for embedding in 402 Payment Required responses.
   * Creates a Checkout session and returns the direct Stripe-hosted URL.
   */
  async buildTopUpUrl(
    callerId: string,
    publisherId: string,
    requiredAmountUsd: number,
    currency = "usd",
  ): Promise<string> {
    // Round up to the nearest supported top-up amount.
    const amountCents = selectTopUpAmount(requiredAmountUsd);
    const { url } = await this.createTopUpSession(
      callerId,
      publisherId,
      amountCents,
      currency,
    );
    return url;
  }

  // ─── Stripe Connect (Publisher Payouts) ──────────────────

  /**
   * Create a Stripe Connect Express account for a new publisher.
   * Store the returned accountId — it's needed for payouts.
   */
  async createConnectAccount(email: string): Promise<ConnectAccountResult> {
    if (!isValidEmail(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }

    const stripe = await this.getStripe();
    const account = await stripe.accounts.create({
      type: "express",
      email,
      capabilities: {
        transfers: { requested: true },
      },
      settings: {
        payouts: { schedule: { interval: "weekly" } },
      },
    });

    return { accountId: account.id };
  }

  /**
   * Generate an Account Link URL so the publisher can complete their
   * Stripe Connect onboarding (identity verification, bank details, etc.).
   */
  async createAccountLink(
    accountId: string,
    returnUrl: string,
    refreshUrl: string,
  ): Promise<AccountLinkResult> {
    const stripe = await this.getStripe();
    const link = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      return_url: returnUrl,
      refresh_url: refreshUrl,
    });

    return { url: link.url, expiresAt: link.expires_at };
  }

  /**
   * Transfer earnings to a publisher's Connect account, retaining the
   * platform fee. Use this for scheduled weekly/monthly payouts.
   *
   * @param connectedAccountId  Publisher's Stripe Connect account ID
   * @param grossAmountCents    Total to pay out before platform fee (cents)
   * @param currency            ISO 4217 lowercase
   */
  async payoutToPublisher(
    connectedAccountId: string,
    grossAmountCents: number,
    currency = "usd",
  ): Promise<PayoutResult> {
    if (grossAmountCents < 50) {
      throw new Error("Minimum payout is $0.50 (50 cents)");
    }

    const platformFeeCents = Math.floor(
      grossAmountCents * this.config.platformFeePercent,
    );
    const netAmountCents = grossAmountCents - platformFeeCents;

    const stripe = await this.getStripe();
    const transfer = await stripe.transfers.create({
      amount: netAmountCents,
      currency,
      destination: connectedAccountId,
      metadata: {
        toolgate_gross_cents: String(grossAmountCents),
        toolgate_platform_fee_cents: String(platformFeeCents),
        toolgate_fee_percent: String(this.config.platformFeePercent),
      },
    });

    return {
      transferId: transfer.id,
      amount: netAmountCents,
      platformFee: platformFeeCents,
    };
  }

  // ─── Raw Stripe client (escape hatch) ────────────────────

  /**
   * Access the underlying Stripe SDK instance for advanced use.
   * Triggers lazy initialization if not yet loaded.
   */
  async getClient(): Promise<Stripe> {
    return this.getStripe();
  }
}

// ─── Helpers ─────────────────────────────────────────────

/** Round up the required amount to the nearest supported top-up tier. */
function selectTopUpAmount(requiredUsd: number): TopUpAmount {
  const requiredCents = Math.ceil(requiredUsd * 100);
  if (requiredCents <= 100) return 100;
  if (requiredCents <= 500) return 500;
  if (requiredCents <= 1000) return 1000;
  return 2500;
}

/** Reject obviously dangerous caller IDs before embedding in URLs / metadata. */
function validateCallerId(id: string): void {
  if (!id || id.length > 256 || !/^[\w\-:.@]+$/.test(id)) {
    throw new Error(
      `Invalid callerId "${id}". Must be 1-256 chars: letters, digits, -, _, :, ., @`,
    );
  }
}

function validatePublisherId(id: string): void {
  if (!id || id.length > 256 || !/^[\w\-:.@]+$/.test(id)) {
    throw new Error(
      `Invalid publisherId "${id}". Must be 1-256 chars: letters, digits, -, _, :, ., @`,
    );
  }
}

function isValidEmail(email: string): boolean {
  // Basic RFC 5321 sanity check — Stripe will do full validation.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320;
}
