/**
 * Phase 1D — Recovery State Machine
 *
 * Rail-aware recovery logic. Each rail has different capabilities for
 * refund, reversal, and compensation. This module determines the correct
 * ChargeOutcome and RecoveryAction based on which rail processed the payment
 * and whether the handler succeeded.
 */
import type { RecoveryAction } from "./types.js";

// ─── Rail Capabilities ────────────────────────────────────

/**
 * Describes what a payment rail can actually do after a charge.
 * Used to select the correct recovery action per rail.
 */
export interface RailCapabilities {
  /** Rail identifier ("prepaid" | "stripe" | "x402") */
  readonly name: string;
  /**
   * Whether this rail supports refunds at all.
   * Prepaid and Stripe: yes. x402: no (on-chain reversal requires new tx).
   */
  readonly supportsRefund: boolean;
  /** Whether partial refunds are supported. */
  readonly supportsPartialRefund: boolean;
  /**
   * Whether the refund is instant.
   * Prepaid: instant (ledger credit). Stripe: 5-10 business days.
   */
  readonly refundIsInstant: boolean;
  /**
   * Whether settlement confirmation can be uncertain.
   * x402 facilitator may time out without confirming.
   */
  readonly settlementCanBeUncertain: boolean;
}

// ─── Per-rail capability constants ────────────────────────

export const PREPAID_CAPABILITIES: RailCapabilities = {
  name: "prepaid",
  supportsRefund: true,
  supportsPartialRefund: true,
  refundIsInstant: true,
  settlementCanBeUncertain: false,
};

export const STRIPE_CAPABILITIES: RailCapabilities = {
  name: "stripe",
  supportsRefund: true,
  supportsPartialRefund: true,
  refundIsInstant: false, // async: 5-10 business days
  settlementCanBeUncertain: false,
};

export const X402_CAPABILITIES: RailCapabilities = {
  name: "x402",
  supportsRefund: false, // on-chain reversal = new tx, not a native refund
  supportsPartialRefund: false,
  refundIsInstant: false,
  settlementCanBeUncertain: true, // facilitator may not confirm
};

export const MPP_CAPABILITIES: RailCapabilities = {
  name: "mpp",
  supportsRefund: false,
  supportsPartialRefund: false,
  refundIsInstant: false,
  settlementCanBeUncertain: true,
};

/** Map from rail name to capabilities (for runtime lookup). */
export const RAIL_CAPABILITIES: Record<string, RailCapabilities> = {
  prepaid: PREPAID_CAPABILITIES,
  stripe: STRIPE_CAPABILITIES,
  x402: X402_CAPABILITIES,
  mpp: MPP_CAPABILITIES,
};

// ─── ChargeOutcome ────────────────────────────────────────

/**
 * Outcome of the charge after execution attempt.
 * Extends the existing chargeStatus values with Phase 1D additions.
 */
export type ChargeOutcome =
  | "not_charged" // no charge attempted
  | "charged" // charged, handler succeeded
  | "refunded" // charged, then refunded via rail (e.g. Stripe)
  | "refund_pending" // refund initiated but not yet confirmed (Stripe async)
  | "credit_compensated" // charged, handler failed → ledger credit issued
  | "credited_back" // ledger balance credit-back (prepaid)
  | "voided" // charge voided before settlement
  | "settlement_uncertain"; // charge attempted, settlement not confirmed (x402)

// ─── Recovery decision ────────────────────────────────────

export interface RecoveryDecision {
  chargeOutcome: ChargeOutcome;
  recoveryAction: RecoveryAction;
}

/**
 * Determine the correct recovery action after a charge + handler outcome.
 *
 * This is the single source of truth for rail-aware recovery. Call this
 * after handler execution to decide what to record in the trace.
 */
export function determineRecovery(
  rail: RailCapabilities,
  handlerFailed: boolean,
  chargeOccurred: boolean,
): RecoveryDecision {
  if (!chargeOccurred) {
    return { chargeOutcome: "not_charged", recoveryAction: "no_charge" };
  }

  if (!handlerFailed) {
    return { chargeOutcome: "charged", recoveryAction: "execute" };
  }

  // Handler failed after charge — select recovery by rail capability
  if (rail.name === "prepaid") {
    // Prepaid: instantly credit back to ledger — free, reversible
    return {
      chargeOutcome: "credited_back",
      recoveryAction: "credit_back",
    };
  }

  if (rail.supportsRefund) {
    // Stripe: initiate async refund via rail API
    return {
      chargeOutcome: "refund_pending",
      recoveryAction: "refund",
    };
  }

  // x402 / MPP: can't refund on-chain — issue ledger credit compensation
  return {
    chargeOutcome: "credit_compensated",
    recoveryAction: "credit_back",
  };
}

/**
 * Get RailCapabilities by rail name string.
 * Falls back to a safe default if the rail is unknown.
 */
export function getCapabilities(railName: string): RailCapabilities {
  return (
    RAIL_CAPABILITIES[railName] ?? {
      name: railName,
      supportsRefund: false,
      supportsPartialRefund: false,
      refundIsInstant: false,
      settlementCanBeUncertain: true,
    }
  );
}
