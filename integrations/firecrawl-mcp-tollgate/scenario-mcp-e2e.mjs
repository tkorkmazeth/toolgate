import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function parseTextPayload(result) {
  return JSON.parse(result.content[0].text);
}

const serverPath = fileURLToPath(
  new URL("./mcp-e2e-server.mjs", import.meta.url),
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: process.cwd(),
  stderr: "pipe",
});

const client = new Client(
  {
    name: "tollgate-firecrawl-mcp-e2e-client",
    version: "1.0.0",
  },
  { capabilities: {} },
);

const stderrChunks = [];
if (transport.stderr) {
  transport.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });
}

async function runScenario() {
  await client.connect(transport);

  const toolsResult = await client.listTools();
  const toolNames = toolsResult.tools.map((tool) => tool.name).sort();

  assert.ok(toolNames.includes("firecrawl_scrape"));
  assert.ok(toolNames.includes("view_traces"));
  assert.ok(toolNames.includes("add_balance"));

  const fallbackArgs = {
    requestId: "mcp-e2e-fallback-001",
    url: "https://example.com/pricing?b=2&a=1#fragment",
  };

  const fallbackResult = await client.callTool({
    name: "firecrawl_scrape",
    arguments: fallbackArgs,
  });
  const fallbackPayload = parseTextPayload(fallbackResult);

  assert.notEqual(fallbackResult.isError, true);
  assert.equal(fallbackPayload.mode, "fallback");

  const topUpResult = await client.callTool({
    name: "add_balance",
    arguments: { amount_usd: 1 },
  });
  const topUpPayload = parseTextPayload(topUpResult);

  assert.notEqual(topUpResult.isError, true);
  assert.equal(topUpPayload.new_balance_usd, 1);

  const paidArgs = {
    requestId: "mcp-e2e-paid-001",
    url: fallbackArgs.url,
  };

  const paidResult = await client.callTool({
    name: "firecrawl_scrape",
    arguments: paidArgs,
  });
  const paidPayload = parseTextPayload(paidResult);

  assert.notEqual(paidResult.isError, true);
  assert.equal(paidPayload.mode, "premium");
  assert.equal(typeof paidPayload.result?.markdown, "string");
  assert.ok(paidPayload.result.markdown.includes("Premium scrape body"));

  const duplicateResult = await client.callTool({
    name: "firecrawl_scrape",
    arguments: paidArgs,
  });
  const duplicatePayload = parseTextPayload(duplicateResult);

  assert.deepEqual(duplicatePayload, paidPayload);

  const tracesResult = await client.callTool({
    name: "view_traces",
    arguments: { limit: 5 },
  });
  const tracesPayload = parseTextPayload(tracesResult);
  const paidTrace = tracesPayload.traces.find((trace) =>
    trace.idempotencyKey.includes("mcp-e2e-paid-001"),
  );

  assert.notEqual(tracesResult.isError, true);
  assert.equal(tracesPayload.transportCalls, 1);
  assert.equal(tracesPayload.duplicateKeys.length, 1);
  assert.ok(paidTrace);
  assert.equal(paidTrace.decision, "execute");
  assert.equal(paidTrace.chargeStatus, "charged");
  assert.equal(paidTrace.handlerStatus, "success");
  assert.ok(paidTrace.events.includes("payment_deducted"));
  assert.ok(paidTrace.events.includes("handler_success"));

  return {
    integration: "firecrawl-mcp-sdk-e2e",
    transport: "stdio",
    tools: toolNames,
    scenarios: [
      {
        name: "list_tools",
        result: {
          toolCount: toolNames.length,
          tools: toolNames,
        },
      },
      {
        name: "payment_missing_fallback",
        result: fallbackPayload,
      },
      {
        name: "credit_balance",
        result: topUpPayload,
      },
      {
        name: "premium_execution",
        result: paidPayload,
      },
      {
        name: "duplicate_replay",
        result: duplicatePayload,
      },
      {
        name: "view_traces",
        result: tracesPayload,
      },
    ],
    stderr: stderrChunks.join(""),
  };
}

try {
  const summary = await runScenario();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} finally {
  await transport.close().catch(() => undefined);
}
