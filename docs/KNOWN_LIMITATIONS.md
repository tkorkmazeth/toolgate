# Known Limitations

Tollgate is a developer preview. It is useful today for local-first demos, single-process
prototypes, and design-partner evaluation, but several production boundaries are intentional.

## Durable idempotency

`InMemoryIdempotencyStore` is process-local. It protects duplicate calls inside one Node.js
process, but it does not coordinate across multiple instances, regions, workers, or restarts.

Use it for:

- local demos,
- single-process prototypes,
- deterministic SDK behavior tests.

For multi-instance deployments, use `DbIdempotencyStore` — a durable store backed by a SQL
database (Cloudflare D1, Turso/libsql, SQLite). It uses the same atomic primitives as
`DbLedger` (`INSERT OR IGNORE` + conditional `UPDATE … WHERE`), so concurrent claimers across
any number of workers collapse to a single owner with no check-then-act race:

```ts
import { ToolGate, DbIdempotencyStore } from "@tkorkmaz/toolgate";

await DbIdempotencyStore.runMigrations(env.DB); // once, at startup
const gate = new ToolGate({
  publisherKey,
  idempotencyStore: new DbIdempotencyStore(env.DB),
});
```

`DbIdempotencyStore` is exercised in CI against a real SQLite engine, including an 8-process
race on one shared database file that asserts exactly one claimer wins (the cross-instance
guarantee, decided by the DB write lock rather than JS event-loop ordering). The same
`DbClient` adapter shape maps to **Turso/libsql (`@libsql/client`), which is the intended
production target**; SQLite is the local/CI engine for the same code path.

Production deployments should still validate schema migrations, lease durations against their
slowest handlers, and TTL settings against their retry windows.

## Ledgers

`InMemoryLedger` is for development and examples. `DbLedger` covers local and single-process
SQLite / D1-style paths with integer minor-unit accounting.

Production deployments should validate:

- schema migrations,
- transaction isolation,
- duplicate credit references,
- webhook replay behavior,
- backup and audit requirements.

## Stripe

Stripe test mode is validated when credentials are configured. Stripe production is beta.
Before using it with real funds, validate your own:

- Checkout session creation,
- webhook endpoint deployment,
- webhook signature verification,
- duplicate webhook delivery behavior,
- balance reconciliation.

## x402

x402 support is experimental. Testnet flows require an external signer or x402 client flow.
Mainnet has not been tested by this project; do not claim mainnet production readiness.

## MPP

MPP support is mocked / spec-path unless verified against a real `mppx` integration. Treat it
as integration scaffolding until exercised against a live provider.

## Hosted product surface

Tollgate currently ships as an open-source runtime. It does not yet include:

- hosted dashboard,
- multi-tenant hosted ledger,
- trace UI,
- enterprise spend governance,
- managed reconciliation service.
