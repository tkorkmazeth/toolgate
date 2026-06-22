/**
 * Child-process worker for the multi-instance claim race.
 *
 * Each worker is a SEPARATE OS process opening the SAME SQLite file, then
 * racing to claim the SAME key. This is a genuine cross-instance test: the
 * winner is decided by SQLite's write lock, not by JS event-loop ordering.
 *
 * Usage: node _idempotency-claim-worker.mjs <dbPath> <key> <startAtEpochMs>
 * Prints the resulting claim status ("claimed" | "in_progress" | ...) to stdout.
 */
import { DbIdempotencyStore } from "../../dist/index.js";
import { tryCreateSqliteClient } from "./_sqlite-client.mjs";

const [dbPath, key, startAt] = process.argv.slice(2);

const client = await tryCreateSqliteClient(dbPath);
if (!client) {
  process.stdout.write("no-driver");
  process.exit(0);
}

// Barrier: every worker wakes at the same wall-clock instant to maximise
// genuine simultaneity on the write.
const waitMs = Number(startAt) - Date.now();
if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

try {
  const store = new DbIdempotencyStore(client);
  const result = await store.claim({
    key,
    ownerId: `pid-${process.pid}`,
    leaseMs: 30_000,
    traceId: `trace-${process.pid}`,
  });
  process.stdout.write(result.status);
} catch (err) {
  process.stdout.write(`error:${err.message}`);
} finally {
  client._db.close();
}
