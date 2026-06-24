#!/usr/bin/env node

/**
 * Tollgate Demo MCP Server v2 — Phase 2 Showcase
 *
 * Demonstrates ALL Tollgate features including Phase 2:
 *   - Paid tools with static, dynamic, and tiered pricing
 *   - Graceful fallback on insufficient balance
 *   - ExecutionPolicy (programmatic per-call decisions)
 *   - Idempotency (duplicate request → same result, no double-charge)
 *   - Execution Trace (every call produces an audit trail)
 *   - paidAction() alias
 *   - Recovery scenarios: payment fail → fallback, error → refund, duplicate → previous result
 *
 * Setup in Claude Desktop config:
 * {
 *   "mcpServers": {
 *     "tollgate-demo": {
 *       "command": "node",
 *       "args": ["/path/to/tollgate-mvp/src/demo-server-v2.mjs"]
 *     }
 *   }
 * }
 *
 * Pre-loads $1.00 balance. 8 tools registered.
 */

import { createInterface } from "node:readline";

// ═══════════════════════════════════════════════════════════
// Inline SDK — Phase 2 (idempotency + trace + recovery)
// Self-contained: no build step, no imports needed
// ═══════════════════════════════════════════════════════════

class InMemoryLedger {
  constructor() { this.balances = new Map(); this.usage = new Map(); this.transactions = []; }
  async getBalance(id) { return this.balances.get(id) ?? 0; }
  async deduct(id, amount, meta) {
    const cur = this.balances.get(id) ?? 0;
    if (cur < amount) return false;
    this.balances.set(id, Math.round((cur - amount) * 1e6) / 1e6);
    this.transactions.push({ type: "deduct", callerId: id, amount, meta, ts: Date.now() });
    return true;
  }
  async credit(id, amount, meta) {
    const cur = this.balances.get(id) ?? 0;
    this.balances.set(id, Math.round((cur + amount) * 1e6) / 1e6);
    this.transactions.push({ type: "credit", callerId: id, amount, meta, ts: Date.now() });
  }
  async getUsage(id, tool, period) {
    const key = `${id}:${tool}:${new Date().toISOString().slice(0, 10)}`;
    return this.usage.get(key) ?? 0;
  }
  async incrementUsage(id, tool, period) {
    const key = `${id}:${tool}:${new Date().toISOString().slice(0, 10)}`;
    this.usage.set(key, (this.usage.get(key) ?? 0) + 1);
  }
}

class InMemoryIdempotencyStore {
  constructor() { this.store = new Map(); }
  async get(key) {
    const r = this.store.get(key);
    if (!r) return null;
    if (r.expiresAt < Date.now()) { this.store.delete(key); return null; }
    return r;
  }
  async set(record) { this.store.set(record.key, record); }
  async update(key, updates) {
    const ex = this.store.get(key);
    if (ex) this.store.set(key, { ...ex, ...updates, updatedAt: Date.now() });
  }
  async delete(key) { this.store.delete(key); }
  get size() { return this.store.size; }
}

class InMemoryTraceStore {
  constructor() { this.traces = []; this.byId = new Map(); this.byKey = new Map(); }
  async save(t) { this.traces.push(t); this.byId.set(t.traceId, t); this.byKey.set(t.idempotencyKey, t); }
  async get(id) { return this.byId.get(id) ?? null; }
  async getByIdempotencyKey(k) { return this.byKey.get(k) ?? null; }
  async list(f = {}) {
    let r = [...this.traces];
    if (f.callerId) r = r.filter(t => t.callerId === f.callerId);
    if (f.toolName) r = r.filter(t => t.toolName === f.toolName);
    if (f.limit) r = r.slice(-f.limit);
    return r;
  }
  get count() { return this.traces.length; }
}

function hashSync(input) {
  const str = JSON.stringify(input) ?? "";
  let hash = 5381;
  for (let i = 0; i < str.length; i++) { hash = ((hash << 5) + hash) ^ str.charCodeAt(i); hash = hash >>> 0; }
  return hash.toString(36);
}

function genCallId() { return `tg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

class TollGate {
  constructor(config) {
    this.config = {
      publisherKey: config.publisherKey,
      defaultCurrency: config.defaultCurrency ?? "usd",
      paymentRails: config.paymentRails ?? ["stripe"],
      ledger: config.ledger ?? new InMemoryLedger(),
      hooks: config.hooks,
      idempotencyStore: config.idempotencyStore ?? new InMemoryIdempotencyStore(),
      traceStore: config.traceStore ?? new InMemoryTraceStore(),
      idempotencyTtlSeconds: config.idempotencyTtlSeconds ?? 3600,
    };
    this.tools = new Map();
  }

  get ledger() { return this.config.ledger; }
  get traces() { return this.config.traceStore; }
  get idempotency() { return this.config.idempotencyStore; }

  paidTool(tc) { return this._register(tc); }
  paidAction(tc) { return this._register(tc); }

  _register(tc) {
    this.tools.set(tc.name, tc);
    const execute = (input, callerId) => this._exec(tc, input, callerId);
    execute.toolName = tc.name;
    execute.config = tc;
    return execute;
  }

  _resolveKey(tool, input, callerId) {
    if (typeof tool.idempotencyKey === "string") return tool.idempotencyKey;
    if (typeof tool.idempotencyKey === "function") return tool.idempotencyKey(input, callerId);
    return `auto_${tool.name}_${callerId}_${hashSync(input)}`;
  }

  async _handleDuplicate(tool, input, callerId, record, key) {
    const policy = tool.onDuplicate ?? "return_previous_result";
    if (tool.onDuplicateDetected) {
      await tool.onDuplicateDetected(input, record, { callerId, callId: record.traceId, tool: tool.name, tier: "premium", balance: await this.config.ledger.getBalance(callerId), timestamp: Date.now() });
    }
    if (policy === "return_previous_result") {
      if (record.status === "in_progress") return { success: false, output: { error: "Duplicate: previous execution still in progress.", idempotencyKey: key } };
      if (record.result) return record.result;
    }
    if (policy === "block") return { success: false, output: { error: "Duplicate request rejected.", idempotencyKey: key } };
    await this.config.idempotencyStore.delete(key);
    return this._exec(tool, input, callerId);
  }

  async _exec(tool, input, callerId) {
    const callId = genCallId();
    const now = Date.now();
    const ledger = this.config.ledger;

    // ── Idempotency check ──
    const idemKey = this._resolveKey(tool, input, callerId);
    const existing = await this.config.idempotencyStore.get(idemKey);
    if (existing) return this._handleDuplicate(tool, input, callerId, existing, idemKey);

    await this.config.idempotencyStore.set({
      key: idemKey, callerId, toolName: tool.name, inputHash: hashSync(input),
      status: "in_progress", traceId: callId, createdAt: now, updatedAt: now,
      expiresAt: now + this.config.idempotencyTtlSeconds * 1000,
    });

    // ── Trace init ──
    const trace = {
      traceId: callId, idempotencyKey: idemKey, callerId, toolName: tool.name,
      inputHash: hashSync(input), currency: this.config.defaultCurrency,
      decision: "execute", handlerStatus: "not_started", fallbackUsed: false,
      chargeStatus: "none", createdAt: now, updatedAt: now,
      events: [{ timestamp: now, event: "trace_created" }],
    };

    const finalize = async (result, traceUp = {}, iStatus) => {
      const fn = Date.now();
      Object.assign(trace, traceUp, { updatedAt: fn });
      trace.events.push({ timestamp: fn, event: "call_completed" });
      await this.config.traceStore.save(trace);
      const st = iStatus ?? (result.success ? "completed" : result.paymentRequired ? "requires_payment" : "failed");
      await this.config.idempotencyStore.update(idemKey, { status: st, result, updatedAt: fn });
      return result;
    };

    this.config.hooks?.onCall?.(tool.name, callerId);

    // ── Pricing ──
    let tier = "premium", price = 0, handler = tool.handler;
    if (tool.tiers) {
      if (tool.tiers.free) {
        const usage = await ledger.getUsage(callerId, tool.name, tool.tiers.free.period);
        if (usage < tool.tiers.free.limit) { tier = "free"; handler = tool.tiers.free.handler ?? tool.handler; }
        else { price = typeof tool.tiers.premium.price === "function" ? await tool.tiers.premium.price(input) : (tool.tiers.premium.price ?? 0); handler = tool.tiers.premium.handler ?? tool.handler; }
      }
    } else if (tool.price !== undefined && tool.price !== "postpaid") {
      price = typeof tool.price === "function" ? await tool.price(input) : tool.price;
    }
    trace.estimatedAmount = price;
    trace.events.push({ timestamp: Date.now(), event: "price_resolved", detail: `$${price}` });

    const ctx = { callerId, callId, tool: tool.name, tier, balance: await ledger.getBalance(callerId), timestamp: Date.now() };

    // ── Policy ──
    let skipPayment = false;
    if (tool.policy) {
      const usageToday = await ledger.getUsage(callerId, tool.name, "day");
      const decision = await tool.policy.decide({ callerId, tier, balance: ctx.balance, estimatedPrice: price, input, tool: tool.name, usageToday });
      trace.events.push({ timestamp: Date.now(), event: "policy_decided", detail: decision });

      if (decision === "fallback") {
        if (tool.fallback) {
          const fo = await tool.fallback(input, ctx);
          return finalize({ success: true, output: fo, isFallback: true }, { decision: "fallback_response", fallbackUsed: true }, "fallback_served");
        }
        this.config.hooks?.onError?.(tool.name, new Error(`Policy "fallback" but no handler for "${tool.name}"`));
      }
      if (decision === "payment_required") {
        const fr = this._payFail(tool, input, ctx, price);
        return finalize(fr, { decision: "topup_required" }, "requires_payment");
      }
      if (decision === "allow_once") skipPayment = true;
      if (decision === "estimate") {
        const est = tool.estimate ? await tool.estimate(input, { callerId, tier, balance: ctx.balance, input, tool: tool.name, usageToday }) : { estimatedPrice: price, currency: this.config.defaultCurrency };
        return finalize({ success: true, output: { type: "cost_estimate", ...est }, isFallback: false }, { decision: "execute" }, "completed");
      }
    }

    // ── Payment gate ──
    const isPostpaid = tool.price === "postpaid";
    const needsPay = tier === "premium" && price > 0 && !isPostpaid && !skipPayment;
    if (needsPay) {
      const ok = await ledger.deduct(callerId, price, { callId, tool: tool.name, amount: price });
      if (!ok) {
        const pfPolicy = tool.onPaymentFailed ?? "block";
        if (pfPolicy === "fallback" && tool.fallback) {
          const fo = await tool.fallback(input, ctx);
          return finalize({ success: true, output: fo, isFallback: true }, { decision: "fallback_response", fallbackUsed: true, failureClass: "insufficient_balance" }, "fallback_served");
        }
        if (pfPolicy === "allow_once") {
          skipPayment = true; // fall through to execution
        } else {
          const fr = this._payFail(tool, input, ctx, price);
          return finalize(fr, { decision: "topup_required", failureClass: "insufficient_balance" }, "requires_payment");
        }
      }
      if (!skipPayment) {
        this.config.hooks?.onPayment?.(tool.name, callerId, price);
        trace.chargeStatus = "charged";
        trace.rail = "prepaid";
      }
    }

    // ── Execute ──
    const startedAt = Date.now();
    trace.events.push({ timestamp: startedAt, event: "handler_started" });
    let output, metrics;
    try {
      output = await handler(input, ctx);
      const endedAt = Date.now();
      metrics = { durationMs: endedAt - startedAt, startedAt, endedAt };
    } catch (error) {
      const endedAt = Date.now();
      metrics = { durationMs: endedAt - startedAt, startedAt, endedAt };
      if (needsPay && !skipPayment) await ledger.credit(callerId, price, { source: "manual", reference: `refund:${callId}:error` });
      if (tool.onFail) await tool.onFail(input, error, ctx);
      return finalize(
        { success: false, output: { error: error.message }, metrics },
        { handlerStatus: "failed", durationMs: metrics.durationMs, chargeStatus: needsPay ? "refunded" : "none", failureClass: "tool_failed", refundReason: error.message },
        "failed",
      );
    }

    if (tier === "free" && tool.tiers?.free) await ledger.incrementUsage(callerId, tool.name, tool.tiers.free.period);

    if (isPostpaid && tool.meter) {
      const mr = await tool.meter(input, output, metrics);
      price = mr.amount;
      const ok = await ledger.deduct(callerId, price, { callId, tool: tool.name, amount: price });
      if (ok) { this.config.hooks?.onPayment?.(tool.name, callerId, price); trace.chargeStatus = "charged"; }
    }

    if (tool.afterExecute) await tool.afterExecute(input, output, metrics);
    const balAfter = await ledger.getBalance(callerId);

    return finalize(
      {
        success: true, output, metrics, isFallback: false,
        receipt: price > 0 ? { callId, tool: tool.name, amount: price, currency: this.config.defaultCurrency, rail: "prepaid", balanceAfter: balAfter, timestamp: Date.now() } : undefined,
      },
      { handlerStatus: "success", durationMs: metrics.durationMs, finalAmount: price, decision: skipPayment ? "allow_once" : "execute", chargeStatus: price > 0 && needsPay ? "charged" : "none" },
      "completed",
    );
  }

  _payFail(tool, input, ctx, req) {
    return {
      success: false,
      paymentRequired: { status: 402, error: "payment_required", tool: tool.name, amount: req, currency: this.config.defaultCurrency, acceptedRails: this.config.paymentRails, topUpUrl: `https://pay.tollgate.dev/topup?publisher=${this.config.publisherKey}&amount=${Math.ceil(req * 100)}` },
    };
  }
}

// ═══════════════════════════════════════════════════════════
// Demo Setup
// ═══════════════════════════════════════════════════════════

const ledger = new InMemoryLedger();
const gate = new TollGate({
  publisherKey: "tg_demo",
  ledger,
  idempotencyTtlSeconds: 300, // 5 min for demo
  hooks: {
    onCall: (tool, caller) => log(`[call] ${tool} by ${caller}`),
    onPayment: (tool, caller, amt) => log(`[payment] ${tool}: $${amt.toFixed(4)} from ${caller}`),
    onError: (tool, err) => log(`[error] ${tool}: ${err.message}`),
  },
});

await ledger.credit("demo-user", 1.00, { source: "manual", reference: "demo-preload" });
log(`[init] Pre-loaded $1.00 for demo-user`);

// ═══════════════════════════════════════════════════════════
// Tools — 8 tools showcasing all features
// ═══════════════════════════════════════════════════════════

const tools = {};

// ── Tool 1: Static pricing + fallback ────────────────────
tools["premium_search"] = {
  description: "AI-powered web search. $0.05/call. Falls back to basic results when balance is low. [Pricing: $0.05/call] [Has free basic mode]",
  inputSchema: { type: "object", properties: { query: { type: "string", description: "Search query" } }, required: ["query"] },
  gate: gate.paidTool({
    name: "premium_search",
    price: 0.05,
    onPaymentFailed: "fallback",
    handler: async (input) => ({
      type: "premium", query: input.query,
      results: [
        { title: `Deep analysis: ${input.query}`, relevance: 0.98 },
        { title: `Expert insights: ${input.query}`, relevance: 0.95 },
        { title: `Data report: ${input.query}`, relevance: 0.91 },
      ],
    }),
    fallback: async (input) => ({
      type: "basic", query: input.query,
      results: [{ title: `Basic: ${input.query}`, relevance: 0.7 }],
      note: "Top up for premium AI analysis.",
    }),
  }),
};

// ── Tool 2: Dynamic pricing ──────────────────────────────
tools["smart_translate"] = {
  description: "AI translation. Price scales with text length ($0.01/100 chars). [Pricing: dynamic]",
  inputSchema: { type: "object", properties: { text: { type: "string" }, targetLang: { type: "string" } }, required: ["text", "targetLang"] },
  gate: gate.paidTool({
    name: "smart_translate",
    price: (input) => Math.max(0.01, Math.ceil(String(input.text || "").length / 100) * 0.01),
    handler: async (input) => ({
      translated: `[${input.targetLang}] ${input.text}`,
      charCount: String(input.text || "").length,
      qualityScore: 0.94,
    }),
  }),
};

// ── Tool 3: Tiered access (3 free/day) ───────────────────
tools["data_lookup"] = {
  description: "Company data enrichment. 3 free lookups/day, then $0.03/call. [Pricing: 3 free/day, then $0.03]",
  inputSchema: { type: "object", properties: { company: { type: "string" } }, required: ["company"] },
  gate: gate.paidTool({
    name: "data_lookup",
    tiers: { free: { limit: 3, period: "day" }, premium: { price: 0.03 } },
    handler: async (input) => ({
      company: input.company,
      employees: Math.floor(Math.random() * 10000) + 100,
      revenue: `$${(Math.random() * 100).toFixed(1)}M`,
      sector: "Technology",
    }),
  }),
};

// ── Tool 4: Idempotent payment (NEW Phase 2) ─────────────
tools["process_invoice"] = {
  description: "Process a payment invoice. Idempotent: calling twice with same invoiceId returns the same result without double-charging. $0.10/call. [Pricing: $0.10/call] [Idempotent]",
  inputSchema: { type: "object", properties: { invoiceId: { type: "string", description: "Unique invoice ID" }, amount: { type: "number" } }, required: ["invoiceId", "amount"] },
  gate: gate.paidAction({  // Using paidAction() alias
    name: "process_invoice",
    price: 0.10,
    idempotencyKey: (input, callerId) => `invoice:${callerId}:${input.invoiceId}`,
    onDuplicate: "return_previous_result",
    onDuplicateDetected: async (input, record, ctx) => {
      log(`[idempotency] Duplicate invoice ${input.invoiceId} detected. Returning cached result (no charge).`);
    },
    handler: async (input) => ({
      invoiceId: input.invoiceId,
      amount: input.amount,
      status: "processed",
      confirmationCode: `INV-${Date.now().toString(36).toUpperCase()}`,
      processedAt: new Date().toISOString(),
    }),
  }),
};

// ── Tool 5: ExecutionPolicy showcase (NEW Phase 2) ───────
tools["smart_analysis"] = {
  description: "AI analysis with smart billing policy. First call/day is free (allow_once). Low balance → fallback. Otherwise paid at $0.08/call. [Pricing: $0.08/call] [Smart policy]",
  inputSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
  gate: gate.paidTool({
    name: "smart_analysis",
    price: 0.08,
    policy: {
      decide: (ctx) => {
        if (ctx.usageToday === 0) return "allow_once";     // First call free
        if (ctx.balance < ctx.estimatedPrice) return "fallback";
        return "execute";
      },
    },
    handler: async (input) => ({
      topic: input.topic, type: "premium_analysis",
      insights: [`Key trend in ${input.topic}: accelerating adoption`, `Market size: growing 40% YoY`, `Top risk: regulatory uncertainty`],
      confidence: 0.92,
    }),
    fallback: async (input) => ({
      topic: input.topic, type: "basic_summary",
      insights: [`${input.topic} is an active area of development.`],
      note: "Top up for detailed AI analysis with confidence scores.",
    }),
  }),
};

// ── Tool 6: Error → automatic refund demo ────────────────
tools["risky_operation"] = {
  description: "A tool that sometimes fails (50% chance). Demonstrates automatic refund on error. $0.05/call. [Pricing: $0.05/call] [Auto-refund on error]",
  inputSchema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
  gate: gate.paidTool({
    name: "risky_operation",
    price: 0.05,
    handler: async (input) => {
      if (Math.random() < 0.5) throw new Error(`Operation "${input.action}" failed: simulated downstream error`);
      return { action: input.action, status: "success", message: "Operation completed successfully!" };
    },
    onFail: async (input, error, ctx) => {
      log(`[recovery] ${ctx.tool} failed for ${ctx.callerId}: ${error.message} — balance auto-refunded`);
    },
  }),
};

// ── Tool 7: View execution traces (NEW Phase 2) ──────────
tools["view_traces"] = {
  description: "View the execution trace history — shows what happened in each paid tool call. [Free]",
  inputSchema: { type: "object", properties: { limit: { type: "number", description: "Max traces to return (default: 5)" } } },
  gate: gate.paidTool({
    name: "view_traces",
    price: 0,
    handler: async (input, ctx) => {
      const limit = input.limit || 5;
      const traces = await gate.traces.list({ callerId: ctx.callerId, limit });
      return {
        totalTraces: gate.traces.count,
        showing: traces.length,
        traces: traces.map(t => ({
          traceId: t.traceId,
          tool: t.toolName,
          decision: t.decision,
          handlerStatus: t.handlerStatus,
          chargeStatus: t.chargeStatus,
          fallbackUsed: t.fallbackUsed,
          failureClass: t.failureClass || null,
          estimatedAmount: t.estimatedAmount,
          finalAmount: t.finalAmount,
          durationMs: t.durationMs,
          eventCount: t.events.length,
          events: t.events.map(e => `${e.event}${e.detail ? `: ${e.detail}` : ""}`),
          createdAt: new Date(t.createdAt).toISOString(),
        })),
      };
    },
  }),
};

// ── Tool 8: Balance & utils ──────────────────────────────
tools["check_balance"] = {
  description: "Check balance, add funds, or view idempotency cache. [Free]",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "'check' (default), 'topup', or 'stats'" },
      amount: { type: "number", description: "Amount to add (only for action='topup')" },
    },
  },
  gate: gate.paidTool({
    name: "check_balance",
    price: 0,
    handler: async (input, ctx) => {
      const action = input.action || "check";

      if (action === "topup") {
        const amt = Number(input.amount) || 1.00;
        if (amt <= 0 || amt > 100) return { error: "Amount must be $0.01-$100" };
        await ledger.credit(ctx.callerId, amt, { source: "stripe", reference: `demo-topup-${Date.now()}` });
        return { credited: `$${amt.toFixed(2)}`, newBalance: `$${(await ledger.getBalance(ctx.callerId)).toFixed(4)}` };
      }

      if (action === "stats") {
        return {
          balance: `$${ctx.balance.toFixed(4)}`,
          tracesRecorded: gate.traces.count,
          idempotencyKeysActive: gate.idempotency.size,
          transactionCount: ledger.transactions.length,
        };
      }

      // Default: check
      const txs = ledger.transactions.filter(t => t.callerId === ctx.callerId);
      return {
        callerId: ctx.callerId,
        balance: `$${ctx.balance.toFixed(4)}`,
        totalSpent: `$${txs.filter(t => t.type === "deduct").reduce((s, t) => s + t.amount, 0).toFixed(4)}`,
        transactionCount: txs.length,
      };
    },
  }),
};

// ═══════════════════════════════════════════════════════════
// MCP Server (JSON-RPC over stdio)
// ═══════════════════════════════════════════════════════════

const CALLER_ID = "demo-user";

function formatResult(name, result) {
  if (result.success) {
    const text = typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2);
    const content = [{ type: "text", text }];
    if (result.isFallback) content.push({ type: "text", text: "\n---\n⚡ Basic result. Use check_balance with action='topup' to add funds." });
    if (result.receipt) content.push({ type: "text", text: `\n📝 $${result.receipt.amount.toFixed(4)} charged | Balance: $${result.receipt.balanceAfter.toFixed(4)} | ${result.metrics?.durationMs ?? 0}ms` });
    return { content, isError: false };
  }
  if (result.paymentRequired) {
    return { content: [{ type: "text", text: `⚠️ Payment required for "${name}": $${result.paymentRequired.amount.toFixed(4)}\nUse check_balance with action='topup' to add funds.` }], isError: true };
  }
  return { content: [{ type: "text", text: `Error: ${result.output?.error ?? "Unknown error"}` }], isError: true };
}

async function handleRequest(req) {
  const { method, params, id } = req;
  switch (method) {
    case "initialize":
      return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "tollgate-demo-v2", version: "0.2.0" }, capabilities: { tools: { listChanged: false } } } };
    case "notifications/initialized":
      return null;
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: Object.entries(tools).map(([n, t]) => ({ name: n, description: t.description, inputSchema: t.inputSchema })) } };
    case "tools/call": {
      const tn = params?.name;
      if (!tools[tn]) return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Unknown tool: ${tn}` }], isError: true } };
      const result = await tools[tn].gate(params?.arguments ?? {}, CALLER_ID);
      return { jsonrpc: "2.0", id, result: formatResult(tn, result) };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// ── stdio transport ──
process.stdin.on("data", (chunk) => {
  const lines = chunk.toString().split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const request = JSON.parse(trimmed);
      handleRequest(request).then(r => { if (r) process.stdout.write(JSON.stringify(r) + "\n"); }).catch(err => {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: err.message } }) + "\n");
      });
    } catch { /* skip malformed */ }
  }
});

function log(msg) { process.stderr.write(`${msg}\n`); }

log(`[tollgate-demo-v2] MCP server started`);
log(`[tollgate-demo-v2] 8 tools: ${Object.keys(tools).join(", ")}`);
log(`[tollgate-demo-v2] Phase 2: idempotency, trace, paidAction(), ExecutionPolicy`);
log(`[tollgate-demo-v2] Demo balance: $1.00 for "demo-user"`);
log(`[tollgate-demo-v2] Try: process_invoice twice with same invoiceId → no double-charge`);
log(`[tollgate-demo-v2] Try: view_traces → see full audit trail of every call`);
