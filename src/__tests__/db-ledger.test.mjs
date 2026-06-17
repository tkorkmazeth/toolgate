/**
 * DbLedger — Unit Tests
 *
 * Tests against an in-memory mock that simulates D1/Turso's
 * prepared-statement API. All storage uses INTEGER minor units (cents for
 * USD) — no REAL / floating-point arithmetic.
 *
 * Run: node --test src/__tests__/db-ledger.test.mjs
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── DB_SCHEMA (inlined to match src/db-ledger.ts) ────────────

const DB_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tg_balances (
    caller_id   TEXT    PRIMARY KEY,
    balance     INTEGER NOT NULL DEFAULT 0,
    currency    TEXT    NOT NULL DEFAULT 'USD',
    decimals    INTEGER NOT NULL DEFAULT 2,
    updated_at  INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tg_transactions (
    id           TEXT    PRIMARY KEY,
    type         TEXT    NOT NULL,
    caller_id    TEXT    NOT NULL,
    amount       INTEGER NOT NULL,
    currency     TEXT    NOT NULL DEFAULT 'USD',
    balance_after INTEGER,
    tool         TEXT,
    source       TEXT,
    reference    TEXT,
    trace_id     TEXT,
    created_at   INTEGER NOT NULL,
    FOREIGN KEY (caller_id) REFERENCES tg_balances(caller_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tg_transactions_caller
    ON tg_transactions (caller_id, created_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_transactions_reference
    ON tg_transactions (reference) WHERE reference IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS tg_usage (
    caller_id   TEXT    NOT NULL,
    tool        TEXT    NOT NULL,
    period      TEXT    NOT NULL,
    count       INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (caller_id, tool, period)
  )`,
];

// ─── In-memory DB mock (D1/Turso compatible) ──────────────────

class InMemoryDb {
  constructor() {
    // Store balances in minor units (cents), not floats
    this.balances = new Map(); // caller_id → { balance: integer cents, currency, decimals, updated_at }
    this.transactions = new Map(); // id → tx
    this.references = new Set(); // unique reference values for idempotency
    this.usage = new Map(); // "caller:tool:period" → { count, updated_at }
    this.runCalls = [];
    this.migrations = [];
  }

  prepare(sql) {
    const db = this;
    const trimmed = sql.trim();
    db.migrations.push(trimmed);
    let boundArgs = [];

    const stmt = {
      bind(...args) {
        boundArgs = args;
        return stmt;
      },

      async run() {
        db.runCalls.push({ sql: trimmed, args: boundArgs });

        // ── tg_balances credit upsert ─────────────────────────
        if (
          trimmed.startsWith("INSERT INTO tg_balances") &&
          trimmed.includes("DO UPDATE SET balance = balance +")
        ) {
          // bind: callerId, cents, currency, decimals, now, cents, now
          const [callerId, cents, currency, decimals, , deltaCents] = boundArgs;
          const existing = db.balances.get(callerId);
          if (existing) {
            existing.balance += deltaCents; // integer addition, exact
            existing.updated_at = Date.now();
          } else {
            db.balances.set(callerId, {
              balance: cents,
              currency,
              decimals,
              updated_at: Date.now(),
            });
          }
          return { success: true, changes: 1 };
        }

        // ── tg_balances deduct init upsert (DO NOTHING) ───────
        if (
          trimmed.startsWith("INSERT INTO tg_balances") &&
          trimmed.includes("DO NOTHING")
        ) {
          // bind: callerId, currency, decimals, now
          const [callerId, currency, decimals] = boundArgs;
          if (!db.balances.has(callerId)) {
            db.balances.set(callerId, {
              balance: 0,
              currency,
              decimals,
              updated_at: Date.now(),
            });
          }
          return { success: true, changes: 0 };
        }

        // ── tg_balances conditional deduct ────────────────────
        if (trimmed.startsWith("UPDATE tg_balances")) {
          if (trimmed.includes("balance >= ?")) {
            // Conditional deduct: bind(cents, now, callerId, checkCents)
            const [cents, , callerId, checkCents] = boundArgs;
            const row = db.balances.get(callerId);
            if (!row || row.balance < checkCents) {
              return { success: true, changes: 0 };
            }
            row.balance -= cents;
            row.updated_at = Date.now();
            return { success: true, changes: 1 };
          } else {
            // Unconditional credit update: bind(cents, now, callerId)
            const [cents, , callerId] = boundArgs;
            const row = db.balances.get(callerId);
            if (row) {
              row.balance += cents;
              row.updated_at = Date.now();
            }
            return { success: true, changes: 1 };
          }
        }

        // ── tg_transactions insert OR IGNORE ──────────────────
        if (trimmed.startsWith("INSERT OR IGNORE INTO tg_transactions")) {
          // bind: id, callerId, cents, currency, source, reference, now
          const [id, callerId, cents, currency, source, reference] = boundArgs;
          if (reference != null && db.references.has(reference)) {
            return { success: true, changes: 0 }; // duplicate — ignored
          }
          if (reference != null) db.references.add(reference);
          db.transactions.set(id, {
            id,
            callerId,
            cents,
            currency,
            source,
            reference,
          });
          return { success: true, changes: 1 };
        }

        // ── tg_transactions deduct insert ─────────────────────
        if (trimmed.startsWith("INSERT INTO tg_transactions")) {
          const [id, callerId, cents, currency, balanceAfter, tool, reference] =
            boundArgs;
          db.transactions.set(id, {
            id,
            callerId,
            cents,
            currency,
            balanceAfter,
            tool,
            reference,
          });
          return { success: true, changes: 1 };
        }

        // ── tg_usage upsert ───────────────────────────────────
        if (trimmed.startsWith("INSERT INTO tg_usage")) {
          const [callerId, tool, period, , now] = boundArgs;
          const key = `${callerId}:${tool}:${period}`;
          const existing = db.usage.get(key);
          if (existing) {
            existing.count += 1;
            existing.updated_at = now;
          } else {
            db.usage.set(key, { count: 1, updated_at: now });
          }
          return { success: true, changes: 1 };
        }

        return { success: true, changes: 0 };
      },

      async first() {
        db.runCalls.push({ sql: trimmed, args: boundArgs, type: "first" });

        // ── SELECT balance, currency, decimals ────────────────
        if (trimmed.startsWith("SELECT balance, currency, decimals")) {
          const [callerId] = boundArgs;
          const row = db.balances.get(callerId);
          return row
            ? {
                balance: row.balance,
                currency: row.currency,
                decimals: row.decimals,
              }
            : null;
        }

        // ── SELECT balance (just balance) ─────────────────────
        if (trimmed.startsWith("SELECT balance FROM tg_balances")) {
          const [callerId] = boundArgs;
          const row = db.balances.get(callerId);
          return row ? { balance: row.balance } : null;
        }

        // ── SELECT count FROM tg_usage ────────────────────────
        if (trimmed.startsWith("SELECT count FROM tg_usage")) {
          const [callerId, tool, period] = boundArgs;
          const key = `${callerId}:${tool}:${period}`;
          const row = db.usage.get(key);
          return row ? { count: row.count } : null;
        }

        return null;
      },

      async all() {
        return { results: [] };
      },
    };

    return stmt;
  }
}

function currentPeriod(period) {
  const d = new Date();
  if (period === "day") return d.toISOString().slice(0, 10);
  if (period === "month") return d.toISOString().slice(0, 7);
  if (period === "hour") return d.toISOString().slice(0, 13);
  return d.toISOString().slice(0, 10);
}

// ─── Inline DbLedger using integer minor units ─────────────────

// Helpers
const usd = (dollars) => ({
  minorUnits: BigInt(Math.round(parseFloat(dollars) * 100)),
  currency: "USD",
  decimals: 2,
});
const toNumber = (m) => Number(m.minorUnits) / 10 ** m.decimals;

class DbLedger {
  constructor(db) {
    this.db = db;
  }

  async getBalance(callerId) {
    const row = await this.db
      .prepare(
        "SELECT balance, currency, decimals FROM tg_balances WHERE caller_id = ?",
      )
      .bind(callerId)
      .first();
    if (!row) return usd("0");
    return {
      minorUnits: BigInt(row.balance),
      currency: row.currency,
      decimals: row.decimals,
    };
  }

  async deduct(callerId, amount, meta) {
    const now = Date.now();
    const cents = Number(amount.minorUnits);

    await this.db
      .prepare(
        `INSERT INTO tg_balances (caller_id, balance, currency, decimals, updated_at)
         VALUES (?, 0, ?, ?, ?)
         ON CONFLICT(caller_id) DO NOTHING`,
      )
      .bind(callerId, amount.currency, amount.decimals, now)
      .run();

    const result = await this.db
      .prepare(
        `UPDATE tg_balances
         SET balance = balance - ?, updated_at = ?
         WHERE caller_id = ? AND balance >= ?`,
      )
      .bind(cents, now, callerId, cents)
      .run();

    if (!result.success || (result.changes ?? 0) === 0) {
      return { success: false, txId: "" };
    }

    const balRow = await this.db
      .prepare("SELECT balance FROM tg_balances WHERE caller_id = ?")
      .bind(callerId)
      .first();
    const balanceAfter = balRow?.balance ?? 0;

    const txId = `tx_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await this.db
      .prepare(
        `INSERT INTO tg_transactions
           (id, type, caller_id, amount, currency, balance_after, tool, reference, created_at)
         VALUES (?, 'deduct', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        txId,
        callerId,
        cents,
        amount.currency,
        balanceAfter,
        meta.tool,
        meta.callId,
        now,
      )
      .run();

    const period = currentPeriod("day");
    await this.db
      .prepare(
        `INSERT INTO tg_usage (caller_id, tool, period, count, updated_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(caller_id, tool, period)
         DO UPDATE SET count = count + 1, updated_at = ?`,
      )
      .bind(callerId, meta.tool, period, now, now)
      .run();

    return { success: true, txId };
  }

  async credit(callerId, amount, meta) {
    const now = Date.now();
    const cents = Number(amount.minorUnits);
    const txId = `tx_credit_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    await this.db
      .prepare(
        `INSERT INTO tg_balances (caller_id, balance, currency, decimals, updated_at)
         VALUES (?, 0, ?, ?, ?)
         ON CONFLICT(caller_id) DO NOTHING`,
      )
      .bind(callerId, amount.currency, amount.decimals, now)
      .run();

    const txResult = await this.db
      .prepare(
        `INSERT OR IGNORE INTO tg_transactions
           (id, type, caller_id, amount, currency, source, reference, created_at)
         VALUES (?, 'credit', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        txId,
        callerId,
        cents,
        amount.currency,
        meta.source,
        meta.reference,
        now,
      )
      .run();

    if ((txResult.changes ?? 0) === 0) {
      return txId;
    }

    await this.db
      .prepare(
        `UPDATE tg_balances SET balance = balance + ?, updated_at = ? WHERE caller_id = ?`,
      )
      .bind(cents, now, callerId)
      .run();

    return txId;
  }

  async getUsage(callerId, tool, period) {
    const row = await this.db
      .prepare(
        `SELECT count FROM tg_usage WHERE caller_id = ? AND tool = ? AND period = ?`,
      )
      .bind(callerId, tool, currentPeriod(period))
      .first();
    return row?.count ?? 0;
  }

  async incrementUsage(callerId, tool, period) {
    const now = Date.now();
    const p = currentPeriod(period);
    await this.db
      .prepare(
        `INSERT INTO tg_usage (caller_id, tool, period, count, updated_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(caller_id, tool, period)
         DO UPDATE SET count = count + 1, updated_at = ?`,
      )
      .bind(callerId, tool, p, now, now)
      .run();
  }

  static async runMigrations(db) {
    for (const sql of DB_SCHEMA) {
      await db.prepare(sql).run();
    }
  }
}

// ─── Tests ─────────────────────────────────────────────────────

describe("DbLedger.getBalance", () => {
  it("returns 0 for unknown callers", async () => {
    const ledger = new DbLedger(new InMemoryDb());
    const bal = await ledger.getBalance("nobody");
    assert.equal(bal.minorUnits, 0n);
    assert.equal(bal.currency, "USD");
  });

  it("returns correct balance after credit", async () => {
    const ledger = new DbLedger(new InMemoryDb());
    await ledger.credit("alice", usd("5.00"), {
      source: "stripe",
      reference: "cs_1",
    });
    const bal = await ledger.getBalance("alice");
    assert.equal(bal.minorUnits, 500n); // 500 cents
    assert.equal(bal.currency, "USD");
  });
});

describe("DbLedger.credit", () => {
  it("accumulates multiple credits as integer cents", async () => {
    const ledger = new DbLedger(new InMemoryDb());
    await ledger.credit("alice", usd("1.00"), {
      source: "stripe",
      reference: "cs_1",
    });
    await ledger.credit("alice", usd("2.50"), {
      source: "stripe",
      reference: "cs_2",
    });
    const bal = await ledger.getBalance("alice");
    assert.equal(bal.minorUnits, 350n); // 100 + 250 = 350 cents — exact
  });

  it("records transaction with integer amount", async () => {
    const db = new InMemoryDb();
    const ledger = new DbLedger(db);
    await ledger.credit("alice", usd("1.00"), {
      source: "stripe",
      reference: "cs_x",
    });
    assert.equal(db.transactions.size, 1);
    const [tx] = [...db.transactions.values()];
    assert.equal(tx.cents, 100); // stored as integer cents, not 1.0 float
  });

  it("is idempotent — same reference does not double-credit", async () => {
    const ledger = new DbLedger(new InMemoryDb());
    await ledger.credit("alice", usd("5.00"), {
      source: "stripe",
      reference: "evt_stripe_123",
    });
    await ledger.credit("alice", usd("5.00"), {
      source: "stripe",
      reference: "evt_stripe_123",
    });
    const bal = await ledger.getBalance("alice");
    // Only one credit should have applied — second INSERT OR IGNORE is a no-op
    assert.equal(bal.minorUnits, 500n);
  });
});

describe("DbLedger.deduct", () => {
  it("returns {success:false} when balance is insufficient", async () => {
    const ledger = new DbLedger(new InMemoryDb());
    await ledger.credit("alice", usd("0.03"), {
      source: "stripe",
      reference: "cs_1",
    });

    const result = await ledger.deduct("alice", usd("0.05"), {
      callId: "call_1",
      tool: "search",
      amount: usd("0.05"),
    });

    assert.equal(result.success, false);
    const bal = await ledger.getBalance("alice");
    assert.equal(bal.minorUnits, 3n); // 3 cents — unchanged
  });

  it("returns {success:true, txId} and decrements when sufficient", async () => {
    const ledger = new DbLedger(new InMemoryDb());
    await ledger.credit("alice", usd("1.00"), {
      source: "stripe",
      reference: "cs_1",
    });

    const result = await ledger.deduct("alice", usd("0.05"), {
      callId: "call_2",
      tool: "search",
      amount: usd("0.05"),
    });

    assert.equal(result.success, true);
    assert.ok(result.txId);
    const bal = await ledger.getBalance("alice");
    assert.equal(bal.minorUnits, 95n); // 100 - 5 = 95 cents
  });

  it("returns {success:false} for zero-balance callers", async () => {
    const ledger = new DbLedger(new InMemoryDb());
    const result = await ledger.deduct("nobody", usd("0.01"), {
      callId: "c",
      tool: "t",
      amount: usd("0.01"),
    });
    assert.equal(result.success, false);
  });

  it("increments daily usage counter on successful deduct", async () => {
    const ledger = new DbLedger(new InMemoryDb());
    await ledger.credit("alice", usd("1.00"), {
      source: "stripe",
      reference: "cs_1",
    });
    await ledger.deduct("alice", usd("0.05"), {
      callId: "c1",
      tool: "search",
      amount: usd("0.05"),
    });
    await ledger.deduct("alice", usd("0.05"), {
      callId: "c2",
      tool: "search",
      amount: usd("0.05"),
    });

    const usage = await ledger.getUsage("alice", "search", "day");
    assert.equal(usage, 2);
  });

  it("does NOT increment usage on failed deduct (insufficient funds)", async () => {
    const ledger = new DbLedger(new InMemoryDb());
    await ledger.deduct("nobody", usd("0.05"), {
      callId: "c1",
      tool: "search",
      amount: usd("0.05"),
    });

    const usage = await ledger.getUsage("nobody", "search", "day");
    assert.equal(usage, 0);
  });

  it("maintains exact integer precision across many micropayments", async () => {
    const ledger = new DbLedger(new InMemoryDb());
    await ledger.credit("alice", usd("1.00"), {
      source: "stripe",
      reference: "cs_1",
    });

    // 10 × $0.01 = $0.10 deducted → $0.90 remaining = 90 cents
    for (let i = 0; i < 10; i++) {
      await ledger.deduct("alice", usd("0.01"), {
        callId: `c${i}`,
        tool: "t",
        amount: usd("0.01"),
      });
    }

    const bal = await ledger.getBalance("alice");
    assert.equal(bal.minorUnits, 90n); // exact — no float drift
  });
});

describe("DbLedger.getUsage / incrementUsage", () => {
  it("returns 0 for unknown caller/tool/period", async () => {
    const ledger = new DbLedger(new InMemoryDb());
    assert.equal(await ledger.getUsage("user", "tool", "day"), 0);
  });

  it("increments correctly", async () => {
    const ledger = new DbLedger(new InMemoryDb());
    await ledger.incrementUsage("user", "lookup", "day");
    await ledger.incrementUsage("user", "lookup", "day");
    await ledger.incrementUsage("user", "lookup", "day");
    assert.equal(await ledger.getUsage("user", "lookup", "day"), 3);
  });

  it("isolates usage per tool", async () => {
    const ledger = new DbLedger(new InMemoryDb());
    await ledger.incrementUsage("user", "search", "day");
    await ledger.incrementUsage("user", "translate", "day");
    await ledger.incrementUsage("user", "translate", "day");

    assert.equal(await ledger.getUsage("user", "search", "day"), 1);
    assert.equal(await ledger.getUsage("user", "translate", "day"), 2);
  });
});

describe("Multi-caller isolation", () => {
  it("separate balances per caller", async () => {
    const db = new InMemoryDb();
    const ledger = new DbLedger(db);

    await ledger.credit("alice", usd("5.00"), {
      source: "stripe",
      reference: "cs_a",
    });
    await ledger.credit("bob", usd("2.00"), {
      source: "stripe",
      reference: "cs_b",
    });

    assert.equal((await ledger.getBalance("alice")).minorUnits, 500n);
    assert.equal((await ledger.getBalance("bob")).minorUnits, 200n);

    await ledger.deduct("alice", usd("1.00"), {
      callId: "c1",
      tool: "t",
      amount: usd("1.00"),
    });
    assert.equal((await ledger.getBalance("alice")).minorUnits, 400n);
    assert.equal((await ledger.getBalance("bob")).minorUnits, 200n);
  });
});

describe("DB_SCHEMA", () => {
  it("defines tg_balances table with INTEGER balance", () => {
    const schema = DB_SCHEMA.find((s) => s.includes("tg_balances"));
    assert.ok(schema);
    assert.ok(schema.includes("INTEGER"), "balance must be INTEGER, not REAL");
    assert.ok(!schema.includes("REAL"), "must not have REAL column");
  });
  it("defines tg_transactions table with INTEGER amount", () => {
    const schema = DB_SCHEMA.find(
      (s) => s.includes("tg_transactions") && s.includes("CREATE TABLE"),
    );
    assert.ok(schema);
    assert.ok(
      schema.includes("amount       INTEGER"),
      "amount must be INTEGER, not REAL",
    );
  });
  it("has unique index on transaction reference", () => {
    const hasUniqueRef = DB_SCHEMA.some(
      (s) => s.includes("UNIQUE") && s.includes("reference"),
    );
    assert.ok(
      hasUniqueRef,
      "must have UNIQUE index on reference for webhook idempotency",
    );
  });
  it("defines tg_usage table", () => {
    assert.ok(DB_SCHEMA.some((s) => s.includes("tg_usage")));
  });
  it("has 5 statements (3 tables + 2 indexes)", () => {
    assert.equal(DB_SCHEMA.length, 5);
  });
});

describe("DbLedger.runMigrations", () => {
  it("calls prepare().run() for each schema statement", async () => {
    const db = new InMemoryDb();
    await DbLedger.runMigrations(db);
    assert.ok(db.runCalls.length >= DB_SCHEMA.length);
  });
});
