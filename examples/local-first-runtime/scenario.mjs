/**
 * Tollgate — Local-First Runtime Example
 *
 * Runs entirely in-memory. No Stripe, x402, MPP, wallets, webhooks,
 * hosted APIs, or environment variables required.
 *
 *   npm run example:local
 *
 * It demonstrates the six edge cases Tollgate exists to handle:
 *   A. Fallback when the caller has no balance (no charge).
 *   B. Block → payment_required (402) when the caller has no balance.
 *   C. Paid execution after a local ledger credit.
 *   D. Idempotent duplicate replay (same requestId → no double charge).
 *   E. Handler failure recovery (charge is credited back).
 *   F. Execution trace inspection.
 */

import { TollGate, InMemoryLedger, usd } from "../../dist/index.js";

const CALLER = "demo-agent";

// A shared ledger so every flow sees the same balance.
const ledger = new InMemoryLedger();

const gate = new TollGate({
  publisherKey: "tg_local_demo",
  paymentRails: ["stripe"], // illustrative only — never contacted in this demo
  topUpBaseUrl: "https://your-topup-endpoint.example/pay",
  ledger,
});

// ─── Helpers ────────────────────────────────────────────────

function heading(title) {
  console.log(`\n${"─".repeat(60)}\n${title}\n${"─".repeat(60)}`);
}

async function printBalance(label) {
  const bal = await ledger.getBalance(CALLER);
  console.log(`  ${label}: $${(Number(bal.minorUnits) / 100).toFixed(2)}`);
}

// ─── Paid tool: premium_search ──────────────────────────────

const premiumSearch = gate.paidTool({
  name: "premium_search",
  description: "AI-powered search with deep analysis.",
  price: usd("0.05"),
  onPaymentFailed: "fallback",
  idempotencyKey: (input) => `premium_search:${input?.requestId ?? "no-id"}`,
  handler: async (input) => ({
    tier: "premium",
    query: input?.query,
    results: ["deep-result-1", "deep-result-2", "deep-result-3"],
  }),
  fallback: async (input) => ({
    tier: "free",
    query: input?.query,
    results: ["basic-result-1"],
    note: "Served from fallback — caller had no balance, no charge made.",
  }),
});

// A "block" variant that returns 402 instead of a fallback.
const premiumSearchBlock = gate.paidTool({
  name: "premium_search_block",
  description: "Same search, but blocks instead of falling back.",
  price: usd("0.05"),
  onPaymentFailed: "block",
  handler: async (input) => ({ tier: "premium", query: input?.query }),
});

// A tool whose handler throws AFTER it is charged — to show recovery.
const flakyEnrich = gate.paidTool({
  name: "flaky_enrich",
  description: "Charges, then throws — used to demonstrate recovery.",
  price: usd("0.10"),
  onPaymentFailed: "block",
  idempotencyKey: (input) => `flaky_enrich:${input?.requestId ?? "no-id"}`,
  handler: async () => {
    throw new Error("upstream provider exploded after charge");
  },
});

// ─── A. Fallback without balance ────────────────────────────

heading("A. Fallback without balance (onPaymentFailed: 'fallback')");
{
  const res = await premiumSearch(
    { query: "vector databases", requestId: "req-A" },
    CALLER,
  );
  console.log("  success      :", res.success);
  console.log("  isFallback   :", res.isFallback);
  console.log("  charged      :", res.receipt ? "yes" : "no");
  console.log("  output       :", JSON.stringify(res.output));
  await printBalance("balance");
}

// ─── B. Block / payment_required without balance ────────────

heading("B. Block → payment_required (onPaymentFailed: 'block')");
{
  const res = await premiumSearchBlock(
    { query: "vector databases", requestId: "req-B" },
    CALLER,
  );
  const pr = res.paymentRequired;
  console.log("  success      :", res.success);
  console.log("  status       :", pr?.status, pr?.error);
  console.log("  amount       :", `$${pr?.amount?.toFixed(2)} ${pr?.currency}`);
  console.log("  acceptedRails:", pr?.acceptedRails?.join(", "));
  console.log("  topUpUrl     :", pr?.topUpUrl);
}

// ─── C. Paid execution after local credit ───────────────────

heading("C. Paid execution after a local ledger credit");
{
  await ledger.credit(CALLER, usd("1.00"), {
    source: "manual",
    reference: "demo-credit-1",
  });
  await printBalance("balance before");

  const res = await premiumSearch(
    { query: "rust async runtimes", requestId: "req-C" },
    CALLER,
  );
  console.log("  success      :", res.success);
  console.log("  isFallback   :", res.isFallback ?? false);
  console.log("  output       :", JSON.stringify(res.output));
  if (res.receipt) {
    console.log(
      "  receipt      :",
      `$${res.receipt.amount.toFixed(2)} via ${res.receipt.rail}` +
        ` → balanceAfter $${res.receipt.balanceAfter.toFixed(2)}`,
    );
  }
  await printBalance("balance after");
}

// ─── D. Idempotent duplicate replay ─────────────────────────

heading("D. Idempotent duplicate replay (same requestId)");
{
  const input = { query: "graph databases", requestId: "req-D" };

  const first = await premiumSearch(input, CALLER);
  await printBalance("balance after 1st call");

  const second = await premiumSearch(input, CALLER);
  await printBalance("balance after 2nd call");

  console.log("  1st charged  :", first.receipt ? "yes" : "no");
  console.log(
    "  2nd outputs match 1st:",
    JSON.stringify(first.output) === JSON.stringify(second.output),
  );
  console.log("  → second call replayed previous result, no double deduct.");
}

// ─── E. Handler failure recovery ────────────────────────────

heading("E. Handler failure recovery (charge credited back)");
{
  await printBalance("balance before");
  const res = await flakyEnrich(
    { query: "enrich me", requestId: "req-E" },
    CALLER,
  );
  console.log("  success      :", res.success);
  await printBalance("balance after (charge recovered)");

  const trace = await gate.traces.findByIdempotencyKey("flaky_enrich:req-E");
  console.log("  recoveryAction:", trace?.recoveryAction);
  console.log("  chargeStatus  :", trace?.chargeStatus);
  console.log("  failureClass  :", trace?.failureClass);
}

// ─── F. Trace inspection ────────────────────────────────────

heading("F. Execution traces");
{
  const traces = await gate.traces.list({ limit: 50 });
  const rows = traces.map((t) => ({
    tool: t.toolName,
    decision: t.decision,
    charge: t.chargeStatus,
    fallback: t.fallbackUsed,
    handler: t.handlerStatus,
    recovery: t.recoveryAction ?? "-",
    failure: t.failureClass ?? "-",
  }));
  console.table(rows);
}

console.log(
  "\nDone. Everything above ran in-memory with no external services.\n",
);
