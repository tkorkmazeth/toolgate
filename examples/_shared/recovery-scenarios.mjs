import http from "node:http";
import { pathToFileURL } from "node:url";
import {
  TollGate,
  createMcpAdapter,
  MppRailAdapter,
  X402RailAdapter,
  usd,
  toNumber,
} from "../../dist/index.js";

const DEMO_CALLER = "demo-agent";
const DEMO_PUBLISHER = "tg_phase3_demo";

export async function createLedgerExample() {
  const gate = new TollGate({
    publisherKey: DEMO_PUBLISHER,
    paymentRails: ["stripe"],
  });

  return createScenarioEnvironment({
    exampleName: "mcp-ledger-recovery",
    category: "paper/search MCP local adapter",
    gate,
    toolName: "paper_search",
    price: usd("0.15"),
    handlerKind: "paper",
    paymentMetaFactory: async () => null,
    primeForPaid: async () => {
      await gate.ledger.credit(DEMO_CALLER, usd("1.00"), {
        source: "manual",
        reference: "ledger-scenario-credit",
      });
    },
    notes: {
      idempotencyKeyFrom: "requestId",
      fallbackImplementation:
        "onPaymentFailed=fallback with a downgraded paper preview payload",
      traceDebugValue:
        "trace events showed duplicate replay without a second deduction",
      railAssumptionsBroken: [
        "prepaid ledger flows are easy to validate but do not expose provider correlation IDs",
      ],
      integrationAttempt:
        "Local paper-search adapter built against MCP registration handlers before attempting a live paper server.",
    },
  });
}

export async function createMppExample() {
  const mppAdapter = new MppRailAdapter({
    methods: [{ name: "stripe", stripeAccountId: "acct_demo_mpp" }],
    mppxInstance: {
      charge: () => async (request) => {
        const auth = request.headers.get("Authorization");
        return new Response(null, {
          status: auth === "Payment mpp-valid-demo" ? 200 : 402,
        });
      },
    },
  });

  const gate = new TollGate({
    publisherKey: DEMO_PUBLISHER,
    paymentRails: ["mpp"],
    railAdapters: [mppAdapter],
  });

  return createScenarioEnvironment({
    exampleName: "mcp-mpp-recovery",
    category: "scraping/extraction MCP paid step",
    gate,
    toolName: "extract_document",
    price: usd("0.20"),
    handlerKind: "extract",
    paymentMetaFactory: async () => {
      const challenge = await mppAdapter.createChallenge({
        callerId: DEMO_CALLER,
        amount: 0.2,
        currency: "usd",
        toolName: "extract_document",
        publisherKey: DEMO_PUBLISHER,
      });
      return {
        "org.paymentauth/credential": "mpp-valid-demo",
        tollgate: {
          mppChallengeId: challenge.mppChallenge?.challenges[0]?.id ?? null,
          providerId: "mpp-provider-demo",
        },
      };
    },
    notes: {
      idempotencyKeyFrom: "requestId",
      fallbackImplementation:
        "missing MPP credential falls back to a partial extraction summary instead of hard 402",
      traceDebugValue:
        "provider and challenge IDs on the trace exposed whether the replay used the same receipt",
      railAssumptionsBroken: [
        "MPP verification needed the expected amount in context; a zero-amount verify was not enough to fund execution",
      ],
      integrationAttempt:
        "Local extraction adapter mirrors the MCP shape used by paid scraping/extraction servers while staying deterministic.",
    },
  });
}

export async function createX402Example() {
  const facilitator = await startFacilitatorServer();
  const x402Adapter = new X402RailAdapter({
    payTo: "0x1111111111111111111111111111111111111111",
    network: { kind: "evm", caip2: "eip155:8453" },
    facilitatorUrl: facilitator.url,
    x402Version: 2,
    maxTimeoutSeconds: 60,
  });

  const gate = new TollGate({
    publisherKey: DEMO_PUBLISHER,
    paymentRails: ["x402"],
    railAdapters: [x402Adapter],
  });

  const env = await createScenarioEnvironment({
    exampleName: "mcp-x402-experimental",
    category: "paid API wrapper MCP",
    gate,
    toolName: "partner_api_lookup",
    price: usd("0.30"),
    handlerKind: "api",
    paymentMetaFactory: async (mode = "success") => {
      const challenge = await x402Adapter.createChallenge({
        callerId: DEMO_CALLER,
        amount: 0.3,
        currency: "usd",
        toolName: "partner_api_lookup",
        publisherKey: DEMO_PUBLISHER,
      });
      return {
        tollgate: {
          x402ActionId: challenge.actionId,
          x402Payment: {
            payer: "0xdemo",
            proof: `x402-${mode}`,
            forceSettleFailure: mode === "uncertain",
          },
          providerId: "x402-facilitator-demo",
        },
      };
    },
    notes: {
      idempotencyKeyFrom: "requestId",
      fallbackImplementation:
        "missing x402 payload returns a degraded partner API stub while preserving the same MCP tool contract",
      traceDebugValue:
        "settlement_uncertain made it obvious that execution succeeded before the facilitator settle leg failed",
      railAssumptionsBroken: [
        "x402 cannot ship with a default facilitator URL; every environment must choose and own that dependency",
        "verify and settle have to be tracked separately or a successful tool call can hide settlement uncertainty",
      ],
      integrationAttempt:
        "Local paid API wrapper adapter validated x402 verify/settle sequencing without claiming production readiness.",
    },
    cleanup: async () => {
      await facilitator.close();
    },
  });

  env.extraScenarios = {
    settlementUncertain: async () => {
      const meta = await env.paymentMetaFactory("uncertain");
      const args = {
        requestId: "x402-uncertain-001",
        query: "evidence cache",
      };
      const result = await env.invoke(args, meta);
      const trace = await env.gate.traces.findByIdempotencyKey(
        env.idempotencyKey(args),
      );
      return {
        name: "settlement_uncertain",
        result: normalizeResult(result),
        trace: normalizeTrace(trace),
      };
    },
  };

  return env;
}

async function createScenarioEnvironment(config) {
  const duplicateEvents = [];
  const mcp = createMcpAdapter(config.gate, {
    includeMeta: true,
    getCallerId: () => DEMO_CALLER,
  });

  const registration = mcp.paidTool(config.toolName, {
    description: `${config.category} recovery example`,
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "Stable idempotency key" },
        query: { type: "string", description: "Scenario query" },
        fail: { type: "boolean", description: "Force handler failure" },
      },
      required: ["requestId", "query"],
    },
    price: config.price,
    onPaymentFailed: "fallback",
    idempotencyKey: (args, callerId) =>
      `${config.toolName}:${callerId}:${String(args.requestId ?? "missing")}`,
    onDuplicateDetected: (_input, record) => {
      duplicateEvents.push(record.key);
    },
    handler: async (args) => {
      if (args.fail) {
        throw new Error(`${config.toolName} failed intentionally`);
      }
      return makePremiumPayload(config.handlerKind, args);
    },
    fallback: async (args) => makeFallbackPayload(config.handlerKind, args),
  });

  const env = {
    ...config,
    gate: config.gate,
    registration,
    duplicateEvents,
    paymentMetaFactory: config.paymentMetaFactory,
    idempotencyKey(args) {
      return `${config.toolName}:${DEMO_CALLER}:${String(args.requestId)}`;
    },
    async invoke(args, meta = undefined) {
      return registration.handler(args, {
        sessionId: DEMO_CALLER,
        _meta: meta ?? undefined,
      });
    },
  };

  return env;
}

export async function runScenarioSuite(createExample) {
  const env = await createExample();
  try {
    const fallbackArgs = { requestId: "missing-001", query: "vector cache" };
    const fallbackResult = await env.invoke(fallbackArgs);
    const fallbackTrace = await env.gate.traces.findByIdempotencyKey(
      env.idempotencyKey(fallbackArgs),
    );

    await env.primeForPaid?.();
    const paidArgs = { requestId: "paid-001", query: "vector cache" };
    const paidMeta = await env.paymentMetaFactory?.("success");
    const balanceBeforePaid = await env.gate.ledger.getBalance(DEMO_CALLER);
    const paidResult = await env.invoke(paidArgs, paidMeta ?? undefined);
    const balanceAfterPaid = await env.gate.ledger.getBalance(DEMO_CALLER);
    const paidTrace = await env.gate.traces.findByIdempotencyKey(
      env.idempotencyKey(paidArgs),
    );

    const duplicateResult = await env.invoke(paidArgs, paidMeta ?? undefined);
    const balanceAfterDuplicate = await env.gate.ledger.getBalance(DEMO_CALLER);

    const errorArgs = {
      requestId: "error-001",
      query: "vector cache",
      fail: true,
    };
    const errorMeta = await env.paymentMetaFactory?.("success");
    const balanceBeforeError = await env.gate.ledger.getBalance(DEMO_CALLER);
    const errorResult = await env.invoke(errorArgs, errorMeta ?? undefined);
    const balanceAfterError = await env.gate.ledger.getBalance(DEMO_CALLER);
    const errorTrace = await env.gate.traces.findByIdempotencyKey(
      env.idempotencyKey(errorArgs),
    );

    const traces = await env.gate.traces.toJSON({ toolName: env.toolName });
    const summary = {
      example: env.exampleName,
      category: env.category,
      scenarios: [
        {
          name: "payment_missing_fallback",
          result: normalizeResult(fallbackResult),
          trace: normalizeTrace(fallbackTrace),
        },
        {
          name: "payment_available_execute",
          balanceBefore: roundMoney(balanceBeforePaid),
          balanceAfter: roundMoney(balanceAfterPaid),
          result: normalizeResult(paidResult),
          trace: normalizeTrace(paidTrace),
        },
        {
          name: "duplicate_idempotency_key",
          balanceAfterFirst: roundMoney(balanceAfterPaid),
          balanceAfterDuplicate: roundMoney(balanceAfterDuplicate),
          duplicateHookCount: env.duplicateEvents.length,
          sameAsPaid:
            JSON.stringify(normalizeResult(duplicateResult)) ===
            JSON.stringify(normalizeResult(paidResult)),
          result: normalizeResult(duplicateResult),
        },
        {
          name: "handler_error_recovery",
          balanceBefore: roundMoney(balanceBeforeError),
          balanceAfter: roundMoney(balanceAfterError),
          result: normalizeResult(errorResult),
          trace: normalizeTrace(errorTrace),
        },
        {
          name: "trace_output",
          traceCount: traces.length,
          traces: traces.map((trace) => normalizeTrace(trace)),
        },
      ],
      extraScenarios: env.extraScenarios
        ? await Promise.all(
            Object.values(env.extraScenarios).map((scenario) => scenario()),
          )
        : [],
      notes: env.notes,
    };

    return { env, summary };
  } catch (error) {
    await env.cleanup?.();
    throw error;
  }
}

export async function runExampleCli(createExample, command = "scenario") {
  const { env, summary } = await runScenarioSuite(createExample);
  try {
    if (command === "traces") {
      const traces = await env.gate.traces.toJSON({ toolName: env.toolName });
      process.stdout.write(`${JSON.stringify(traces, null, 2)}\n`);
      return;
    }

    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await env.cleanup?.();
  }
}

export function printExampleIntro(name, category) {
  process.stdout.write(
    `${name}: ${category}\nRun the scenario with: node scenario.mjs\nPrint traces with: node scenario.mjs traces\n`,
  );
}

function makePremiumPayload(kind, args) {
  if (kind === "paper") {
    return {
      mode: "premium",
      requestId: args.requestId,
      papers: [
        {
          title: "Deterministic Recovery for Paid Agent Tools",
          doi: "10.5555/tollgate.2026.001",
        },
      ],
    };
  }

  if (kind === "extract") {
    return {
      mode: "premium",
      requestId: args.requestId,
      document: {
        title: "Recovery Notes",
        fields: ["headline", "body", "citations"],
      },
    };
  }

  return {
    mode: "premium",
    requestId: args.requestId,
    payload: {
      provider: "partner-api",
      answer: `premium:${args.query}`,
    },
  };
}

function makeFallbackPayload(kind, args) {
  if (kind === "paper") {
    return {
      mode: "fallback",
      requestId: args.requestId,
      preview: ["Preview paper abstract only"],
    };
  }

  if (kind === "extract") {
    return {
      mode: "fallback",
      requestId: args.requestId,
      preview: { title: "Partial extraction preview" },
    };
  }

  return {
    mode: "fallback",
    requestId: args.requestId,
    preview: { answer: `fallback:${args.query}` },
  };
}

function normalizeResult(result) {
  const first =
    result.content?.[0]?.type === "text" ? result.content[0].text : null;
  return {
    isError: Boolean(result.isError),
    output: parseText(first),
    meta: normalizeMeta(result._meta),
  };
}

function normalizeMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  const tollgate =
    meta.tollgate && typeof meta.tollgate === "object" ? meta.tollgate : null;
  if (!tollgate) return null;
  return {
    paid: Boolean(tollgate.paid),
    isFallback: Boolean(tollgate.isFallback),
    acceptedRails: Array.isArray(tollgate.acceptedRails)
      ? tollgate.acceptedRails
      : undefined,
    amount:
      typeof tollgate.amount === "number"
        ? roundMoney(tollgate.amount)
        : undefined,
  };
}

function normalizeTrace(trace) {
  if (!trace) return null;
  return {
    toolName: trace.toolName,
    idempotencyKey: trace.idempotencyKey,
    decision: trace.decision,
    failureClass: trace.failureClass ?? null,
    chargeStatus: trace.chargeStatus,
    rail: trace.rail ?? "none",
    challengeId: trace.challengeId ?? null,
    receiptId: trace.receiptId ?? null,
    provider: trace.provider ?? null,
    events: trace.events.map((event) => event.event),
  };
}

function parseText(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function roundMoney(value) {
  if (value && typeof value === "object" && "minorUnits" in value) {
    return roundMoney(toNumber(value));
  }
  return Math.round(value * 10000) / 10000;
}

async function startFacilitatorServer() {
  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    const payload = body?.paymentPayload ?? {};

    if (request.url === "/verify") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ valid: payload.proof?.startsWith("x402-") }),
      );
      return;
    }

    if (request.url === "/settle") {
      if (payload.forceSettleFailure) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ success: false }));
        return;
      }

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: true, txHash: "0xsettledemo" }));
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not start x402 facilitator server");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

export function isDirectRun(metaUrl, argv1) {
  return pathToFileURL(argv1).href === metaUrl;
}
