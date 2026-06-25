/**
 * x402 Solana — end-to-end through the MCP adapter (offline, CI-friendly).
 *
 * Exercises the full paid-tool lifecycle on the Solana rail without a real
 * validator: a fake in-process facilitator answers /supported, /verify, and
 * /settle over localhost, so X402RailAdapter's real fetch calls run, and the
 * MCP adapter's built-in verify → credit → execute → settle path is driven with
 * the packaged Solana signer.
 *
 *   1. 402 discovery: a paid MCP tool with no balance returns an x402 Solana
 *      challenge in _meta (network, mint, actionId).
 *   2. Sign: the packaged buildSolanaPaymentPayload() turns it into a
 *      partial-signed SVM payload.
 *   3. Pay: retrying with the proof in _meta.tollgate verifies, credits,
 *      executes, and settles — the trace shows rail_payment_verified +
 *      rail_payment_settled with the on-chain tx signature.
 *
 * Run: node --test src/__tests__/x402-solana-e2e.test.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { Keypair } from "@solana/web3.js";
import {
  ToolGate,
  InMemoryLedger,
  createMcpAdapter,
  X402RailAdapter,
  buildSolanaPaymentPayload,
  usd,
} from "../../dist/index.js";

const DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SETTLE_SIG =
  "5wHu1qwD4kT2example9signatureBase58oNSolanaDevnet11111111111";

const payer = Keypair.generate();
const recipient = Keypair.generate();
const feePayer = Keypair.generate();
const fixedBlockhash = Keypair.generate().publicKey.toBase58();

// ─── Fake in-process x402 facilitator ─────────────────────

let server;
let facilitatorUrl;
const facilitatorCalls = [];

function jsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () =>
      resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}),
    );
  });
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const send = (obj) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET" && req.url.endsWith("/supported")) {
      facilitatorCalls.push("supported");
      return send({
        kinds: [
          {
            x402Version: 2,
            scheme: "exact",
            network: DEVNET_CAIP2,
            extra: { feePayer: feePayer.publicKey.toBase58() },
          },
        ],
      });
    }
    const body = await jsonBody(req);
    if (req.url.endsWith("/verify")) {
      facilitatorCalls.push("verify");
      // A real facilitator validates the partial-signed tx here.
      return send({ isValid: true, payer: payer.publicKey.toBase58() });
    }
    if (req.url.endsWith("/settle")) {
      facilitatorCalls.push("settle");
      return send({ success: true, transaction: SETTLE_SIG, payer: payer.publicKey.toBase58() });
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0);
  await once(server, "listening");
  facilitatorUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

// ─── Harness ──────────────────────────────────────────────

async function buildGate() {
  const ledger = new InMemoryLedger(); // zero balance
  const rail = new X402RailAdapter({
    payTo: recipient.publicKey.toBase58(),
    network: { kind: "solana", caip2: DEVNET_CAIP2 },
    facilitatorUrl,
  });
  // Pull the fee payer from /supported so challenges carry extra.feePayer.
  await rail.discoverFeePayer();

  const gate = new ToolGate({
    publisherKey: "tg_sol_e2e",
    ledger,
    paymentRails: ["x402"],
    railAdapters: [rail],
  });
  const mcp = createMcpAdapter(gate, { getCallerId: () => "agent_sol" });

  const tool = mcp.paidTool("premium_search", {
    description: "Premium search, paid per call.",
    price: usd("0.05"),
    onPaymentFailed: "block",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, requestId: { type: "string" } },
      required: ["query", "requestId"],
    },
    idempotencyKey: (args) => `premium_search:${args.requestId}`,
    handler: async (args) => ({ tier: "premium", query: args.query }),
  });

  return { gate, rail, tool };
}

// ─── Tests ────────────────────────────────────────────────

describe("x402 Solana — MCP end-to-end", () => {
  it("returns an x402 Solana challenge when the caller has no balance", async () => {
    const { tool } = await buildGate();

    const res = await tool.handler(
      { query: "vector dbs", requestId: "disc-1" },
      {},
    );

    assert.equal(res.isError, true, "no balance → payment required");
    assert.equal(res._meta.tollgate.paymentRequired, true);
    const challenge = res._meta.x402;
    assert.ok(challenge, "challenge block present in _meta.x402");
    assert.equal(challenge.x402Version, 2, "Solana forces x402 v2");
    const req = challenge.accepts[0];
    assert.equal(req.network, DEVNET_CAIP2);
    assert.equal(req.asset, DEVNET_USDC, "asset is the devnet USDC mint");
    assert.equal(
      req.extra.feePayer,
      feePayer.publicKey.toBase58(),
      "fee payer discovered from /supported and surfaced to the client",
    );
    assert.ok(res._meta.tollgate.x402ActionId, "actionId present for retry");
  });

  it("verifies, executes, and settles when retried with a signed proof", async () => {
    const { tool, gate } = await buildGate();

    // 1) discover the challenge
    const challengeRes = await tool.handler(
      { query: "vector dbs", requestId: "disc-2" },
      {},
    );
    const challenge = challengeRes._meta.x402;
    const actionId = challengeRes._meta.tollgate.x402ActionId;

    // 2) sign it (offline — fixed blockhash, no RPC)
    const { paymentPayload } = await buildSolanaPaymentPayload({
      challenge: { x402PaymentRequired: challenge },
      payerSecretKey: payer.secretKey,
      blockhash: fixedBlockhash,
    });

    // 3) pay: retry with the proof in _meta (fresh requestId → fresh idem key)
    const paidRes = await tool.handler(
      { query: "vector dbs", requestId: "pay-2" },
      {
        _meta: {
          tollgate: { x402Payment: paymentPayload, x402ActionId: actionId },
        },
      },
    );

    assert.notEqual(paidRes.isError, true, "paid call should succeed");
    const payload = JSON.parse(paidRes.content[0].text);
    assert.equal(payload.tier, "premium");
    assert.equal(payload.query, "vector dbs");

    // facilitator saw verify then settle
    assert.ok(facilitatorCalls.includes("verify"));
    assert.ok(facilitatorCalls.includes("settle"));

    // 4) the trace records verify + on-chain settle with the tx signature
    const trace = await gate.traces.findByIdempotencyKey(
      "premium_search:pay-2",
    );
    assert.ok(trace, "trace exists for the paid call");
    assert.equal(trace.handlerStatus, "success");
    const events = trace.events.map((e) => e.event);
    assert.ok(
      events.includes("rail_payment_verified"),
      "verify event recorded",
    );
    assert.ok(
      events.includes("rail_payment_settled"),
      "settle event recorded",
    );
    assert.equal(
      trace.provider?.traceId,
      SETTLE_SIG,
      "on-chain tx signature attached to the trace",
    );
  });
});
