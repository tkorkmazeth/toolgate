import type {
  ToolGateConfig,
  PaidToolConfig,
  ToolCallResult,
  ExecutionContext,
  ExecutionMetrics,
  PaymentRequiredResponse,
  PaymentRail,
  LedgerAdapter,
  PriceSpec,
  ToolHandler,
  PolicyContext,
  RailAdapter,
  SettlementAction,
  PaymentMode,
  ExecutionTrace,
  IdempotencyRecord,
  IdempotencyStore,
  TraceStore,
  RecoveryAction,
} from "./types.js";
import {
  type Money,
  usd,
  toNumber,
  toDecimalString,
  isZero,
  resolvePriceInput,
} from "./money.js";
import { determineRecovery, getCapabilities } from "./recovery.js";
import { InMemoryLedger } from "./ledger.js";
import { InMemoryIdempotencyStore } from "./idempotency.js";
import { InMemoryTraceStore } from "./trace-store.js";
import { randomUUID } from "node:crypto";

// ─── ToolGate Core ─────────────────────────────────────────

export class ToolGate {
  private config: Required<
    Pick<
      ToolGateConfig,
      "publisherKey" | "defaultCurrency" | "paymentRails" | "topUpBaseUrl"
    >
  > & {
    ledger: LedgerAdapter;
    hooks: ToolGateConfig["hooks"];
    railAdapters: RailAdapter[];
    paymentMode: PaymentMode;
    idempotencyStore: IdempotencyStore;
    traceStore: TraceStore;
    idempotencyTtlSeconds: number;
  };

  private tools = new Map<string, PaidToolConfig>();

  constructor(config: ToolGateConfig) {
    this.config = {
      publisherKey: config.publisherKey,
      defaultCurrency: config.defaultCurrency ?? "usd",
      paymentRails: config.paymentRails ?? ["stripe"],
      topUpBaseUrl:
        config.topUpBaseUrl ??
        "https://toolgate-api.talha-korkmazeth.workers.dev/pay",
      ledger: config.ledger ?? new InMemoryLedger(),
      hooks: config.hooks,
      railAdapters: config.railAdapters ?? [],
      paymentMode: config.paymentMode ?? "hybrid",
      idempotencyStore:
        config.idempotencyStore ?? new InMemoryIdempotencyStore(),
      traceStore: config.traceStore ?? new InMemoryTraceStore(),
      idempotencyTtlSeconds: config.idempotencyTtlSeconds ?? 3600,
    };
  }

  /**
   * Register a paid tool. Returns a callable function that handles
   * the full lifecycle: pricing → payment → execution → metering.
   */
  paidTool(toolConfig: PaidToolConfig) {
    this.tools.set(toolConfig.name, toolConfig);

    // Return the callable tool function
    const execute = (input: unknown, callerId: string) =>
      this.executeTool(toolConfig, input, callerId);

    // Attach metadata for MCP registration
    execute.toolName = toolConfig.name;
    execute.description = toolConfig.description;
    execute.getPrice = () => toolConfig.price;
    execute.config = toolConfig;

    return execute;
  }

  /**
   * Alias for paidTool(). Same engine, same config.
   * Use paidAction() to reflect that Toolgate handles any paid action,
   * not just MCP tools.
   */
  paidAction(toolConfig: PaidToolConfig) {
    return this.paidTool(toolConfig);
  }

  /** Get the ledger (useful for crediting balances externally) */
  get ledger(): LedgerAdapter {
    return this.config.ledger;
  }

  /** Get the ledger as a method (alias for .ledger getter) */
  getLedger(): LedgerAdapter {
    return this.config.ledger;
  }

  /** Get a specific rail adapter by rail name */
  getRailAdapter(rail: PaymentRail): RailAdapter | undefined {
    return this.config.railAdapters?.find((a) => a.rail === rail);
  }

  /** Access the trace store (for querying execution history) */
  get traces(): TraceStore {
    return this.config.traceStore;
  }

  /** Access the idempotency store */
  get idempotency(): IdempotencyStore {
    return this.config.idempotencyStore;
  }

  /** List all registered tools with pricing info */
  listTools(): Array<{ name: string; description?: string; price: string }> {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      price: describePricing(t),
    }));
  }

  // ─── Core Execution Engine ─────────────────────────────

  private async executeTool(
    tool: PaidToolConfig,
    input: unknown,
    callerId: string,
  ): Promise<ToolCallResult> {
    const callId = generateCallId();
    const now = Date.now();

    // ── Step 0: Atomic idempotency claim ──────────────────
    const idempotencyKey = this.resolveIdempotencyKey(tool, input, callerId);
    const inputHash = hashSync(input);
    const ownerId = randomUUID();
    const leaseMs = 30_000; // 30-second default lease

    const claimResult = await this.config.idempotencyStore.claim({
      key: idempotencyKey,
      ownerId,
      leaseMs,
      traceId: callId,
    });

    if (claimResult.status === "completed") {
      // Idempotent replay — return cached result without re-executing
      return this.handleDuplicate(
        tool,
        input,
        callerId,
        claimResult.record,
        idempotencyKey,
        "return_previous_result",
      );
    }

    if (claimResult.status === "in_progress") {
      // Another execution is actively running — block concurrent request
      return {
        success: false,
        output: {
          error:
            "Duplicate request: a previous execution is still in progress.",
          idempotencyKey,
        },
      };
    }
    // status === "claimed" or "failed" → we own it, proceed to execute

    // ── Initialize trace ──────────────────────────────────
    const trace: ExecutionTrace = {
      traceId: callId,
      idempotencyKey,
      callerId,
      toolName: tool.name,
      inputHash,
      currency: this.config.defaultCurrency,
      decision: "execute",
      handlerStatus: "not_started",
      fallbackUsed: false,
      chargeStatus: "none",
      createdAt: now,
      updatedAt: now,
      events: [{ timestamp: now, event: "trace_created" }],
    };

    // Helper to finalize trace + idempotency record before returning
    const finalize = async (
      result: ToolCallResult,
      traceUpdates: Partial<ExecutionTrace> = {},
      succeeded = result.success,
    ): Promise<ToolCallResult> => {
      const finalNow = Date.now();
      Object.assign(trace, traceUpdates, { updatedAt: finalNow });
      trace.events.push({ timestamp: finalNow, event: "call_completed" });
      await this.config.traceStore.save(trace);

      if (succeeded) {
        await this.config.idempotencyStore.complete(
          idempotencyKey,
          ownerId,
          result,
        );
      } else {
        await this.config.idempotencyStore.fail(idempotencyKey, ownerId, {
          message:
            (result.output as { error?: string } | undefined)?.error ??
            "execution_failed",
        });
      }
      return result;
    };

    // ── Existing execution logic (unchanged behavior) ─────
    const ledger = this.config.ledger;

    // Notify global hook
    this.config.hooks?.onCall?.(tool.name, callerId);

    // ── Step 1: Determine tier and price ──────────────────

    let tier: "free" | "premium" = "premium";
    let price: Money = usd("0.00");
    let handler: ToolHandler = tool.handler;

    if (tool.tiers) {
      // Check if caller qualifies for free tier
      if (tool.tiers.free) {
        const usage = await ledger.getUsage(
          callerId,
          tool.name,
          tool.tiers.free.period,
        );
        if (usage < tool.tiers.free.limit) {
          tier = "free";
          price = usd("0.00");
          handler = tool.tiers.free.handler ?? tool.handler;
        } else {
          tier = "premium";
          price = await resolvePriceInput(
            tool.tiers.premium.price as PriceSpec,
            input,
          );
          handler = tool.tiers.premium.handler ?? tool.handler;
        }
      }
    } else if (tool.price !== undefined && tool.price !== "postpaid") {
      price = await resolvePriceInput(tool.price, input);
    }
    // postpaid: price determined after execution via meter()

    trace.estimatedAmount = price;
    trace.events.push({
      timestamp: Date.now(),
      event: "price_resolved",
      detail: toDecimalString(price),
    });

    // ── Step 2: Build execution context ───────────────────

    const balanceMoney = await ledger.getBalance(callerId);
    const ctx: ExecutionContext = {
      callerId,
      callId,
      tool: tool.name,
      tier,
      balance: toNumber(balanceMoney), // number for backward compat in policy fns
      timestamp: Date.now(),
    };

    // ── Step 2.5: Policy evaluation ───────────────────────────

    let skipPaymentGate = false;
    if (tool.policy) {
      const isPostpaidForPolicy = tool.price === "postpaid";
      const estimatedPrice = isPostpaidForPolicy ? 0 : toNumber(price);
      const usageToday = await ledger.getUsage(callerId, tool.name, "day");
      const policyCtx: PolicyContext = {
        callerId,
        tier,
        balance: ctx.balance,
        estimatedPrice,
        input,
        tool: tool.name,
        usageToday,
      };

      const decision = await tool.policy.decide(policyCtx);
      trace.events.push({
        timestamp: Date.now(),
        event: "policy_decided",
        detail: decision,
      });

      if (decision === "fallback") {
        if (tool.onFallback) await tool.onFallback(input, "fallback", ctx);
        if (tool.fallback) {
          const fallbackOutput = await tool.fallback(input, ctx);
          return finalize(
            { success: true, output: fallbackOutput, isFallback: true },
            {
              decision: "fallback_response",
              handlerStatus: "not_started",
              fallbackUsed: true,
              chargeStatus: "none",
            },
          );
        }
        // Policy returned fallback but no fallback handler — warn and return 402
        this.config.hooks?.onError?.(
          tool.name,
          new Error(
            `Policy returned "fallback" for tool "${tool.name}" but no fallback handler is defined. ` +
              `Add a fallback handler or change the policy decision.`,
          ),
        );
        const failureResult = await this.handlePaymentFailure(
          tool,
          input,
          ctx,
          price,
          callerId,
        );
        return finalize(failureResult, {
          decision: "topup_required",
          handlerStatus: "not_started",
          chargeStatus: "none",
        });
      }

      if (decision === "payment_required") {
        const failureResult = await this.handlePaymentFailure(
          tool,
          input,
          ctx,
          price,
          callerId,
        );
        return finalize(failureResult, {
          decision: "topup_required",
          handlerStatus: "not_started",
          chargeStatus: "none",
        });
      }

      if (decision === "allow_once") {
        skipPaymentGate = true;
      }

      if (decision === "estimate") {
        const estimateCtx: Omit<PolicyContext, "estimatedPrice"> = {
          callerId,
          tier,
          balance: ctx.balance,
          input,
          tool: tool.name,
          usageToday,
        };
        const costEstimate = tool.estimate
          ? await tool.estimate(input, estimateCtx)
          : { estimatedPrice: price, currency: this.config.defaultCurrency };
        const estimateResult = {
          success: true,
          output: { type: "cost_estimate", ...costEstimate },
          isFallback: false,
        };
        return finalize(estimateResult, {
          decision: "execute",
          handlerStatus: "not_started",
          chargeStatus: "none",
        });
      }
      // "execute" or default → continue with normal payment gate
    }

    // ── Step 3: Payment gate ────────────────────────────

    const isPostpaid = tool.price === "postpaid";
    const needsPayment =
      tier === "premium" && !isZero(price) && !isPostpaid && !skipPaymentGate;

    if (needsPayment) {
      const deductResult = await ledger.deduct(callerId, price, {
        callId,
        tool: tool.name,
        amount: price,
      });

      if (!deductResult.success) {
        // Insufficient balance — handle based on policy
        const failureResult = await this.handlePaymentFailure(
          tool,
          input,
          ctx,
          price,
          callerId,
        );
        const isFallbackResult =
          failureResult.success && failureResult.isFallback;
        return finalize(failureResult, {
          decision: isFallbackResult ? "fallback_response" : "topup_required",
          handlerStatus: "not_started",
          fallbackUsed: isFallbackResult,
          chargeStatus: "none",
          failureClass: "insufficient_balance",
        });
      }

      // Payment hook
      this.config.hooks?.onPayment?.(tool.name, callerId, toNumber(price));
      trace.chargeStatus = "charged";
      trace.rail = "prepaid";
      trace.events.push({
        timestamp: Date.now(),
        event: "payment_deducted",
        detail: toDecimalString(price),
      });
    }

    // ── Step 4: beforeExecute hook ────────────────────────

    if (tool.beforeExecute) {
      const proceed = await tool.beforeExecute(input, ctx);
      if (!proceed) {
        // Refund if we already deducted
        if (needsPayment) {
          await ledger.credit(callerId, price, {
            source: "manual",
            reference: `refund:${callId}:aborted`,
          });
        }
        const abortResult = {
          success: false,
          output: { error: "Execution aborted by beforeExecute hook" },
        };
        return finalize(abortResult, {
          handlerStatus: "failed",
          chargeStatus: needsPayment ? "refunded" : "none",
          decision: "no_charge",
        });
      }
    }

    // ── Step 5: Execute handler ───────────────────────────

    const startedAt = Date.now();
    let output: unknown;
    let metrics: ExecutionMetrics;

    trace.handlerStatus = "not_started";
    trace.events.push({ timestamp: startedAt, event: "handler_started" });

    try {
      output = await handler(input, ctx);
      const endedAt = Date.now();
      metrics = { durationMs: endedAt - startedAt, startedAt, endedAt };
      trace.events.push({
        timestamp: endedAt,
        event: "handler_success",
        detail: `${metrics.durationMs}ms`,
      });
    } catch (error) {
      const endedAt = Date.now();
      metrics = { durationMs: endedAt - startedAt, startedAt, endedAt };

      // Refund on execution failure — rail-aware recovery
      const railName = trace.rail ?? "prepaid";
      const capabilities = getCapabilities(railName);
      const recovery = determineRecovery(capabilities, true, needsPayment);

      if (needsPayment) {
        await ledger.credit(callerId, price, {
          source: "manual",
          reference: `refund:${callId}:error`,
        });
        trace.events.push({
          timestamp: Date.now(),
          event: "recovery_initiated",
          detail: recovery.recoveryAction,
        });
        trace.events.push({
          timestamp: Date.now(),
          event: "recovery_completed",
          detail: toDecimalString(price),
        });
      }

      // onFail hook
      if (tool.onFail) {
        await tool.onFail(input, error as Error, ctx);
      }
      this.config.hooks?.onError?.(tool.name, error as Error);

      const errorResult = {
        success: false,
        output: { error: (error as Error).message },
        metrics,
      };
      return finalize(errorResult, {
        handlerStatus: "failed",
        durationMs: metrics.durationMs,
        chargeStatus: needsPayment
          ? (recovery.chargeOutcome as ExecutionTrace["chargeStatus"])
          : "none",
        recoveryAction: recovery.recoveryAction,
        decision: recovery.recoveryAction,
        failureClass: "tool_failed",
        refundReason: (error as Error).message,
      });
    }

    // ── Step 5b: Track usage for free tier calls ───────────

    if (tier === "free" && tool.tiers?.free) {
      await ledger.incrementUsage(callerId, tool.name, tool.tiers.free.period);
    }

    // ── Step 6: Post-execution metering (postpaid) ────────

    if (isPostpaid && tool.meter) {
      const meterResult = await tool.meter(input, output, metrics!);
      price = usd(meterResult.amount);

      const postpaidDeduct = await ledger.deduct(callerId, price, {
        callId,
        tool: tool.name,
        amount: price,
      });

      if (postpaidDeduct.success) {
        this.config.hooks?.onPayment?.(tool.name, callerId, toNumber(price));
        trace.chargeStatus = "charged";
        trace.rail = "prepaid";
        trace.events.push({
          timestamp: Date.now(),
          event: "postpaid_metered",
          detail: toDecimalString(price),
        });
      }
    }

    // ── Step 7: afterExecute hook ─────────────────────────

    if (tool.afterExecute) {
      await tool.afterExecute(input, output, metrics!);
    }

    // ── Step 8: Build receipt ─────────────────────────────

    const balanceAfterMoney = await ledger.getBalance(callerId);

    const successResult: ToolCallResult = {
      success: true,
      output,
      receipt: !isZero(price)
        ? {
            callId,
            tool: tool.name,
            amount: toNumber(price),
            currency: this.config.defaultCurrency,
            rail: "prepaid",
            balanceAfter: toNumber(balanceAfterMoney),
            timestamp: Date.now(),
          }
        : undefined,
      metrics: metrics!,
      isFallback: false,
    };

    return finalize(successResult, {
      handlerStatus: "success",
      durationMs: metrics!.durationMs,
      finalAmount: price,
      decision: skipPaymentGate ? "allow_once" : "execute",
      chargeStatus: !isZero(price) && needsPayment ? "charged" : "none",
    });
  }

  // ─── Payment Failure Handling ──────────────────────────

  private async handlePaymentFailure(
    tool: PaidToolConfig,
    input: unknown,
    ctx: ExecutionContext,
    requiredAmount: Money,
    callerId: string,
  ): Promise<ToolCallResult> {
    const policy = tool.onPaymentFailed ?? "block";

    // Fire payment fail hook
    if (tool.onPaymentFail) {
      await tool.onPaymentFail(input, {
        code: "insufficient_balance",
        balance: ctx.balance,
        required: toNumber(requiredAmount),
      });
    }

    // ── Fallback: return degraded response ────────────────
    if (policy === "fallback" && tool.fallback) {
      if (tool.onFallback)
        await tool.onFallback(input, "insufficient_balance", ctx);
      const fallbackOutput = await tool.fallback(input, ctx);
      return {
        success: true,
        output: fallbackOutput,
        isFallback: true,
      };
    }

    // ── Allow once: execute without payment (grace) ───────
    if (policy === "allow_once") {
      const startedAt = Date.now();
      const output = await tool.handler(input, ctx);
      const endedAt = Date.now();
      return {
        success: true,
        output,
        metrics: { durationMs: endedAt - startedAt, startedAt, endedAt },
        isFallback: false,
      };
    }

    // ── Block (default): return 402 ───────────────────────
    const requiredNum = toNumber(requiredAmount);
    const paymentRequired: PaymentRequiredResponse = {
      status: 402,
      error: "payment_required",
      tool: tool.name,
      amount: requiredNum,
      currency: this.config.defaultCurrency,
      acceptedRails: this.config.paymentRails,
      topUpUrl: `${this.config.topUpBaseUrl}?publisher=${this.config.publisherKey}&caller=${encodeURIComponent(callerId)}&amount=${requiredNum}`,
    };

    // ── Rail adapters: fan-out settlement creation ────
    if (this.config.railAdapters.length > 0) {
      const results = await Promise.allSettled(
        this.config.railAdapters.map((adapter) =>
          adapter.createChallenge({
            callerId,
            amount: requiredNum,
            currency: this.config.defaultCurrency,
            toolName: tool.name,
            publisherKey: this.config.publisherKey,
          }),
        ),
      );

      const settlements: SettlementAction[] = [];
      for (const result of results) {
        if (result.status === "fulfilled") {
          settlements.push(result.value);
          // Backward compat: populate x402Challenge if x402 adapter present
          if (result.value.x402PaymentRequired) {
            paymentRequired.x402Challenge = result.value.x402PaymentRequired;
          }
        }
      }
      if (settlements.length > 0) {
        paymentRequired.settlements = settlements;
      }
    }

    return {
      success: false,
      paymentRequired,
    };
  }

  // ─── Idempotency Helpers ──────────────────────────────

  private resolveIdempotencyKey(
    tool: PaidToolConfig,
    input: unknown,
    callerId: string,
  ): string {
    if (typeof tool.idempotencyKey === "string") {
      return tool.idempotencyKey;
    }
    if (typeof tool.idempotencyKey === "function") {
      return tool.idempotencyKey(input, callerId);
    }
    return `auto_${tool.name}_${callerId}_${hashSync(input)}`;
  }

  private async handleDuplicate(
    tool: PaidToolConfig,
    input: unknown,
    callerId: string,
    record: IdempotencyRecord,
    key: string,
    _policy?: string,
  ): Promise<ToolCallResult> {
    const duplicatePolicy = tool.onDuplicate ?? "return_previous_result";

    // Fire duplicate detected hook
    if (tool.onDuplicateDetected) {
      const balanceMoney = await this.config.ledger.getBalance(callerId);
      const ctx: ExecutionContext = {
        callerId,
        callId: record.traceId,
        tool: tool.name,
        tier: "premium",
        balance: toNumber(balanceMoney),
        timestamp: Date.now(),
      };
      await tool.onDuplicateDetected(input, record, ctx);
    }

    if (duplicatePolicy === "return_previous_result") {
      if (record.result) {
        return record.result as ToolCallResult;
      }
      // Record exists but no result yet (in_progress)
      return {
        success: false,
        output: {
          error:
            "Duplicate request: a previous execution is still in progress.",
          idempotencyKey: key,
        },
      };
    }

    if (duplicatePolicy === "block") {
      return {
        success: false,
        output: {
          error: "Duplicate request detected. Request rejected.",
          idempotencyKey: key,
        },
      };
    }

    // "re_execute": execute fresh (claim will have already reclaimed the key)
    return this.executeTool(tool, input, callerId);
  }
}

// ─── Helpers ─────────────────────────────────────────────

function describePricing(tool: PaidToolConfig): string {
  if (tool.tiers) {
    const free = tool.tiers.free;
    const prem = tool.tiers.premium.price;
    const premStr = typeof prem === "number" ? `$${prem}` : "dynamic";
    return free
      ? `${free.limit} free/${free.period}, then ${premStr}/call`
      : `${premStr}/call`;
  }
  if (tool.price === "postpaid") return "usage-based (metered)";
  if (typeof tool.price === "number") return `$${tool.price}/call`;
  if (typeof tool.price === "function") return "dynamic pricing";
  if (typeof tool.price === "string") return `$${tool.price}/call`;
  if (
    tool.price &&
    typeof tool.price === "object" &&
    "minorUnits" in tool.price
  )
    return `${toDecimalString(tool.price as import("./money.js").Money)}/call`;
  return "free";
}

function generateCallId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `tg_${ts}_${rand}`;
}

/**
 * djb2 hash for input deduplication. Fast, not cryptographic.
 * Used for duplicate request detection in idempotency keys.
 */
function hashSync(input: unknown): string {
  const str = JSON.stringify(input) ?? "";
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0; // unsigned 32-bit
  }
  return hash.toString(36);
}
