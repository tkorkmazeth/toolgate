/**
 * DbIdempotencyStore — Real-DB Integration Tests
 *
 * Unlike concurrency.test.mjs (which uses a hand-written in-memory DbClient
 * mock), this suite runs DbIdempotencyStore against a REAL SQL engine
 * (better-sqlite3). That proves two things the mock cannot:
 *
 *   Level 1 — the emitted SQL is valid and behaves correctly against a real
 *             query planner: INSERT OR IGNORE returns changes=0 on conflict,
 *             the conditional UPDATE … WHERE evaluates as intended, NULL/JSON
 *             round-trip, lease/TTL semantics.
 *
 *   Level 2 — DB-level serialization: multiple SEPARATE OS processes opening
 *             the same SQLite file race to claim the same key, and exactly one
 *             wins. This is the actual "multi-instance safe" proof — decided by
 *             SQLite's write lock, not JS event-loop ordering.
 *
 * SQLite is the local/CI engine. The same DbClient adapter shape maps to
 * Turso/libsql (@libsql/client) for production — that is the forward target.
 *
 * Run: npm run build && node --test src/__tests__/db-idempotency.integration.test.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DbIdempotencyStore } from "../../dist/index.js";
import { tryCreateSqliteClient } from "./_sqlite-client.mjs";

const WORKER = fileURLToPath(
  new URL("./_idempotency-claim-worker.mjs", import.meta.url),
);

// Probe for the native driver once. If absent, register a single skipped test
// so CI stays green on platforms where better-sqlite3 can't be built.
const probe = await tryCreateSqliteClient(":memory:");
const driverAvailable = probe !== null;
if (probe) probe._db.close();

function runWorker(dbPath, key, startAt) {
  return new Promise((resolve) => {
    const child = fork(WORKER, [dbPath, key, String(startAt)], {
      silent: true,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => resolve(out.trim()));
  });
}

describe("DbIdempotencyStore integration (real SQLite)", { skip: !driverAvailable }, () => {
  // ── Level 1: lifecycle against a real SQL engine ──

  it("claim → complete → replay returns the cached result", async () => {
    const client = await tryCreateSqliteClient(":memory:");
    await DbIdempotencyStore.runMigrations(client);
    const store = new DbIdempotencyStore(client);

    const first = await store.claim({
      key: "k1", ownerId: "o1", leaseMs: 30_000, traceId: "t1",
    });
    assert.equal(first.status, "claimed");

    assert.equal(await store.complete("k1", "o1", { answer: 42 }), true);

    const replay = await store.claim({
      key: "k1", ownerId: "o2", leaseMs: 30_000, traceId: "t2",
    });
    assert.equal(replay.status, "completed");
    assert.deepEqual(replay.record.result, { answer: 42 });

    client._db.close();
  });

  it("INSERT OR IGNORE: a second claim on an active lease is blocked", async () => {
    const client = await tryCreateSqliteClient(":memory:");
    await DbIdempotencyStore.runMigrations(client);
    const store = new DbIdempotencyStore(client);

    const a = await store.claim({ key: "k2", ownerId: "o1", leaseMs: 30_000, traceId: "t" });
    const b = await store.claim({ key: "k2", ownerId: "o2", leaseMs: 30_000, traceId: "t" });
    assert.equal(a.status, "claimed");
    assert.equal(b.status, "in_progress");

    client._db.close();
  });

  it("failed records are reclaimable; non-owner complete is rejected", async () => {
    const client = await tryCreateSqliteClient(":memory:");
    await DbIdempotencyStore.runMigrations(client);
    const store = new DbIdempotencyStore(client);

    await store.claim({ key: "k3", ownerId: "o1", leaseMs: 30_000, traceId: "t1" });
    assert.equal(await store.complete("k3", "impostor", { x: 1 }), false);
    await store.fail("k3", "o1", { message: "boom" });

    const retry = await store.claim({ key: "k3", ownerId: "o2", leaseMs: 30_000, traceId: "t2" });
    assert.equal(retry.status, "claimed");

    client._db.close();
  });

  it("expired lease is reclaimable; an active one is not", async () => {
    const client = await tryCreateSqliteClient(":memory:");
    await DbIdempotencyStore.runMigrations(client);
    const store = new DbIdempotencyStore(client);

    await store.claim({ key: "k4", ownerId: "o1", leaseMs: 0, traceId: "t1" });
    await new Promise((r) => setTimeout(r, 5));

    const reclaim = await store.claim({ key: "k4", ownerId: "o2", leaseMs: 30_000, traceId: "t2" });
    assert.equal(reclaim.status, "claimed");

    const blocked = await store.claim({ key: "k4", ownerId: "o3", leaseMs: 30_000, traceId: "t3" });
    assert.equal(blocked.status, "in_progress");

    client._db.close();
  });

  // ── Level 2: true multi-process race on one shared file ──

  describe("multi-process claim race (separate OS processes, one DB file)", () => {
    let dir, dbPath;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), "tg-idem-"));
      dbPath = join(dir, "idem.db");
    });

    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("8 processes racing the same key → exactly one winner", async () => {
      // Migrate once from the parent, then close so workers contend cleanly.
      const migrator = await tryCreateSqliteClient(dbPath);
      await DbIdempotencyStore.runMigrations(migrator);
      migrator._db.close();

      const N = 8;
      const startAt = Date.now() + 300; // shared wake-up barrier
      const statuses = await Promise.all(
        Array.from({ length: N }, () => runWorker(dbPath, "race-key", startAt)),
      );

      assert.ok(
        !statuses.some((s) => s.startsWith("error:")),
        `no worker should error, got: ${statuses.join(", ")}`,
      );
      const claimed = statuses.filter((s) => s === "claimed");
      const inProgress = statuses.filter((s) => s === "in_progress");
      assert.equal(claimed.length, 1, `exactly one winner, got: ${statuses.join(", ")}`);
      assert.equal(inProgress.length, N - 1, `the rest see in_progress, got: ${statuses.join(", ")}`);
    });
  });
});
