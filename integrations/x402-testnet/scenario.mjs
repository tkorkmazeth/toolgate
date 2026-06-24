import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
  buildProofMeta,
  callerId,
  createRuntime,
  defaultAmount,
  extractPaymentRequiredDetails,
  getNetworkFromEnv,
  parseJsonEnv,
  printSummary,
  toolName,
} from "../../examples/x402-testnet-recovery/_shared.mjs";

const requiredEnv = [
  "X402_FACILITATOR_URL",
  "X402_PAY_TO",
  "X402_NETWORK_CAIP2",
];

function readAcceptedAmount(accepted) {
  return accepted?.amount ?? accepted?.maxAmountRequired ?? null;
}

function validateProofShape(name, proof, expected) {
  const warnings = [];

  assert.ok(proof?.actionId, `${name}.actionId is required`);
  assert.ok(proof?.payload, `${name}.payload is required`);

  const accepted = proof.payload.accepted;
  if (!accepted) {
    warnings.push(
      `${name}: proof.payload.accepted is missing; skipping network/asset/amount/payTo consistency checks.`,
    );
    return warnings;
  }

  const checks = [
    {
      key: "network",
      actual: accepted.network,
      expected: expected.network,
    },
    {
      key: "asset",
      actual: accepted.asset,
      expected: expected.asset,
    },
    {
      key: "payTo",
      actual: accepted.payTo,
      expected: expected.payTo,
    },
    {
      key: "amount",
      actual: readAcceptedAmount(accepted),
      expected: expected.amount,
    },
  ];

  for (const check of checks) {
    if (!check.actual) {
      warnings.push(
        `${name}: proof.payload.accepted.${check.key} is missing; skipping that consistency check.`,
      );
      continue;
    }

    assert.equal(
      check.actual,
      check.expected,
      `${name}.payload.accepted.${check.key} did not match the scenario expectation`,
    );
  }

  return warnings;
}

async function createSettlementUncertainAdapter(
  facilitatorUrl,
  payTo,
  network,
) {
  const upstream = new URL(facilitatorUrl);
  const proxy = http.createServer(async (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    await once(req, "end");
    const rawBody = Buffer.concat(chunks);

    if (req.url === "/verify") {
      const response = await fetch(new URL("/verify", upstream), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: rawBody,
      });
      const text = await response.text();
      res.statusCode = response.status;
      res.setHeader(
        "content-type",
        response.headers.get("content-type") ?? "application/json",
      );
      res.end(text);
      return;
    }

    if (req.url === "/settle") {
      res.statusCode = 502;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ success: false, error: "forced_settlement_failure" }),
      );
      return;
    }

    res.statusCode = 404;
    res.end("not_found");
  });

  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    proxy,
    ...createRuntime({
      facilitatorUrl: `http://127.0.0.1:${port}`,
      payTo,
      network,
    }),
  };
}

async function runScenario() {
  const missing = requiredEnv.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    printSummary({
      scenario: "x402-testnet-recovery",
      blocked: true,
      partial: false,
      blocker: {
        reason: "missing_env",
        required: requiredEnv,
        missing,
        facilitatorUrl:
          process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator",
        network: process.env.X402_NETWORK_CAIP2 ?? "eip155:84532",
        details:
          "Tollgate can generate the challenge internally, but this repo still needs a signed x402 proof from the recovery helpers or another client flow. Provide X402_PAYMENT_PROOF_JSON for the main path and optionally X402_PAYMENT_UNCERTAIN_PROOF_JSON for settlement_uncertain.",
        explicitBlocker:
          "This test validates verify/settle with supplied proofs. It does not sign the client payment payload inline.",
      },
    });
    return;
  }

  const network = getNetworkFromEnv();
  const successProof = parseJsonEnv("X402_PAYMENT_PROOF_JSON");
  const uncertainProof = parseJsonEnv("X402_PAYMENT_UNCERTAIN_PROOF_JSON");
  const { gate, duplicateKeys, registration, blockingRegistration } =
    createRuntime({ network });
  const warnings = [];

  const fallbackArgs = { requestId: "x402-missing-001", query: "vector cache" };
  const fallbackResult = await registration.handler(fallbackArgs, {
    sessionId: callerId,
  });
  const fallbackTrace = await gate.traces.findByIdempotencyKey(
    `${toolName}:${callerId}:${fallbackArgs.requestId}`,
  );

  const paymentRequiredArgs = {
    requestId: "x402-required-001",
    query: "vector cache",
  };
  const paymentRequiredResult = await blockingRegistration.handler(
    paymentRequiredArgs,
    {
      sessionId: callerId,
    },
  );
  const paymentRequiredTrace = await gate.traces.findByIdempotencyKey(
    `${toolName}_blocking:${callerId}:${paymentRequiredArgs.requestId}`,
  );

  assert.equal(fallbackResult.isError, false);
  assert.equal(JSON.parse(fallbackResult.content[0].text).mode, "fallback");
  assert.equal(paymentRequiredResult.isError, true);

  const paymentRequiredContent = extractPaymentRequiredDetails(
    paymentRequiredResult,
  );
  assert.ok(paymentRequiredContent);
  const x402Settlement =
    paymentRequiredContent.paymentRequired?.settlements?.find(
      (entry) => entry.rail === "x402",
    ) ?? null;

  assert.equal(paymentRequiredContent.error, "payment_required");
  assert.equal(
    paymentRequiredContent.paymentRequired?.error,
    "payment_required",
  );
  assert.equal(paymentRequiredTrace?.decision, "topup_required");
  assert.ok(x402Settlement);
  assert.equal(x402Settlement?.rail, "x402");
  assert.ok(x402Settlement?.actionId);
  assert.ok(x402Settlement?.x402PaymentRequired);
  assert.deepEqual(
    paymentRequiredContent.paymentRequired?.x402Challenge,
    x402Settlement?.x402PaymentRequired,
  );

  const expectedAccepted = x402Settlement?.x402PaymentRequired?.accepts?.[0];
  const expectedProofShape = {
    network: network.caip2,
    asset: expectedAccepted?.asset,
    payTo: process.env.X402_PAY_TO,
    amount: readAcceptedAmount(expectedAccepted) ?? String(defaultAmount),
  };

  if (successProof) {
    warnings.push(
      ...validateProofShape(
        "X402_PAYMENT_PROOF_JSON",
        successProof,
        expectedProofShape,
      ),
    );
  }

  if (uncertainProof) {
    warnings.push(
      ...validateProofShape(
        "X402_PAYMENT_UNCERTAIN_PROOF_JSON",
        uncertainProof,
        expectedProofShape,
      ),
    );
  }

  let verifyAndSettleSummary;
  let duplicateSummary;
  if (successProof) {
    const paidArgs = { requestId: "x402-paid-001", query: "vector cache" };
    const paidMeta = buildProofMeta(
      successProof,
      process.env.X402_FACILITATOR_URL,
    );
    const paidResult = await registration.handler(paidArgs, {
      sessionId: callerId,
      _meta: paidMeta,
    });
    const duplicateResult = await registration.handler(paidArgs, {
      sessionId: callerId,
      _meta: paidMeta,
    });
    const paidTrace = await gate.traces.findByIdempotencyKey(
      `${toolName}:${callerId}:${paidArgs.requestId}`,
    );

    assert.equal(paidResult.isError, false);
    assert.deepEqual(duplicateResult, paidResult);
    assert.equal(paidTrace?.decision, "execute");
    assert.equal(paidTrace?.chargeStatus, "charged");
    assert.ok(paidTrace?.receiptId);
    assert.ok(paidTrace?.provider?.traceId);
    assert.equal(duplicateKeys.length, 1);

    verifyAndSettleSummary = {
      skipped: false,
      actionId: successProof.actionId,
      result: paidResult,
      trace: paidTrace,
    };
    duplicateSummary = {
      skipped: false,
      duplicateKeys,
      result: duplicateResult,
    };
  } else {
    verifyAndSettleSummary = {
      skipped: true,
      blocker: {
        reason: "missing_X402_PAYMENT_PROOF_JSON",
        required: ["X402_PAYMENT_PROOF_JSON"],
        details:
          "Generate the payment_required challenge with examples/x402-testnet-recovery/challenge.mjs, sign it with sign-payload.mjs, then pass the resulting proof JSON here.",
      },
    };
    duplicateSummary = {
      skipped: true,
      blocker: {
        reason: "missing_X402_PAYMENT_PROOF_JSON",
        required: ["X402_PAYMENT_PROOF_JSON"],
        details:
          "Duplicate replay is only exercised after a successful verify_and_settle run.",
      },
    };
  }

  let uncertainSummary;
  if (uncertainProof) {
    const uncertainProxy = await createSettlementUncertainAdapter(
      process.env.X402_FACILITATOR_URL,
      process.env.X402_PAY_TO,
      network,
    );
    try {
      const uncertainRegistration = uncertainProxy.registration;
      const uncertainGate = uncertainProxy.gate;
      const uncertainArgs = {
        requestId: "x402-uncertain-001",
        query: "evidence cache",
      };
      const uncertainResult = await uncertainRegistration.handler(
        uncertainArgs,
        {
          sessionId: callerId,
          _meta: buildProofMeta(
            uncertainProof,
            process.env.X402_FACILITATOR_URL,
          ),
        },
      );
      const uncertainTrace = await uncertainGate.traces.findByIdempotencyKey(
        `${toolName}:${callerId}:${uncertainArgs.requestId}`,
      );

      assert.equal(uncertainResult.isError, false);
      assert.equal(uncertainTrace?.failureClass, "settlement_uncertain");
      assert.equal(uncertainTrace?.handlerStatus, "success");
      assert.equal(uncertainTrace?.chargeStatus, "charged");
      assert.equal(uncertainTrace?.recoveryAction ?? null, null);
      assert.equal(uncertainTrace?.decision, "execute");
      assert.ok(
        uncertainTrace?.events.some(
          (event) => event.event === "handler_success",
        ),
      );
      assert.ok(
        uncertainTrace?.events.some(
          (event) => event.event === "settlement_uncertain",
        ),
      );

      const handlerSuccessEventIndex =
        uncertainTrace?.events.findIndex(
          (event) => event.event === "handler_success",
        ) ?? -1;
      const settlementUncertainEventIndex =
        uncertainTrace?.events.findIndex(
          (event) => event.event === "settlement_uncertain",
        ) ?? -1;
      assert.ok(handlerSuccessEventIndex >= 0);
      assert.ok(settlementUncertainEventIndex > handlerSuccessEventIndex);

      uncertainSummary = {
        executed: true,
        handlerExecutedBeforeSettlementFailure:
          handlerSuccessEventIndex >= 0 &&
          settlementUncertainEventIndex > handlerSuccessEventIndex,
        trace: uncertainTrace,
      };
    } finally {
      await new Promise((resolve) => uncertainProxy.proxy.close(resolve));
    }
  } else {
    uncertainSummary = {
      executed: false,
      blocker: {
        reason: "missing_X402_PAYMENT_UNCERTAIN_PROOF_JSON",
        required: ["X402_PAYMENT_UNCERTAIN_PROOF_JSON"],
        details:
          "A second valid proof is needed to force a separate settlement_uncertain run without reusing the main successful proof.",
      },
    };
  }

  printSummary({
    scenario: "x402-testnet-recovery",
    blocked: false,
    partial: !successProof,
    validated: [
      "payment_missing_fallback",
      "payment_required_through_tollgate",
      ...(successProof ? ["verify_and_settle", "duplicate_replay"] : []),
      ...(uncertainProof ? ["settlement_uncertain"] : []),
    ],
    skipped: [
      ...(!successProof
        ? [
            {
              name: "verify_and_settle",
              reason: "missing_X402_PAYMENT_PROOF_JSON",
            },
            {
              name: "duplicate_replay",
              reason: "missing_X402_PAYMENT_PROOF_JSON",
            },
          ]
        : []),
      ...(!uncertainProof
        ? [
            {
              name: "settlement_uncertain",
              reason: "missing_X402_PAYMENT_UNCERTAIN_PROOF_JSON",
            },
          ]
        : []),
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
    scenarios: [
      {
        name: "payment_missing_fallback",
        result: fallbackResult,
        trace: fallbackTrace,
      },
      {
        name: "payment_required_through_tollgate",
        result: paymentRequiredContent.paymentRequired,
        trace: paymentRequiredTrace,
        note: "This test generates the Tollgate challenge through the MCP registration. Sign that challenge separately and feed the resulting proof back via X402_PAYMENT_PROOF_JSON.",
      },
      {
        name: "verify_and_settle",
        result: verifyAndSettleSummary,
      },
      {
        name: "duplicate_replay",
        result: duplicateSummary,
      },
      {
        name: "settlement_uncertain",
        result: uncertainSummary,
      },
    ],
  });
}

await runScenario();
