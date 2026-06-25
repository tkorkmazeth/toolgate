/**
 * x402 Solana (SVM) client-side signer — example entry point.
 *
 * The implementation now ships in the package itself:
 *   import { buildSolanaPaymentPayload } from "@niceberglabs/tollgate";
 *
 * This file just re-exports it from the built output so the local examples and
 * scenarios (devnet-settle.mjs, tests) keep importing from one place. Install
 * @solana/web3.js and @solana/spl-token to actually sign.
 */

export {
  buildSolanaPaymentPayload,
  extractSolanaRequirement,
} from "../../dist/rail-adapters/x402-solana-signer.js";
