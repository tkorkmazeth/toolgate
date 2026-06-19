import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolGate, createMcpAdapter, usd } from "../../dist/index.js";
import {
  createFakeFirecrawlTransport,
  createFirecrawlFallbackResult,
  createFirecrawlIdempotencyKey,
  createFirecrawlPremiumResult,
  firecrawlScrapeInputSchema,
  normalizeFirecrawlUrl,
} from "../../integrations/firecrawl-mcp-toolgate/index.mjs";

const callerId = "firecrawl-test-agent";

function parseMcpPayload(result) {
  return JSON.parse(result.content[0].text);
}

function createRegisteredFirecrawlTool({ gate, transport, duplicateKeys }) {
  const mcp = createMcpAdapter(gate, {
    includeMeta: true,
    getCallerId: () => callerId,
  });

  mcp.paidTool("firecrawl_scrape", {
    description: "Paid wrapper for the Firecrawl MCP scrape tool",
    inputSchema: firecrawlScrapeInputSchema,
    price: usd("0.25"),
    onPaymentFailed: "fallback",
    idempotencyKey: createFirecrawlIdempotencyKey,
    onDuplicateDetected: async (_input, record) => {
      duplicateKeys.push(record.key);
    },
    handler: async (input) =>
      createFirecrawlPremiumResult(input, callerId, transport),
    fallback: async (input) => createFirecrawlFallbackResult(input),
  });

  let registeredTool;
  const server = {
    tool(name, schema, handler) {
      registeredTool = { name, schema, handler };
    },
  };
  mcp.registerAll(server);

  return registeredTool;
}

describe("Firecrawl normalization", () => {
  it("normalizes query param ordering", () => {
    assert.equal(
      normalizeFirecrawlUrl("https://example.com/path?b=2&a=1"),
      normalizeFirecrawlUrl("https://example.com/path?a=1&b=2"),
    );
  });

  it("removes hashes from URLs", () => {
    assert.equal(
      normalizeFirecrawlUrl("https://example.com/path?a=1#section"),
      "https://example.com/path?a=1",
    );
  });

  it("normalizes trailing slashes", () => {
    assert.equal(
      normalizeFirecrawlUrl("https://example.com/docs/"),
      normalizeFirecrawlUrl("https://example.com/docs"),
    );
  });
});

describe("Firecrawl idempotency", () => {
  it("uses scrapeOptions hash when requestId is missing", () => {
    const left = createFirecrawlIdempotencyKey(
      {
        url: "https://example.com/path?a=1#section",
        scrapeOptions: { onlyMainContent: true, formats: ["markdown"] },
      },
      callerId,
    );
    const right = createFirecrawlIdempotencyKey(
      {
        url: "https://example.com/path?a=1",
        scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
      },
      callerId,
    );
    const different = createFirecrawlIdempotencyKey(
      {
        url: "https://example.com/path?a=1",
        scrapeOptions: { formats: ["markdown"], onlyMainContent: false },
      },
      callerId,
    );

    assert.equal(left, right);
    assert.notEqual(left, different);
    assert.match(left, /options:/);
  });
});

describe("Firecrawl MCP adapter path", () => {
  it("marks fallback traces with no charge and avoids transport calls", async () => {
    const gate = new ToolGate({
      publisherKey: "tg_firecrawl_test",
      paymentRails: ["stripe"],
    });
    const transport = createFakeFirecrawlTransport();
    const duplicateKeys = [];
    const tool = createRegisteredFirecrawlTool({
      gate,
      transport,
      duplicateKeys,
    });
    const input = {
      requestId: "fc-fallback-001",
      url: "https://example.com/pricing?b=2&a=1#hash",
    };

    const result = await tool.handler(input, { sessionId: callerId });
    const trace = await gate.traces.findByIdempotencyKey(
      createFirecrawlIdempotencyKey(input, callerId),
    );

    assert.equal(result.isError, false);
    assert.equal(result._meta.toolgate.isFallback, true);
    assert.equal(parseMcpPayload(result).mode, "fallback");
    assert.equal(trace?.fallbackUsed, true);
    assert.equal(trace?.chargeStatus, "none");
    assert.equal(transport.calls.length, 0);
    assert.deepEqual(duplicateKeys, []);
  });

  it("replays duplicates through MCP without re-calling Firecrawl", async () => {
    const gate = new ToolGate({
      publisherKey: "tg_firecrawl_test",
      paymentRails: ["stripe"],
    });
    const transport = createFakeFirecrawlTransport();
    const duplicateKeys = [];
    const tool = createRegisteredFirecrawlTool({
      gate,
      transport,
      duplicateKeys,
    });
    const input = {
      requestId: "fc-paid-001",
      url: "https://example.com/pricing?a=1&b=2",
    };

    await gate.ledger.credit(callerId, usd("1.00"), {
      source: "manual",
      reference: "firecrawl-test-credit",
    });

    const first = await tool.handler(input, { sessionId: callerId });
    const second = await tool.handler(input, { sessionId: callerId });
    const trace = await gate.traces.findByIdempotencyKey(
      createFirecrawlIdempotencyKey(input, callerId),
    );

    assert.equal(first.isError, false);
    assert.deepEqual(second, first);
    assert.equal(parseMcpPayload(first).mode, "premium");
    assert.equal(
      parseMcpPayload(first).result.markdown.includes("Premium scrape body"),
      true,
    );
    assert.equal(transport.calls.length, 1);
    assert.equal(duplicateKeys.length, 1);
    assert.equal(trace?.chargeStatus, "charged");
    assert.equal(trace?.handlerStatus, "success");
    assert.ok(
      trace?.events.some((event) => event.event === "payment_deducted"),
    );
    assert.ok(trace?.events.some((event) => event.event === "handler_success"));
  });
});
