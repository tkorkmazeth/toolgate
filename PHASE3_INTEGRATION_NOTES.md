# Phase 3 Integration Notes

Phase 3 is focused on rail validation plus realistic MCP tool integration.

## Lines of Code Changed

- Modified files: 309 insertions, 9 deletions
- New example files: 560 lines added
- Total current Phase 3 delta: 869 lines added, 9 lines deleted

## Example Coverage

- `examples/mcp-ledger-recovery`: local paper/search MCP adapter
- `examples/mcp-mpp-recovery`: local scraping/extraction MCP adapter with MPP proof validation
- `examples/mcp-x402-experimental`: local paid API wrapper MCP adapter with explicit x402 facilitator

## Idempotency Key Source

- All three examples derive the key from `requestId`
- MCP adapter passes `idempotencyKey` through to ToolGate so duplicate MCP calls replay the original result instead of re-charging
- Example format: `<toolName>:<callerId>:<requestId>`

## Fallback Implementation

- Every example uses `onPaymentFailed: "fallback"`
- Ledger example returns a downgraded paper preview
- MPP example returns a partial extraction preview when the credential is missing
- x402 example returns a degraded partner API response when no x402 payload is attached
- The fallback path runs before any hard 402 response is emitted

## How Trace Helped Debug

- `gate.traces.findByIdempotencyKey()` made it easy to inspect a single MCP request path
- `gate.traces.toJSON()` gave deterministic trace export for the scenario runners
- MPP traces now include challenge IDs, receipt IDs, and provider metadata so replay vs. re-charge is visible
- x402 traces distinguish `rail_payment_verified`, `rail_payment_settled`, `rail_credit_reversed`, `rail_settlement_skipped`, and `settlement_uncertain`
- Trace inspection exposed two real bugs during implementation:
  - MPP verification was crediting `0` because expected amount was not passed into verification context
  - MCP duplicate calls with a rail proof could provisional-credit twice unless idempotency was checked before rail verification

## Rail Assumptions That Broke

- MPP proof verification cannot be modeled as a boolean-only check; the execution path needs the verified amount in context
- Verifying a rail payment before ToolGate sees idempotency can create a double-credit leak on duplicate calls
- Rail-backed failures are not the same as prepaid refunds; provisional credits must be reversed on failed or fallback results
- x402 cannot assume a default facilitator URL
- x402 verification and settlement are separate states; successful execution does not imply settlement certainty

## Real MCP Integration Attempt

- The paper/search example is the integration fork for a realistic MCP category
- Instead of starting with a dashboard or persistence layer, the work stayed on the MCP registration boundary and validated:
  - identical recovery semantics across ledger, MPP, and x402-backed calls
  - deterministic duplicate handling from MCP request arguments
  - trace export that is usable without a database
- The same pattern was then applied to scraping/extraction and paid API wrapper categories to check whether the recovery layer remained stable across more realistic tool shapes