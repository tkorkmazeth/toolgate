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

Do not treat it as multi-instance production-safe. Durable idempotency is future work.

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
