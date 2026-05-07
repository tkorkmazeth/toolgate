import type {
  RailAdapter,
  ChallengeParams,
  SettlementAction,
  PaymentProof,
  VerificationResult,
} from "../types.js";

// ─── MPP Rail Adapter ─────────────────────────────────────

/**
 * MPP (Machine Payments Protocol) rail adapter.
 * Uses `mppx` package to create payment challenges and verify payments.
 *
 * Install: npm i mppx
 *
 * Supports payment methods:
 * - stripe({ secretKey }) — fiat via Shared Payment Tokens (SPT)
 * - tempo({ currency, recipient }) — crypto via Tempo blockchain
 *
 * @see https://mpp.dev/sdk/typescript
 */
export interface MppRailConfig {
  /**
   * mppx payment methods array.
   * Import from 'mppx/server':
   *   import { stripe, tempo } from 'mppx/server'
   *
   * Example:
   *   methods: [stripe({ secretKey: process.env.STRIPE_SECRET_KEY! })]
   *   methods: [stripe({ secretKey: '...' }), tempo({ currency: '0x...', recipient: '0x...' })]
   */
  methods: unknown[];

  /**
   * Currency for MPP charges.
   * For Stripe: "usd", "eur", etc.
   * For Tempo: token contract address.
   */
  currency?: string;
}

export class MppRailAdapter implements RailAdapter {
  rail = "mpp" as const;
  private mppxInstance: unknown;
  private config: MppRailConfig;

  constructor(config: MppRailConfig) {
    this.config = config;

    // Lazy-load mppx — it's a peer dependency
    let MppxLib: { Mppx: { create: (opts: unknown) => unknown } };
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      MppxLib = require("mppx/server");
    } catch {
      throw new Error(
        "mppx package not found. Install it: npm install mppx\n" +
          "mppx is required for MPP rail support.\n" +
          "Docs: https://mpp.dev/sdk/typescript",
      );
    }

    this.mppxInstance = MppxLib.Mppx.create({
      methods: config.methods,
    });
  }

  async createChallenge(params: ChallengeParams): Promise<SettlementAction> {
    const mppx = this.mppxInstance as {
      charge: (opts: { amount: string }) => (req: Request) => Promise<Response>;
    };

    const chargeHandler = mppx.charge({ amount: String(params.amount) });
    const syntheticRequest = new Request("https://toolgate.internal/charge", {
      method: "GET",
      headers: {
        "x-toolgate-caller": params.callerId,
        "x-toolgate-tool": params.toolName,
      },
    });

    try {
      const response = await chargeHandler(syntheticRequest);

      if (response.status === 402) {
        // MPP uses WWW-Authenticate header with "Payment" scheme
        const challengeHeader = response.headers.get("www-authenticate");

        return {
          rail: "mpp",
          mppChallenge: {
            protocol: "mpp",
            wwwAuthenticate: challengeHeader,
            amount: params.amount,
            currency: params.currency ?? this.config.currency ?? "usd",
            headers: Object.fromEntries(response.headers.entries()),
          },
          expiresAt: Math.floor(Date.now() / 1000) + 60 * 60, // 1 hour
        };
      }

      return {
        rail: "mpp",
        mppChallenge: {
          protocol: "mpp",
          amount: params.amount,
          currency: params.currency ?? this.config.currency ?? "usd",
          error: "unexpected_mppx_response",
          status: response.status,
        },
      };
    } catch (error) {
      return {
        rail: "mpp",
        mppChallenge: {
          protocol: "mpp",
          amount: params.amount,
          currency: params.currency ?? this.config.currency ?? "usd",
          error: (error as Error).message,
        },
      };
    }
  }

  async verifyPayment(proof: PaymentProof): Promise<VerificationResult | null> {
    if (!proof.mppPaymentHeader) return null;

    try {
      const mppx = this.mppxInstance as {
        charge: (opts: {
          amount: string;
        }) => (req: Request) => Promise<Response>;
      };

      const verifyRequest = new Request("https://toolgate.internal/verify", {
        headers: {
          Authorization: `Payment ${proof.mppPaymentHeader}`,
        },
      });

      // Use charge({ amount: "0" }) to check whether the credential is valid —
      // mppx won't return 402 if the Payment header is accepted.
      const chargeHandler = mppx.charge({ amount: "0" });
      const response = await chargeHandler(verifyRequest);

      if (response.status !== 402) {
        return {
          verified: true,
          rail: "mpp",
          amount: 0, // actual amount comes from the credential
          currency: this.config.currency ?? "usd",
          receiptId: `mpp_${Date.now().toString(36)}`,
        };
      }

      return null;
    } catch {
      return null;
    }
  }
}
