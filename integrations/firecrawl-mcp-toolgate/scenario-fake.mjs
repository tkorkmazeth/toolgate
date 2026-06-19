import assert from "node:assert/strict";
import { ToolGate, createMcpAdapter, usd, toNumber } from "../../dist/index.js";
import {
  createFakeFirecrawlTransport,
  createFirecrawlFallbackResult,
  createFirecrawlIdempotencyKey,
  createFirecrawlPremiumResult,
  firecrawlScrapeInputSchema,
  summarizeTrace,
} from "./index.mjs";

const callerId = "firecrawl-demo-agent";

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
    price: 0.25,
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

async function runScenario() {
  const gate = new ToolGate({
    publisherKey: "tg_firecrawl_demo",
    paymentRails: ["stripe"],
  });
  const transport = createFakeFirecrawlTransport();
  const duplicateKeys = [];
  const tool = createRegisteredFirecrawlTool({
    gate,
    transport,
    duplicateKeys,
  });

  const fallbackInput = {
    requestId: "fc-missing-001",
    url: "https://example.com/pricing?b=2&a=1#fragment",
  };
  const fallbackResult = await tool.handler(fallbackInput, {
    sessionId: callerId,
  });
  const fallbackTrace = await gate.traces.findByIdempotencyKey(
    createFirecrawlIdempotencyKey(fallbackInput, callerId),
  );

  assert.equal(fallbackResult.isError, false);
  assert.equal(fallbackResult._meta.toolgate.isFallback, true);
  assert.equal(parseMcpPayload(fallbackResult).mode, "fallback");
  assert.equal(fallbackTrace?.fallbackUsed, true);
  assert.equal(fallbackTrace?.chargeStatus, "none");
  assert.equal(transport.calls.length, 0);

  await gate.ledger.credit(callerId, usd("1.00"), {
    source: "manual",
    reference: "firecrawl-scenario-credit",
  });

  const paidInput = {
    requestId: "fc-paid-001",
    url: "https://example.com/pricing?a=1&b=2",
  };
  const balanceBeforePaid = await gate.ledger.getBalance(callerId);
  const paidResult = await tool.handler(paidInput, { sessionId: callerId });
  const paidOutput = parseMcpPayload(paidResult);
  const balanceAfterPaid = await gate.ledger.getBalance(callerId);
  const paidTrace = await gate.traces.findByIdempotencyKey(
    createFirecrawlIdempotencyKey(paidInput, callerId),
  );

  assert.equal(paidResult.isError, false);
  assert.equal(paidResult._meta.toolgate.isFallback, false);
  assert.equal(paidOutput.mode, "premium");
  assert.equal(transport.calls.length, 1);
  assert.equal(toNumber(balanceBeforePaid) - toNumber(balanceAfterPaid), 0.25);

  const duplicateResult = await tool.handler(paidInput, {
    sessionId: callerId,
  });
  const balanceAfterDuplicate = await gate.ledger.getBalance(callerId);
  const transportCallsAfterDuplicate = transport.calls.length;

  assert.deepEqual(duplicateResult, paidResult);
  assert.equal(toNumber(balanceAfterDuplicate), toNumber(balanceAfterPaid));
  assert.equal(transportCallsAfterDuplicate, 1);
  assert.equal(duplicateKeys.length, 1);

  const errorInput = {
    requestId: "fc-error-001",
    url: "https://example.com/error",
    fail: true,
  };
  const balanceBeforeError = await gate.ledger.getBalance(callerId);
  const errorResult = await tool.handler(errorInput, { sessionId: callerId });
  const balanceAfterError = await gate.ledger.getBalance(callerId);
  const errorTrace = await gate.traces.findByIdempotencyKey(
    createFirecrawlIdempotencyKey(errorInput, callerId),
  );

  assert.equal(errorResult.isError, true);
  assert.equal(toNumber(balanceAfterError), toNumber(balanceBeforeError));
  assert.equal(transport.calls.length, 2);
  assert.ok(["credit_back", "no_charge"].includes(errorTrace?.decision ?? ""));

  const traces = await gate.traces.toJSON({ toolName: "firecrawl_scrape" });

  return {
    integration: "firecrawl-mcp-toolgate-fake",
    tool: "firecrawl_scrape",
    scenarios: [
      {
        name: "payment_missing",
        result: {
          success: !fallbackResult.isError,
          isFallback: fallbackResult._meta.toolgate.isFallback,
          mode: parseMcpPayload(fallbackResult).mode,
        },
        trace: summarizeTrace(fallbackTrace),
      },
      {
        name: "payment_available_via_mcp",
        balanceBefore: toNumber(balanceBeforePaid),
        balanceAfter: toNumber(balanceAfterPaid),
        result: {
          success: !paidResult.isError,
          isFallback: paidResult._meta.toolgate.isFallback,
          mode: paidOutput.mode,
        },
        trace: summarizeTrace(paidTrace),
      },
      {
        name: "duplicate_request",
        duplicateKeys,
        transportCalls: transportCallsAfterDuplicate,
        balanceAfterFirst: toNumber(balanceAfterPaid),
        balanceAfterDuplicate: toNumber(balanceAfterDuplicate),
        sameResult:
          JSON.stringify(duplicateResult) === JSON.stringify(paidResult),
      },
      {
        name: "handler_error",
        result: {
          success: !errorResult.isError,
          error: errorResult.content[0].text,
        },
        balanceBefore: toNumber(balanceBeforeError),
        balanceAfter: toNumber(balanceAfterError),
        trace: summarizeTrace(errorTrace),
      },
      {
        name: "trace_output",
        traceCount: traces.length,
        decisions: traces.map((trace) => ({
          idempotencyKey: trace.idempotencyKey,
          decision: trace.decision,
          events: trace.events.map((event) => event.event),
        })),
      },
    ],
  };
}

const summary = await runScenario();
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
