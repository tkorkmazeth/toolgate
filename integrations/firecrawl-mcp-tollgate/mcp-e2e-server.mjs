import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TollGate, createMcpAdapter, usd, toNumber } from "../../dist/index.js";
import {
  createFakeFirecrawlTransport,
  createFirecrawlFallbackResult,
  createFirecrawlIdempotencyKey,
  createFirecrawlPremiumResult,
  firecrawlScrapeInputSchema,
} from "./index.mjs";

const callerId = "mcp-e2e-client";
const duplicateKeys = [];
const gate = new TollGate({
  publisherKey: "tg_firecrawl_mcp_e2e",
  paymentRails: ["stripe"],
});
const transportState = createFakeFirecrawlTransport();
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
    createFirecrawlPremiumResult(input, callerId, transportState),
  fallback: async (input) => createFirecrawlFallbackResult(input),
});

const server = new McpServer({
  name: "tollgate-firecrawl-mcp-e2e",
  version: "1.0.0",
});

server.tool(
  "add_balance",
  {
    amount_usd: z.number().min(0.01).max(100),
  },
  async ({ amount_usd }) => {
    await gate.ledger.credit(callerId, usd(amount_usd), {
      source: "manual",
      reference: `mcp-e2e-topup-${Date.now()}`,
    });
    const balance = await gate.ledger.getBalance(callerId);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              callerId,
              added_usd: amount_usd,
              new_balance_usd: toNumber(balance),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  "view_traces",
  {
    limit: z.number().int().min(1).max(20).optional(),
  },
  async ({ limit = 10 }) => {
    const traces = await gate.traces.list({ callerId, limit });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              callerId,
              totalTraces: gate.traces.count,
              duplicateKeys,
              transportCalls: transportState.calls.length,
              traces: traces.map((trace) => ({
                idempotencyKey: trace.idempotencyKey,
                decision: trace.decision,
                chargeStatus: trace.chargeStatus,
                handlerStatus: trace.handlerStatus,
                fallbackUsed: trace.fallbackUsed,
                receiptId: trace.receiptId ?? null,
                provider: trace.provider ?? null,
                events: trace.events.map((event) => event.event),
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

const [firecrawlRegistration] = mcp.getRegistrations();

server.tool(
  firecrawlRegistration.name,
  {
    requestId: z.string().optional(),
    url: z.string(),
    fail: z.boolean().optional(),
    scrapeOptions: z.record(z.unknown()).optional(),
  },
  async (args, extra) => firecrawlRegistration.handler(args, extra),
);

const transport = new StdioServerTransport();
await server.connect(transport);
