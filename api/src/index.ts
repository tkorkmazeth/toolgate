import { Hono } from "hono";
import { cors } from "hono/cors";
import Stripe from "stripe";
import { DbLedger, WebhookHandler } from "@niceberglabs/tollgate";

// ─── Cloudflare Worker env bindings ──────────────────────

export interface Env {
  DB: D1Database;
  /** Publisher API key — set via: wrangler secret put TOLLGATE_PUBLISHER_KEY */
  TOLLGATE_PUBLISHER_KEY: string;
  /** Stripe test or live secret key */
  STRIPE_SECRET_KEY?: string;
  /** Stripe webhook signing secret (whsec_...) */
  STRIPE_WEBHOOK_SECRET?: string;
  /** Landing page URL for Stripe Checkout redirects */
  TOP_UP_SUCCESS_URL?: string;
  TOP_UP_CANCEL_URL?: string;
}

// ─── Module-scope migration flag ─────────────────────────
// Cloudflare reuses Worker isolates across requests — migrations run once
// per isolate lifetime, not on every request.
let migrated = false;
async function ensureMigrated(db: D1Database) {
  if (!migrated) {
    await DbLedger.runMigrations(db);
    migrated = true;
  }
}

// ─── Top-up tier selection (mirrors StripeAdapter logic) ─

function selectTopUpAmountCents(requiredUsd: number): 100 | 500 | 1000 | 2500 {
  const cents = requiredUsd * 100;
  if (cents <= 100) return 100;
  if (cents <= 500) return 500;
  if (cents <= 1000) return 1000;
  return 2500;
}

// ─── App setup ───────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));

// ─── Auth middleware ──────────────────────────────────────

async function requireAuth(c: any, next: any) {
  const key = c.req.header("x-tollgate-key");
  if (!key || key !== c.env.TOLLGATE_PUBLISHER_KEY) {
    return c.json(
      { error: "Unauthorized. Provide X-Tollgate-Key header." },
      401,
    );
  }
  await next();
}

// ─── GET /api/balance/:callerId ───────────────────────────

app.get("/api/balance/:callerId", requireAuth, async (c) => {
  await ensureMigrated(c.env.DB);
  const ledger = new DbLedger(c.env.DB);
  const callerId = c.req.param("callerId");
  const balance = await ledger.getBalance(callerId);
  return c.json({ caller_id: callerId, balance_usd: balance });
});

// ─── POST /api/topup ─────────────────────────────────────
// Body: { callerId: string, requiredAmountUsd: number }
// Returns: { url: string } — Stripe Checkout URL

app.post("/api/topup", requireAuth, async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json(
      { error: "Stripe not configured. Set STRIPE_SECRET_KEY secret." },
      503,
    );
  }

  const body = await c.req.json<{
    callerId?: string;
    requiredAmountUsd?: number;
  }>();
  const { callerId, requiredAmountUsd } = body;

  if (!callerId || typeof callerId !== "string") {
    return c.json({ error: "callerId is required" }, 400);
  }
  if (typeof requiredAmountUsd !== "number" || requiredAmountUsd <= 0) {
    return c.json(
      { error: "requiredAmountUsd must be a positive number" },
      400,
    );
  }

  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, {
    apiVersion: "2025-02-24.acacia",
  });

  const amountCents = selectTopUpAmountCents(requiredAmountUsd);
  const successUrl =
    c.env.TOP_UP_SUCCESS_URL ?? "https://main.tollgate.pages.dev?topup=success";
  const cancelUrl =
    c.env.TOP_UP_CANCEL_URL ??
    "https://main.tollgate.pages.dev?topup=cancelled";

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: amountCents,
          product_data: {
            name: "Tollgate Balance Top-Up",
            description: `$${(amountCents / 100).toFixed(2)} added to your Tollgate balance`,
          },
        },
        quantity: 1,
      },
    ],
    metadata: {
      tollgate_caller_id: callerId,
      tollgate_publisher_id: c.env.TOLLGATE_PUBLISHER_KEY,
      tollgate_amount_cents: String(amountCents),
    },
    success_url: `${successUrl}&session_id={CHECKOUT_SESSION_ID}&caller_id=${encodeURIComponent(callerId)}`,
    cancel_url: cancelUrl,
  });

  if (!session.url) {
    return c.json({ error: "Stripe did not return a checkout URL" }, 500);
  }

  return c.json({ url: session.url, amount_usd: amountCents / 100 });
});

// ─── POST /api/webhook/stripe ─────────────────────────────
// No auth — Stripe signature is the authentication mechanism.

app.post("/api/webhook/stripe", async (c) => {
  if (!c.env.STRIPE_SECRET_KEY || !c.env.STRIPE_WEBHOOK_SECRET) {
    return c.json(
      {
        error:
          "Stripe not configured. Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.",
      },
      503,
    );
  }

  await ensureMigrated(c.env.DB);

  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, {
    apiVersion: "2025-02-24.acacia",
  });
  const ledger = new DbLedger(c.env.DB);

  const handler = new WebhookHandler({
    stripeClient: stripe,
    webhookSecret: c.env.STRIPE_WEBHOOK_SECRET,
    ledger,
  });

  const rawBody = await c.req.text();
  const signature = c.req.header("stripe-signature") ?? "";

  const result = await handler.handle(rawBody, signature);

  if (result.error && !result.processed) {
    return c.json({ error: result.error }, 400);
  }

  return c.json(result);
});

// ─── GET /api/stats ───────────────────────────────────────

app.get("/api/stats", requireAuth, async (c) => {
  await ensureMigrated(c.env.DB);
  const db = c.env.DB;

  const [revenueRow, callsRow, callersRow] = await Promise.all([
    db
      .prepare(
        "SELECT COALESCE(ROUND(SUM(amount), 6), 0) as total FROM tg_transactions WHERE type = 'credit' AND source = 'stripe'",
      )
      .first<{ total: number }>(),
    db
      .prepare(
        "SELECT COUNT(*) as count FROM tg_transactions WHERE type = 'deduct'",
      )
      .first<{ count: number }>(),
    db
      .prepare(
        "SELECT COUNT(DISTINCT caller_id) as count FROM tg_balances WHERE balance > 0",
      )
      .first<{ count: number }>(),
  ]);

  return c.json({
    revenue_usd: revenueRow?.total ?? 0,
    paid_calls: callsRow?.count ?? 0,
    active_callers: callersRow?.count ?? 0,
    publisher_key: c.env.TOLLGATE_PUBLISHER_KEY.slice(0, 12) + "…",
  });
});

// ─── POST /api/keys ───────────────────────────────────────
// Alpha: single publisher. Returns the configured key.

app.post("/api/keys", requireAuth, async (c) => {
  return c.json({
    publisher_key: c.env.TOLLGATE_PUBLISHER_KEY,
    note: "Alpha: single-publisher mode. Multi-publisher support coming in Sprint B.",
  });
});

// ─── GET /pay ─────────────────────────────────────────────
// Browser-navigable Stripe Checkout redirect.
// Called by the SDK when a caller's 402 topUpUrl is visited.
// Query params: publisher (key), caller (callerId), amount (cents integer)
// No auth header required — publisher key is validated inline.

app.get("/pay", async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.text(
      "Payment not yet configured. Visit https://main.tollgate.pages.dev for setup instructions.",
      503,
    );
  }

  const publisher = c.req.query("publisher");
  const caller = c.req.query("caller");
  const amountStr = c.req.query("amount");

  // Validate publisher key (constant-time comparison not needed — alpha only)
  if (!publisher || publisher !== c.env.TOLLGATE_PUBLISHER_KEY) {
    return c.text("Invalid publisher key.", 400);
  }
  if (!caller || caller.trim().length === 0) {
    return c.text("Missing caller ID.", 400);
  }

  const amountCents = parseInt(amountStr ?? "100", 10);
  if (isNaN(amountCents) || amountCents < 50 || amountCents > 250000) {
    return c.text("Invalid amount (must be 50–250000 cents).", 400);
  }

  await ensureMigrated(c.env.DB);

  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, {
    apiVersion: "2025-02-24.acacia",
  });

  const successUrl =
    c.env.TOP_UP_SUCCESS_URL ?? "https://main.tollgate.pages.dev?topup=success";
  const cancelUrl =
    c.env.TOP_UP_CANCEL_URL ??
    "https://main.tollgate.pages.dev?topup=cancelled";

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: amountCents,
          product_data: {
            name: "Tollgate Balance Top-Up",
            description: `$${(amountCents / 100).toFixed(2)} added to your Tollgate balance`,
          },
        },
        quantity: 1,
      },
    ],
    metadata: {
      tollgate_caller_id: caller,
      tollgate_publisher_id: publisher,
      tollgate_amount_cents: String(amountCents),
    },
    success_url: `${successUrl}&session_id={CHECKOUT_SESSION_ID}&caller_id=${encodeURIComponent(caller)}`,
    cancel_url: cancelUrl,
  });

  if (!session.url) {
    return c.text("Failed to create Stripe Checkout session.", 500);
  }

  return c.redirect(session.url, 302);
});

// ─── Health check ─────────────────────────────────────────

app.get("/", (c) =>
  c.json({
    service: "tollgate-api",
    version: "0.1.0-alpha.1",
    endpoints: [
      "GET  /pay                (browser top-up redirect → Stripe Checkout)",
      "GET  /api/balance/:callerId",
      "POST /api/topup",
      "POST /api/webhook/stripe",
      "GET  /api/stats",
      "POST /api/keys",
    ],
  }),
);

export default app;
