# Bright Data MCP Notes

## Decision

Do not fully integrate in this sprint.

The Bright Data MCP surface is broad and mode-driven. The mapping is clear enough to document now, but a full wrapper should wait until the Firecrawl integration is exercised against a live MCP deployment.

## Natural Tollgate Mapping

Rapid or Free mode maps cleanly to fallback or a basic tier:

- `search_engine`
- `scrape_as_markdown`
- `discover`

These tools are good candidates for:

- fallback result when payment is missing
- free tier handler in a `tiers.free` configuration
- low-cost preview before a paid rerun

Pro mode maps to paid execution:

- browser automation tools such as `scraping_browser_snapshot`, `scraping_browser_click_ref`, `scraping_browser_screenshot`
- advanced scraping helpers such as `extract`
- dataset and `web_data_*` tools that imply higher provider cost or longer polling windows

Recommended Tollgate behavior:

- Rapid or free tool -> `fallback_response` or free-tier handler
- Pro tool -> paid execution through `paidAction`
- API failure after charge -> `refund`
- failure before charge -> `no_charge`
- CAPTCHA, block, or transient rate-limit -> `retry_later` first, then `fallback_response` if there is a cheap basic path

## Friction To Expect

1. Bright Data uses mode switches and tool groups such as `PRO_MODE`, `GROUPS`, and `TOOLS`, so the billing boundary is partly environment-level rather than purely tool-level.
2. Several high-value tools are asynchronous or polling-based, especially `web_data_*`. That raises a question about whether billing should happen before kickoff, on completion, or after polling success.
3. CAPTCHA, block, and rate-limit outcomes are product-level states, not just generic handler errors. They map better to `retry_later` or a controlled fallback than to a plain exception.
4. The free tier already exists at the provider layer. Tollgate should not obscure it; it should formalize the recovery behavior above it.

## Recommended First Bright Data Slice

If this gets picked up next, start with:

- free path: `scrape_as_markdown`
- paid path: `extract` or one browser tool

That gives a simple fallback-to-paid progression without taking on the full `web_data_*` polling surface on day one.
