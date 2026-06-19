import assert from "node:assert/strict";
import { ToolGate, createMcpAdapter, usd, toNumber } from "../../dist/index.js";
import {
  createFirecrawlFallbackResult,
  createFirecrawlIdempotencyKey,
  createFirecrawlPremiumResult,
  createLiveFirecrawlTransport,
  firecrawlScrapeInputSchema,
  previewMarkdown,
  summarizeTrace,
} from "./index.mjs";

const callerId = "firecrawl-live-agent";
const targetUrl =
  process.env.FIRECRAWL_LIVE_TEST_URL ??
  process.argv[2] ??
  "https://github.com/tkorkmazeth/toolgate";

function parseMcpPayload(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("Missing text content in MCP response");
  return JSON.parse(text);
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

async function runLiveScenario() {
  const gate = new ToolGate({
    publisherKey: "tg_firecrawl_live",
    paymentRails: ["stripe"],
  });
  const transport = createLiveFirecrawlTransport();
  const duplicateKeys = [];
  const tool = createRegisteredFirecrawlTool({
    gate,
    transport,
    duplicateKeys,
  });

  const fallbackInput = {
    requestId: "firecrawl-live-missing-001",
    url: targetUrl,
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
    reference: "firecrawl-live-credit",
  });

  const paidInput = {
    requestId: "firecrawl-live-paid-001",
    url: targetUrl,
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
  assert.equal(typeof paidOutput.result?.markdown, "string");
  assert.ok(paidOutput.result.markdown.length > 0);
  assert.equal(transport.calls.length, 1);
  assert.equal(toNumber(balanceBeforePaid) - toNumber(balanceAfterPaid), 0.25);
  assert.equal(paidTrace?.chargeStatus, "charged");
  assert.equal(paidTrace?.handlerStatus, "success");
  assert.ok(
    paidTrace?.events.some((event) => event.event === "payment_deducted"),
  );
  assert.ok(
    paidTrace?.events.some((event) => event.event === "handler_success"),
  );

  const duplicateResult = await tool.handler(paidInput, {
    sessionId: callerId,
  });
  const balanceAfterDuplicate = await gate.ledger.getBalance(callerId);

  assert.deepEqual(duplicateResult, paidResult);
  assert.equal(toNumber(balanceAfterDuplicate), toNumber(balanceAfterPaid));
  assert.equal(transport.calls.length, 1);
  assert.equal(duplicateKeys.length, 1);

  const traces = await gate.traces.toJSON({ toolName: "firecrawl_scrape" });

  return {
    integration: "firecrawl-mcp-toolgate-live",
    targetUrl: paidOutput.url,
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
        name: "payment_available_live_scrape_via_mcp",
        balanceBefore: toNumber(balanceBeforePaid),
        balanceAfter: toNumber(balanceAfterPaid),
        metadata: paidOutput.result?.metadata ?? null,
        markdownPreview: previewMarkdown(paidOutput.result?.markdown),
        trace: summarizeTrace(paidTrace),
      },
      {
        name: "duplicate_request",
        duplicateKeys,
        balanceAfterFirst: toNumber(balanceAfterPaid),
        balanceAfterDuplicate: toNumber(balanceAfterDuplicate),
        transportCalls: transport.calls.length,
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

try {
  const summary = await runLiveScenario();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  const message = (error && error.message) || String(error);
  if (message.includes("Missing FIRECRAWL_API_KEY")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          integration: "firecrawl-mcp-toolgate-live",
          blocked: true,
          blocker: {
            reason: "missing_env",
            required: ["FIRECRAWL_API_KEY"],
            details:
              "Export FIRECRAWL_API_KEY in the terminal before running the live Firecrawl scenario.",
          },
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 0;
  } else {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
