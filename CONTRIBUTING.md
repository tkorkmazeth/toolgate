# Contributing

Thanks for helping improve Toolgate. This project is in developer preview, so small,
well-scoped changes are easiest to review.

## Local setup

```bash
npm install
npm run build
npm test
npm run example:local
```

## Before opening a pull request

Run:

```bash
npm run typecheck
npm test
npm run test:sdk
npm run package:dry-run
```

## Test guidance

Prefer tests that import the public built SDK (`../../dist/index.js`) for public behavior.
Inline implementation tests are still useful for focused spec coverage, but new end-to-end
runtime behavior should exercise the exported package API where practical.

Good candidates for SDK import tests:

- local-first fallback and `payment_required` behavior,
- idempotent replay without double deduct,
- prepaid recovery after handler failure,
- MCP adapter response metadata,
- rail adapter challenge/verification behavior with deterministic fakes.

## Scope

Keep pull requests focused. Avoid mixing documentation, runtime behavior, rail adapter work,
and formatting-only changes in the same PR unless they are required for one coherent change.

## Commit style

Use short, descriptive commit messages. Examples:

```text
fix prepaid recovery trace status
add local-first runtime example
docs: clarify x402 limitations
```
