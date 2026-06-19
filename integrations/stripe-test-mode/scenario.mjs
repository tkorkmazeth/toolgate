import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ToolGate,
  StripeAdapter,
  createWebhookHandler,
  toNumber,
  usd,
} from "../../dist/index.js";

const publisherKey = "tg_stripe_test_mode";
const callerId = "stripe-test-caller";
const currentDir = path.dirname(fileURLToPath(import.meta.url));

loadEnvFile(path.resolve(currentDir, "../../.env"));
loadEnvFile(path.resolve(currentDir, ".env"));

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  const source = readFileSync(filePath, "utf8");
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function printSummary(summary) {
  process.stdout.write(
    `${JSON.stringify(
      summary,
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    )}\n`,
  );
}

function runCommand(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} failed with exit code ${code}\n${stdout}\n${stderr}`,
        ),
      );
    });
  });
}

function startStripeListener({ forwardUrl, apiKey }) {
  const args = [
    "listen",
    "--events",
    "checkout.session.completed",
    "--forward-to",
    forwardUrl,
    "--api-key",
    apiKey,
    "--skip-update",
  ];
  const child = spawn("stripe", args, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];

  const secret = new Promise((resolve, reject) => {
    const onChunk = (chunk) => {
      const text = String(chunk);
      logs.push(text);
      const match = text.match(/whsec_[A-Za-z0-9]+/);
      if (match) {
        resolve(match[0]);
      }
    };

    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.on("error", reject);
    child.on("exit", (code) => {
      reject(
        new Error(
          `stripe listen exited before providing a webhook secret (exit ${code})\n${logs.join("")}`,
        ),
      );
    });
  });

  return { child, logs, secret };
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(new Error(message)), ms);
      timeout.unref?.();
    }),
  ]);
}

async function runScenario() {
  if (!process.env.STRIPE_SECRET_KEY) {
    printSummary({
      scenario: "stripe-test-mode-recovery",
      blocked: true,
      blocker: {
        reason: "missing_env",
        required: ["STRIPE_SECRET_KEY"],
        optional: ["STRIPE_CLI_PROFILE"],
        details:
          "This acceptance test uses Stripe test mode plus Stripe CLI webhook forwarding. Export STRIPE_SECRET_KEY in the same terminal and rerun.",
      },
    });
    return;
  }

  const gate = new ToolGate({
    publisherKey,
    paymentRails: ["stripe"],
  });
  const paidLookup = gate.paidAction({
    name: "premium_lookup",
    description: "Stripe recovery acceptance scenario",
    price: usd("0.25"),
    onPaymentFailed: "block",
    idempotencyKey: (input, currentCallerId) =>
      `premium_lookup:${currentCallerId}:${String(input.requestId)}`,
    handler: async (input) => ({
      mode: "premium",
      requestId: input.requestId,
      payload: {
        answer: `premium:${input.query}`,
      },
    }),
  });

  const paymentRequiredInput = {
    requestId: "stripe-missing-001",
    query: "vector cache",
  };
  const paymentRequiredResult = await paidLookup(
    paymentRequiredInput,
    callerId,
  );
  const paymentRequiredTrace = await gate.traces.findByIdempotencyKey(
    `premium_lookup:${callerId}:${paymentRequiredInput.requestId}`,
  );

  assert.equal(paymentRequiredResult.success, false);
  assert.equal(
    paymentRequiredResult.paymentRequired?.error,
    "payment_required",
  );
  assert.equal(paymentRequiredTrace?.decision, "topup_required");

  let webhookHandler;
  let stripeClient;
  let resolveWebhook;
  const receivedWebhook = new Promise((resolve) => {
    resolveWebhook = resolve;
  });

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/webhook") {
      res.statusCode = 404;
      res.end("not_found");
      return;
    }

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    await once(req, "end");

    const rawBody = Buffer.concat(chunks);
    const signature = req.headers["stripe-signature"];
    if (!webhookHandler || typeof signature !== "string") {
      res.statusCode = 503;
      res.end("listener_not_ready");
      return;
    }

    const event = await stripeClient.webhooks.constructEventAsync(
      rawBody,
      signature,
      webhookHandler.webhookSecret,
    );
    const result = await webhookHandler.handle(rawBody, signature);

    resolveWebhook({
      event,
      result,
      rawBody,
      signature,
    });

    res.statusCode = result.processed ? 200 : 202;
    res.end(JSON.stringify(result));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const listener = startStripeListener({
    forwardUrl: `http://127.0.0.1:${port}/webhook`,
    apiKey: process.env.STRIPE_SECRET_KEY,
  });

  try {
    const webhookSecret = await withTimeout(
      listener.secret,
      30000,
      `Timed out waiting for stripe listen webhook secret\n${listener.logs.join("")}`,
    );

    const stripeAdapter = new StripeAdapter({
      secretKey: process.env.STRIPE_SECRET_KEY,
      webhookSecret,
      topUpBaseUrl: "https://pay.toolgate.dev",
    });
    stripeClient = await stripeAdapter.getClient();
    webhookHandler = createWebhookHandler({
      stripeClient,
      webhookSecret,
      ledger: gate.ledger,
    });

    const checkoutAmountCents = 100;
    const checkoutCurrency = "usd";
    const createdTopUpSession = await stripeAdapter.createTopUpSession(
      callerId,
      publisherKey,
      checkoutAmountCents,
      checkoutCurrency,
    );
    const createdSession = await stripeClient.checkout.sessions.retrieve(
      createdTopUpSession.sessionId,
      {
        expand: ["line_items"],
      },
    );
    const createdLineItem = createdSession.line_items?.data?.[0] ?? null;

    assert.ok(createdTopUpSession.url);
    assert.equal(createdSession.id, createdTopUpSession.sessionId);
    assert.equal(createdSession.url, createdTopUpSession.url);
    assert.equal(createdSession.metadata?.toolgate_caller_id, callerId);
    assert.equal(createdSession.metadata?.toolgate_publisher_id, publisherKey);
    assert.equal(
      createdSession.metadata?.toolgate_amount_cents,
      String(checkoutAmountCents),
    );
    assert.equal(createdSession.metadata?.toolgate_currency, checkoutCurrency);

    const createdAmount =
      createdSession.amount_total ??
      createdLineItem?.amount_total ??
      createdLineItem?.price?.unit_amount ??
      null;
    assert.equal(createdAmount, checkoutAmountCents);

    await runCommand("stripe", [
      "trigger",
      "checkout.session.completed",
      "--api-key",
      process.env.STRIPE_SECRET_KEY,
      "--override",
      `checkout_session:metadata.toolgate_caller_id=${callerId}`,
      "--override",
      `checkout_session:metadata.toolgate_publisher_id=${publisherKey}`,
      "--override",
      "checkout_session:metadata.toolgate_amount_cents=100",
      "--override",
      "checkout_session:metadata.toolgate_currency=usd",
    ]);

    const webhook = await withTimeout(
      receivedWebhook,
      60000,
      `Timed out waiting for forwarded Stripe webhook\n${listener.logs.join("")}`,
    );
    const checkoutSession = webhook.event.data.object;
    const paymentIntentId =
      typeof checkoutSession.payment_intent === "string"
        ? checkoutSession.payment_intent
        : (checkoutSession.payment_intent?.id ?? null);
    const retrievedSession = await stripeClient.checkout.sessions.retrieve(
      checkoutSession.id,
    );

    assert.equal(webhook.result.processed, true);
    assert.equal(webhook.result.duplicate, undefined);
    assert.equal(toNumber(await gate.ledger.getBalance(callerId)), 1);
    assert.equal(retrievedSession.id, checkoutSession.id);

    const paidInput = {
      requestId: "stripe-paid-001",
      query: "vector cache",
    };
    const paidResult = await paidLookup(paidInput, callerId);
    const duplicateResult = await paidLookup(paidInput, callerId);
    const paidTraceKey = `premium_lookup:${callerId}:${paidInput.requestId}`;
    const paidTrace = await gate.traces.findByIdempotencyKey(paidTraceKey);

    assert.equal(paidResult.success, true);
    assert.deepEqual(duplicateResult, paidResult);

    const balanceAfterExecution = await gate.ledger.getBalance(callerId);
    assert.equal(toNumber(balanceAfterExecution), 0.75);

    if (paidTrace) {
      paidTrace.receiptId = checkoutSession.id;
      paidTrace.provider = {
        ...(paidTrace.provider ?? {}),
        name: "stripe",
        correlationId: checkoutSession.id,
        traceId: paymentIntentId ?? undefined,
      };
      paidTrace.events.push({
        timestamp: Date.now(),
        event: "stripe_topup_linked",
        metadata: {
          checkoutSessionId: checkoutSession.id,
          paymentIntentId,
        },
      });
      await gate.traces.save(paidTrace);
    }

    const balanceBeforeDuplicateWebhook =
      await gate.ledger.getBalance(callerId);
    const duplicateWebhookResult = await webhookHandler.handle(
      webhook.rawBody,
      webhook.signature,
    );
    const balanceAfterDuplicateWebhook = await gate.ledger.getBalance(callerId);
    const finalTrace = await gate.traces.findByIdempotencyKey(paidTraceKey);

    assert.equal(duplicateWebhookResult.duplicate, true);
    assert.equal(
      toNumber(balanceAfterDuplicateWebhook),
      toNumber(balanceBeforeDuplicateWebhook),
    );
    assert.equal(finalTrace?.provider?.correlationId, checkoutSession.id);
    assert.equal(finalTrace?.provider?.traceId ?? null, paymentIntentId);

    printSummary({
      scenario: "stripe-test-mode-recovery",
      blocked: false,
      scenarios: [
        {
          name: "payment_required",
          result: paymentRequiredResult.paymentRequired,
          trace: paymentRequiredTrace,
        },
        {
          name: "stripe_checkout_session_created",
          sessionId: createdSession.id,
          sessionUrl: createdSession.url,
          metadata: createdSession.metadata,
          amountValidatedFrom:
            createdSession.amount_total != null
              ? "session.amount_total"
              : createdLineItem?.amount_total != null
                ? "line_items[0].amount_total"
                : "line_items[0].price.unit_amount",
          amountValidated: createdAmount,
        },
        {
          name: "stripe_checkout_completed",
          sessionId: checkoutSession.id,
          paymentIntentId,
          webhook: webhook.result,
          retrievedSessionId: retrievedSession.id,
        },
        {
          name: "paid_execution_after_webhook",
          result: paidResult,
          trace: finalTrace,
        },
        {
          name: "duplicate_webhook",
          result: duplicateWebhookResult,
          balanceBeforeDuplicateWebhook: toNumber(
            balanceBeforeDuplicateWebhook,
          ),
          balanceAfterDuplicateWebhook: toNumber(balanceAfterDuplicateWebhook),
        },
      ],
      notes: {
        flow: "Stripe CLI generated a real test-mode checkout.session.completed event and forwarded it to a local webhook handler using the Stripe signing secret from the live listener session.",
      },
    });
  } finally {
    listener.child.kill("SIGTERM");
    await new Promise((resolve) => server.close(resolve));
  }
}

await runScenario();
