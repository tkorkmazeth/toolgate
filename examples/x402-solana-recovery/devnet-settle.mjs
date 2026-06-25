/**
 * x402 Solana DEVNET end-to-end settle.
 *
 * Real run against a live facilitator (default: PayAI) and Solana devnet:
 *   discoverFeePayer → createChallenge → sign (partial) → /verify → /settle
 *
 * It is a SELF-TRANSFER smoke test by default (payTo = payer), so you only need
 * ONE funded account: the payer's devnet USDC ATA. Fund it once at
 * https://faucet.circle.com (select "Solana Devnet") with the printed address.
 *
 * Env:
 *   SOLANA_PAYER_SECRET   base58 or JSON-array secret key. If unset, a keypair
 *                         is generated and written to PAYER_KEYPAIR_PATH.
 *   PAYER_KEYPAIR_PATH    default: ./.devnet-payer.json (gitignored scratch)
 *   X402_FACILITATOR_URL  default: https://facilitator.payai.network
 *   SOLANA_RPC_URL        default: https://api.devnet.solana.com
 *   PAY_TO                optional recipient override (default: self)
 *   AMOUNT_USDC           default: 0.001
 *
 * Usage:
 *   node examples/x402-solana-recovery/devnet-settle.mjs
 */

import { readFile, writeFile } from "node:fs/promises";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import { X402RailAdapter } from "../../dist/rail-adapters/x402-rail.js";
import { buildSolanaPaymentPayload } from "./sign-payload.mjs";

const DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const FACILITATOR =
  process.env.X402_FACILITATOR_URL ?? "https://facilitator.payai.network";
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const KEYPAIR_PATH =
  process.env.PAYER_KEYPAIR_PATH ?? "./.devnet-payer.json";
const AMOUNT_USDC = Number(process.env.AMOUNT_USDC ?? "0.001");

function parseSecret(raw) {
  raw = raw.trim();
  if (raw.startsWith("[")) return Uint8Array.from(JSON.parse(raw));
  // base58
  return Keypair.fromSecretKey(bs58Decode(raw)).secretKey;
}

// Tiny base58 decoder (avoid adding bs58 dep)
function bs58Decode(str) {
  const ALPHABET =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = [0];
  for (const ch of str) {
    const value = ALPHABET.indexOf(ch);
    if (value === -1) throw new Error("bad base58 char");
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of str) {
    if (ch === "1") bytes.push(0);
    else break;
  }
  return Uint8Array.from(bytes.reverse());
}

async function loadOrCreatePayer() {
  if (process.env.SOLANA_PAYER_SECRET) {
    return Keypair.fromSecretKey(parseSecret(process.env.SOLANA_PAYER_SECRET));
  }
  try {
    const raw = await readFile(KEYPAIR_PATH, "utf8");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch {
    const kp = Keypair.generate();
    await writeFile(KEYPAIR_PATH, JSON.stringify(Array.from(kp.secretKey)));
    return kp;
  }
}

async function main() {
  const payer = await loadOrCreatePayer();
  const payTo = process.env.PAY_TO
    ? new PublicKey(process.env.PAY_TO)
    : payer.publicKey;

  const mint = new PublicKey(DEVNET_USDC);
  const payerAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
  const connection = new Connection(RPC_URL, "confirmed");

  console.log("── x402 Solana devnet settle ──");
  console.log("Payer       :", payer.publicKey.toBase58());
  console.log("Payer USDC ATA:", payerAta.toBase58());
  console.log("Pay to      :", payTo.toBase58());
  console.log("Facilitator :", FACILITATOR);
  console.log("Amount      :", AMOUNT_USDC, "USDC");

  // ── Preflight: does the payer hold devnet USDC? ──
  let balance = 0n;
  try {
    const acct = await getAccount(connection, payerAta);
    balance = acct.amount;
  } catch {
    /* ATA does not exist yet */
  }
  const needed = BigInt(Math.round(AMOUNT_USDC * 1e6));
  console.log("Balance     :", Number(balance) / 1e6, "USDC");
  if (balance < needed) {
    console.log("\n⚠️  Not funded. Fund this address with devnet USDC:");
    console.log("   1) Open https://faucet.circle.com");
    console.log('   2) Network "Solana Devnet", paste:', payer.publicKey.toBase58());
    console.log("   3) Re-run this script.");
    process.exit(2);
  }

  // ── Rail: discover fee payer + build challenge ──
  const rail = new X402RailAdapter({
    payTo: payTo.toBase58(),
    network: { kind: "solana", caip2: DEVNET_CAIP2 },
    facilitatorUrl: FACILITATOR,
  });

  const feePayer = await rail.discoverFeePayer();
  console.log("Fee payer   :", feePayer ?? "(none advertised!)");
  if (!feePayer) process.exit(1);

  const action = await rail.createChallenge({
    callerId: payer.publicKey.toBase58(),
    amount: AMOUNT_USDC,
    currency: "usd",
    toolName: "devnet_smoke",
    publisherKey: "tg_devnet",
  });

  // ── Sign (partial) ──
  const { paymentPayload, memo } = await buildSolanaPaymentPayload({
    challenge: action,
    payerSecretKey: payer.secretKey,
    rpcUrl: RPC_URL,
  });
  console.log("Memo nonce  :", memo);

  const proof = { rail: "x402", x402PaymentPayload: paymentPayload };
  const context = { actionId: action.actionId };

  // ── Verify ──
  const verified = await rail.verifyPayment(proof, context);
  console.log("\n/verify →", verified ? "VALID ✅" : "INVALID ❌");
  if (!verified) process.exit(1);

  // ── Settle ──
  const settled = await rail.settlePayment(proof, context);
  if (!settled) {
    console.log("/settle → FAILED ❌ (settlement uncertain)");
    process.exit(1);
  }
  console.log("/settle → SETTLED ✅");
  console.log("tx          :", settled.txHash);
  console.log(
    "explorer    :",
    `https://explorer.solana.com/tx/${settled.txHash}?cluster=devnet`,
  );
}

main().catch((err) => {
  console.error("\n✖", err?.message ?? err);
  process.exit(1);
});
