import { randomBytes } from "node:crypto";
import type { VersionedTransaction } from "@solana/web3.js";

// ─── x402 Solana (SVM) client-side signer ─────────────────
//
// Turns a Tollgate 402 challenge into an x402 "exact" payment payload for
// Solana. Solana has no EIP-712 / EIP-3009; the SVM "exact" scheme instead has
// the client build and PARTIALLY sign a real SPL transfer, leaving the fee-payer
// signature empty for the facilitator to fill at /settle:
//
//   1. ComputeBudget: set unit limit + unit price (price ≤ 5 microLamports/CU)
//   2. SPL TransferChecked: payer ATA → recipient ATA, exact atomic amount
//   3. Memo: a random nonce (or seller-provided memo) for payment uniqueness
//   fee payer = requirement.extra.feePayer (the facilitator), NOT the client
//
// @solana/web3.js and @solana/spl-token are imported dynamically and declared as
// optional peer dependencies, so installing Tollgate stays light for callers
// that never sign on Solana.

const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/** Max compute-unit price the SVM "exact" scheme allows (microLamports/CU). */
const MAX_CU_PRICE = 5;

/** A facilitator-validated x402 v2 payment payload, ready for the X-PAYMENT header. */
export interface SolanaPaymentPayload {
  x402Version: 2;
  accepted: Record<string, unknown>;
  payload: { transaction: string };
}

export interface SolanaPaymentRequirement {
  scheme?: string;
  network: string;
  maxAmountRequired?: string;
  amount?: string;
  asset: string;
  payTo: string;
  resource?: string;
  description?: string;
  maxTimeoutSeconds?: number;
  extra?: { feePayer?: string; decimals?: number; [k: string]: unknown };
}

export interface BuildSolanaPaymentInput {
  /** Tollgate 402 response, the raw x402 block, or a single requirement. */
  challenge: unknown;
  /** Client wallet secret key (64-byte Uint8Array). */
  payerSecretKey: Uint8Array;
  /** RPC endpoint used to fetch a recent blockhash (omit if `blockhash` is given). */
  rpcUrl?: string;
  /** Explicit recent blockhash — skips RPC (useful for tests/offline signing). */
  blockhash?: string;
  /** Override the memo (defaults to a random 16-byte hex nonce). */
  memo?: string;
  /**
   * Compute-unit limit. Bounded by the SVM "exact" scheme: facilitators reject
   * limits that are too high (~50k+) and a transfer needs more than ~10k, so
   * the default sits comfortably between.
   */
  computeUnitLimit?: number;
  /** Compute-unit price in microLamports/CU (clamped to ≤ 5). */
  computeUnitPrice?: number;
}

export interface BuildSolanaPaymentResult {
  paymentPayload: SolanaPaymentPayload;
  transaction: VersionedTransaction;
  memo: string;
}

async function loadSolana() {
  try {
    const [web3, splToken] = await Promise.all([
      import("@solana/web3.js"),
      import("@solana/spl-token"),
    ]);
    return { web3, splToken };
  } catch (cause) {
    throw new Error(
      "x402 Solana signing requires @solana/web3.js and @solana/spl-token.\n" +
        "Install them: npm install @solana/web3.js @solana/spl-token",
      { cause },
    );
  }
}

/**
 * Pull the first payment requirement out of a Tollgate 402 response, whether it
 * arrives as the raw x402PaymentRequired block or a Tollgate settlement entry.
 */
export function extractSolanaRequirement(
  challenge: unknown,
): SolanaPaymentRequirement {
  const c = challenge as Record<string, any> | undefined;
  const block =
    c?.x402PaymentRequired ?? c?.paymentRequired?.x402Challenge ?? c;
  const accepts = block?.accepts ?? c?.accepts;
  const requirement = Array.isArray(accepts) ? accepts[0] : block;

  if (!requirement?.asset || !requirement?.payTo || !requirement?.network) {
    throw new Error(
      "Challenge does not contain a usable Solana x402 payment requirement " +
        "(missing asset/payTo/network).",
    );
  }
  if (!String(requirement.network).startsWith("solana:")) {
    throw new Error(
      `Requirement network "${requirement.network}" is not a Solana network.`,
    );
  }
  return requirement as SolanaPaymentRequirement;
}

/**
 * Build a base64, partially-signed x402 SVM payment payload from a 402
 * challenge. The client signs only its own slot; the fee-payer signature stays
 * empty for the facilitator to fill at /settle.
 */
export async function buildSolanaPaymentPayload(
  input: BuildSolanaPaymentInput,
): Promise<BuildSolanaPaymentResult> {
  const {
    challenge,
    payerSecretKey,
    rpcUrl,
    blockhash,
    memo,
    computeUnitLimit = 30_000,
    computeUnitPrice = 1,
  } = input;

  const { web3, splToken } = await loadSolana();
  const {
    Connection,
    Keypair,
    PublicKey,
    TransactionInstruction,
    TransactionMessage,
    VersionedTransaction,
    ComputeBudgetProgram,
  } = web3;
  const { getAssociatedTokenAddressSync, createTransferCheckedInstruction } =
    splToken;

  const requirement = extractSolanaRequirement(challenge);

  if (!requirement.extra?.feePayer) {
    throw new Error(
      "Solana requirement is missing extra.feePayer — the facilitator must " +
        "advertise a fee payer (X402RailConfig.feePayer / discoverFeePayer()).",
    );
  }

  const payer = Keypair.fromSecretKey(payerSecretKey);
  const mint = new PublicKey(requirement.asset);
  const recipient = new PublicKey(requirement.payTo);
  const feePayer = new PublicKey(requirement.extra.feePayer);
  const decimals = requirement.extra?.decimals ?? 6;
  const amount = BigInt(requirement.maxAmountRequired ?? requirement.amount!);

  const sourceAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
  // allowOwnerOffCurve:true so a PDA recipient (program-owned payTo) is allowed.
  const destAta = getAssociatedTokenAddressSync(mint, recipient, true);

  const memoText = memo ?? randomBytes(16).toString("hex");

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: Math.min(computeUnitPrice, MAX_CU_PRICE),
    }),
    createTransferCheckedInstruction(
      sourceAta,
      mint,
      destAta,
      payer.publicKey,
      amount,
      decimals,
    ),
    new TransactionInstruction({
      keys: [],
      programId: new PublicKey(MEMO_PROGRAM_ID),
      data: Buffer.from(memoText, "utf8"),
    }),
  ];

  let recentBlockhash = blockhash;
  if (!recentBlockhash) {
    if (!rpcUrl) {
      throw new Error("Provide either `blockhash` or `rpcUrl` to sign.");
    }
    const connection = new Connection(rpcUrl, "confirmed");
    ({ blockhash: recentBlockhash } = await connection.getLatestBlockhash());
  }

  const message = new TransactionMessage({
    payerKey: feePayer, // facilitator sponsors fees + signs at /settle
    recentBlockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);
  // Sign ONLY the client's slot — the fee-payer signature stays empty.
  transaction.sign([payer]);

  const serialized = Buffer.from(
    transaction.serialize(),
  ).toString("base64");

  // The x402 v2 PaymentPayload embeds the `accepted` requirement the client
  // agreed to. Facilitators validate the on-chain transaction against it and
  // expect the amount as an atomic STRING under `accepted.amount`.
  const accepted = {
    scheme: requirement.scheme ?? "exact",
    network: requirement.network,
    amount: String(requirement.maxAmountRequired ?? requirement.amount),
    asset: requirement.asset,
    payTo: requirement.payTo,
    maxTimeoutSeconds: requirement.maxTimeoutSeconds ?? 300,
    extra: requirement.extra,
  };

  return {
    paymentPayload: { x402Version: 2, accepted, payload: { transaction: serialized } },
    transaction,
    memo: memoText,
  };
}
