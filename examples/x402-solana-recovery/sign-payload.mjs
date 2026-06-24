/**
 * x402 Solana (SVM) client-side signer.
 *
 * Turns a Toolgate 402 challenge into an x402 "exact" payment payload for
 * Solana. This is the Solana counterpart to examples/x402-testnet-recovery/
 * sign-payload.mjs (which signs EIP-3009 authorizations for EVM).
 *
 * Solana has no EIP-712 / EIP-3009. The SVM "exact" scheme instead has the
 * client build and PARTIALLY sign a real SPL transfer transaction, leaving the
 * fee-payer signature empty for the facilitator to fill at /settle:
 *
 *   1. ComputeBudget: set unit limit + unit price (price ≤ 5 microLamports/CU)
 *   2. SPL TransferChecked: payer ATA → recipient ATA, exact atomic amount
 *   3. Memo: a random nonce (or seller-provided memo) for payment uniqueness
 *   fee payer = requirement.extra.feePayer (the facilitator), NOT the client
 *
 * The client signs only its own slot (partialSign), serializes with
 * requireAllSignatures:false, and base64-encodes the result into
 * payload.transaction.
 *
 * Heavy Solana deps are imported dynamically so the core SDK install stays
 * light — install @solana/web3.js and @solana/spl-token to use this helper.
 */

import { randomBytes } from "node:crypto";

const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/** Max compute-unit price the SVM "exact" scheme allows (microLamports/CU). */
const MAX_CU_PRICE = 5;

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
 * Pull the first payment requirement out of a Toolgate 402 response, whether it
 * arrives as the raw x402PaymentRequired block or a Toolgate settlement entry.
 */
export function extractSolanaRequirement(challenge) {
  const block =
    challenge?.x402PaymentRequired ??
    challenge?.paymentRequired?.x402Challenge ??
    challenge;
  const accepts = block?.accepts ?? challenge?.accepts;
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
  return requirement;
}

/**
 * Build a base64, partially-signed x402 SVM payment payload from a 402
 * challenge. Returns { paymentPayload, transaction, memo }.
 *
 * @param {object}   args
 * @param {object}   args.challenge       Toolgate 402 response (or x402 block)
 * @param {Uint8Array} args.payerSecretKey Client wallet secret key (64 bytes)
 * @param {string}  [args.rpcUrl]         RPC endpoint to fetch a recent blockhash
 * @param {string}  [args.blockhash]      Explicit blockhash (skips RPC; for tests)
 * @param {string}  [args.memo]           Override memo (defaults to a random nonce)
 * @param {number}  [args.computeUnitLimit=30000] Bounded by the SVM "exact"
 *   scheme: facilitators reject limits that are too high (~50k+) and a transfer
 *   needs more than ~10k, so the default sits comfortably in between.
 * @param {number}  [args.computeUnitPrice=1] microLamports/CU (clamped to ≤ 5)
 */
export async function buildSolanaPaymentPayload({
  challenge,
  payerSecretKey,
  rpcUrl,
  blockhash,
  memo,
  computeUnitLimit = 30_000,
  computeUnitPrice = 1,
}) {
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
  const {
    getAssociatedTokenAddressSync,
    createTransferCheckedInstruction,
  } = splToken;

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
  const amount = BigInt(requirement.maxAmountRequired ?? requirement.amount);

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
    transaction.serialize({ requireAllSignatures: false }),
  ).toString("base64");

  // The x402 v2 PaymentPayload embeds the `accepted` requirement the client
  // agreed to. Facilitators validate the on-chain transaction against it, and
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

  const paymentPayload = {
    x402Version: 2,
    accepted,
    payload: { transaction: serialized },
  };

  return { paymentPayload, transaction, memo: memoText };
}
