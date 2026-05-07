import type {
  RailAdapter,
  ChallengeParams,
  SettlementAction,
  PaymentProof,
  VerificationResult,
} from "../types.js";

// ─── x402 Rail Adapter ────────────────────────────────────

/**
 * x402 rail adapter.
 * Creates x402-spec-compliant payment requirements.
 * Optionally uses `@x402/core` for verification; falls back to facilitator API.
 *
 * Install: npm i @x402/core @x402/evm   (for Base/Ethereum)
 *     OR:  npm i @x402/core @x402/svm   (for Solana)
 *
 * x402 flow:
 * 1. Server returns 402 with payment requirement
 * 2. Agent signs USDC transfer (EIP-3009, no approval needed)
 * 3. Agent retries with payment proof in header
 * 4. Facilitator (Coinbase/Cloudflare) settles on-chain
 *
 * @see https://docs.cdp.coinbase.com/x402
 */
export interface X402RailConfig {
  /**
   * Wallet address to receive payments.
   * Must be a valid address on the configured network.
   */
  payTo: string;

  /**
   * Network identifier in CAIP-2 format.
   * Examples:
   *   "eip155:8453"   — Base mainnet
   *   "eip155:84532"  — Base Sepolia (testnet)
   *   "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" — Solana mainnet
   */
  network: string;

  /**
   * Payment scheme. Default: "exact"
   */
  scheme?: string;

  /**
   * Facilitator URL for payment verification.
   * Default: Coinbase hosted facilitator.
   */
  facilitatorUrl?: string;
}

export class X402RailAdapter implements RailAdapter {
  rail = "x402" as const;
  private config: Required<X402RailConfig>;

  constructor(config: X402RailConfig) {
    this.config = {
      scheme: "exact",
      facilitatorUrl: "https://x402.org/facilitate",
      ...config,
    };
  }

  async createChallenge(params: ChallengeParams): Promise<SettlementAction> {
    // x402 payment requirement format follows the x402 specification.
    // Standardized — any x402 client can parse and pay this.
    // Reference: https://github.com/coinbase/x402/blob/main/specs/x402-specification.md
    const paymentRequirement: Record<string, unknown> = {
      scheme: this.config.scheme,
      network: this.config.network,
      maxAmountRequired: String(params.amount),
      resource: `toolgate://${params.publisherKey}/${params.toolName}`,
      description: `Payment for ${params.toolName} tool call`,
      mimeType: "application/json",
      payTo: this.config.payTo,
      maxTimeoutSeconds: 300, // 5 min for on-chain settlement
      asset: "USDC",
      extra: {
        toolgate_caller_id: params.callerId,
        toolgate_tool: params.toolName,
        toolgate_publisher: params.publisherKey,
      },
    };

    return {
      rail: "x402",
      x402PaymentRequired: paymentRequirement,
      expiresAt: Math.floor(Date.now() / 1000) + 300, // 5 min
    };
  }

  async verifyPayment(proof: PaymentProof): Promise<VerificationResult | null> {
    if (!proof.x402Proof) return null;

    try {
      // Try @x402/core for native verification
      let x402Core: {
        verifyPayment?: (proof: unknown, req: unknown) => Promise<boolean>;
      };
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        x402Core = require("@x402/core");
      } catch {
        // @x402/core not installed — use facilitator API
        return await this.verifyViaFacilitator(proof);
      }

      if (x402Core.verifyPayment) {
        const isValid = await x402Core.verifyPayment(proof.x402Proof, {
          network: this.config.network,
          payTo: this.config.payTo,
        });

        if (isValid) {
          return {
            verified: true,
            rail: "x402",
            amount: Number(
              (proof.x402Proof as Record<string, unknown>).amount ?? 0,
            ),
            currency: "usd",
            receiptId: `x402_${Date.now().toString(36)}`,
          };
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private async verifyViaFacilitator(
    proof: PaymentProof,
  ): Promise<VerificationResult | null> {
    try {
      const response = await fetch(`${this.config.facilitatorUrl}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proof: proof.x402Proof,
          network: this.config.network,
          payTo: this.config.payTo,
        }),
      });

      if (response.ok) {
        const result = (await response.json()) as {
          verified: boolean;
          amount?: number;
          txHash?: string;
        };
        if (result.verified) {
          return {
            verified: true,
            rail: "x402",
            amount: result.amount ?? 0,
            currency: "usd",
            receiptId: result.txHash ?? `x402_${Date.now().toString(36)}`,
          };
        }
      }

      return null;
    } catch {
      return null;
    }
  }
}
