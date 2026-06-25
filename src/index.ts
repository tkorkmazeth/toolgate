// Core SDK
export { TollGate, TollGate as ToolGate } from "./tollgate.js";
export { InMemoryLedger } from "./ledger.js";

// Phase 1A: Money — integer arithmetic for billing
export {
  usd,
  usdc,
  money,
  add,
  subtract,
  multiply,
  gte,
  gt,
  isZero,
  toDecimalString,
  toMinorUnits,
  toNumber,
  parsePriceInput,
  resolvePriceInput,
  isMoney,
} from "./money.js";
export type { Money, TransactionId, PriceInput } from "./money.js";

// Phase 1B: Atomic idempotency store
export { InMemoryIdempotencyStore } from "./idempotency.js";
// Phase 1C: Durable, cross-instance idempotency store (D1/Turso/SQLite)
export {
  DbIdempotencyStore,
  DB_IDEMPOTENCY_SCHEMA,
} from "./db-idempotency.js";

// Phase 1D: Recovery state machine
export {
  determineRecovery,
  getCapabilities,
  PREPAID_CAPABILITIES,
  STRIPE_CAPABILITIES,
  X402_CAPABILITIES,
  MPP_CAPABILITIES,
  RAIL_CAPABILITIES,
} from "./recovery.js";
export type {
  RailCapabilities,
  ChargeOutcome,
  RecoveryDecision,
} from "./recovery.js";

// Phase 2: Trace store
export { InMemoryTraceStore } from "./trace-store.js";

// Phase B: Settlement-uncertainty recovery (retry + queue + reconcile)
export {
  settleWithRetry,
  InMemoryPendingSettlementStore,
  DbPendingSettlementStore,
  DB_PENDING_SETTLEMENT_SCHEMA,
  SettlementReconciler,
  startSettlementReconciler,
} from "./settlement-recovery.js";
export type {
  SettleRetryOptions,
  SettleAttemptOutcome,
  PendingSettlement,
  PendingSettlementInput,
  PendingSettlementStore,
  ChainConfirmer,
  ReconcileResult,
  ReconcilerOptions,
  ReconcilerLoopHandle,
} from "./settlement-recovery.js";

// MCP Adapter
export { McpAdapter, createMcpAdapter } from "./mcp-adapter.js";

// Rail Adapters (Stripe production, MPP via mppx, x402 via @x402/core)
export {
  StripeRailAdapter,
  MppRailAdapter,
  X402RailAdapter,
  EVM_USDC_ADDRESSES,
  EVM_USDC_EIP712_DOMAINS,
  SOLANA_USDC_ADDRESSES,
  buildSolanaPaymentPayload,
  extractSolanaRequirement,
} from "./rail-adapters/index.js";
export type {
  StripeRailConfig,
  MppRailConfig,
  X402RailConfig,
  BuildSolanaPaymentInput,
  BuildSolanaPaymentResult,
  SolanaPaymentPayload,
  SolanaPaymentRequirement,
} from "./rail-adapters/index.js";

// Stripe Integration (Phase 1)
export { StripeAdapter } from "./stripe-adapter.js";
export { WebhookHandler, createWebhookHandler } from "./webhook-handler.js";
export { DbLedger, DB_SCHEMA } from "./db-ledger.js";

// Types
export type {
  TollGateConfig,
  ToolGateConfig,
  PaidToolConfig,
  ToolCallResult,
  ExecutionContext,
  ExecutionMetrics,
  PaymentRequiredResponse,
  PaymentRail,
  PriceSpec,
  TierConfig,
  LedgerAdapter,
  MeterResult,
  PaymentFailReason,
  GlobalHooks,
  ExecutionPolicy,
  PolicyDecision,
  PolicyContext,
  CostEstimate,
  RailAdapter,
  SettlementAction,
  PaymentMode,
  ChallengeParams,
  PaymentProof,
  VerificationResult,
  MppMethodConfig,
  MppChallengeEntry,
  X402PaymentRequirement,
  X402Network,
  VerificationContext,
  SettlementResult,
  // Failure/Recovery taxonomy
  FailureClass,
  RecoveryAction,
  ExecutionTrace,
  TraceEvent,
  IdempotencyStatus,
  IdempotencyRecord,
  IdempotencyStore,
  ClaimResult,
  SerializedError,
  TraceStore,
} from "./types.js";

export type { McpAdapterConfig, McpPaidToolConfig } from "./mcp-adapter.js";

export type {
  McpToolResult,
  McpToolRegistration,
  McpCallExtra,
  McpServerLike,
} from "./mcp-types.js";

export type {
  StripeAdapterConfig,
  TopUpAmount,
  CheckoutSessionResult,
  PayoutResult,
  ConnectAccountResult,
  AccountLinkResult,
} from "./stripe-adapter.js";

export type { WebhookResult } from "./webhook-handler.js";

export type { DbClient, DbStatement } from "./db-ledger.js";
