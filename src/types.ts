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
  /** Payment mode — prepaid (balance-only), per_request (rail-only), or hybrid. Default: "hybrid" */
  paymentMode?: PaymentMode;
  /**
   * Base URL for Stripe top-up redirect links included in 402 responses.
   * The SDK appends `?publisher=...&caller=...&amount=...` to this URL.
   * Must expose a GET endpoint that creates a Stripe Checkout and redirects.
   * Defaults to the Toolgate hosted API.
   */
  topUpBaseUrl?: string;
  /** Idempotency store for duplicate request handling. Default: InMemoryIdempotencyStore */
  idempotencyStore?: IdempotencyStore;
  /** Execution trace store. Default: InMemoryTraceStore */
  traceStore?: TraceStore;
  /**
   * Default idempotency TTL in seconds. After this, same key = new execution.
   * Default: 3600 (1 hour).
   */
  idempotencyTtlSeconds?: number;
}

export type PaymentRail = "stripe" | "x402" | "mpp";

export type PaymentMode = "prepaid" | "per_request" | "hybrid";

// ─── x402 Network Types ──────────────────────────────────

/**
 * Typed x402 network config.
 * EVM uses 0x-prefixed addresses, Solana uses base58.
 * CAIP-2 format: "eip155:{chainId}" or "solana:{genesisHash}"
 */
export type X402Network =
  | {
      kind: "evm";
      /** CAIP-2 network ID, e.g. "eip155:8453" */
      caip2: `eip155:${string}`;
      /** ERC-20 token contract address (0x...) */
      asset?: `0x${string}`;
      /** Token decimals (default: 6 for USDC) */
      decimals?: number;
    }
  | {
      kind: "solana";
      /** CAIP-2 network ID, e.g. "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" */
      caip2: `solana:${string}`;
      /** SPL token mint address (base58) */
      asset?: string;
      /** Token decimals (default: 6 for USDC) */
      decimals?: number;
    };

// ─── MPP Method Config (typed, not opaque) ───────────────

export type MppMethodConfig =
  | {
      name: "tempo";
      /** Tempo token contract address (e.g., pathUSD: "0x20c0...") */
      currency: string;
      /** Recipient wallet address */
      recipient: string;
    }
  | {
      name: "stripe";
      /** Stripe account ID that receives the payment */
      stripeAccountId?: string;
    }
  | {
      name: string;
      /** Custom method — name + arbitrary params */
      params: Record<string, unknown>;
    };

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

  // ── Phase 2: Idempotency & Recovery ───────────────────

  /**
   * How to extract idempotency key from input.
   * If string: used as-is (static key for all calls).
   * If function: called with (input, callerId) to derive key.
   * If omitted: auto-generated from tool name + callerId + input hash.
   */
  idempotencyKey?: string | ((input: unknown, callerId: string) => string);

  /**
   * What to do when a duplicate request arrives for a completed execution.
   * Default: "return_previous_result"
   */
  onDuplicate?: "return_previous_result" | "re_execute" | "block";

  /** Fires when a duplicate request is detected */
  onDuplicateDetected?: (
    input: unknown,
    record: IdempotencyRecord,
    ctx: ExecutionContext,
  ) => void | Promise<void>;

  /** Fires when estimated cost exceeds balance and cost is uncertain */
  onCostOverrun?: (
    input: unknown,
    estimatedCost: number,
    ctx: ExecutionContext,
  ) => RecoveryAction | Promise<RecoveryAction>;

  /** Fires when tool execution times out */
  onToolTimeout?: (
    input: unknown,
    durationMs: number,
    ctx: ExecutionContext,
  ) => RecoveryAction | Promise<RecoveryAction>;
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

export interface RailAdapter {
  /** Which rail this adapter handles */
  rail: PaymentRail;

  /**
   * Create a payment challenge for the caller.
   * Returns a standardized settlement action with rail-specific details.
   */
  createChallenge(params: ChallengeParams): Promise<SettlementAction>;

  /**
   * Verify a payment proof from a retry request.
   * Returns verified result if valid, null if invalid.
   * IMPORTANT: For x402, this only validates — does NOT settle on-chain.
   */
  verifyPayment?(
    proof: PaymentProof,
    context?: VerificationContext,
  ): Promise<VerificationResult | null>;

  /**
   * Settle a verified payment on-chain.
   * For x402: POSTs to facilitator /settle endpoint.
   * For MPP: may be no-op (webhook-based) or mppx-handled.
   * Called AFTER tool execution succeeds.
   */
  settlePayment?(
    proof: PaymentProof,
    context?: VerificationContext,
  ): Promise<SettlementResult | null>;
}

/**
 * Context passed to verify/settle — includes the original payment requirements.
 */
export interface VerificationContext {
  /** The original payment requirement from createChallenge() */
  paymentRequirements?: X402PaymentRequirement;
  /** Settlement action ID (maps to pending requirements) */
  actionId?: string;
  /** Expected amount to credit before execution when the rail verifies a proof */
  expectedAmount?: number;
  /** Currency for the verified payment */
  currency?: string;
  /** Tool identity for provider correlation */
  toolName?: string;
  /** Caller identity for provider correlation */
  callerId?: string;
}

export interface SettlementResult {
  settled: true;
  rail: PaymentRail;
  txHash?: string;
  amount: number;
  currency: string;
  receiptId: string;
}

export interface ChallengeParams {
  callerId: string;
  amount: number;
  currency: string;
  toolName: string;
  publisherKey: string;
}

export interface SettlementAction {
  rail: PaymentRail;
  /** Unique ID for this settlement action (used to look up pending requirements) */
  actionId?: string;
  /** URL for the caller to complete payment (Stripe Checkout etc.) */
  url?: string;

  /** x402 payment requirement — full x402-spec format */
  x402PaymentRequired?: {
    x402Version: number;
    accepts: X402PaymentRequirement[];
  };

  /** MPP challenge — full MPP-spec format */
  mppChallenge?: {
    protocol: "mpp";
    /** Array of MPP challenges (one per payment method) */
    challenges: MppChallengeEntry[];
    /** Pre-built WWW-Authenticate header values (for HTTP contexts) */
    wwwAuthenticate?: string[];
  };

  /** Expiration (seconds since epoch) */
  expiresAt?: number;
}

export interface MppChallengeEntry {
  id: string;
  realm: string;
  method: string; // "tempo", "stripe", etc.
  intent: "charge" | "stream";
  request: string; // base64url-encoded JSON
}

export interface X402PaymentRequirement {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface PaymentProof {
  rail: PaymentRail;
  /** MPP: base64url-encoded credential from Authorization header */
  mppPaymentHeader?: string;
  /** x402: raw payment payload from X-PAYMENT header (decoded) */
  x402PaymentPayload?: Record<string, unknown>;
  /** Raw request for middleware-level verification */
  rawRequest?: unknown;
}

export interface VerificationResult {
  verified: true;
  rail: PaymentRail;
  amount: number;
  currency: string;
  /** Receipt/tx ID from the payment rail */
  receiptId: string;
}

// ─── Global Hooks ──────────────────────────────────────────

export interface GlobalHooks {
  onCall?: (tool: string, callerId: string) => void;
  onPayment?: (tool: string, callerId: string, amount: number) => void;
  onError?: (tool: string, error: Error) => void;
}

// ─── Failure Classification ────────────────────────────────
//
// Three categories: payment failures, credential failures, tool failures,
// and execution failures. Used in ExecutionTrace and recovery decision logic.

export type FailureClass =
  // Payment failures
  | "insufficient_balance"
  | "payment_declined"
  | "payment_pending"
  | "rail_unavailable"
  | "payment_challenge_required"
  // Credential failures (Basis Theory / Visa IC / ACP ecosystem)
  | "credential_expired"
  | "credential_unavailable"
  | "provider_verification_failed"
  | "provider_partial_failure"
  | "user_cancelled"
  | "merchant_declined"
  // Tool failures
  | "tool_timeout"
  | "tool_failed"
  | "partial_result"
  // Execution failures
  | "cost_overrun"
  | "duplicate_request"
  | "settlement_uncertain"
  | "approval_required";

// ─── Recovery Actions ──────────────────────────────────────
//
// What Toolgate does in response to a failure or policy decision.
// Superset of the existing PolicyDecision type.

export type RecoveryAction =
  | "execute" // proceed normally
  | "fallback_response" // return degraded result
  | "retry_later" // tell caller to retry
  | "topup_required" // 402 with payment challenge
  | "refund" // charge happened, undo it
  | "credit_back" // post-execution credit
  | "do_not_settle" // x402: don't call /settle (auto-refund)
  | "no_charge" // execute but don't bill
  | "partial_response" // return partial + partial charge
  | "allow_once" // grace period execution
  | "return_previous_result" // idempotent duplicate
  | "require_approval" // defer to human/agent approval (Phase 3)
  | "request_reapproval" // credential expired → ask user to re-approve
  | "request_new_credential" // credential unavailable → request fresh one
  | "manual_review"; // escalate to human for non-automatable failures

// ─── Execution Trace ──────────────────────────────────────
//
// Immutable record of every paid tool call. Not just logging —
// this is a core product artifact. Answers: "What did the agent
// see, decide, and trigger?"

export interface ExecutionTrace {
  /** Unique trace ID */
  traceId: string;
  /** Idempotency key (caller-provided or auto-generated) */
  idempotencyKey: string;
  /** Caller identity */
  callerId: string;
  /** Tool name */
  toolName: string;
  /** djb2 hash of the input (for duplicate detection) */
  inputHash: string;

  // ── Pricing ──
  estimatedAmount?: number;
  finalAmount?: number;
  currency: string;

  // ── Decision ──
  /** The execution decision that was made */
  decision: RecoveryAction;
  /** Why the normal path couldn't proceed (if applicable) */
  failureClass?: FailureClass;

  // ── Payment ──
  rail?: PaymentRail | "prepaid" | "none";
  challengeId?: string;
  receiptId?: string;

  // ── Execution ──
  handlerStatus: "not_started" | "success" | "failed" | "timeout" | "partial";
  durationMs?: number;
  fallbackUsed: boolean;

  // ── Settlement / Reversal ──
  chargeStatus:
    | "none"
    | "charged"
    | "refunded"
    | "credited_back"
    | "voided"
    | "no_charge";
  refundReason?: string;

  // ── Provider Context (for rail/credential correlation) ──
  /** Provider-specific trace/correlation IDs for support & debugging. */
  provider?: {
    name?: string;
    traceId?: string;
    correlationId?: string;
    enrollmentId?: string;
    instructionId?: string;
    credentialExpiresAt?: string;
  };

  // ── Timestamps ──
  createdAt: number;
  updatedAt: number;
  /** Ordered list of trace events (append-only) */
  events: TraceEvent[];
}

export interface TraceEvent {
  timestamp: number;
  event: string;
  detail?: string;
  metadata?: Record<string, unknown>;
}

// ─── Idempotency ──────────────────────────────────────────

export type IdempotencyStatus =
  | "in_progress"
  | "completed"
  | "failed"
  | "refunded"
  | "no_charge"
  | "fallback_served"
  | "requires_payment"
  | "requires_approval";

export interface IdempotencyRecord {
  key: string;
  callerId: string;
  toolName: string;
  inputHash: string;
  status: IdempotencyStatus;
  /** Stored result (for returning on duplicate) */
  result?: ToolCallResult;
  traceId: string;
  createdAt: number;
  updatedAt: number;
  /** TTL — auto-expire after this timestamp */
  expiresAt: number;
}

/**
 * Pluggable idempotency store. InMemoryIdempotencyStore for dev,
 */
export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>;
  set(record: IdempotencyRecord): Promise<void>;
  update(key: string, updates: Partial<IdempotencyRecord>): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Pluggable trace store. In-memory for dev, DB/analytics for production.
 */
export interface TraceStore {
  save(trace: ExecutionTrace): Promise<void>;
  get(traceId: string): Promise<ExecutionTrace | null>;
  getByIdempotencyKey(key: string): Promise<ExecutionTrace | null>;
  findByIdempotencyKey(key: string): Promise<ExecutionTrace | null>;
  list(filter: {
    callerId?: string;
    toolName?: string;
    limit?: number;
  }): Promise<ExecutionTrace[]>;
  toJSON(filter?: {
    callerId?: string;
    toolName?: string;
    limit?: number;
  }): Promise<ExecutionTrace[]>;
}
