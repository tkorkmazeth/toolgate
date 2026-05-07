# FINAL_SPEC.md — Definitive Implementation Specification

**Date:** 2026-05-07
**Supersedes:** POST_SESSIONS_SPEC.md, PIVOT_SPEC.md
**Status:** FINAL — do not implement anything from older specs

---

## Context: Why This Spec Exists

Every previous spec was built on incomplete competitive research. This one is built on verified facts:

| What we assumed | What's actually true |
|---|---|
| "MPP SDK henüz GA değil, stub kalsın" | `mppx` npm'de GA. wevm maintains. Express/Hono/Next.js middleware. Stripe SPT (fiat) + Tempo (crypto). 50+ services adopted. |
| "x402 stub kalsın" | `@x402/core`, `@x402/express`, `@x402/hono` hepsi GA. 165M+ tx, 69K agents. Coinbase + Cloudflare backed. V2 adds fiat. |
| "PayGated basit proxy" | v10.9.0: prepaid credit grants, priority/expiry/rollover, key hierarchy, sandbox, revenue share, multi-currency, usage forecast. |
| "Nevermined sadece crypto" | Stripe OAuth fiat, MCP+A2A+x402+AP2, sub-$0.001 tx, "20 dakikada deploy". |
| "Fiat-first positioning unique" | MPP supports fiat via Stripe SPT. Nevermined has Stripe OAuth. PayGated has Stripe Checkout. |

**What IS still unique to Toolgate (verified — no competitor has these):**
1. **ExecutionPolicy** — programmable per-call billing decisions (execute/fallback/payment_required/allow_once/estimate)
2. **Graceful fallback** — return degraded response instead of hard 402
3. **Cost estimation** — pre-flight estimate via policy "estimate" decision
4. **Postpaid metering** — charge based on actual consumption after execution

**Architecture decision: Pattern B**
Toolgate wraps mppx/x402 internally. Developer only knows Toolgate API. mppx = payment rail, @x402/* = payment rail, Toolgate = execution intelligence layer above rails.

---

## SDK & Protocol Reference (verified May 2026)

### mppx (MPP protocol)
```
npm i mppx
```
- **Maintainer:** wevm (viem/wagmi team)
- **Server:** `import { Mppx, stripe, tempo } from 'mppx/server'`
- **Client:** `import { MppxClient } from 'mppx/client'`
- **CLI:** `npx mppx` for testing paid endpoints
- **Frameworks:** `mppx/express`, `mppx/hono`, `mppx/elysia`
- **Payment methods:**
  - `stripe({ secretKey })` — fiat via Shared Payment Tokens (SPT). Visa, Mastercard, Affirm, Klarna.
  - `tempo({ currency, recipient })` — crypto via Tempo blockchain
  - Custom methods supported
- **Server flow:**
  ```typescript
  const mppx = Mppx.create({ methods: [stripe({ secretKey: '...' })] })
  const response = await mppx.charge({ amount: '0.05' })(request)
  if (response.status === 402) return response.challenge
  return response.withReceipt(Response.json({ data: '...' }))
  ```
- **MCP transport:** JSON-RPC error 32042, credentials/receipts in `_meta` fields
- **Docs:** https://mpp.dev/sdk/typescript

### x402 SDK (x402 protocol)
```
npm i @x402/core @x402/express   # or @x402/hono, @x402/next
npm i @x402/evm @x402/svm        # chain-specific
npm i @coinbase/x402              # Coinbase facilitator
```
- **Maintainer:** x402 Foundation (Coinbase + Cloudflare)
- **Server middleware:**
  ```typescript
  import { paymentMiddleware } from '@x402/express'
  app.use(paymentMiddleware({
    '/api/search': {
      scheme: 'exact',
      price: '$0.05',
      network: 'eip155:8453',  // Base mainnet
      payTo: '0x...',
      description: 'Premium search'
    }
  }))
  ```
- **Chains:** Base, Ethereum, Polygon, Optimism, Arbitrum, Avalanche, Solana, Aptos, Stellar, Sui
- **Asset:** USDC (EIP-3009 — no approval needed from buyer)
- **MCP:** Official example at `coinbase/x402/examples/typescript/clients/mcp`
- **Docs:** https://docs.cdp.coinbase.com/x402

### Cloudflare Agents SDK
```
import { paidTool, withX402 } from 'agents'
```
- `paidTool()` = drop-in for `tool()` with x402 payment
- `withX402` server middleware, `withX402Client` client wrapper
- x402/USDC only, no fiat (yet)
- **Risk level for Toolgate:** HIGH — same pattern, bigger platform

### PayGated (competitor)
- **URL:** paygated.dev
- **v10.9.0 features:** prepaid credit grants (named, priority, expiry, rollover), Stripe Checkout auto-topup, key hierarchy (parent/child API keys), sandbox mode, revenue share tracking, multi-currency credit conversion, usage forecast engine, webhook signature verification
- **Architecture:** proxy in front of MCP server (`paygated wrap`)
- **What PayGated DOESN'T have:** ExecutionPolicy, graceful fallback, cost estimation, postpaid metering

### Nevermined (competitor)
- **URL:** nevermined.ai
- **Features:** Stripe OAuth + crypto (USDC/USDT/ETH), MCP+A2A+x402+AP2, prepaid credits with real-time burn, sub-$0.001 tx, "20 min to deploy"
- **Architecture:** managed SDK + hosted service
- **What Nevermined DOESN'T have:** ExecutionPolicy, graceful fallback, cost estimation (as SDK-level abstractions)

---

## Architecture: Pattern B — Toolgate Wraps Rails

```
┌─────────────────────────────────────────────────────────┐
│                    Developer's MCP Server                │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Toolgate SDK (core)                   │  │
│  │                                                   │  │
│  │  ┌─────────────┐  ┌───────────────────────────┐   │  │
│  │  │ Execution   │  │ Payment Gate               │   │  │
│  │  │ Policy      │  │  ┌───────┐ ┌───────────┐  │   │  │
│  │  │ Engine      │  │  │Prepaid│ │Per-request │  │   │  │
│  │  │             │  │  │Ledger │ │(MPP/x402)  │  │   │  │
│  │  └─────────────┘  │  └───────┘ └───────────┘  │   │  │
│  │  ┌─────────────┐  └───────────────────────────┘   │  │
│  │  │ Lifecycle   │  ┌───────────────────────────┐   │  │
│  │  │ Hooks +     │  │ Rail Adapters              │   │  │
│  │  │ Metering    │  │  ┌─────┐ ┌───┐ ┌────┐    │   │  │
│  │  └─────────────┘  │  │Stripe│ │MPP│ │x402│    │   │  │
│  │                   │  └─────┘ └───┘ └────┘    │   │  │
│  │                   └───────────────────────────┘   │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │         Tool Handlers (developer code)             │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Payment Modes

```typescript
type PaymentMode = "prepaid" | "per_request" | "hybrid";
```

**`"prepaid"` (current default):**
Balance topup → ledger credit → tool call → deduct from ledger → execute.
Best for: high-frequency calls, low amounts, no approval friction.

**`"per_request"`:**
Tool call → Toolgate policy check → if needs payment → rail adapter creates challenge (MPP 402 or x402 402) → agent pays → verify → execute.
Best for: one-off API calls, agent-native machine payment, no account/balance needed.

**`"hybrid"` (NEW default):**
Tool call → check prepaid balance first → if sufficient, deduct and execute → if insufficient, check policy → if "fallback", return degraded → if "payment_required", create rail challenge → agent pays → verify → execute.
Best for: flexible, covers all cases, Toolgate's main value prop.

### Execution Flow (hybrid mode)

```
1. Tool called with (input, callerId)
2. Determine tier + price
3. Check prepaid balance in ledger
4. If balance >= price:
   → Deduct → Execute → Receipt (current flow, unchanged)
5. If balance < price:
   → Evaluate ExecutionPolicy
   → "execute"          → deduct what's available, execute (or block)
   → "fallback"         → run fallback handler, no charge
   → "allow_once"       → execute free (grace period)
   → "estimate"         → return cost estimate
   → "payment_required" → create challenge via RailAdapter(s)
                          → return 402 with MPP/x402 challenge
6. On retry with payment proof:
   → RailAdapter.verifyPayment() → if valid → execute → receipt
   → OR: webhook already credited ledger → normal prepaid flow
```

---

## Phase 1: Type System Updates

**Goal:** Add PaymentMode, update RailAdapter interface, add verification types.

### File: `src/types.ts`

**1.1 — Add PaymentMode to ToolGateConfig:**

```typescript
export interface ToolGateConfig {
  publisherKey: string;
  paymentRails?: PaymentRail[];
  defaultCurrency?: string;
  ledger?: LedgerAdapter;
  hooks?: GlobalHooks;
  topUpBaseUrl?: string;
  /** How payments are collected. Default: "hybrid" */
  paymentMode?: PaymentMode;
  /** Rail adapters for payment settlement */
  railAdapters?: RailAdapter[];
}

export type PaymentMode = "prepaid" | "per_request" | "hybrid";
```

**1.2 — Update CreditMeta source union:**

```typescript
export interface CreditMeta {
  source: "stripe" | "x402" | "mpp" | "manual";
  reference: string;
}
```

**1.3 — Add RailAdapter interface (full, not stub):**

```typescript
// ─── Rail Adapter (settlement layer abstraction) ──────────

export interface RailAdapter {
  /** Which rail this adapter handles */
  rail: PaymentRail;

  /**
   * Create a payment challenge for the caller.
   * Returns a standardized settlement action with rail-specific details.
   */
  createChallenge(params: ChallengeParams): Promise<SettlementAction>;

  /**
   * Verify a payment proof from a retry request.
   * Returns the verified amount if valid, null if invalid.
   * Used in "per_request" and "hybrid" modes.
   */
  verifyPayment?(proof: PaymentProof): Promise<VerificationResult | null>;
}

export interface ChallengeParams {
  callerId: string;
  amount: number;
  currency: string;
  toolName: string;
  publisherKey: string;
}

export interface SettlementAction {
  rail: PaymentRail;
  /** URL for the caller to complete payment */
  url?: string;
  /** x402 payment requirement (for x402 protocol) */
  x402PaymentRequired?: Record<string, unknown>;
  /** MPP challenge (for MPP protocol) */
  mppChallenge?: Record<string, unknown>;
  /** Expiration (seconds since epoch) */
  expiresAt?: number;
}

export interface PaymentProof {
  rail: PaymentRail;
  /** MPP: Payment header value from retry request */
  mppPaymentHeader?: string;
  /** x402: Payment proof from retry request */
  x402Proof?: Record<string, unknown>;
  /** Raw request for middleware-level verification */
  rawRequest?: unknown;
}

export interface VerificationResult {
  verified: true;
  rail: PaymentRail;
  amount: number;
  currency: string;
  /** Receipt/tx ID from the payment rail */
  receiptId: string;
}
```

**1.4 — Update PaymentRequiredResponse:**

```typescript
export interface PaymentRequiredResponse {
  status: 402;
  error: "payment_required";
  tool: string;
  amount: number;
  currency: string;
  topUpUrl?: string;
  x402Challenge?: Record<string, unknown>;
  acceptedRails: PaymentRail[];
  /** Rail-specific settlement options */
  settlements?: SettlementAction[];
}
```

**1.5 — Update index.ts exports:**

Add to type exports:
```typescript
export type {
  // ... existing ...
  PaymentMode,
  RailAdapter,
  ChallengeParams,
  SettlementAction,
  PaymentProof,
  VerificationResult,
} from "./types.js";
```

---

## Phase 2: MppRailAdapter (Real Implementation)

**Goal:** Create a real MPP rail adapter using `mppx` as a peer dependency. NOT a stub.

### File: `src/rail-adapters/mpp-rail.ts`

```typescript
import type { RailAdapter, ChallengeParams, SettlementAction, PaymentProof, VerificationResult } from "../types.js";

/**
 * MPP (Machine Payments Protocol) rail adapter.
 * Uses `mppx` package to create payment challenges and verify payments.
 *
 * Install: npm i mppx
 *
 * Supports payment methods:
 * - stripe({ secretKey }) — fiat via Shared Payment Tokens (SPT)
 * - tempo({ currency, recipient }) — crypto via Tempo blockchain
 * - Custom methods via mppx API
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
   *   methods: [tempo({ currency: '0x...', recipient: '0x...' })]
   *   methods: [stripe({ secretKey: '...' }), tempo({ currency: '0x...', recipient: '0x...' })]
   */
  methods: unknown[];

  /**
   * Currency for MPP charges.
   * For Stripe: "usd", "eur", etc.
   * For Tempo: token contract address
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
      // Dynamic import for ESM compatibility
      MppxLib = require("mppx/server");
    } catch {
      throw new Error(
        'mppx package not found. Install it: npm install mppx\n' +
        'mppx is required for MPP rail support.\n' +
        'Docs: https://mpp.dev/sdk/typescript'
      );
    }

    this.mppxInstance = MppxLib.Mppx.create({
      methods: config.methods,
    });
  }

  async createChallenge(params: ChallengeParams): Promise<SettlementAction> {
    // Use mppx to create a proper MPP 402 challenge.
    // mppx.charge() returns a handler that takes a Request and returns
    // a Response with status 402 + challenge headers.
    //
    // For MCP (non-HTTP) context, we extract the challenge data
    // and return it as a structured object.

    const mppx = this.mppxInstance as {
      charge: (opts: { amount: string }) => (req: Request) => Promise<{
        status: number;
        challenge?: Response;
        headers?: Headers;
      }>;
    };

    // Create a synthetic request to get the challenge from mppx
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
        // Extract MPP challenge from 402 response headers
        // MPP uses WWW-Authenticate header with "Payment" scheme
        const challengeHeader =
          response instanceof Response
            ? response.headers.get("www-authenticate")
            : null;

        return {
          rail: "mpp",
          mppChallenge: {
            protocol: "mpp",
            wwwAuthenticate: challengeHeader,
            amount: params.amount,
            currency: params.currency,
            // Include raw response headers for agents that speak MPP natively
            headers: response instanceof Response
              ? Object.fromEntries(response.headers.entries())
              : {},
          },
          expiresAt: Math.floor(Date.now() / 1000) + 60 * 60, // 1 hour
        };
      }

      // If mppx didn't return 402, something unexpected happened
      return {
        rail: "mpp",
        mppChallenge: {
          protocol: "mpp",
          amount: params.amount,
          currency: params.currency,
          error: "unexpected_mppx_response",
          status: response.status,
        },
      };
    } catch (error) {
      // If mppx throws, return a degraded challenge with enough info
      // for the agent to attempt payment through other means
      return {
        rail: "mpp",
        mppChallenge: {
          protocol: "mpp",
          amount: params.amount,
          currency: params.currency,
          error: (error as Error).message,
        },
      };
    }
  }

  async verifyPayment(proof: PaymentProof): Promise<VerificationResult | null> {
    if (!proof.mppPaymentHeader) return null;

    // For MPP verification, the standard approach is:
    // 1. Agent retries with "Payment" header containing the credential
    // 2. mppx middleware verifies the credential
    // 3. On success, the request proceeds
    //
    // In Toolgate's MCP context, the payment proof comes in _meta.
    // We reconstruct a request with the Payment header and let mppx verify.

    try {
      const mppx = this.mppxInstance as {
        charge: (opts: { amount: string }) => (req: Request) => Promise<{
          status: number;
          receipt?: unknown;
          withReceipt?: (res: Response) => Response;
        }>;
      };

      const verifyRequest = new Request("https://toolgate.internal/verify", {
        headers: {
          Authorization: `Payment ${proof.mppPaymentHeader}`,
        },
      });

      // A small charge that we use to verify — mppx will check the credential
      const chargeHandler = mppx.charge({ amount: "0" });
      const response = await chargeHandler(verifyRequest);

      if (response.status !== 402) {
        // Payment verified — mppx accepted the credential
        return {
          verified: true,
          rail: "mpp",
          amount: 0, // Actual amount comes from the credential
          currency: this.config.currency ?? "usd",
          receiptId: `mpp_${Date.now().toString(36)}`,
        };
      }

      return null; // Payment not valid
    } catch {
      return null;
    }
  }
}
```

**IMPORTANT NOTE FOR IMPLEMENTER:** The `createChallenge` method above uses mppx's charge handler with a synthetic Request. This is the cleanest approach because mppx's API is HTTP-middleware-first. If mppx exposes lower-level challenge-creation APIs (check their docs), use those instead of the synthetic Request pattern. The key contract is: return a `SettlementAction` with `mppChallenge` containing enough data for an MPP-aware agent to pay.

**If the synthetic Request approach doesn't work with mppx's API** (i.e., mppx requires a real HTTP context), fall back to:
1. Extract the MPP challenge format from mppx source/docs
2. Build the challenge object directly using the MPP spec
3. Use mppx only for verification (which does need a Request)

Test both paths and use whichever works. The IMPORTANT thing is that the challenge format is MPP-spec-compliant so any mppx client can pay.

### peerDependencies update in `package.json`:

```json
"peerDependencies": {
  "stripe": ">=14.0.0",
  "mppx": ">=0.1.0"
},
"peerDependenciesMeta": {
  "stripe": { "optional": true },
  "mppx": { "optional": true }
}
```

---

## Phase 3: X402RailAdapter (Real Implementation)

**Goal:** Create a real x402 rail adapter using `@x402/core` as a peer dependency.

### File: `src/rail-adapters/x402-rail.ts`

```typescript
import type { RailAdapter, ChallengeParams, SettlementAction, PaymentProof, VerificationResult } from "../types.js";

/**
 * x402 rail adapter.
 * Uses `@x402/core` to create payment requirements.
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
   *
   * @see https://chainagnostic.org/CAIPs/caip-2
   */
  network: string;

  /**
   * Payment scheme. Default: "exact" (exact amount).
   */
  scheme?: string;

  /**
   * Facilitator URL for payment verification.
   * Default: Coinbase hosted facilitator
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
    // This creates a proper x402-compatible 402 response payload.
    //
    // The format is standardized — any x402 client (@x402/fetch, @x402/axios,
    // mppx x402 method, Cloudflare withX402Client) can parse and pay this.
    //
    // Reference: https://github.com/coinbase/x402/blob/main/specs/x402-specification.md

    const paymentRequirement = {
      scheme: this.config.scheme,
      network: this.config.network,
      maxAmountRequired: String(params.amount),
      resource: `toolgate://${params.publisherKey}/${params.toolName}`,
      description: `Payment for ${params.toolName} tool call`,
      mimeType: "application/json",
      payTo: this.config.payTo,
      maxTimeoutSeconds: 300, // 5 min for on-chain settlement
      asset: "USDC", // x402 uses USDC by default
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

    // x402 verification typically goes through a facilitator.
    // The facilitator (Coinbase hosted, or self-hosted) verifies:
    // 1. The payment signature is valid
    // 2. The payment amount matches the requirement
    // 3. The on-chain transaction is confirmed
    //
    // For production: use @x402/core's verification utilities
    // or call the facilitator API directly.

    try {
      // Try to load @x402/core for native verification
      let x402Core: { verifyPayment?: (proof: unknown, req: unknown) => Promise<boolean> };
      try {
        x402Core = require("@x402/core");
      } catch {
        // @x402/core not installed — fall back to facilitator API
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
            amount: Number((proof.x402Proof as Record<string, unknown>).amount ?? 0),
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

  private async verifyViaFacilitator(proof: PaymentProof): Promise<VerificationResult | null> {
    // Call the facilitator HTTP API to verify payment
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
        const result = await response.json() as { verified: boolean; amount?: number; txHash?: string };
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
```

### peerDependencies update in `package.json`:

```json
"peerDependencies": {
  "stripe": ">=14.0.0",
  "mppx": ">=0.1.0",
  "@x402/core": ">=0.1.0"
},
"peerDependenciesMeta": {
  "stripe": { "optional": true },
  "mppx": { "optional": true },
  "@x402/core": { "optional": true }
}
```

---

## Phase 4: StripeRailAdapter (Real, Not Stub)

**Goal:** Extract existing Stripe topup logic into a proper RailAdapter.

### File: `src/rail-adapters/stripe-rail.ts`

```typescript
import type { RailAdapter, ChallengeParams, SettlementAction } from "../types.js";

/**
 * Stripe rail adapter — creates Checkout sessions for balance top-ups.
 * Uses the existing Toolgate hosted API or a custom topUpBaseUrl.
 *
 * This is the simplest rail — no additional dependencies needed.
 * Payment verification happens via Stripe webhook → WebhookHandler → ledger credit.
 */
export interface StripeRailConfig {
  /**
   * Base URL for topup endpoint.
   * The URL receives: ?publisher=...&caller=...&amount=... (cents)
   * Default: Toolgate hosted API
   */
  topUpBaseUrl?: string;
}

export class StripeRailAdapter implements RailAdapter {
  rail = "stripe" as const;
  private topUpBaseUrl: string;

  constructor(config?: StripeRailConfig) {
    this.topUpBaseUrl = config?.topUpBaseUrl ?? "https://toolgate-api.talha-korkmazeth.workers.dev/pay";
  }

  async createChallenge(params: ChallengeParams): Promise<SettlementAction> {
    const amountCents = Math.ceil(params.amount * 100);
    return {
      rail: "stripe",
      url: `${this.topUpBaseUrl}?publisher=${params.publisherKey}&caller=${encodeURIComponent(params.callerId)}&amount=${amountCents}`,
      expiresAt: Math.floor(Date.now() / 1000) + 30 * 60,
    };
  }

  // No verifyPayment — Stripe verification happens via webhook → ledger credit
}
```

### File: `src/rail-adapters/index.ts`

```typescript
export { StripeRailAdapter } from "./stripe-rail.js";
export type { StripeRailConfig } from "./stripe-rail.js";

export { MppRailAdapter } from "./mpp-rail.js";
export type { MppRailConfig } from "./mpp-rail.js";

export { X402RailAdapter } from "./x402-rail.js";
export type { X402RailConfig } from "./x402-rail.js";
```

---

## Phase 5: Wire Into Core Engine

**Goal:** Update `toolgate.ts` to use payment modes and rail adapters.

### File: `src/toolgate.ts`

**5.1 — Update constructor to store new config:**

Add to imports:
```typescript
import type { ..., PaymentMode, RailAdapter, SettlementAction } from "./types.js";
```

Update stored config type to include:
```typescript
paymentMode: PaymentMode;
railAdapters: RailAdapter[];
```

Update constructor defaults:
```typescript
this.config = {
  // ... existing ...
  paymentMode: config.paymentMode ?? "hybrid",
  railAdapters: config.railAdapters ?? [],
};
```

**5.2 — Update `handlePaymentFailure` to use rail adapters:**

Replace the "Block (default)" section of `handlePaymentFailure`:

```typescript
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

// Enrich with rail-specific settlement actions
if (this.config.railAdapters.length > 0) {
  const results = await Promise.allSettled(
    this.config.railAdapters.map((adapter) =>
      adapter.createChallenge({
        callerId,
        amount: requiredAmount,
        currency: this.config.defaultCurrency,
        toolName: tool.name,
        publisherKey: this.config.publisherKey,
      })
    )
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
    // Failed adapters silently skipped — don't block 402 response
  }
  if (settlements.length > 0) {
    paymentRequired.settlements = settlements;
  }
}

return { success: false, paymentRequired };
```

**5.3 — NO changes to execution pipeline for Phase 5:**

The `executeTool` method stays the same. In `hybrid` mode, the prepaid check happens first (existing code). Rail adapters only fire when payment fails and the 402 needs to be returned. This keeps the change surface minimal and backward compatible.

`per_request` mode (where payment verification happens inline) is a Phase 7 feature — more complex, needs its own test suite.

---

## Phase 6: Tests

### File: `src/__tests__/rail-adapter.test.mjs`

Use the same inline pattern as existing tests (no build step, `node:test` + `node:assert`).

**Test cases:**

1. **"StripeRailAdapter creates challenge with correct URL format"**
   - Create StripeRailAdapter with default config
   - Call createChallenge with known params
   - Assert: result.rail === "stripe"
   - Assert: result.url contains publisher, caller, amount in cents

2. **"402 includes settlements from registered rail adapters"**
   - Register a mock RailAdapter
   - Create paidTool, call with zero balance
   - Assert: result.paymentRequired.settlements array has 1 entry

3. **"402 works with no rail adapters (backward compatible)"**
   - Create ToolGate with NO railAdapters
   - Call with zero balance
   - Assert: result.paymentRequired exists, settlements is undefined

4. **"multiple rail adapters produce multiple settlements"**
   - Register StripeRailAdapter + mock x402 adapter
   - Call with zero balance
   - Assert: settlements.length === 2

5. **"failed rail adapter doesn't block 402 response"**
   - Register adapter that throws + adapter that succeeds
   - Assert: settlements.length === 1 (only successful)

6. **"createChallenge receives correct parameters"**
   - Spy adapter that records params
   - Assert: { callerId, amount, currency, toolName, publisherKey } correct

7. **"CreditMeta accepts 'mpp' source"**
   - Credit with source: "mpp"
   - Assert: balance updated

8. **"paymentMode defaults to hybrid"**
   - Create ToolGate with no paymentMode
   - Assert via indirect test (existing prepaid behavior works)

9. **"x402 challenge populates backward-compat x402Challenge field"**
   - Register adapter returning x402PaymentRequired
   - Assert: result.paymentRequired.x402Challenge is populated

10. **"MppRailAdapter requires mppx (graceful error)"**
    - Skip if mppx is installed; otherwise:
    - Assert: new MppRailAdapter({ methods: [] }) throws with helpful message

### Update `package.json` test script:

```json
"test": "node --test src/__tests__/paidTool.test.mjs src/__tests__/mcp-adapter.test.mjs src/__tests__/stripe.test.mjs src/__tests__/webhook-handler.test.mjs src/__tests__/db-ledger.test.mjs src/__tests__/rail-adapter.test.mjs"
```

**Expected result:** 95 existing + 10 new = **105 passing, 0 failing.**

---

## Phase 7: Messaging Updates

### 7.1 — `package.json`

```json
"version": "0.2.0-alpha.1",
"description": "Billing-aware execution SDK for paid MCP tools — graceful fallback, programmable billing logic, rail-agnostic metering. Works with Stripe, MPP, and x402.",
"keywords": [
  "mcp", "payments", "billing", "usage-billing", "monetization",
  "ai-tools", "stripe", "prepaid", "agent", "llm",
  "model-context-protocol", "mpp", "x402", "rail-agnostic",
  "agentic-commerce"
]
```

### 7.2 — `README.md`

**Replace opening (lines 1-5):**

```markdown
# Toolgate

Billing-aware execution SDK for paid MCP tools — graceful fallback, programmable billing logic, and rail-agnostic metering.

Works with Stripe (fiat), MPP (Stripe+Tempo), and x402 (crypto). You handle the billing decisions — Toolgate handles execution reliability.

```

**Add new section AFTER "Payment Flow" and BEFORE "LedgerAdapter":**

```markdown
## Rail-Agnostic Architecture

Toolgate doesn't collect payments — it controls what happens at the billing decision point. Payment settlement is delegated to rail adapters:

| Rail | Settlement | Status |
|------|-----------|--------|
| **Stripe** (fiat) | Credit card, BNPL via Stripe Checkout | Production |
| **MPP** (Stripe+Tempo) | Session-based micropayments via mppx | Production |
| **x402** (Coinbase) | USDC on Base/Solana/10+ chains via @x402/core | Production |
| **Custom** | Implement `RailAdapter` for any backend | Available |

```typescript
import { ToolGate } from "@tkorkmaz/toolgate";
import { MppRailAdapter } from "@tkorkmaz/toolgate/rail-adapters";
import { stripe } from "mppx/server";

const gate = new ToolGate({
  publisherKey: "tg_pub_xxx",
  railAdapters: [
    new MppRailAdapter({
      methods: [stripe({ secretKey: process.env.STRIPE_SECRET_KEY! })],
    }),
  ],
});

// Same paidTool API — now with MPP settlement on 402
const search = gate.paidTool({
  name: "premium_search",
  price: 0.05,
  handler: async (input) => deepSearch(input.query),
  fallback: async (input) => quickSearch(input.query),
});
```

Regardless of rail, the execution pipeline is identical: balance check → policy evaluation → execute or fallback → receipt → refund on error.
```

### 7.3 — `llms.txt`

**Update header:**
```
# Last updated: 2026-05-07 (FINAL — rail-agnostic, real mppx/x402 integration)
```

**Update one-liner:**
```
One-liner: "Billing-aware execution SDK for paid MCP tools — graceful fallback, programmable billing logic, and rail-agnostic metering."
```

**Replace the STRATEGY Growth line:**
```
Growth: SDK (rail-agnostic, Stripe+MPP+x402) → Billing intelligence (analytics, optimization) → Governance (enterprise budgets, audit)
```

**Add post-Sessions landscape section (after Protocol layer, before Agent payment infrastructure):**

```markdown
### Ecosystem status (verified May 7, 2026):
- **mppx** (npm i mppx): GA. wevm maintained. Stripe SPT fiat + Tempo crypto. Express/Hono/Next.js middleware. 50+ services.
- **x402 SDK** (@x402/core, @x402/express): GA. 165M+ tx, 69K agents. USDC on 10+ chains. V2 adds fiat via CAIP.
- **Cloudflare paidTool**: GA. x402 powered. Drop-in `tool()` replacement. HIGH overlap risk.
- **PayGated**: v10.9.0. Prepaid credits (grants/priority/expiry/rollover), Stripe auto-topup, key hierarchy, sandbox, revenue share, multi-currency. STRONG overlap.
- **Nevermined**: GA. Stripe OAuth + crypto. MCP+A2A+x402+AP2. Sub-$0.001 tx. STRONG overlap on billing features.
- **Key insight**: Payment rails (MPP, x402) are commoditized. Billing proxies (PayGated) are mature. Toolgate's moat is EXECUTION INTELLIGENCE: ExecutionPolicy, graceful fallback, cost estimation, postpaid metering. No competitor has these.
```

**Update DEFERRED section — replace Multi-Protocol to reflect reality:**

```markdown
### DONE: Rail Adapters (MPP, x402, Stripe)
Status: IMPLEMENTED — real adapters using mppx and @x402/core
StripeRailAdapter: production
MppRailAdapter: production (requires `npm i mppx`)
X402RailAdapter: production (requires `npm i @x402/core`)
```

**Update test count** from 95 to 105 (or actual count after Phase 6).

### 7.4 — `landing/index.html`

**Update hero subtitle** (if any "fiat-first" remains):
```
"Graceful fallback. Programmable billing decisions. Post-execution metering. Any payment rail."
```

**Add "Works with" badges after hero:**
```html
<div class="flex flex-wrap justify-center gap-3 mt-8 mb-4">
  <span class="px-4 py-2 rounded-full border border-border text-sm text-muted">Stripe (fiat)</span>
  <span class="px-4 py-2 rounded-full border border-border text-sm text-muted">MPP (Stripe + Tempo)</span>
  <span class="px-4 py-2 rounded-full border border-border text-sm text-muted">x402 (Coinbase)</span>
  <span class="px-4 py-2 rounded-full border border-border text-sm text-muted">Custom rails</span>
</div>
```

**Add "Rail-Agnostic by Design" to features section:**
Title: "Rail-agnostic by design"
Body: "Stripe today. MPP and x402 built in. Toolgate doesn't collect payments — it controls what happens at the billing decision point. Swap the settlement layer without changing your billing logic."

**Update comparison table** — add "Payment rails" row:
```
| Payment rails | x402 only | x402 only | x402 only | Stripe + MPP + x402 |
```

---

## Phase 8: Final Verification

### 8.1 — Run full test suite

```bash
node --test src/__tests__/paidTool.test.mjs src/__tests__/mcp-adapter.test.mjs src/__tests__/stripe.test.mjs src/__tests__/webhook-handler.test.mjs src/__tests__/db-ledger.test.mjs src/__tests__/rail-adapter.test.mjs
```

**Must be 105+ passing, 0 failing.**

### 8.2 — TypeScript build check

```bash
npx tsc --noEmit
```

**Must compile with zero errors.**

### 8.3 — Verify exports

```bash
node -e "const t = require('./dist/index.js'); console.log(Object.keys(t))"
```

Must include: ToolGate, InMemoryLedger, McpAdapter, createMcpAdapter, StripeAdapter, WebhookHandler, DbLedger, StripeRailAdapter, MppRailAdapter, X402RailAdapter

### 8.4 — Verify peer dependency errors are helpful

```bash
# In a fresh directory without mppx installed:
node -e "const { MppRailAdapter } = require('@tkorkmaz/toolgate'); new MppRailAdapter({ methods: [] })"
# Should throw: "mppx package not found. Install it: npm install mppx"
```

---

## Summary: Files Changed

### CREATED (new files):
| File | Purpose |
|---|---|
| `src/rail-adapters/stripe-rail.ts` | Stripe settlement adapter (real) |
| `src/rail-adapters/mpp-rail.ts` | MPP settlement adapter using mppx (real) |
| `src/rail-adapters/x402-rail.ts` | x402 settlement adapter using @x402/core (real) |
| `src/rail-adapters/index.ts` | Barrel exports |
| `src/__tests__/rail-adapter.test.mjs` | 10 tests for rail adapters |

### MODIFIED (existing files):
| File | Changes |
|---|---|
| `src/types.ts` | PaymentMode, RailAdapter, ChallengeParams, SettlementAction, PaymentProof, VerificationResult, updated CreditMeta, updated ToolGateConfig, updated PaymentRequiredResponse |
| `src/index.ts` | Export new types + rail adapter classes |
| `src/toolgate.ts` | Store railAdapters + paymentMode in config, use adapters in handlePaymentFailure |
| `package.json` | version bump, description, keywords, peerDependencies, test script |
| `README.md` | Opening, new Rail-Agnostic section |
| `llms.txt` | Header, one-liner, strategy, ecosystem status, test count |
| `landing/index.html` | Hero subtitle, Works With badges, comparison table, new feature section |

### UNCHANGED:
| File | Why |
|---|---|
| `src/ledger.ts` | No changes needed |
| `src/mcp-adapter.ts` | Settlements flow through ToolCallResult automatically |
| `src/mcp-types.ts` | No changes needed |
| `src/stripe-adapter.ts` | Still works independently |
| `src/webhook-handler.ts` | Still works independently |
| `src/db-ledger.ts` | Still works independently |
| All existing test files | No modifications |
| `src/demo-server.mjs` | No changes needed |

### DELETED:
| File | Why |
|---|---|
| `POST_SESSIONS_SPEC.md` | Superseded by this file |
| `src/rail-adapters/mpp-rail.stub.ts` | Replaced by real implementation |
| `src/rail-adapters/x402-rail.stub.ts` | Replaced by real implementation |

### Execution order:
```
Phase 1 (types)          → additive, no runtime risk
Phase 2 (MppRailAdapter) → new file, peer dep
Phase 3 (X402RailAdapter)→ new file, peer dep
Phase 4 (StripeRailAdapter) → new file, extracts existing logic
Phase 5 (wire into core) → small change in toolgate.ts
Phase 6 (tests)          → validates Phases 1-5
Phase 7 (messaging)      → text only
Phase 8 (verification)   → final check
```

Each phase is independently committable. Stop and fix if any phase breaks tests.

---

## Future Work (NOT in this spec — implement only after PMF validation)

| Feature | Trigger |
|---|---|
| `paymentMode: "per_request"` full flow | First publisher asks for zero-balance per-request mode |
| Inline payment verification in executeTool | Per-request mode needs this |
| MCP transport-level MPP (JSON-RPC 32042) | When MCP agents start sending Payment headers |
| Multi-package split (@toolgate/core, @toolgate/rail-mpp) | When dependency tree becomes a concern |
| Dashboard + analytics | When 3+ publishers ask for revenue visibility |
