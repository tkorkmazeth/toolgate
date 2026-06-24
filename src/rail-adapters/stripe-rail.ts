import type {
  RailAdapter,
  ChallengeParams,
  SettlementAction,
} from "../types.js";

// ─── Stripe Rail Adapter ──────────────────────────────────

/**
 * Stripe rail adapter — creates Checkout URLs for balance top-ups.
 * Uses the Tollgate hosted API or a custom topUpBaseUrl.
 *
 * No additional dependencies needed — just a URL.
 * Payment verification happens via Stripe webhook → WebhookHandler → ledger credit.
 */
export interface StripeRailConfig {
  /**
   * Base URL for the top-up endpoint.
   * Receives: ?publisher=...&caller=...&amount=... (cents)
   * Default: Tollgate hosted API.
   */
  topUpBaseUrl?: string;
}

export class StripeRailAdapter implements RailAdapter {
  rail = "stripe" as const;
  private topUpBaseUrl: string;

  constructor(config?: StripeRailConfig) {
    this.topUpBaseUrl =
      config?.topUpBaseUrl ??
      "https://tollgate-api.talha-korkmazeth.workers.dev/pay";
  }

  async createChallenge(params: ChallengeParams): Promise<SettlementAction> {
    const amountCents = Math.ceil(params.amount * 100);
    return {
      rail: "stripe",
      url:
        `${this.topUpBaseUrl}` +
        `?publisher=${encodeURIComponent(params.publisherKey)}` +
        `&caller=${encodeURIComponent(params.callerId)}` +
        `&amount=${amountCents}` +
        `&currency=${params.currency}` +
        `&tool=${encodeURIComponent(params.toolName)}`,
      expiresAt: Math.floor(Date.now() / 1000) + 30 * 60, // 30 min
    };
  }

  // No verifyPayment — Stripe verification happens via webhook → ledger credit
}
