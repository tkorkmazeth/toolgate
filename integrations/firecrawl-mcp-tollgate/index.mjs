import { createHash } from "node:crypto";

export const firecrawlScrapeInputSchema = {
  type: "object",
  properties: {
    requestId: { type: "string", description: "Stable idempotency key" },
    url: { type: "string", description: "URL to scrape" },
    fail: { type: "boolean", description: "Force fake transport failure" },
    scrapeOptions: {
      type: "object",
      description: "Optional Firecrawl scrape options",
    },
  },
  required: ["url"],
};

export function normalizeFirecrawlUrl(rawUrl) {
  const url = new URL(String(rawUrl));
  url.hash = "";

  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  const sortedParams = [...url.searchParams.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  url.search = "";

  for (const [key, value] of sortedParams) {
    url.searchParams.append(key, value);
  }

  return url.toString();
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function hashStableValue(value) {
  return createHash("sha256")
    .update(stableSerialize(value))
    .digest("hex")
    .slice(0, 16);
}

export function createFirecrawlIdempotencyKey(input, callerId) {
  const normalizedUrl = normalizeFirecrawlUrl(input.url);
  const requestToken =
    input.requestId != null
      ? String(input.requestId)
      : `options:${hashStableValue(input.scrapeOptions ?? {})}`;

  return `firecrawl_scrape:${callerId}:${requestToken}:${normalizedUrl}`;
}

export function createFakeFirecrawlTransport() {
  const calls = [];

  return {
    calls,
    async scrape(args) {
      calls.push({
        requestId: args.requestId ?? null,
        url: args.url,
        fail: !!args.fail,
        scrapeOptions: args.scrapeOptions ?? null,
      });

      if (args.fail) {
        throw new Error("Firecrawl scrape API error");
      }

      return {
        markdown: `# Snapshot for ${args.url}\n\nPremium scrape body for ${args.url}.`,
        metadata: {
          sourceURL: args.url,
          statusCode: 200,
          title: `Snapshot for ${new URL(args.url).hostname}`,
        },
        creditsUsed: 1,
      };
    },
  };
}

export function createLiveFirecrawlTransport({
  apiKey = process.env.FIRECRAWL_API_KEY,
  apiUrl = process.env.FIRECRAWL_API_URL ?? "https://api.firecrawl.dev",
  fetchImpl = globalThis.fetch,
  defaultScrapeOptions = {},
} = {}) {
  if (!apiKey) {
    throw new Error(
      "Missing FIRECRAWL_API_KEY. Export it in the terminal before running the live Firecrawl scenario.",
    );
  }

  if (typeof fetchImpl !== "function") {
    throw new Error("Global fetch is unavailable in this Node runtime.");
  }

  const calls = [];
  const baseUrl = apiUrl.replace(/\/$/, "");

  return {
    calls,
    async scrape(args) {
      const url = normalizeFirecrawlUrl(args.url);
      calls.push({
        requestId: args.requestId ?? null,
        url,
        live: true,
      });

      const payload = {
        formats: ["markdown"],
        onlyMainContent: true,
        ...defaultScrapeOptions,
        ...args.scrapeOptions,
        url,
      };

      const response = await fetchImpl(`${baseUrl}/v2/scrape`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          body?.error ??
          body?.message ??
          body?.metadata?.error ??
          `Firecrawl API error (${response.status})`;
        throw new Error(message);
      }

      return body?.data ?? body;
    },
  };
}

export async function createFirecrawlPremiumResult(input, callerId, transport) {
  const normalizedUrl = normalizeFirecrawlUrl(input.url);
  const fullResult = await transport.scrape({
    ...input,
    url: normalizedUrl,
  });

  return {
    mode: "premium",
    provider: "firecrawl-mcp",
    tool: "firecrawl_scrape",
    requestId: input.requestId ?? null,
    callerId,
    url: normalizedUrl,
    result: fullResult,
  };
}

export function createFirecrawlFallbackResult(input) {
  const normalizedUrl = normalizeFirecrawlUrl(input.url);
  return {
    mode: "fallback",
    provider: "tollgate",
    tool: "firecrawl_scrape",
    requestId: input.requestId ?? null,
    url: normalizedUrl,
    preview: {
      title: `Preview for ${new URL(normalizedUrl).hostname}`,
      summary:
        "Payment missing. Returning a lightweight preview instead of the full Firecrawl scrape result.",
    },
    recovery: {
      action: "top_up_and_retry",
      reason: "payment_missing",
    },
  };
}

export function createFirecrawlScrapePaidAction({
  gate,
  transport,
  price = 0.2,
  onDuplicateDetected,
}) {
  return gate.paidAction({
    name: "firecrawl_scrape",
    description: "Paid wrapper for the Firecrawl MCP scrape tool",
    price,
    onPaymentFailed: "fallback",
    idempotencyKey: createFirecrawlIdempotencyKey,
    onDuplicateDetected,
    handler: async (input, ctx) => {
      return createFirecrawlPremiumResult(input, ctx.callerId, transport);
    },
    fallback: async (input) => createFirecrawlFallbackResult(input),
  });
}

export function summarizeTrace(trace) {
  if (!trace) {
    return null;
  }

  return {
    traceId: trace.traceId,
    decision: trace.decision,
    chargeStatus: trace.chargeStatus,
    handlerStatus: trace.handlerStatus,
    fallbackUsed: trace.fallbackUsed,
    refundReason: trace.refundReason ?? null,
    events: trace.events.map((event) => event.event),
  };
}

export function previewMarkdown(markdown, maxLength = 240) {
  if (typeof markdown !== "string") {
    return null;
  }

  const compact = markdown.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength)}...`;
}
