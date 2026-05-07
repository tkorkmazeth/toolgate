// ─── Core Types ────────────────────────────────────────────

export interface ToolGateConfig {
  publisherKey: string;
  /** Payment rails to accept. Default: ["stripe"] */
  paymentRails?: PaymentRail[];
  /** Default currency (ISO 4217). Default: "usd" */
  defaultCurrency?: string;
  /** Ledger adapter for balance management */
  ledger?: LedgerAdapter;
  /** Event hooks for observability */
  hooks?: GlobalHooks;
  /** Payment rail adapters for 402 settlement options */
  railAdapters?: RailAdapter[];
  /**
   * Base URL for Stripe top-up redirect links included in 402 responses.
   * The SDK appends `?publisher=...&caller=...&amount=...` to this URL.
   * Must expose a GET endpoint that creates a Stripe Checkout and redirects.
   * Defaults to the Toolgate hosted API.
   */
  topUpBaseUrl?: string;
}

export type PaymentRail = "stripe" | "x402" | "mpp";

// ─── Pricing ───────────────────────────────────────────────

/** Static number, dynamic function, or "postpaid" (meter after execution) */
export type PriceSpec =
  | number
  | ((input: unknown) => number | Promise<number>)
  | "postpaid";

export interface TierConfig {
  free?: {
    limit: number;
    period: "hour" | "day" | "week" | "month";
    handler?: ToolHandler;
  };
  premium: {
    /** Postpaid is not supported in tiers; use a number or function. */
    price: Exclude<PriceSpec, "postpaid">;
    handler?: ToolHandler;
  };
}

// ─── Tool Definition ───────────────────────────────────────

export type ToolHandler = (
  input: unknown,
  ctx: ExecutionContext,
) => unknown | Promise<unknown>;

export interface PaidToolConfig {
  name: string;
  description?: string;

  /** Simple pricing (use this OR tiers, not both) */
  price?: PriceSpec;
  /** Tiered access with free + premium */
  tiers?: TierConfig;

  /** Main handler (required if not using tiers with separate handlers) */
  handler: ToolHandler;

  /** What to do when payment fails */
  onPaymentFailed?: "block" | "fallback" | "allow_once";
  /** Fallback handler when payment fails and onPaymentFailed = "fallback" */
  fallback?: ToolHandler;

  // ─── Lifecycle Hooks ───────────────────────────────────
  /** Runs before execution. Return false to abort. */
  beforeExecute?: (
    input: unknown,
    ctx: ExecutionContext,
  ) => boolean | Promise<boolean>;
  /** Runs after successful execution. Good for logging, metering. */
  afterExecute?: (
    input: unknown,
    output: unknown,
    metrics: ExecutionMetrics,
  ) => void | Promise<void>;
  /** Runs when the handler throws */
  onFail?: (
    input: unknown,
    error: Error,
    ctx: ExecutionContext,
  ) => void | Promise<void>;
  /** Runs when payment cannot be collected */
  onPaymentFail?: (
    input: unknown,
    reason: PaymentFailReason,
  ) => void | Promise<void>;

  /** Post-execution metering for "postpaid" pricing */
  meter?: (
    input: unknown,
    output: unknown,
    metrics: ExecutionMetrics,
  ) => MeterResult | Promise<MeterResult>;

  /** Execution policy — programmatic control over paid tool behavior */
  policy?: ExecutionPolicy;

  /**
   * Cost estimator — returns estimated price before execution.
   * Invoked when policy.decide() returns "estimate".
   */
  estimate?: (
    input: unknown,
    ctx: Omit<PolicyContext, "estimatedPrice">,
  ) => CostEstimate | Promise<CostEstimate>;

  /** Fires when fallback is triggered (for analytics/logging) */
  onFallback?: (
    input: unknown,
    reason: PolicyDecision | "insufficient_balance",
    ctx: ExecutionContext,
  ) => void | Promise<void>;
}

// ─── Execution Policy ──────────────────────────────────────

export interface ExecutionPolicy {
  decide: (ctx: PolicyContext) => PolicyDecision | Promise<PolicyDecision>;
}

export type PolicyDecision =
  | "execute"
  | "fallback"
  | "payment_required"
  | "allow_once"
  | "estimate";

export interface PolicyContext {
  callerId: string;
  tier: "free" | "premium";
  balance: number;
  estimatedPrice: number;
  input: unknown;
  tool: string;
  usageToday: number;
  callerMeta?: Record<string, unknown>;
}

export interface CostEstimate {
  estimatedPrice: number;
  maxPrice?: number;
  currency: string;
  breakdown?: Record<string, number>;
  reason?: string;
}

// ─── Execution Context & Metrics ───────────────────────────

export interface ExecutionContext {
  callerId: string;
  callId: string;
  tool: string;
  tier: "free" | "premium";
  balance: number;
  timestamp: number;
}

export interface ExecutionMetrics {
  durationMs: number;
  startedAt: number;
  endedAt: number;
  /** Arbitrary metadata the handler can attach */
  meta?: Record<string, unknown>;
}

export interface MeterResult {
  amount: number;
  breakdown?: Record<string, number>;
}

export type PaymentFailReason =
  | { code: "insufficient_balance"; balance: number; required: number }
  | { code: "payment_declined"; detail: string }
  | { code: "rail_unavailable"; rail: PaymentRail };

// ─── Payment Response (402) ────────────────────────────────

export interface PaymentRequiredResponse {
  status: 402;
  error: "payment_required";
  tool: string;
  amount: number;
  currency: string;
  /** URL to top up balance (Stripe Checkout) */
  topUpUrl?: string;
  /** x402 challenge for crypto-native agents */
  x402Challenge?: Record<string, unknown>;
  /** Settlement options from registered rail adapters */
  settlements?: SettlementAction[];
  /** Accepts array for multi-rail */
  acceptedRails: PaymentRail[];
}

// ─── Tool Call Result ──────────────────────────────────────

export interface ToolCallResult {
  success: boolean;
  output?: unknown;
  /** Payment receipt */
  receipt?: {
    callId: string;
    tool: string;
    amount: number;
    currency: string;
    rail: PaymentRail | "prepaid";
    balanceAfter: number;
    timestamp: number;
  };
  /** Returned when payment is required */
  paymentRequired?: PaymentRequiredResponse;
  /** Execution metrics */
  metrics?: ExecutionMetrics;
  /** Whether this was a fallback response */
  isFallback?: boolean;
}

// ─── Ledger Adapter ────────────────────────────────────────

export interface LedgerAdapter {
  getBalance(callerId: string): Promise<number>;
  deduct(callerId: string, amount: number, meta: DeductMeta): Promise<boolean>;
  credit(callerId: string, amount: number, meta: CreditMeta): Promise<void>;
  getUsage(callerId: string, tool: string, period: string): Promise<number>;
  incrementUsage(callerId: string, tool: string, period: string): Promise<void>;
}

export interface DeductMeta {
  callId: string;
  tool: string;
  amount: number;
}

export interface CreditMeta {
  source: "stripe" | "x402" | "mpp" | "manual";
  reference: string;
}

// ─── Rail Adapter (settlement layer abstraction) ──────────

/**
 * A RailAdapter handles payment settlement for a specific rail.
 * It converts a payment requirement into a settlement action
 * (e.g., Stripe Checkout URL, MPP session, x402 challenge).
 *
 * This is NOT the ledger — it's the bridge between "payment needed"
 * and "payment settled". The ledger gets credited when settlement completes.
 */
export interface RailAdapter {
  /** Which rail this adapter handles */
  rail: PaymentRail;

  /**
   * Build a settlement action for the given payment requirement.
   * Returns a URL, challenge, or session that the caller can use to pay.
   */
  createSettlement(params: {
    callerId: string;
    amount: number;
    currency: string;
    toolName: string;
    publisherKey: string;
  }): Promise<SettlementAction>;
}

export interface SettlementAction {
  rail: PaymentRail;
  /** URL for the caller to complete payment (Stripe Checkout, MPP session, etc.) */
  url?: string;
  /** x402 challenge payload for crypto-native agents */
  x402Challenge?: Record<string, unknown>;
  /** MPP session ID for streaming micropayments */
  mppSessionId?: string;
  /** Expiration timestamp (seconds since epoch) */
  expiresAt?: number;
}

// ─── Global Hooks ──────────────────────────────────────────

export interface GlobalHooks {
  onCall?: (tool: string, callerId: string) => void;
  onPayment?: (tool: string, callerId: string, amount: number) => void;
  onError?: (tool: string, error: Error) => void;
}
