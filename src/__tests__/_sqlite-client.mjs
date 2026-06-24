/**
 * Test helper: adapts better-sqlite3 to the D1-style `DbClient` interface that
 * `DbIdempotencyStore` / `DbLedger` expect (`prepare().bind().run()/first()`).
 *
 * SQLite is used here as a real SQL engine for integration tests. The SAME
 * adapter shape maps to Turso/libsql (`@libsql/client`) for production — that
 * is the forward-looking target; SQLite just lets us prove the SQL and the
 * cross-process serialization locally and in CI without a network service.
 *
 * Returns null if better-sqlite3 is not installed, so callers can skip
 * gracefully on platforms where the native module is unavailable.
 */
export async function tryCreateSqliteClient(path = ":memory:") {
  let Database;
  try {
    ({ default: Database } = await import("better-sqlite3"));
  } catch {
    return null;
  }

  const db = new Database(path);
  // WAL + busy_timeout so concurrent writers (separate processes sharing one
  // file) wait for the write lock instead of throwing SQLITE_BUSY.
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  return {
    _db: db,
    prepare(sql) {
      const stmt = db.prepare(sql);
      let bound = [];
      return {
        bind(...values) {
          bound = values;
          return this;
        },
        async run() {
          const r = stmt.run(...bound);
          return { success: true, changes: r.changes };
        },
        async first() {
          return stmt.get(...bound) ?? null;
        },
        async all() {
          return { results: stmt.all(...bound) };
        },
      };
    },
  };
}
