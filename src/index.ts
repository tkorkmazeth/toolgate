// Core SDK
export { ToolGate } from "./toolgate.js";
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

// MCP Adapter
export { McpAdapter, createMcpAdapter } from "./mcp-adapter.js";

// Rail Adapters (Stripe production, MPP via mppx, x402 via @x402/core)
export {
  StripeRailAdapter,
  MppRailAdapter,
  X402RailAdapter,
  EVM_USDC_ADDRESSES,
  SOLANA_USDC_ADDRESSES,
} from "./rail-adapters/index.js";
export type {
  StripeRailConfig,
  MppRailConfig,
  X402RailConfig,
} from "./rail-adapters/index.js";

// Stripe Integration (Phase 1)
export { StripeAdapter } from "./stripe-adapter.js";
export { WebhookHandler, createWebhookHandler } from "./webhook-handler.js";
export { DbLedger, DB_SCHEMA } from "./db-ledger.js";

// Types
export type {
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
