/**
 * x402 Solana client-side signer tests (offline — no RPC, no validator).
 *
 * Proves the "Solana sign method + its output" half of the integration: given a
 * Toolgate 402 challenge, the signer produces a base64 partially-signed SVM
 * transaction wrapped as an x402 v2 payment payload, with the fee-payer slot
 * left empty for the facilitator.
 *
 * A fixed blockhash is injected so the test never touches the network.
 *
 * Run: node --test src/__tests__/x402-solana-sign.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import {
  buildSolanaPaymentPayload,
  extractSolanaRequirement,
} from "../../examples/x402-solana-recovery/sign-payload.mjs";

const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

function makeChallenge({ feePayer, payTo, amount = "50000" }) {
  return {
    x402PaymentRequired: {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: SOLANA_DEVNET,
          maxAmountRequired: amount,
          resource: "toolgate://tg_pub_test/premium_search",
          description: "Payment for premium_search",
          payTo,
          asset: DEVNET_USDC,
          maxTimeoutSeconds: 300,
          extra: { feePayer },
        },
      ],
    },
  };
}

describe("x402 Solana signer", () => {
  it("produces an x402 v2 SVM payload from a 402 challenge", async () => {
    const payer = Keypair.generate();
    const recipient = Keypair.generate();
    const facilitator = Keypair.generate();
    // Any 32-byte base58 string is a structurally valid blockhash for signing.
    const blockhash = Keypair.generate().publicKey.toBase58();

    const { paymentPayload, transaction, memo } =
      await buildSolanaPaymentPayload({
        challenge: makeChallenge({
          feePayer: facilitator.publicKey.toBase58(),
          payTo: recipient.publicKey.toBase58(),
        }),
        payerSecretKey: payer.secretKey,
        blockhash,
      });

    // ── payload envelope ──
    assert.equal(paymentPayload.x402Version, 2);
    // x402 v2 embeds the accepted requirement; amount is an atomic STRING.
    assert.equal(paymentPayload.accepted.scheme, "exact");
    assert.equal(paymentPayload.accepted.network, SOLANA_DEVNET);
    assert.equal(paymentPayload.accepted.amount, "50000");
    assert.equal(paymentPayload.accepted.asset, DEVNET_USDC);
    assert.equal(paymentPayload.accepted.extra.feePayer, facilitator.publicKey.toBase58());
    assert.ok(
      typeof paymentPayload.payload.transaction === "string",
      "transaction is a base64 string",
    );
    assert.ok(memo.length > 0, "a memo nonce was attached");

    // ── deserialize and inspect the actual transaction ──
    const bytes = Buffer.from(paymentPayload.payload.transaction, "base64");
    const decoded = VersionedTransaction.deserialize(bytes);
    const keys = decoded.message.staticAccountKeys.map((k) => k.toBase58());

    assert.equal(
      keys[0],
      facilitator.publicKey.toBase58(),
      "account[0] is the fee payer (the facilitator), not the client",
    );
    assert.equal(
      decoded.message.compiledInstructions.length,
      4,
      "2 compute-budget + 1 transferChecked + 1 memo = 4 instructions",
    );

    // Round-trip equality with the returned VersionedTransaction
    assert.equal(
      Buffer.from(transaction.serialize({ requireAllSignatures: false })).toString(
        "base64",
      ),
      paymentPayload.payload.transaction,
    );
  });

  it("leaves the fee-payer signature empty (partial sign)", async () => {
    const payer = Keypair.generate();
    const facilitator = Keypair.generate();
    const blockhash = Keypair.generate().publicKey.toBase58();

    const { transaction } = await buildSolanaPaymentPayload({
      challenge: makeChallenge({
        feePayer: facilitator.publicKey.toBase58(),
        payTo: Keypair.generate().publicKey.toBase58(),
      }),
      payerSecretKey: payer.secretKey,
      blockhash,
    });

    // Two required signers: [0]=feePayer (empty), [1]=client (filled).
    assert.equal(transaction.signatures.length, 2);
    const feePayerSig = transaction.signatures[0];
    const clientSig = transaction.signatures[1];
    assert.ok(
      feePayerSig.every((b) => b === 0),
      "fee-payer signature slot is all zeros (facilitator signs at /settle)",
    );
    assert.ok(
      clientSig.some((b) => b !== 0),
      "client signature is present",
    );
  });

  it("rejects a non-Solana or malformed requirement", async () => {
    await assert.rejects(
      () =>
        buildSolanaPaymentPayload({
          challenge: { x402PaymentRequired: { accepts: [{}] } },
          payerSecretKey: Keypair.generate().secretKey,
          blockhash: Keypair.generate().publicKey.toBase58(),
        }),
      /usable Solana x402 payment requirement/,
    );
  });

  it("requires extra.feePayer to be present", async () => {
    const challenge = makeChallenge({
      feePayer: undefined,
      payTo: Keypair.generate().publicKey.toBase58(),
    });
    // strip feePayer entirely
    delete challenge.x402PaymentRequired.accepts[0].extra.feePayer;

    await assert.rejects(
      () =>
        buildSolanaPaymentPayload({
          challenge,
          payerSecretKey: Keypair.generate().secretKey,
          blockhash: Keypair.generate().publicKey.toBase58(),
        }),
      /missing extra\.feePayer/,
    );
  });

  it("extractSolanaRequirement reads the first accepts entry", () => {
    const req = extractSolanaRequirement(
      makeChallenge({
        feePayer: Keypair.generate().publicKey.toBase58(),
        payTo: Keypair.generate().publicKey.toBase58(),
      }),
    );
    assert.equal(req.network, SOLANA_DEVNET);
    assert.equal(req.asset, DEVNET_USDC);
  });
});
