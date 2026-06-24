# x402 Comparison Notes

## What Hard 402 MCP Approaches Usually Do

A typical x402-paid MCP flow is:

1. tool request arrives without proof
2. server returns a payment challenge or hard 402
3. client obtains proof and retries
4. tool executes if verification and settlement succeed

That pattern is useful because the payment boundary is explicit and native to x402.

## What Tollgate Adds Above x402

Tollgate does not replace that challenge flow. It wraps the paid action and adds recovery semantics around it:

- fallback response instead of only a hard stop
- idempotent replay so the same paid retry does not double charge
- trace output for verification, settlement, duplicate detection, and recovery decisions
- explicit `refund`, `no_charge`, or `settlement_uncertain` states when execution and settlement diverge

## Practical Difference

Hard x402 behavior:

- best when you want a strict paywall and a canonical payment challenge
- weak on degraded responses and retry ergonomics by itself

Tollgate over x402:

- still preserves the x402 payment proof flow
- adds operational recovery for agents and MCP clients
- makes partial failure visible instead of collapsing everything into a single success or fail bit

## Existing Demo Surface In This Repo

Use:

```bash
npm run scenario:x402
```

That scenario already shows the important distinction:

- execution can succeed
- settlement can still be uncertain
- the trace should say so

That is the point of the integration layer. Tollgate does not replace x402. It adds fallback, idempotency, traceability, and recovery above it.
