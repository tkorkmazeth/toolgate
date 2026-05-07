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
} from "./types.js";
import { InMemoryLedger } from "./ledger.js";

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

  /** Get the ledger (useful for crediting balances externally) */
  get ledger(): LedgerAdapter {
    return this.config.ledger;
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
    const ledger = this.config.ledger;

    // Notify global hook
    this.config.hooks?.onCall?.(tool.name, callerId);

    // ── Step 1: Determine tier and price ──────────────────

    let tier: "free" | "premium" = "premium";
    let price: number = 0;
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
          price = 0;
          handler = tool.tiers.free.handler ?? tool.handler;
        } else {
          tier = "premium";
          price = await resolvePrice(tool.tiers.premium.price, input);
          handler = tool.tiers.premium.handler ?? tool.handler;
        }
      }
    } else if (tool.price !== undefined && tool.price !== "postpaid") {
      price = await resolvePrice(tool.price, input);
    }
    // postpaid: price determined after execution via meter()

    // ── Step 2: Build execution context ───────────────────

    const ctx: ExecutionContext = {
      callerId,
      callId,
      tool: tool.name,
      tier,
      balance: await ledger.getBalance(callerId),
      timestamp: Date.now(),
    };

    // ── Step 2.5: Policy evaluation ───────────────────────────

    let skipPaymentGate = false;
    if (tool.policy) {
      const isPostpaidForPolicy = tool.price === "postpaid";
      const estimatedPrice = isPostpaidForPolicy ? 0 : price;
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

      if (decision === "fallback") {
        if (tool.onFallback) await tool.onFallback(input, "fallback", ctx);
        if (tool.fallback) {
          const fallbackOutput = await tool.fallback(input, ctx);
          return { success: true, output: fallbackOutput, isFallback: true };
        }
        return await this.handlePaymentFailure(
          tool,
          input,
          ctx,
          price,
          callerId,
        );
      }

      if (decision === "payment_required") {
        return await this.handlePaymentFailure(
          tool,
          input,
          ctx,
          price,
          callerId,
        );
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
        return {
          success: true,
          output: { type: "cost_estimate", ...costEstimate },
          isFallback: false,
        };
      }
      // "execute" or default → continue with normal payment gate
    }

    // ── Step 3: Payment gate ────────────────────────────

    const isPostpaid = tool.price === "postpaid";
    const needsPayment =
      tier === "premium" && price > 0 && !isPostpaid && !skipPaymentGate;

    if (needsPayment) {
      const deducted = await ledger.deduct(callerId, price, {
        callId,
        tool: tool.name,
        amount: price,
      });

      if (!deducted) {
        // Insufficient balance — handle based on policy
        return await this.handlePaymentFailure(
          tool,
          input,
          ctx,
          price,
          callerId,
        );
      }

      // Payment hook
      this.config.hooks?.onPayment?.(tool.name, callerId, price);
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
        return {
          success: false,
          output: { error: "Execution aborted by beforeExecute hook" },
        };
      }
    }

    // ── Step 5: Execute handler ───────────────────────────

    const startedAt = Date.now();
    let output: unknown;
    let metrics: ExecutionMetrics;

    try {
      output = await handler(input, ctx);
      const endedAt = Date.now();
      metrics = { durationMs: endedAt - startedAt, startedAt, endedAt };
    } catch (error) {
      const endedAt = Date.now();
      metrics = { durationMs: endedAt - startedAt, startedAt, endedAt };

      // Refund on execution failure
      if (needsPayment) {
        await ledger.credit(callerId, price, {
          source: "manual",
          reference: `refund:${callId}:error`,
        });
      }

      // onFail hook
      if (tool.onFail) {
        await tool.onFail(input, error as Error, ctx);
      }
      this.config.hooks?.onError?.(tool.name, error as Error);

      return {
        success: false,
        output: { error: (error as Error).message },
        metrics,
      };
    }

    // ── Step 5b: Track usage for free tier calls ───────────

    if (tier === "free" && tool.tiers?.free) {
      await ledger.incrementUsage(callerId, tool.name, tool.tiers.free.period);
    }

    // ── Step 6: Post-execution metering (postpaid) ────────

    if (isPostpaid && tool.meter) {
      const meterResult = await tool.meter(input, output, metrics);
      price = meterResult.amount;

      const deducted = await ledger.deduct(callerId, price, {
        callId,
        tool: tool.name,
        amount: price,
      });

      if (!deducted) {
        // Postpaid but can't pay — still return result but flag it
        // (debatable: could also withhold. MVP: return + flag)
      } else {
        this.config.hooks?.onPayment?.(tool.name, callerId, price);
      }
    }

    // ── Step 7: afterExecute hook ─────────────────────────

    if (tool.afterExecute) {
      await tool.afterExecute(input, output, metrics);
    }

    // ── Step 8: Build receipt ─────────────────────────────

    const balanceAfter = await ledger.getBalance(callerId);

    return {
      success: true,
      output,
      receipt:
        price > 0
          ? {
              callId,
              tool: tool.name,
              amount: price,
              currency: this.config.defaultCurrency,
              rail: "prepaid",
              balanceAfter,
              timestamp: Date.now(),
            }
          : undefined,
      metrics,
      isFallback: false,
    };
  }

  // ─── Payment Failure Handling ──────────────────────────

  private async handlePaymentFailure(
    tool: PaidToolConfig,
    input: unknown,
    ctx: ExecutionContext,
    requiredAmount: number,
    callerId: string,
  ): Promise<ToolCallResult> {
    const policy = tool.onPaymentFailed ?? "block";

    // Fire payment fail hook
    if (tool.onPaymentFail) {
      await tool.onPaymentFail(input, {
        code: "insufficient_balance",
        balance: ctx.balance,
        required: requiredAmount,
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
    const paymentRequired: PaymentRequiredResponse = {
      status: 402,
      error: "payment_required",
      tool: tool.name,
      amount: requiredAmount,
      currency: this.config.defaultCurrency,
      acceptedRails: this.config.paymentRails,
      topUpUrl: `${this.config.topUpBaseUrl}?publisher=${this.config.publisherKey}&caller=${encodeURIComponent(callerId)}&amount=${Math.ceil(requiredAmount * 100)}`,
    };

    // ── Rail adapters: fan-out settlement creation ────────
    if (this.config.railAdapters.length > 0) {
      const results = await Promise.allSettled(
        this.config.railAdapters.map((adapter) =>
          adapter.createChallenge({
            callerId,
            amount: requiredAmount,
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
}

// ─── Helpers ─────────────────────────────────────────────

async function resolvePrice(
  spec: Exclude<PriceSpec, "postpaid">,
  input: unknown,
): Promise<number> {
  if (typeof spec === "number") return spec;
  if (typeof spec === "function") return await spec(input);
  return 0;
}

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
  return "free";
}

function generateCallId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `tg_${ts}_${rand}`;
}
