#!/usr/bin/env node

/**
 * Tollgate Phase 2 Demo MCP Server
 *
 * Showcases all Phase 2 features: idempotency, execution trace, paidAction()
 * alias, refund-on-error recovery, and the full billing lifecycle.
 *
 * Run standalone:  node src/demo-server.mjs
 * Claude Desktop (~/.claude/claude_desktop_config.json):
 * {
 *   "mcpServers": {
 *     "tollgate-demo": {
 *       "command": "node",
 *       "args": ["/path/to/tollgate-mvp/src/demo-server.mjs"]
 *     }
 *   }
 * }
 *
 * Tools:
 *  premium_search    — static $0.05/call, fallback on no balance
 *  generate_invoice  — idempotency demo: same requestId → no double charge
 *  smart_translate   — dynamic pricing (per-character)
 *  data_lookup       — tiered (3 free/day then $0.03/call)
 *  risky_operation   — error-recovery demo: auto-refund on handler failure
 *  view_traces       — inspect execution trace store (free)
 *  check_balance     — balance + stats (free)
 *  add_balance       — demo top-up (free)
 */

import { createInterface } from "node:readline";

// ═══════════════════════════════════════════════════════════
// Phase 2 Inline SDK (no build step needed — self-contained)
// ═══════════════════════════════════════════════════════════

// ─── Helpers ──────────────────────────────────────────────

function hashSync(input) {
  const str = JSON.stringify(input) ?? "";
  let h = 5381;
  for (let i = 0; i < str.length; i++)
    h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function makeId(prefix = "tg") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── InMemoryLedger ───────────────────────────────────────

class InMemoryLedger {
  constructor() {
    this.balances = new Map();
    this.usage = new Map();
    this.transactions = [];
  }
  async getBalance(id) {
    return this.balances.get(id) ?? 0;
  }
  async deduct(id, amount, meta) {
    const cur = this.balances.get(id) ?? 0;
    if (cur < amount) return false;
    this.balances.set(id, Math.round((cur - amount) * 1e6) / 1e6);
    this.transactions.push({
      type: "deduct",
      callerId: id,
      amount,
      meta,
      ts: Date.now(),
    });
    return true;
  }
  async credit(id, amount, meta) {
    const cur = this.balances.get(id) ?? 0;
    this.balances.set(id, Math.round((cur + amount) * 1e6) / 1e6);
    this.transactions.push({
      type: "credit",
      callerId: id,
      amount,
      meta,
      ts: Date.now(),
    });
  }
  async getUsage(id, tool) {
    const key = `${id}:${tool}:${new Date().toISOString().slice(0, 10)}`;
    return this.usage.get(key) ?? 0;
  }
  async incrementUsage(id, tool) {
    const key = `${id}:${tool}:${new Date().toISOString().slice(0, 10)}`;
    this.usage.set(key, (this.usage.get(key) ?? 0) + 1);
  }
}

// ─── InMemoryIdempotencyStore ─────────────────────────────

class InMemoryIdempotencyStore {
  constructor(ttlSeconds = 3600) {
    this.store = new Map();
    this.ttlMs = ttlSeconds * 1000;
  }
  async get(key) {
    const r = this.store.get(key);
    if (!r) return null;
    if (r.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return r;
  }
  async set(record) {
    this.store.set(record.key, record);
  }
  async update(key, updates) {
    const existing = this.store.get(key);
    if (existing)
      this.store.set(key, { ...existing, ...updates, updatedAt: Date.now() });
  }
  async delete(key) {
    this.store.delete(key);
  }
  get size() {
    return this.store.size;
  }
  all() {
    return [...this.store.values()];
  }
}

// ─── InMemoryTraceStore ───────────────────────────────────

class InMemoryTraceStore {
  constructor() {
    this.traces = [];
    this.byId = new Map();
    this.byKey = new Map();
  }
  async save(trace) {
    this.traces.push(trace);
    this.byId.set(trace.traceId, trace);
    if (trace.idempotencyKey) this.byKey.set(trace.idempotencyKey, trace);
  }
  async get(id) {
    return this.byId.get(id) ?? null;
  }
  async getByIdempotencyKey(key) {
    return this.byKey.get(key) ?? null;
  }
  async list(filters = {}) {
    let result = [...this.traces];
    if (filters.callerId)
      result = result.filter((t) => t.callerId === filters.callerId);
    if (filters.toolName)
      result = result.filter((t) => t.toolName === filters.toolName);
    if (filters.limit) result = result.slice(-filters.limit);
    return result;
  }
  get count() {
    return this.traces.length;
  }
}

// ─── TollGate (Phase 2) ───────────────────────────────────

class TollGate {
  constructor(config) {
    this.config = {
      publisherKey: config.publisherKey,
      defaultCurrency: config.defaultCurrency ?? "usd",
      paymentRails: config.paymentRails ?? ["stripe"],
      ledger: config.ledger ?? new InMemoryLedger(),
      hooks: config.hooks,
    };
    this.idempotencyStore =
      config.idempotencyStore ?? new InMemoryIdempotencyStore();
    this.traceStore = config.traceStore ?? new InMemoryTraceStore();
    this.tools = new Map();
  }

  get ledger() {
    return this.config.ledger;
  }
  get traces() {
    return this.traceStore;
  }
  get idempotency() {
    return this.idempotencyStore;
  }

  /** Register a paid tool and return a callable. */
  paidTool(tc) {
    this.tools.set(tc.name, tc);
    const execute = (input, callerId) => this._exec(tc, input, callerId);
    execute.toolName = tc.name;
    execute.config = tc;
    return execute;
  }

  /** Alias for paidTool() — same engine. */
  paidAction(tc) {
    return this.paidTool(tc);
  }

  // ── Resolve idempotency key ──────────────────────────────
  _resolveKey(tool, input, callerId) {
    if (typeof tool.idempotencyKey === "string") return tool.idempotencyKey;
    if (typeof tool.idempotencyKey === "function")
      return tool.idempotencyKey(input, callerId);
    return `auto_${tool.name}_${callerId}_${hashSync(input)}`;
  }

  // ── Handle duplicate request ─────────────────────────────
  async _handleDuplicate(tool, input, callerId, record, key) {
    const policy = tool.onDuplicate ?? "return_previous_result";
    if (tool.onDuplicateDetected) {
      await tool.onDuplicateDetected(input, record, {
        callerId,
        callId: record.traceId,
        tool: tool.name,
        tier: "premium",
        balance: 0,
        timestamp: Date.now(),
      });
    }
    if (policy === "return_previous_result") {
      if (record.status === "in_progress") {
        return {
          success: false,
          output: {
            error:
              "Duplicate request: a previous execution is still in progress.",
            idempotencyKey: key,
          },
        };
      }
      if (record.result) return record.result;
    }
    if (policy === "block") {
      return {
        success: false,
        output: {
          error: "Duplicate request detected. Request rejected.",
          idempotencyKey: key,
        },
      };
    }
    // re_execute
    await this.idempotencyStore.delete(key);
    return this._exec(tool, input, callerId);
  }

  // ── Core execution engine ────────────────────────────────
  async _exec(tool, input, callerId) {
    const traceId = makeId("tg");
    const now = Date.now();
    const ledger = this.config.ledger;

    // Step 0 — Idempotency check
    const idemKey = this._resolveKey(tool, input, callerId);
    const existing = await this.idempotencyStore.get(idemKey);
    if (existing)
      return this._handleDuplicate(tool, input, callerId, existing, idemKey);

    await this.idempotencyStore.set({
      key: idemKey,
      callerId,
      toolName: tool.name,
      inputHash: hashSync(input),
      status: "in_progress",
      traceId,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 3_600_000,
    });

    // Initialise trace
    const trace = {
      traceId,
      idempotencyKey: idemKey,
      callerId,
      toolName: tool.name,
      inputHash: hashSync(input),
      estimatedAmount: 0,
      finalAmount: 0,
      currency: this.config.defaultCurrency,
      decision: "execute",
      chargeStatus: "none",
      createdAt: now,
      updatedAt: now,
      events: [{ timestamp: now, event: "trace_created" }],
    };

    this.config.hooks?.onCall?.(tool.name, callerId);

    // Determine tier / price / handler
    let tier = "premium",
      price = 0,
      handler = tool.handler;
    if (tool.tiers) {
      if (tool.tiers.free) {
        const usage = await ledger.getUsage(callerId, tool.name);
        if (usage < tool.tiers.free.limit) {
          tier = "free";
          price = 0;
          handler = tool.tiers.free.handler ?? tool.handler;
        } else {
          tier = "premium";
          const pp = tool.tiers.premium.price;
          price = typeof pp === "function" ? await pp(input) : (pp ?? 0);
          handler = tool.tiers.premium.handler ?? tool.handler;
        }
      }
    } else if (tool.price !== undefined && tool.price !== "postpaid") {
      price =
        typeof tool.price === "function" ? await tool.price(input) : tool.price;
    }

    const isPostpaid = tool.price === "postpaid";
    trace.estimatedAmount = price;
    trace.events.push({
      timestamp: Date.now(),
      event: "price_resolved",
      detail: String(price),
    });

    const ctx = {
      callerId,
      callId: traceId,
      tool: tool.name,
      tier,
      balance: await ledger.getBalance(callerId),
      timestamp: now,
    };
    const needsPayment = tier === "premium" && price > 0 && !isPostpaid;

    // Payment gate
    if (needsPayment) {
      const ok = await ledger.deduct(callerId, price, {
        callId: traceId,
        tool: tool.name,
        amount: price,
      });
      if (!ok) {
        trace.chargeStatus = "failed";
        trace.decision = "payment_required";
        trace.events.push({ timestamp: Date.now(), event: "payment_failed" });
        await this.traceStore.save(trace);
        const result = await this._payFail(tool, input, ctx, price);
        await this.idempotencyStore.update(idemKey, {
          status: "requires_payment",
          result,
          updatedAt: Date.now(),
        });
        return result;
      }
      trace.finalAmount = price;
      trace.chargeStatus = "charged";
      trace.events.push({
        timestamp: Date.now(),
        event: "payment_deducted",
        detail: String(price),
      });
      this.config.hooks?.onPayment?.(tool.name, callerId, price);
    }

    if (tool.beforeExecute) {
      const proceed = await tool.beforeExecute(input, ctx);
      if (!proceed) {
        if (needsPayment) {
          await ledger.credit(callerId, price, {
            source: "manual",
            reference: `refund:${traceId}:aborted`,
          });
          trace.chargeStatus = "refunded";
        }
        const result = {
          success: false,
          output: { error: "Aborted by beforeExecute" },
        };
        await this.traceStore.save(trace);
        await this.idempotencyStore.update(idemKey, {
          status: "failed",
          result,
          updatedAt: Date.now(),
        });
        return result;
      }
    }

    trace.events.push({ timestamp: Date.now(), event: "handler_started" });

    const startedAt = Date.now();
    let output, metrics;
    try {
      output = await handler(input, ctx);
      const endedAt = Date.now();
      metrics = { durationMs: endedAt - startedAt, startedAt, endedAt };
    } catch (err) {
      const endedAt = Date.now();
      metrics = { durationMs: endedAt - startedAt, startedAt, endedAt };
      if (needsPayment) {
        await ledger.credit(callerId, price, {
          source: "manual",
          reference: `refund:${traceId}:error`,
        });
        trace.chargeStatus = "refunded";
        trace.events.push({
          timestamp: Date.now(),
          event: "refunded",
          detail: err.message,
        });
      }
      trace.decision = "error";
      trace.events.push({
        timestamp: Date.now(),
        event: "handler_error",
        detail: err.message,
      });
      await this.traceStore.save(trace);
      if (tool.onFail) await tool.onFail(input, err, ctx);
      this.config.hooks?.onError?.(tool.name, err);
      const result = {
        success: false,
        output: { error: err.message },
        metrics,
      };
      await this.idempotencyStore.update(idemKey, {
        status: "failed",
        result,
        updatedAt: Date.now(),
      });
      return result;
    }

    if (tier === "free" && tool.tiers?.free)
      await ledger.incrementUsage(callerId, tool.name);

    if (isPostpaid && tool.meter) {
      const mr = await tool.meter(input, output, metrics);
      price = mr.amount;
      trace.finalAmount = price;
      const ok = await ledger.deduct(callerId, price, {
        callId: traceId,
        tool: tool.name,
        amount: price,
      });
      if (ok) {
        trace.chargeStatus = "charged";
        trace.events.push({
          timestamp: Date.now(),
          event: "postpaid_metered",
          detail: String(price),
        });
        this.config.hooks?.onPayment?.(tool.name, callerId, price);
      }
    }

    if (tool.afterExecute) await tool.afterExecute(input, output, metrics);

    trace.events.push({ timestamp: Date.now(), event: "handler_success" });
    trace.events.push({ timestamp: Date.now(), event: "call_completed" });
    await this.traceStore.save(trace);

    const balanceAfter = await ledger.getBalance(callerId);
    const result = {
      success: true,
      output,
      receipt:
        price > 0
          ? {
              callId: traceId,
              tool: tool.name,
              amount: price,
              currency: this.config.defaultCurrency,
              rail: "prepaid",
              balanceAfter,
              timestamp: Date.now(),
            }
          : undefined,
      metrics,
      isFallback: false,
      traceId,
    };
    await this.idempotencyStore.update(idemKey, {
      status: "completed",
      result,
      updatedAt: Date.now(),
    });
    return result;
  }

  async _payFail(tool, input, ctx, req) {
    const policy = tool.onPaymentFailed ?? "block";
    if (tool.onPaymentFail)
      await tool.onPaymentFail(input, {
        code: "insufficient_balance",
        balance: ctx.balance,
        required: req,
      });
    if (policy === "fallback" && tool.fallback) {
      return {
        success: true,
        output: await tool.fallback(input, ctx),
        isFallback: true,
      };
    }
    if (policy === "allow_once") {
      const s = Date.now();
      const o = await tool.handler(input, ctx);
      return {
        success: true,
        output: o,
        metrics: {
          durationMs: Date.now() - s,
          startedAt: s,
          endedAt: Date.now(),
        },
        isFallback: false,
      };
    }
    return {
      success: false,
      paymentRequired: {
        status: 402,
        error: "payment_required",
        tool: tool.name,
        amount: req,
        currency: this.config.defaultCurrency,
        acceptedRails: this.config.paymentRails,
        topUpUrl: `https://pay.tollgate.dev/topup?publisher=${this.config.publisherKey}&amount=${Math.ceil(req * 100)}`,
      },
    };
  }
}

// ═══════════════════════════════════════════════════════════
// MCP Server (JSON-RPC over stdio)
// ═══════════════════════════════════════════════════════════

const SERVER_INFO = {
  name: "tollgate-demo",
  version: "0.1.0",
};

// ─── Setup TollGate ──────────────────────────────────────

const ledger = new InMemoryLedger();
const gate = new TollGate({
  publisherKey: "tg_demo",
  ledger,
  hooks: {
    onCall: (tool, caller) => log(`[call]    ${tool} by ${caller}`),
    onPayment: (tool, caller, amt) =>
      log(`[payment] ${tool}: $${amt.toFixed(4)} from ${caller}`),
    onError: (tool, err) => log(`[error]   ${tool}: ${err.message}`),
  },
});

// Pre-load demo balance
await ledger.credit("demo-user", 1.0, {
  source: "manual",
  reference: "demo-preload",
});
log(`[init] Pre-loaded $1.00 for demo-user`);

// ─── Define Tools ────────────────────────────────────────

const tools = {};

// ── Tool 1: Static pricing + fallback ────────────────────
tools["premium_search"] = {
  description:
    "Premium web search with AI analysis. [Pricing: $0.05/call | Falls back to basic on no balance]",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
    },
    required: ["query"],
  },
  gate: gate.paidTool({
    name: "premium_search",
    price: 0.05,
    onPaymentFailed: "fallback",
    handler: async (input) => ({
      type: "premium",
      query: input.query,
      results: [
        {
          title: `Deep analysis: ${input.query}`,
          relevance: 0.98,
          snippet: "Comprehensive AI-powered analysis with citations...",
        },
        {
          title: `Expert insights: ${input.query}`,
          relevance: 0.95,
          snippet: "Curated expert opinions with confidence scoring...",
        },
        {
          title: `Data report: ${input.query}`,
          relevance: 0.91,
          snippet: "Statistical analysis and trend identification...",
        },
      ],
      totalResults: 1250,
      analysisDepth: "comprehensive",
    }),
    fallback: async (input) => ({
      type: "basic",
      query: input.query,
      results: [
        {
          title: `Basic result: ${input.query}`,
          relevance: 0.7,
          snippet: "Limited preview — add funds for premium.",
        },
      ],
      note: "Fallback mode: balance insufficient. Use add_balance to top up.",
    }),
  }),
};

// ── Tool 2: Idempotency demo — invoice generation ────────
//    Same requestId always returns the same invoice (no double charge)
tools["generate_invoice"] = {
  description: [
    "Generate a payment invoice. Idempotency demo: calling with the same requestId",
    "returns the cached invoice without charging again.",
    "[Pricing: $0.10/call | Idempotent by requestId]",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      requestId: {
        type: "string",
        description:
          "Unique request ID — same ID returns cached result (no double charge)",
      },
      amount: { type: "number", description: "Invoice amount in USD" },
      description: { type: "string", description: "Invoice description" },
      recipient: { type: "string", description: "Recipient name or email" },
    },
    required: ["requestId", "amount", "description"],
  },
  gate: gate.paidAction({
    // ← paidAction() alias
    name: "generate_invoice",
    price: 0.1,
    // Idempotency key derived from requestId (not full input hash)
    idempotencyKey: (input) => `invoice_${input.requestId}`,
    onDuplicateDetected: (_input, record) => {
      log(
        `[idempotency] duplicate detected for key=${record.key}, status=${record.status}`,
      );
    },
    handler: async (input, ctx) => {
      const invoiceId = `INV-${Date.now().toString(36).toUpperCase()}`;
      return {
        invoiceId,
        requestId: input.requestId,
        amount: `$${Number(input.amount).toFixed(2)}`,
        description: input.description,
        recipient: input.recipient ?? "unknown",
        issuedAt: new Date().toISOString(),
        status: "issued",
        generatedBy: ctx.callerId,
        traceId: ctx.callId,
        note: "Subsequent calls with same requestId return this exact result (idempotent — no re-charge).",
      };
    },
  }),
};

// ── Tool 3: Dynamic pricing — translation ────────────────
tools["smart_translate"] = {
  description:
    "AI translation. [Pricing: $0.01 per 100 characters (min $0.01)]",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to translate" },
      targetLang: {
        type: "string",
        description: "Target language code (e.g., tr, de, ja)",
      },
    },
    required: ["text", "targetLang"],
  },
  gate: gate.paidTool({
    name: "smart_translate",
    price: (input) =>
      Math.max(0.01, Math.ceil(String(input.text || "").length / 100) * 0.01),
    handler: async (input) => ({
      original: input.text,
      translated: `[${input.targetLang}] ${input.text}`,
      targetLang: input.targetLang,
      qualityScore: 0.94,
      charCount: String(input.text || "").length,
    }),
  }),
};

// ── Tool 4: Tiered access — data lookup ──────────────────
tools["data_lookup"] = {
  description:
    "Company data enrichment. [Pricing: 3 free calls/day, then $0.03/call]",
  inputSchema: {
    type: "object",
    properties: {
      company: { type: "string", description: "Company name" },
    },
    required: ["company"],
  },
  gate: gate.paidTool({
    name: "data_lookup",
    tiers: {
      free: { limit: 3, period: "day" },
      premium: { price: 0.03 },
    },
    handler: async (input) => ({
      company: input.company,
      domain: `${String(input.company).toLowerCase().replace(/\s+/g, "")}.com`,
      employees: Math.floor(Math.random() * 10000) + 100,
      revenue: `$${(Math.random() * 100).toFixed(1)}M`,
      founded: 2010 + Math.floor(Math.random() * 14),
      sector: "Technology",
    }),
  }),
};

// ── Tool 5: Error recovery demo — sometimes fails ────────
//    On failure: auto-refunds the charge and returns error
tools["risky_operation"] = {
  description: [
    "Demonstrates error recovery. Randomly fails ~40% of the time.",
    "On failure, the $0.08 charge is automatically refunded.",
    "[Pricing: $0.08/call | Auto-refund on failure]",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "Task description" },
      forceError: {
        type: "boolean",
        description: "Set true to force a failure (for testing refund)",
      },
    },
    required: ["task"],
  },
  gate: gate.paidTool({
    name: "risky_operation",
    price: 0.08,
    onFail: (_input, err, ctx) => {
      log(
        `[recovery] risky_operation failed for ${ctx.callerId}: ${err.message} — refund issued`,
      );
    },
    handler: async (input) => {
      // Force error if requested, otherwise 40% random failure
      if (input.forceError || Math.random() < 0.4) {
        throw new Error(`External service unavailable: ${input.task}`);
      }
      return {
        task: input.task,
        status: "completed",
        result: `Successfully processed: ${input.task}`,
        timestamp: new Date().toISOString(),
      };
    },
  }),
};

// ── Tool 6: View execution traces (Phase 2 showcase) ─────
tools["view_traces"] = {
  description:
    "View recent execution traces. Shows idempotency keys, charge status, events. [Free]",
  inputSchema: {
    type: "object",
    properties: {
      toolName: {
        type: "string",
        description: "Filter by tool name (optional)",
      },
      limit: {
        type: "number",
        description: "Max number of traces to return (default 5)",
      },
    },
  },
  gate: gate.paidTool({
    name: "view_traces",
    price: 0,
    handler: async (input, ctx) => {
      const traces = await gate.traces.list({
        callerId: ctx.callerId,
        toolName: input.toolName,
        limit: Number(input.limit) || 5,
      });
      return {
        totalTracesRecorded: gate.traces.count,
        activeIdempotencyKeys: gate.idempotency.size,
        traces: traces.map((t) => ({
          traceId: t.traceId,
          tool: t.toolName,
          idempotencyKey: t.idempotencyKey,
          chargeStatus: t.chargeStatus,
          finalAmount:
            t.finalAmount > 0 ? `$${t.finalAmount.toFixed(4)}` : "free",
          decision: t.decision,
          eventCount: t.events.length,
          events: t.events.map(
            (e) => `${e.event}${e.detail ? `: ${e.detail}` : ""}`,
          ),
          createdAt: new Date(t.createdAt).toISOString(),
        })),
      };
    },
  }),
};

// ── Tool 7: Check balance ─────────────────────────────────
tools["check_balance"] = {
  description: "Check your Tollgate balance and transaction history. [Free]",
  inputSchema: { type: "object", properties: {} },
  gate: gate.paidTool({
    name: "check_balance",
    price: 0,
    handler: async (_input, ctx) => {
      const txs = ledger.transactions.filter(
        (t) => t.callerId === ctx.callerId,
      );
      const totalSpent = txs
        .filter((t) => t.type === "deduct")
        .reduce((s, t) => s + t.amount, 0);
      const totalRefunded = txs
        .filter(
          (t) =>
            t.type === "credit" &&
            t.meta?.source === "manual" &&
            String(t.meta?.reference ?? "").includes("refund"),
        )
        .reduce((s, t) => s + t.amount, 0);
      return {
        callerId: ctx.callerId,
        balance: `$${ctx.balance.toFixed(4)}`,
        totalCharged: `$${totalSpent.toFixed(4)}`,
        totalRefunded: `$${totalRefunded.toFixed(4)}`,
        netSpend: `$${(totalSpent - totalRefunded).toFixed(4)}`,
        transactions: txs.length,
        idempotencyKeys: gate.idempotency.size,
        traces: gate.traces.count,
        recentTxs: txs.slice(-5).map((t) => ({
          type: t.type,
          amount: `$${t.amount.toFixed(4)}`,
          tool: t.meta?.tool ?? t.meta?.reference ?? "—",
          ts: new Date(t.ts).toISOString(),
        })),
      };
    },
  }),
};

// ── Tool 8: Add balance (demo top-up) ────────────────────
tools["add_balance"] = {
  description:
    "Add funds to your Tollgate balance (demo instant credit). [Free]",
  inputSchema: {
    type: "object",
    properties: {
      amount: { type: "number", description: "USD to add (0.01–100)" },
    },
    required: ["amount"],
  },
  gate: gate.paidTool({
    name: "add_balance",
    price: 0,
    handler: async (input, ctx) => {
      const amount = Number(input.amount) || 0;
      if (amount <= 0 || amount > 100)
        return { error: "Amount must be between $0.01 and $100.00" };
      await ledger.credit(ctx.callerId, amount, {
        source: "stripe",
        reference: `demo-topup-${Date.now()}`,
      });
      const newBalance = await ledger.getBalance(ctx.callerId);
      return {
        credited: `$${amount.toFixed(2)}`,
        newBalance: `$${newBalance.toFixed(4)}`,
        message: "Balance topped up! You can now retry paid tools.",
      };
    },
  }),
};

// ─── Format result for MCP ───────────────────────────────

function formatResult(toolName, result) {
  if (result.success) {
    const text =
      typeof result.output === "string"
        ? result.output
        : JSON.stringify(result.output, null, 2);

    const content = [{ type: "text", text }];

    if (result.isFallback) {
      content.push({
        type: "text",
        text: "\n---\n⚡ This is a basic result. Use 'add_balance' tool to top up, then retry for premium results.",
      });
    }

    if (result.receipt) {
      content.push({
        type: "text",
        text: `\n📝 Receipt: $${result.receipt.amount.toFixed(4)} charged | Balance: $${result.receipt.balanceAfter.toFixed(4)}`,
      });
    }

    return { content, isError: false };
  }

  if (result.paymentRequired) {
    const pr = result.paymentRequired;
    return {
      content: [
        {
          type: "text",
          text: [
            `⚠️ Payment required to use "${toolName}".`,
            `Amount needed: $${pr.amount.toFixed(4)} USD`,
            `Your balance: insufficient`,
            ``,
            `Use the "add_balance" tool to top up your balance, then retry.`,
            `Example: add_balance({ amount: 1.00 })`,
          ].join("\n"),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: `Error: ${result.output?.error ?? "Unknown error"}`,
      },
    ],
    isError: true,
  };
}

// ─── MCP JSON-RPC Handler ────────────────────────────────

const CALLER_ID = "demo-user"; // In production, derive from session/auth

async function handleRequest(request) {
  const { method, params, id } = request;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: SERVER_INFO,
          capabilities: {
            tools: { listChanged: false },
          },
        },
      };

    case "notifications/initialized":
      return null; // No response for notifications

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: Object.entries(tools).map(([name, t]) => ({
            name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      };

    case "tools/call": {
      const toolName = params?.name;
      const args = params?.arguments ?? {};

      if (!tools[toolName]) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
            isError: true,
          },
        };
      }

      const gateTool = tools[toolName].gate;
      const result = await gateTool(args, CALLER_ID);
      const mcpResult = formatResult(toolName, result);

      return { jsonrpc: "2.0", id, result: mcpResult };
    }

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// ─── stdio Transport ─────────────────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });
let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();

  // Parse JSON-RPC messages (newline-delimited)
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const request = JSON.parse(trimmed);
      handleRequest(request)
        .then((response) => {
          if (response) {
            process.stdout.write(JSON.stringify(response) + "\n");
          }
        })
        .catch((err) => {
          log(`[error] ${err.message}`);
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32603, message: err.message },
            }) + "\n",
          );
        });
    } catch {
      // Skip malformed JSON
    }
  }
});

function log(msg) {
  process.stderr.write(`${msg}\n`);
}

log(`[tollgate-demo] MCP server started (stdio) — Phase 2`);
log(
  `[tollgate-demo] ${Object.keys(tools).length} tools registered: ${Object.keys(tools).join(", ")}`,
);
log(`[tollgate-demo] Demo balance: $1.00 for "demo-user"`);
