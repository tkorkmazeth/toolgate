import type { ToolGate } from "./toolgate.js";
import type {
  PaidToolConfig,
  ToolCallResult,
  PriceSpec,
  ExecutionPolicy,
  PolicyContext,
  CostEstimate,
  PaymentProof,
  VerificationResult,
  VerificationContext,
  RailAdapter,
} from "./types.js";
import type {
  McpToolResult,
  McpToolRegistration,
  McpCallExtra,
  McpServerLike,
  JsonSchema,
} from "./mcp-types.js";

// ─── Adapter Config ────────────────────────────────────────

export interface McpAdapterConfig {
  /**
   * How to extract caller identity from MCP call context.
   * Default: uses sessionId or "anonymous"
   */
  getCallerId?: (args: Record<string, unknown>, extra: McpCallExtra) => string;

  /**
   * Default caller ID for anonymous/unauthenticated calls.
   * Default: "anonymous"
   */
  defaultCallerId?: string;

  /**
   * Whether to include Toolgate metadata (_meta) in MCP responses.
   * Agents that understand Toolgate can use this for smarter payment handling.
   * Default: true
   */
  includeMeta?: boolean;
}

// ─── MCP Paid Tool Config ──────────────────────────────────

export interface McpPaidToolConfig {
  /** Tool description shown to agents */
  description: string;

  /** JSON Schema for tool input */
  inputSchema: JsonSchema;

  /** Price per call (static, dynamic, or "postpaid") */
  price?: PriceSpec;

  /** Tiered access config */
  tiers?: PaidToolConfig["tiers"];

  /** Main handler — receives parsed args, returns any serializable value */
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;

  /** Fallback handler for when payment fails */
  fallback?: (args: Record<string, unknown>) => unknown | Promise<unknown>;

  /** Payment failure policy */
  onPaymentFailed?: "block" | "fallback" | "allow_once";

  /** Lifecycle hooks */
  beforeExecute?: PaidToolConfig["beforeExecute"];
  afterExecute?: PaidToolConfig["afterExecute"];
  onFail?: PaidToolConfig["onFail"];
  onPaymentFail?: PaidToolConfig["onPaymentFail"];

  /** Post-execution metering for "postpaid" */
  meter?: PaidToolConfig["meter"];

  /** Execution policy — programmatic control over billing decisions */
  policy?: PaidToolConfig["policy"];

  /**
   * Cost estimator — returns estimated price before execution.
   * Used when policy.decide() returns "estimate".
   */
  estimate?: PaidToolConfig["estimate"];

  /** Fires when fallback is triggered (for analytics/logging) */
  onFallback?: PaidToolConfig["onFallback"];

  /** Optional Phase 2 idempotency key passthrough */
  idempotencyKey?: PaidToolConfig["idempotencyKey"];

  /** Duplicate handling passthrough */
  onDuplicate?: PaidToolConfig["onDuplicate"];

  /** Duplicate lifecycle hook passthrough */
  onDuplicateDetected?: PaidToolConfig["onDuplicateDetected"];

  /** Recovery hook passthrough */
  onCostOverrun?: PaidToolConfig["onCostOverrun"];

  /** Timeout recovery hook passthrough */
  onToolTimeout?: PaidToolConfig["onToolTimeout"];
}

// ─── MCP Adapter ───────────────────────────────────────────

export class McpAdapter {
  private gate: ToolGate;
  private config: Required<McpAdapterConfig>;
  private registrations: McpToolRegistration[] = [];

  constructor(gate: ToolGate, config?: McpAdapterConfig) {
    this.gate = gate;
    this.config = {
      getCallerId: config?.getCallerId ?? defaultGetCallerId,
      defaultCallerId: config?.defaultCallerId ?? "anonymous",
      includeMeta: config?.includeMeta ?? true,
    };
  }

  /**
   * Create a paid MCP tool. Returns a registration object that can be
   * used with server.tool() or registered automatically via .register().
   */
  paidTool(name: string, config: McpPaidToolConfig): McpToolRegistration {
    // Create the underlying ToolGate paid tool
    const gateTool = this.gate.paidTool({
      name,
      description: config.description,
      price: config.price,
      tiers: config.tiers,
      onPaymentFailed:
        config.onPaymentFailed ?? (config.fallback ? "fallback" : "block"),

      // Wrap MCP handler to match ToolGate's (input, ctx) signature
      handler: async (input) => {
        const args = input as Record<string, unknown>;
        return await config.handler(args);
      },

      // Wrap fallback
      fallback: config.fallback
        ? async (input) => {
            const args = input as Record<string, unknown>;
            return await config.fallback!(args);
          }
        : undefined,

      // Pass through lifecycle hooks
      beforeExecute: config.beforeExecute,
      afterExecute: config.afterExecute,
      onFail: config.onFail,
      onPaymentFail: config.onPaymentFail,
      meter: config.meter,
      policy: config.policy,
      estimate: config.estimate,
      onFallback: config.onFallback,
      idempotencyKey: config.idempotencyKey,
      onDuplicate: config.onDuplicate,
      onDuplicateDetected: config.onDuplicateDetected,
      onCostOverrun: config.onCostOverrun,
      onToolTimeout: config.onToolTimeout,
    });

    // Build the MCP handler that wraps ToolGate execution
    const mcpHandler = async (
      args: Record<string, unknown>,
      extra: McpCallExtra,
    ): Promise<McpToolResult> => {
      const callerId = this.config.getCallerId(args, extra);
      const idempotencyKey = resolveMcpIdempotencyKey(name, config, args, callerId);
      const expectedAmount = await resolveExpectedAmount(config, args);
      const existingRecord = await this.gate.idempotency.get(idempotencyKey);

      // Extract payment proof from _meta, verify, credit, then settle after execution
      const meta = extra._meta;
      let railAdapter: RailAdapter | undefined;
      let railProof: PaymentProof | undefined;
      let verificationContext: VerificationContext | undefined;
      let providerPatch: Record<string, unknown> | undefined;
      let traceChallengeId: string | undefined;
      let traceReceiptId: string | undefined;
      let verifiedAmount = 0;

      if (meta && !existingRecord) {
        let proof: PaymentProof | undefined;
        const mppCredential = meta["org.paymentauth/credential"];
        if (mppCredential) {
          proof = { rail: "mpp", mppPaymentHeader: String(mppCredential) };
          traceChallengeId = getString(
            meta["toolgate.mppChallengeId"] ??
              (meta.toolgate as Record<string, unknown> | undefined)?.mppChallengeId,
          );
        } else {
          const tgMeta = meta.toolgate as Record<string, unknown> | undefined;
          if (tgMeta?.x402Payment) {
            const actionId = tgMeta.x402ActionId as string | undefined;
            proof = {
              rail: "x402",
              x402PaymentPayload: tgMeta.x402Payment as Record<string, unknown>,
            };
            verificationContext = {
              actionId,
              expectedAmount,
              currency: "usd",
              toolName: name,
              callerId,
            };
            traceChallengeId = actionId;
          }
        }
        if (proof?.rail === "mpp") {
          verificationContext = {
            expectedAmount,
            currency: "usd",
            toolName: name,
            callerId,
          };
        }
        if (proof) {
          const adapter = this.gate.getRailAdapter(proof.rail);
          if (adapter) {
            const verification: VerificationResult | null =
              (await adapter.verifyPayment?.(proof, verificationContext)) ??
              null;
            if (verification?.verified) {
              await this.gate.ledger.credit(callerId, verification.amount, {
                source: proof.rail,
                reference:
                  verification.receiptId ?? `rail_${Date.now().toString(36)}`,
              });
              railAdapter = adapter;
              railProof = proof;
              verifiedAmount = verification.amount;
              traceReceiptId = verification.receiptId;
              providerPatch = {
                name: proof.rail === "mpp" ? "mppx" : "x402-facilitator",
                correlationId:
                  getString(
                    (meta.toolgate as Record<string, unknown> | undefined)?.providerId,
                  ) ?? verification.receiptId,
              };
            }
          }
        }
      }

      const result: ToolCallResult = await gateTool(args, callerId);
      await this.annotateTrace(idempotencyKey, {
        rail: railProof?.rail,
        challengeId: traceChallengeId,
        receiptId: traceReceiptId,
        provider: providerPatch,
        event:
          railProof && traceReceiptId
            ? {
                event: "rail_payment_verified",
                detail: railProof.rail,
                metadata: {
                  challengeId: traceChallengeId,
                  receiptId: traceReceiptId,
                },
              }
            : undefined,
      });

      if (railProof && verifiedAmount > 0 && (!result.success || result.isFallback)) {
        await this.gate.ledger.deduct(callerId, verifiedAmount, {
          callId: result.receipt?.callId ?? idempotencyKey,
          tool: name,
          amount: verifiedAmount,
        });
        await this.annotateTrace(idempotencyKey, {
          event: {
            event: "rail_credit_reversed",
            detail: railProof.rail,
            metadata: { amount: verifiedAmount },
          },
        });
      }

      // Settle on-chain after successful execution
      if (result.success && railAdapter?.settlePayment && railProof) {
        const settlement = await railAdapter
          .settlePayment(railProof, verificationContext)
          .catch(() => null);

        if (settlement) {
          await this.annotateTrace(idempotencyKey, {
            receiptId: settlement.receiptId,
            provider: {
              ...(providerPatch ?? {}),
              traceId: settlement.txHash,
            },
            event: {
              event: "rail_payment_settled",
              detail: settlement.rail,
              metadata: {
                receiptId: settlement.receiptId,
                txHash: settlement.txHash,
              },
            },
          });
        } else if (railProof.rail === "x402") {
          await this.annotateTrace(idempotencyKey, {
            failureClass: "settlement_uncertain",
            event: {
              event: "settlement_uncertain",
              detail: "x402 facilitator did not confirm settlement",
            },
          });
        }
      } else if (railProof && (!result.success || result.isFallback)) {
        await this.annotateTrace(idempotencyKey, {
          event: {
            event: "rail_settlement_skipped",
            detail: railProof.rail,
          },
        });
      }

      return this.formatMcpResult(result, name);
    };

    const registration: McpToolRegistration = {
      name,
      description: this.buildDescription(name, config),
      inputSchema: config.inputSchema,
      handler: mcpHandler,
    };

    this.registrations.push(registration);
    return registration;
  }

  /**
   * Register all paid tools with an MCP server instance.
   * Works with @modelcontextprotocol/sdk McpServer.
   */
  registerAll(server: McpServerLike): void {
    for (const reg of this.registrations) {
      server.tool(
        reg.name,
        Object.fromEntries(
          Object.entries(reg.inputSchema.properties).map(([k, v]) => [k, v]),
        ),
        reg.handler,
      );
    }
  }

  /**
   * Get all registrations (for manual server setup or testing).
   */
  getRegistrations(): McpToolRegistration[] {
    return [...this.registrations];
  }

  /**
   * Get the underlying ToolGate instance (for balance management etc).
   */
  getGate(): ToolGate {
    return this.gate;
  }

  // ─── Internal: Format ToolCallResult → McpToolResult ───

  private formatMcpResult(
    result: ToolCallResult,
    toolName: string,
  ): McpToolResult {
    // ── Cost Estimate (policy "estimate" decision) ──────────
    if (
      result.success &&
      result.output !== null &&
      result.output !== undefined &&
      typeof result.output === "object" &&
      !Array.isArray(result.output) &&
      (result.output as Record<string, unknown>).type === "cost_estimate"
    ) {
      const est = result.output as Record<string, unknown>;
      return {
        content: [
          {
            type: "text",
            text: `Cost estimate for "${toolName}": $${Number(est.estimatedPrice).toFixed(4)} ${String(est.currency ?? "usd").toUpperCase()}${est.reason ? `\n${est.reason}` : ""}`,
          },
        ],
        isError: false,
        _meta: this.config.includeMeta
          ? { toolgate: { costEstimate: est } }
          : undefined,
      };
    }
    // ── Success ──────────────────────────────────────────
    if (result.success) {
      const content = serializeOutput(result.output);
      const mcpResult: McpToolResult = {
        content,
        isError: false,
      };

      if (this.config.includeMeta) {
        mcpResult._meta = {
          toolgate: {
            paid: !!result.receipt,
            isFallback: result.isFallback ?? false,
            receipt: result.receipt ?? null,
            metrics: result.metrics
              ? {
                  durationMs: result.metrics.durationMs,
                }
              : null,
          },
        };
      }

      // Add fallback notice to output
      if (result.isFallback) {
        content.push({
          type: "text",
          text: "\n---\n⚡ This is a basic result. Top up your balance for the full premium version.",
        });
      }

      return mcpResult;
    }

    // ── Payment Required (402) ───────────────────────────
    if (result.paymentRequired) {
      const pr = result.paymentRequired;
      return {
        content: [
          {
            type: "text",
            text: [
              `⚠️ Payment required to use "${toolName}".`,
              ``,
              `Amount: $${pr.amount.toFixed(4)} ${pr.currency.toUpperCase()}`,
              `Accepted payment methods: ${pr.acceptedRails.join(", ")}`,
              pr.topUpUrl ? `\nTop up balance: ${pr.topUpUrl}` : "",
              ``,
              `To continue, add funds to your Toolgate balance and retry.`,
            ].join("\n"),
          },
        ],
        isError: true,
        _meta: this.config.includeMeta
          ? (() => {
              const mcpMeta: Record<string, unknown> = {
                toolgate: {
                  paymentRequired: true,
                  amount: pr.amount,
                  currency: pr.currency,
                  acceptedRails: pr.acceptedRails,
                  topUpUrl: pr.topUpUrl ?? null,
                },
              };
              if (
                pr.settlements?.some((s) => s.rail === "mpp" && s.mppChallenge)
              ) {
                const mppSettlement = pr.settlements.find(
                  (s) => s.rail === "mpp",
                )!;
                mcpMeta["org.paymentauth/challenges"] =
                  mppSettlement.mppChallenge!.challenges;
                (mcpMeta.toolgate as Record<string, unknown>).mppChallengeId =
                  mppSettlement.mppChallenge!.challenges[0]?.id ?? null;
              }
              if (
                pr.settlements?.some(
                  (s) => s.rail === "x402" && s.x402PaymentRequired,
                )
              ) {
                const x402Settlement = pr.settlements.find(
                  (s) => s.rail === "x402",
                )!;
                mcpMeta["x402"] = x402Settlement.x402PaymentRequired;
                if (x402Settlement.actionId) {
                  (mcpMeta.toolgate as Record<string, unknown>).x402ActionId =
                    x402Settlement.actionId;
                }
              }
              return mcpMeta;
            })()
          : undefined,
      };
    }

    // ── Execution Error ──────────────────────────────────
    return {
      content: [
        {
          type: "text",
          text: `Error executing "${toolName}": ${
            typeof result.output === "object" &&
            result.output !== null &&
            "error" in result.output
              ? (result.output as Record<string, unknown>).error
              : "Unknown error"
          }`,
        },
      ],
      isError: true,
      _meta: this.config.includeMeta
        ? {
            toolgate: {
              error: true,
              metrics: result.metrics
                ? { durationMs: result.metrics.durationMs }
                : null,
            },
          }
        : undefined,
    };
  }

  // ─── Internal: Build enriched description ──────────────

  private buildDescription(name: string, config: McpPaidToolConfig): string {
    const parts = [config.description];

    // Add pricing info to description so agents can see it
    if (config.tiers) {
      const free = config.tiers.free;
      if (free) {
        parts.push(
          `[Pricing: ${free.limit} free calls per ${free.period}, then paid]`,
        );
      }
    } else if (config.price !== undefined) {
      if (typeof config.price === "number") {
        parts.push(`[Pricing: $${config.price}/call]`);
      } else if (config.price === "postpaid") {
        parts.push(`[Pricing: usage-based metering]`);
      } else {
        parts.push(`[Pricing: dynamic per-call]`);
      }
    }

    if (config.fallback || config.onPaymentFailed === "fallback") {
      parts.push(`[Has free basic mode]`);
    }

    return parts.join(" ");
  }

  private async annotateTrace(
    idempotencyKey: string,
    patch: {
      rail?: PaymentProof["rail"];
      challengeId?: string;
      receiptId?: string;
      provider?: Record<string, unknown>;
      failureClass?: PaidToolConfig["onPaymentFail"] extends never
        ? never
        : "settlement_uncertain";
      event?: {
        event: string;
        detail?: string;
        metadata?: Record<string, unknown>;
      };
    },
  ): Promise<void> {
    const trace = await this.gate.traces.findByIdempotencyKey(idempotencyKey);
    if (!trace) return;

    if (patch.rail) {
      trace.rail = patch.rail;
    }
    if (patch.challengeId) {
      trace.challengeId = patch.challengeId;
    }
    if (patch.receiptId) {
      trace.receiptId = patch.receiptId;
    }
    if (patch.failureClass) {
      trace.failureClass = patch.failureClass;
    }
    if (patch.provider) {
      trace.provider = {
        ...(trace.provider ?? {}),
        ...patch.provider,
      };
    }
    if (patch.event) {
      trace.events.push({
        timestamp: Date.now(),
        event: patch.event.event,
        detail: patch.event.detail,
        metadata: patch.event.metadata,
      });
    }
    trace.updatedAt = Date.now();
    await this.gate.traces.save(trace);
  }
}

// ─── Helpers ─────────────────────────────────────────────

function defaultGetCallerId(
  _args: Record<string, unknown>,
  extra: McpCallExtra,
): string {
  return extra.sessionId ?? "anonymous";
}

function resolveMcpIdempotencyKey(
  name: string,
  config: McpPaidToolConfig,
  args: Record<string, unknown>,
  callerId: string,
): string {
  if (typeof config.idempotencyKey === "string") {
    return config.idempotencyKey;
  }
  if (typeof config.idempotencyKey === "function") {
    return config.idempotencyKey(args, callerId);
  }
  return `auto_${name}_${callerId}_${hashSync(args)}`;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hashSync(input: unknown): string {
  const str = JSON.stringify(input) ?? "";
  let hash = 5381;
  for (let index = 0; index < str.length; index++) {
    hash = (((hash << 5) + hash) ^ str.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

async function resolveExpectedAmount(
  config: McpPaidToolConfig,
  args: Record<string, unknown>,
): Promise<number> {
  if (typeof config.price === "number") {
    return config.price;
  }
  if (typeof config.price === "function") {
    return await config.price(args);
  }
  return 0;
}

function serializeOutput(output: unknown): McpToolResult["content"] {
  if (output === null || output === undefined) {
    return [{ type: "text", text: "No output." }];
  }

  if (typeof output === "string") {
    return [{ type: "text", text: output }];
  }

  if (typeof output === "object") {
    return [
      {
        type: "text",
        text: JSON.stringify(output, null, 2),
      },
    ];
  }

  return [{ type: "text", text: String(output) }];
}

// ─── Factory Function ──────────────────────────────────────

/**
 * Create an MCP adapter for a ToolGate instance.
 *
 * @example
 * ```ts
 * const gate = new ToolGate({ publisherKey: "tg_pub_xxx" });
 * const mcp = createMcpAdapter(gate);
 *
 * const search = mcp.paidTool("premium_search", {
 *   description: "Premium web search with AI analysis",
 *   inputSchema: {
 *     type: "object",
 *     properties: { query: { type: "string", description: "Search query" } },
 *     required: ["query"],
 *   },
 *   price: 0.05,
 *   handler: async ({ query }) => ({ results: [`Result for ${query}`] }),
 * });
 *
 * // Option A: Register with MCP server
 * mcp.registerAll(server);
 *
 * // Option B: Manual registration
 * server.tool(search.name, search.inputSchema, search.handler);
 * ```
 */
export function createMcpAdapter(
  gate: ToolGate,
  config?: McpAdapterConfig,
): McpAdapter {
  return new McpAdapter(gate, config);
}
