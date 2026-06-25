/**
 * x402 Solana end-to-end settle (devnet by default, mainnet opt-in).
 *
 * Real run against a live facilitator (default: PayAI):
 *   discoverFeePayer → createChallenge → sign (partial) → /verify → /settle
 *
 * It is a SELF-TRANSFER smoke test by default (payTo = payer), so you only need
 * ONE funded account: the payer's USDC ATA. On devnet, fund it at
 * https://faucet.circle.com ("Solana Devnet"). On MAINNET, fund the printed
 * address with a small amount of real USDC — self-transfer means no net loss
 * (the facilitator pays the gas), so ~0.01 USDC is plenty.
 *
 * Env:
 *   SOLANA_NETWORK        "devnet" (default) or "mainnet"
 *   SOLANA_PAYER_SECRET   base58 or JSON-array secret key. If unset, a keypair
 *                         is generated and written to PAYER_KEYPAIR_PATH.
 *   PAYER_KEYPAIR_PATH    default: ./.<network>-payer.json (gitignored scratch)
 *   X402_FACILITATOR_URL  default: https://facilitator.payai.network
 *   SOLANA_RPC_URL        default: cluster public RPC for the chosen network
 *   NETWORK_CAIP2         override the CAIP-2 network id
 *   USDC_MINT             override the USDC mint
 *   PAY_TO                optional recipient override (default: self)
 *   AMOUNT_USDC           default: 0.001
 *
 * Usage:
 *   node examples/x402-solana-recovery/devnet-settle.mjs                 # devnet
 *   SOLANA_NETWORK=mainnet SOLANA_RPC_URL=... node …/devnet-settle.mjs   # mainnet
 */

import { readFile, writeFile } from "node:fs/promises";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import { X402RailAdapter } from "../../dist/rail-adapters/x402-rail.js";
import { buildSolanaPaymentPayload } from "./sign-payload.mjs";

const NETWORK = (process.env.SOLANA_NETWORK ?? "devnet").toLowerCase();
const IS_MAINNET = NETWORK === "mainnet" || NETWORK === "mainnet-beta";

const NETWORKS = {
  devnet: {
    caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    rpc: "https://api.devnet.solana.com",
    cluster: "devnet",
  },
  mainnet: {
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    rpc: "https://api.mainnet-beta.solana.com",
    cluster: "mainnet-beta",
  },
};
const NET = IS_MAINNET ? NETWORKS.mainnet : NETWORKS.devnet;

const NETWORK_CAIP2 = process.env.NETWORK_CAIP2 ?? NET.caip2;
const USDC_MINT = process.env.USDC_MINT ?? NET.usdc;
const CLUSTER = NET.cluster;

const FACILITATOR =
  process.env.X402_FACILITATOR_URL ?? "https://facilitator.payai.network";
const RPC_URL = process.env.SOLANA_RPC_URL ?? NET.rpc;
const KEYPAIR_PATH =
  process.env.PAYER_KEYPAIR_PATH ??
  (IS_MAINNET ? "./.mainnet-payer.json" : "./.devnet-payer.json");
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

  const mint = new PublicKey(USDC_MINT);
  const payerAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
  const connection = new Connection(RPC_URL, "confirmed");

  console.log(`── x402 Solana ${CLUSTER} settle ──`);
  console.log("Payer       :", payer.publicKey.toBase58());
  console.log("Payer USDC ATA:", payerAta.toBase58());
  console.log("Pay to      :", payTo.toBase58());
  console.log("Facilitator :", FACILITATOR);
  console.log("Amount      :", AMOUNT_USDC, "USDC");

  // ── Preflight: does the payer hold USDC? ──
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
    if (IS_MAINNET) {
      console.log("\n⚠️  Not funded. Send a small amount of real USDC to:");
      console.log("   ", payer.publicKey.toBase58());
      console.log("   (self-transfer → no net loss; facilitator pays gas). Then re-run.");
    } else {
      console.log("\n⚠️  Not funded. Fund this address with devnet USDC:");
      console.log("   1) Open https://faucet.circle.com");
      console.log('   2) Network "Solana Devnet", paste:', payer.publicKey.toBase58());
      console.log("   3) Re-run this script.");
    }
    process.exit(2);
  }

  // ── Rail: discover fee payer + build challenge ──
  const rail = new X402RailAdapter({
    payTo: payTo.toBase58(),
    network: { kind: "solana", caip2: NETWORK_CAIP2 },
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
    `https://explorer.solana.com/tx/${settled.txHash}?cluster=${CLUSTER}`,
  );
}

main().catch((err) => {
  console.error("\n✖", err?.message ?? err);
  process.exit(1);
});
