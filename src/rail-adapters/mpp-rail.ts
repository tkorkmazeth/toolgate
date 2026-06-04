import { randomBytes } from "node:crypto";
import type {
  RailAdapter,
  ChallengeParams,
  SettlementAction,
  PaymentProof,
  VerificationResult,
  VerificationContext,
  SettlementResult,
  MppMethodConfig,
} from "../types.js";

export interface MppRailConfig {
  /** Typed MPP payment methods. Must contain at least one entry. */
  methods: MppMethodConfig[];
  /** Optional mppx instance for in-process payment verification only. */
  mppxInstance?: unknown;
}

export class MppRailAdapter implements RailAdapter {
  rail = "mpp" as const;
  private config: MppRailConfig;

  constructor(config: MppRailConfig) {
    if (!config.methods || config.methods.length === 0) {
      throw new Error("MppRailConfig requires at least one payment method");
    }
    this.config = config;
  }

  async createChallenge(params: ChallengeParams): Promise<SettlementAction> {
    const challengeId = `tg_mpp_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;

    const challenges = this.config.methods.map((method, index) => {
      const requestPayload = {
        amount: this.convertAmount(params.amount, method),
        currency: this.getCurrencyForRequest(method),
        recipient: this.getRecipient(method),
        description: params.toolName,
        metadata: { toolName: params.toolName, callerId: params.callerId },
      };
      const requestBase64 = Buffer.from(
        JSON.stringify(requestPayload),
      ).toString("base64url");
      return {
        id: `${challengeId}_${index}`,
        realm: "toolgate",
        method: method.name,
        intent: "charge" as const,
        request: requestBase64,
      };
    });

    const wwwAuthenticate = challenges.map(
      (ch) =>
        `Payment id="${ch.id}", realm="${ch.realm}", method="${ch.method}", intent="${ch.intent}", request="${ch.request}"`,
    );

    return {
      rail: "mpp",
      mppChallenge: {
        protocol: "mpp",
        challenges,
        wwwAuthenticate,
      },
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  }

  async verifyPayment(
    proof: PaymentProof,
    context?: VerificationContext,
  ): Promise<VerificationResult | null> {
    if (!proof.mppPaymentHeader || !this.config.mppxInstance) return null;

    try {
      const mppx = this.config.mppxInstance as {
        charge: (opts: {
          amount: string;
        }) => (req: Request) => Promise<Response>;
      };

      const verifyRequest = new Request("https://toolgate.internal/verify", {
        headers: {
          Authorization: `Payment ${proof.mppPaymentHeader}`,
        },
      });

      const chargeHandler = mppx.charge({ amount: "0" });
      const response = await chargeHandler(verifyRequest);

      if (response.status !== 402) {
        return {
          verified: true,
          rail: "mpp",
          amount: context?.expectedAmount ?? 0,
          currency: context?.currency ?? "usd",
          receiptId: `mpp_${Date.now().toString(36)}`,
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  async settlePayment(
    _proof: PaymentProof,
    _context?: VerificationContext,
  ): Promise<SettlementResult | null> {
    // MPP settlement happens via webhook or mppx internally.
    // No explicit settle call needed from Toolgate.
    return null;
  }

  private convertAmount(amount: number, method: MppMethodConfig): number {
    if (method.name === "tempo") return Math.round(amount * 1e6);
    if (method.name === "stripe") return Math.round(amount * 100);
    return amount;
  }

  private getCurrencyForRequest(method: MppMethodConfig): string {
    if (method.name === "tempo")
      return (method as { name: "tempo"; currency: string }).currency;
    return "usd";
  }

  private getRecipient(method: MppMethodConfig): string | undefined {
    if (method.name === "tempo")
      return (method as { name: "tempo"; currency: string; recipient: string })
        .recipient;
    return undefined;
  }
}
