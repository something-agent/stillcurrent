/** StillCurrent on Cloudflare Workers: x402 pay-per-call "is it still current?" checks (Hono + official x402 v2 SDK). */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { checkCitation, checkUrl } from "./checks";
import type { Settings } from "./config";
import * as S from "./schemas";
import { validateCitationCheck, validateUrlCheck } from "./validate";

const priceUsd = (p: string) => p.replace(/^\$/, "");
const atomic = (p: string) => String(Math.round(parseFloat(priceUsd(p)) * 1_000_000));

interface PaidRoute {
  price: string; description: string; inputExample: Record<string, unknown>; inputSchema: Record<string, unknown>;
  outputExample: unknown; outputExampleFull: unknown; outputSchema: Record<string, unknown>; summary: string;
}

export function paidRoutes(s: Settings): Record<string, PaidRoute> {
  return {
    "/check/url": { price: s.priceUrlCheck, description: S.URL_DESCRIPTION, inputExample: S.URL_INPUT_EXAMPLE, inputSchema: S.URL_INPUT_SCHEMA,
      outputExample: S.URL_OUTPUT_EXAMPLE, outputExampleFull: S.URL_OUTPUT_EXAMPLE_FULL, outputSchema: S.URL_OUTPUT_SCHEMA, summary: "URL liveness + freshness check" },
    "/check/citation": { price: s.priceCitationCheck, description: S.CIT_DESCRIPTION, inputExample: S.CIT_INPUT_EXAMPLE, inputSchema: S.CIT_INPUT_SCHEMA,
      outputExample: S.CIT_OUTPUT_EXAMPLE, outputExampleFull: S.CIT_OUTPUT_EXAMPLE_FULL, outputSchema: S.CIT_OUTPUT_SCHEMA, summary: "Quote / claim still on the cited page?" },
  };
}

function x402Routes(s: Settings) {
  const routes: Record<string, any> = {};
  for (const [path, r] of Object.entries(paidRoutes(s))) {
    routes[`POST ${path}`] = {
      accepts: [{ scheme: "exact", payTo: s.payTo, price: r.price, network: s.network, maxTimeoutSeconds: 300 }],
      ...(s.publicBaseUrl ? { resource: s.publicBaseUrl + path } : {}),
      description: r.description,
      mimeType: "application/json",
      serviceName: S.SERVICE_NAME,
      tags: ["citations", "link-checking", "fact-checking", "freshness", "research"],
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: {
          x402Version: 2,
          error: "Payment required",
          message: `${S.SERVICE_NAME} ${path} costs $${priceUsd(r.price)} in USDC on ${s.network}. Payment requirements are in the PAYMENT-REQUIRED response header (base64-encoded JSON).`,
          accepts: [{ scheme: "exact", network: s.network, asset: S.USDC_BASE, amount: atomic(r.price), payTo: s.payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
          docs: (s.publicBaseUrl || "") + "/",
        },
      }),
      extensions: declareDiscoveryExtension({
        input: r.inputExample,
        inputSchema: r.inputSchema,
        bodyType: "json",
        output: { example: r.outputExample, schema: r.outputSchema },
      }),
    };
  }
  return routes;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("check timed out")), ms))]);

export function buildApp(s: Settings): Hono {
  const app = new Hono();
  const PAID = paidRoutes(s);
  const base = (c: Context) => (s.publicBaseUrl || new URL(c.req.url).origin).replace(/\/+$/, "");

  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["*"],
    exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE", "EXTENSION-RESPONSES"] }));

  if (s.paymentsDisabled) {
    console.warn("X402_DISABLED=1: PAYMENT GATE IS OFF (test mode). Never expose this instance publicly.");
  } else {
    // Runs before the route handlers, so unpaid probes (even with empty bodies) get 402, not 422.
    //
    // Workers rule: a promise whose I/O was started by one request must not be awaited by another
    // (the waiter can hang forever, e.g. when the first request is cancelled). The SDK's default
    // middleware shares one facilitator /supported promise across requests, which hung concurrent
    // first requests in production. So until the gate is ready, every request builds its own
    // resource server, fetches /supported itself and runs the middleware with
    // syncFacilitatorOnStart=false. The first request that completes this caches the ready gate;
    // after that no cross-request promises remain (the SDK's one-time Bazaar setup promise has
    // already been awaited inside that request).
    const routes = x402Routes(s);
    let ready: MiddlewareHandler | null = null;
    app.use("/check/*", async (c, next) => {
      if (ready) return ready(c, next);
      const facilitator = new HTTPFacilitatorClient({ url: s.facilitatorUrl, timeoutMs: 20_000 });
      const server = new x402ResourceServer(facilitator).register(s.network, new ExactEvmScheme());
      server.registerExtension(bazaarResourceServerExtension);
      try {
        await server.initialize();
      } catch (e) {
        console.error("facilitator /supported failed", e);
        return c.json({ error: "payment facilitator unavailable, retry shortly" }, 503, { "Retry-After": "30" });
      }
      const mw = paymentMiddleware(routes, server, undefined, undefined, false);
      const res = await mw(c, next);
      ready ??= mw;
      return res;
    });
  }

  app.onError((err, c) => {
    console.error("unhandled error", err);
    const timeout = /timed out/.test(String(err?.message));
    return c.json({ error: timeout ? "check timed out" : "internal error" }, timeout ? 504 : 500);
  });

  // ---------------------------------------------------------------- free routes
  app.get("/", (c) => {
    const b = base(c);
    return c.json({
      name: S.SERVICE_NAME,
      version: S.VERSION,
      description: S.SERVICE_DESC,
      payment: {
        protocol: "x402 (v2, scheme 'exact')",
        network: s.network,
        network_name: s.network === "eip155:8453" ? "Base mainnet" : s.network,
        asset: "USDC",
        asset_address: s.network === "eip155:8453" ? S.USDC_BASE : null,
        pay_to: s.payTo,
        facilitator: s.facilitatorUrl,
        mode: s.paymentsDisabled ? "TEST MODE: payments disabled" : "live",
      },
      endpoints: Object.entries(PAID).map(([p, r]) => ({ method: "POST", path: p, url: b + p, price_usd: priceUsd(r.price), description: r.description, input_example: r.inputExample })),
      free: { "GET /": "this document", "GET /.well-known/x402": "x402 discovery manifest", "GET /openapi.json": "OpenAPI 3 with x-payment-info",
        "GET /llms.txt": "plain-text summary", "GET /demo": "sample /check/url output for https://example.com (cached)", "GET /health": "health" },
      notes: [
        "A request without payment receives HTTP 402 with the payment requirements in the PAYMENT-REQUIRED header (base64 JSON).",
        "Payment is settled only when the check returns HTTP 200; invalid input (422) is not charged.",
        "Dead, blocked or unreachable target URLs are valid results (HTTP 200) and are charged.",
        "Claim matching is lexical (terms and numbers), not semantic entailment.",
      ],
    });
  });

  // Small SVG icon (directories such as x402scan show the origin favicon).
  const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f766e"/><path d="M18 33l9 9 19-20" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const icon = (c: Context) => c.body(FAVICON, 200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" });
  app.get("/favicon.ico", icon);
  app.get("/favicon.svg", icon);
  app.get("/health", (c) => c.json({ ok: true, time: new Date().toISOString(), payments: !s.paymentsDisabled }));

  app.get("/.well-known/x402", (c) => {
    const b = base(c);
    return c.json({
      version: 1,
      x402Version: 2,
      kind: "resource-server",
      name: S.SERVICE_NAME,
      description: S.SERVICE_DESC,
      resources: Object.keys(PAID).map((p) => b + p),
      resourceDetails: Object.entries(PAID).map(([p, r]) => ({
        url: b + p, method: "POST", description: r.description, price: { amount: priceUsd(r.price), currency: "USD" },
        accepts: [{ scheme: "exact", network: s.network, asset: S.USDC_BASE, payTo: s.payTo, amount: atomic(r.price) }],
      })),
      docs: b + "/",
      updated: "2026-10-21T00:00:00Z",
    }, 200, { "Cache-Control": "public, max-age=3600" });
  });

  app.get("/openapi.json", (c) => {
    const paths: Record<string, any> = {};
    for (const [p, r] of Object.entries(PAID)) {
      paths[p] = {
        post: {
          summary: r.description.slice(0, 120),
          description: r.description,
          operationId: p.replace(/\//g, "_").replace(/^_/, "") + "_post",
          requestBody: { required: true, content: { "application/json": { schema: r.inputSchema, example: r.inputExample } } },
          responses: {
            "200": { description: "Successful Response", content: { "application/json": { schema: r.outputSchema, example: r.outputExampleFull } } },
            "402": { description: "Payment Required. x402 v2 payment requirements in the PAYMENT-REQUIRED header (base64 JSON)." },
            "422": { description: "Validation Error (not charged)" },
          },
          "x-payment-info": { protocols: [{ x402: {} }], price: { mode: "fixed", currency: "USD", amount: priceUsd(r.price) }, network: s.network, asset: S.USDC_BASE, payTo: s.payTo },
        },
      };
    }
    for (const p of ["/", "/health", "/.well-known/x402", "/llms.txt", "/demo"]) {
      paths[p] = { get: { summary: p, security: [], responses: { "200": { description: "Successful Response" } } } };
    }
    const info: Record<string, any> = {
      title: `${S.SERVICE_NAME} API`, version: S.VERSION, description: S.SERVICE_DESC,
      "x-guidance":
        "POST /check/url with {\"url\": ...} returns whether a link is alive and current (verdict, last-updated date, archive.org snapshot). " +
        "POST /check/citation with {\"url\": ..., \"quote\": ...} and/or {\"claim\": ...} returns whether that text still appears on the cited page. " +
        "Both are paid per call via x402 (USDC on Base).",
    };
    if (s.contactEmail) info.contact = { email: s.contactEmail };
    return c.json({ openapi: "3.1.0", info, servers: [{ url: base(c) }], paths });
  });

  app.get("/llms.txt", (c) => {
    const b = base(c);
    const p1 = priceUsd(s.priceUrlCheck), p2 = priceUsd(s.priceCitationCheck);
    return c.text(`# StillCurrent

${S.SERVICE_DESC}

Payment: x402 v2, scheme exact, USDC on ${s.network}, payTo ${s.payTo}. Unpaid calls get HTTP 402 with requirements in the PAYMENT-REQUIRED header.

## Endpoints
- POST ${b}/check/url  ($${p1}/call) body: {"url": "...", "stale_after_days": 365}
  Returns verdict (live | live_stale | redirected_cross_domain | moved_to_homepage | soft_404 | parked | dead | unreachable | blocked | invalid_target), freshness, last-updated date with source and confidence, redirect chain, latest archive.org snapshot, evidence list.
- POST ${b}/check/citation  ($${p2}/call) body: {"url": "...", "quote": "exact text", "claim": "paraphrase with numbers"}
  Returns verdict (verified | partially_matched | not_found_on_page | only_in_archive | page_unavailable_but_in_archive | page_unavailable | page_unreadable), matched snippet and score, numbers found/missing, archive comparison, and the URL check.

## Free
- GET ${b}/  GET ${b}/.well-known/x402  GET ${b}/openapi.json  GET ${b}/demo
`);
  });

  // Per-isolate cache: fixed input, recomputed at most hourly, so it cannot be used to check arbitrary URLs.
  let demoCache: { t: number; data: unknown } = { t: 0, data: null };
  app.get("/demo", async (c) => {
    if (!s.demoEnabled) return c.json({ error: "demo disabled" }, 404);
    if (demoCache.data === null || Date.now() - demoCache.t > 3_600_000) {
      const { result } = await withTimeout(checkUrl("https://example.com/", s), 55_000);
      demoCache = { t: Date.now(), data: result };
    }
    return c.json({ demo: true, note: "Fixed sample input, cached up to 1 hour. Paid endpoints accept any URL.", endpoint: "POST /check/url", result: demoCache.data });
  });

  // ---------------------------------------------------------------- paid routes
  const readJson = async (c: Context): Promise<unknown> => {
    const t = await c.req.text();
    if (!t.trim()) return undefined;
    try { return JSON.parse(t); } catch { return Symbol.for("invalid"); }
  };
  const invalidJson = (c: Context) => c.json({ detail: [{ loc: ["body"], msg: "JSON decode error", type: "json_invalid" }] }, 422);

  app.post("/check/url", async (c) => {
    const raw = await readJson(c);
    if (raw === Symbol.for("invalid")) return invalidJson(c);
    const v = validateUrlCheck(raw);
    if (!v.ok) return c.json({ detail: v.errors }, 422);
    const { result } = await withTimeout(checkUrl(v.value.url, s, { staleAfterDays: v.value.stale_after_days, includeArchive: v.value.include_archive }), 55_000);
    return c.json(result);
  });

  app.post("/check/citation", async (c) => {
    const raw = await readJson(c);
    if (raw === Symbol.for("invalid")) return invalidJson(c);
    const v = validateCitationCheck(raw);
    if (!v.ok) return c.json({ detail: v.errors }, 422);
    const r = await withTimeout(checkCitation(v.value.url, v.value.quote, v.value.claim, s, {
      staleAfterDays: v.value.stale_after_days, checkArchiveIfMissing: v.value.check_archive_if_missing }), 58_000);
    return c.json(r);
  });

  app.notFound((c) => c.json({ detail: "Not Found" }, 404));
  return app;
}
