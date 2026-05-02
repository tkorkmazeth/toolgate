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
  source: "stripe" | "x402" | "manual";
  reference: string;
}

// ─── Global Hooks ──────────────────────────────────────────

export interface GlobalHooks {
  onCall?: (tool: string, callerId: string) => void;
  onPayment?: (tool: string, callerId: string, amount: number) => void;
  onError?: (tool: string, error: Error) => void;
}
