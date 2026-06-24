import type {
  RailAdapter,
  ChallengeParams,
  SettlementAction,
  PaymentProof,
  VerificationResult,
  VerificationContext,
  SettlementResult,
  X402PaymentRequirement,
  X402Network,
} from "../types.js";

// ─── x402 Rail Config ─────────────────────────────────────

export interface X402RailConfig {
  /** Wallet address to receive payments (0x... for EVM, base58 for Solana) */
  payTo: string;

  /**
   * Network configuration. Typed to distinguish EVM vs Solana.
   *
   * EVM example:
   *   { kind: "evm", caip2: "eip155:8453" }                     // Base mainnet, USDC auto-detected
   *   { kind: "evm", caip2: "eip155:8453", asset: "0x833..." }  // explicit asset
   *
   * Solana example:
   *   { kind: "solana", caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }  // mainnet
   *   { kind: "solana", caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }  // devnet
   */
  network: X402Network;

  /** x402 protocol version. Default: 1. Set to 2 for v2 features (sessions, discovery). */
  x402Version?: 1 | 2;

  /** Payment scheme. Default: "exact" */
  scheme?: string;

  /**
   * Facilitator URL for payment verification and settlement.
   *
   * Known facilitators:
   *   - Coinbase hosted: "https://x402.org/facilitator" (Base, Polygon, Arbitrum, World, Solana)
   *   - xpay: "https://facilitator.xpay.sh" (Base, Base Sepolia only)
   *   - Self-hosted: any URL implementing /verify and /settle
   *
   * REQUIRED. No default — developer must explicitly choose a facilitator.
   */
  facilitatorUrl: string;

  /**
   * Resource URL template for the payment requirement.
   * If not provided, defaults to "tollgate://{publisherKey}/{toolName}".
   */
  resourceUrl?: string;

  /** Max seconds for payment settlement. Default: 300 */
  maxTimeoutSeconds?: number;
}

// ─── Known Asset Addresses ────────────────────────────────

/** USDC contract addresses for EVM networks (ERC-20) */
export const EVM_USDC_ADDRESSES: Record<string, `0x${string}`> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
  "eip155:1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Ethereum mainnet
  "eip155:137": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // Polygon
  "eip155:42161": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Arbitrum
  "eip155:10": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // Optimism
};

/** USDC mint addresses for Solana networks (SPL Token) */
export const SOLANA_USDC_ADDRESSES: Record<string, string> = {
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp":
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // Solana mainnet
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1":
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // Solana devnet
};

// ─── X402 Rail Adapter ────────────────────────────────────

export class X402RailAdapter implements RailAdapter {
  rail = "x402" as const;
  private config: X402RailConfig;

  /**
   * Pending payment requirements — stored after createChallenge(),
   * needed by facilitator /verify and /settle endpoints.
   */
  private pending = new Map<string, X402PaymentRequirement>();
  /**
   * Timer references for pending cleanup — cleared on settlement to avoid
   * firing a delete after the entry has already been removed.
   */
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: X402RailConfig) {
    if (!config.facilitatorUrl) {
      throw new Error(
        "X402RailAdapter requires facilitatorUrl. Known options:\n" +
          '  - Coinbase: "https://x402.org/facilitator"\n' +
          '  - xpay: "https://facilitator.xpay.sh"\n' +
          "  - Or your own self-hosted facilitator",
      );
    }
    this.config = config;
  }

  async createChallenge(params: ChallengeParams): Promise<SettlementAction> {
    const decimals = this.config.network.decimals ?? 6;
    const amountAtomic = String(
      Math.round(params.amount * Math.pow(10, decimals)),
    );
    const timeout = this.config.maxTimeoutSeconds ?? 300;
    const actionId = `x402_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const resource =
      this.config.resourceUrl ??
      `tollgate://${params.publisherKey}/${params.toolName}`;

    const paymentRequirement: X402PaymentRequirement = {
      scheme: this.config.scheme ?? "exact",
      network: this.config.network.caip2,
      maxAmountRequired: amountAtomic,
      resource,
      description: `Payment for ${params.toolName}: $${params.amount.toFixed(4)} ${params.currency.toUpperCase()}`,
      payTo: this.config.payTo,
      asset: this.getAssetAddress(),
      maxTimeoutSeconds: timeout,
      extra: {
        tollgate_caller_id: params.callerId,
        tollgate_tool: params.toolName,
        tollgate_publisher: params.publisherKey,
      },
    };

    // Store for later verify/settle
    this.pending.set(actionId, paymentRequirement);

    // Auto-cleanup after timeout + buffer — store timer ref so settle can cancel it
    const timer = setTimeout(
      () => {
        this.pending.delete(actionId);
        this.pendingTimers.delete(actionId);
      },
      (timeout + 60) * 1000,
    );
    timer.unref?.();
    this.pendingTimers.set(actionId, timer);

    return {
      rail: "x402",
      actionId,
      x402PaymentRequired: {
        x402Version: this.config.x402Version ?? 1,
        accepts: [paymentRequirement],
      },
      expiresAt: Math.floor(Date.now() / 1000) + timeout,
    };
  }

  /**
   * Verify a payment proof via facilitator /verify endpoint.
   * IMPORTANT: This only VALIDATES — does NOT settle on-chain.
   * Call settlePayment() after successful tool execution.
   */
  async verifyPayment(
    proof: PaymentProof,
    context?: VerificationContext,
  ): Promise<VerificationResult | null> {
    if (!proof.x402PaymentPayload) return null;

    const requirements =
      context?.paymentRequirements ??
      (context?.actionId ? this.pending.get(context.actionId) : undefined);

    if (!requirements) return null;

    const facilitatorRequirements =
      this.toFacilitatorPaymentRequirements(requirements);

    try {
      const response = await fetch(`${this.config.facilitatorUrl}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x402Version: this.config.x402Version ?? 1,
          paymentPayload: proof.x402PaymentPayload,
          paymentRequirements: facilitatorRequirements,
        }),
      });

      if (!response.ok) return null;

      const result = (await response.json()) as {
        valid?: boolean;
        isValid?: boolean;
        payer?: string;
      };

      const isValid = result.valid ?? result.isValid ?? false;
      if (!isValid) return null;

      const decimals = this.config.network.decimals ?? 6;
      return {
        verified: true,
        rail: "x402",
        amount:
          Number(this.getAtomicAmount(requirements)) / Math.pow(10, decimals),
        currency: "usd",
        receiptId: `x402_verify_${Date.now().toString(36)}`,
      };
    } catch {
      return null;
    }
  }

  /**
   * Settle a verified payment on-chain via facilitator /settle endpoint.
   * This is where money actually moves. Call AFTER tool execution succeeds.
   */
  async settlePayment(
    proof: PaymentProof,
    context?: VerificationContext,
  ): Promise<SettlementResult | null> {
    if (!proof.x402PaymentPayload) return null;

    const requirements =
      context?.paymentRequirements ??
      (context?.actionId ? this.pending.get(context.actionId) : undefined);

    if (!requirements) return null;

    const facilitatorRequirements =
      this.toFacilitatorPaymentRequirements(requirements);

    try {
      const response = await fetch(`${this.config.facilitatorUrl}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x402Version: this.config.x402Version ?? 1,
          paymentPayload: proof.x402PaymentPayload,
          paymentRequirements: facilitatorRequirements,
        }),
      });

      if (!response.ok) return null;

      const result = (await response.json()) as {
        success?: boolean;
        txHash?: string;
        transaction?: string;
      };

      if (!result.success) return null;
      const txHash = result.txHash ?? result.transaction;

      const decimals = this.config.network.decimals ?? 6;

      // Clean up pending entry and cancel its cleanup timer
      if (context?.actionId) {
        this.pending.delete(context.actionId);
        const timer = this.pendingTimers.get(context.actionId);
        if (timer) {
          clearTimeout(timer);
          this.pendingTimers.delete(context.actionId);
        }
      }

      return {
        settled: true,
        rail: "x402",
        txHash,
        amount:
          Number(this.getAtomicAmount(requirements)) / Math.pow(10, decimals),
        currency: "usd",
        receiptId: txHash ?? `x402_settle_${Date.now().toString(36)}`,
      };
    } catch {
      return null;
    }
  }

  private getAtomicAmount(requirements: X402PaymentRequirement): string {
    return (
      (requirements as X402PaymentRequirement & { amount?: string }).amount ??
      requirements.maxAmountRequired
    );
  }

  private toFacilitatorPaymentRequirements(
    requirements: X402PaymentRequirement,
  ): Record<string, unknown> {
    if ((this.config.x402Version ?? 1) >= 2) {
      return {
        scheme: requirements.scheme,
        network: requirements.network,
        amount: this.getAtomicAmount(requirements),
        asset: requirements.asset,
        payTo: requirements.payTo,
        maxTimeoutSeconds: requirements.maxTimeoutSeconds,
        extra: requirements.extra,
      };
    }

    return requirements as unknown as Record<string, unknown>;
  }

  // ─── Helpers ──────────────────────────────────────────────

  /**
   * Get the token address for the configured network.
   * EVM: Auto-detects USDC for known networks. Solana: same.
   * Falls back to config.network.asset or throws.
   */
  getAssetAddress(): string {
    const network = this.config.network;

    if (network.asset) return network.asset;

    if (network.kind === "evm") {
      const addr = EVM_USDC_ADDRESSES[network.caip2];
      if (addr) return addr;
    }

    if (network.kind === "solana") {
      const addr = SOLANA_USDC_ADDRESSES[network.caip2];
      if (addr) return addr;
    }

    const allNetworks = [
      ...Object.keys(EVM_USDC_ADDRESSES),
      ...Object.keys(SOLANA_USDC_ADDRESSES),
    ];

    throw new Error(
      `No known USDC address for network "${network.caip2}". ` +
        `Provide network.asset explicitly. ` +
        `Supported auto-detect: ${allNetworks.join(", ")}`,
    );
  }

  /** Get pending requirements count (for testing/monitoring) */
  get pendingCount(): number {
    return this.pending.size;
  }
}
