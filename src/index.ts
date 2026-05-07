// Core SDK
export { ToolGate } from "./toolgate.js";
export { InMemoryLedger } from "./ledger.js";

// MCP Adapter
export { McpAdapter, createMcpAdapter } from "./mcp-adapter.js";

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
