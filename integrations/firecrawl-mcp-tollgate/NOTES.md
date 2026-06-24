# Firecrawl MCP Integration Notes

## Summary

Target tool: `firecrawl_scrape`

Goal of the attempt: wrap one real Firecrawl MCP tool with `paidAction` and prove the recovery contract without changing the Tollgate SDK core.

## Lines Of Code Changed

- SDK core changes: 0 lines
- Integration wrapper and scenario: 267 net-new lines
- Root script wiring: 1 line in `package.json`
- Docs and notes: separate from the runtime integration count above

## What Changed

- Added `integrations/firecrawl-mcp-tollgate/index.mjs` as a small wrapper around the Firecrawl scrape contract
- Added `integrations/firecrawl-mcp-tollgate/scenario.mjs` to prove:
  - payment available -> full result
  - payment missing -> fallback result
  - duplicate requestId plus URL -> replay previous result with no double charge
  - handler or API error -> refund
  - trace output -> decision events

## Where The Idempotency Key Came From

Firecrawl's scrape tool exposes a URL, but not an app-level idempotency key that Tollgate can safely reuse.

The wrapper therefore sourced idempotency from:

- callerId
- `requestId` injected by the MCP caller or wrapper layer
- normalized URL

Final key shape:

```text
firecrawl_scrape:{callerId}:{requestId}:{normalizedUrl}
```

The URL normalization step strips the hash and sorts query parameters so the same page does not accidentally double-charge because of query-string ordering.

## How Fallback Was Implemented

Fallback is not a Firecrawl server primitive. It had to be defined at the wrapper boundary.

The fallback returns:

- the same tool name
- the normalized URL
- a lightweight preview payload
- a recovery hint: `top_up_and_retry`

That keeps the MCP contract stable while making the degraded response explicit.

## Which Recovery Actions Were Useful

- `fallback_response`: best fit for missing payment on expensive scrape calls
- duplicate replay: essential for retry safety and no double charge
- `refund`: useful when the downstream scrape call throws after payment deduction
- `no_charge`: still useful conceptually for pre-execution aborts, although this scenario exercised `refund`
- traces: the most useful debugging surface because they showed `payment_deducted`, `handler_started`, and the final recovery decision

## Did The SDK API Feel Natural?

Mostly yes.

`paidAction` was the right abstraction for this integration because the MCP tool wrapper is really a paid action around an external server call, not a new Tollgate-native tool type.

The parts that felt natural:

- `paidAction` plus `fallback`
- custom `idempotencyKey`
- `onDuplicateDetected`
- trace lookup by idempotency key

The parts that still need integration glue rather than SDK changes:

- transport wiring into a live stdio or streamable-HTTP MCP server
- deciding where `requestId` should come from in a real client stack
- shaping a degraded fallback payload for agents

## Real Friction Points

1. Firecrawl does not hand Tollgate a stable idempotency token. The integration had to introduce `requestId` and compose it with a normalized URL.
2. URL normalization matters. The same page can arrive with reordered query params or an irrelevant fragment, which would otherwise create false misses in duplicate detection.
3. A live Firecrawl MCP deployment sits behind stdio or HTTP transport plus API-key configuration. That means deterministic repo-local validation needed a transport seam instead of spawning the server in-process.
4. Firecrawl returns premium results, but it does not define a degraded response contract. The wrapper had to invent the fallback payload shape.

## Which Assumptions Broke

- Assumption: the downstream MCP tool would already expose a safe idempotency handle. It did not.
- Assumption: URL alone was enough for duplicate protection. It was not; `requestId` is needed to distinguish intentional repeated scrapes from retries.
- Assumption: a "real integration attempt" required SDK changes. It did not. The existing Tollgate surface was enough for the first pass.
