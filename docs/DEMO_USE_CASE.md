# Recommended Demo Use Case

Use a paid search / scraping / enrichment tool as the first public demo.

The clearest story is a Firecrawl-style extraction wrapper:

1. Caller asks for a premium extraction.
2. Caller has no balance, so Tollgate serves a fallback summary instead of failing hard.
3. Caller receives `payment_required` when the tool is configured to block.
4. Caller is credited locally for the demo.
5. Premium extraction runs and returns a prepaid receipt.
6. Duplicate `requestId` replays without a second deduct.
7. A simulated upstream failure after charge triggers prepaid `credit_back` recovery.
8. The trace table shows decision, charge status, fallback usage, handler status, recovery action, and failure class.

Why this demo works:

- Search/scraping/enrichment calls are naturally paid or quota-limited.
- The fallback behavior is easy to understand: basic result vs premium result.
- Duplicate retries and upstream failures are realistic agent-tool edge cases.
- It does not require the audience to understand Stripe, x402, wallets, or webhooks first.

Use this command for the local version:

```bash
npm run example:local
```

Use this command for the deterministic Firecrawl-shaped scenario:

```bash
npm run scenario:firecrawl:fake
```

Use the live Firecrawl path only after setting `FIRECRAWL_API_KEY`:

```bash
npm run scenario:firecrawl:live -- <url>
```
