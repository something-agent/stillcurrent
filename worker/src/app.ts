/** StillCurrent on Cloudflare Workers: x402 pay-per-call "is it still current?" checks (Hono + official x402 v2 SDK). */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { BATCH_MAX_URLS, checkUrls } from "./batch";
import { checkCitation, checkUrl } from "./checks";
import { RpcUnavailable, verifyPayment } from "./receipt";
import type { Settings } from "./config";
import * as S from "./schemas";
import { validateCitationCheck, validatePaymentVerify, validateUrlCheck, validateUrlsCheck } from "./validate";

const priceUsd = (p: string) => p.replace(/^\$/, "");
const atomic = (p: string) => String(Math.round(parseFloat(priceUsd(p)) * 1_000_000));

interface PaidRoute {
  price: string; description: string; inputExample: Record<string, unknown>; inputSchema: Record<string, unknown>;
  outputExample: unknown; outputExampleFull: unknown; outputSchema: Record<string, unknown>; summary: string; tags?: string[];
}

export function paidRoutes(s: Settings): Record<string, PaidRoute> {
  return {
    "/check/url": { price: s.priceUrlCheck, description: S.URL_DESCRIPTION, inputExample: S.URL_INPUT_EXAMPLE, inputSchema: S.URL_INPUT_SCHEMA,
      outputExample: S.URL_OUTPUT_EXAMPLE, outputExampleFull: S.URL_OUTPUT_EXAMPLE_FULL, outputSchema: S.URL_OUTPUT_SCHEMA, summary: "URL liveness + freshness check" },
    "/check/citation": { price: s.priceCitationCheck, description: S.CIT_DESCRIPTION, inputExample: S.CIT_INPUT_EXAMPLE, inputSchema: S.CIT_INPUT_SCHEMA,
      outputExample: S.CIT_OUTPUT_EXAMPLE, outputExampleFull: S.CIT_OUTPUT_EXAMPLE_FULL, outputSchema: S.CIT_OUTPUT_SCHEMA, summary: "Quote / claim still on the cited page?" },
    "/check/urls": { price: s.priceUrlBatch, description: S.BATCH_DESCRIPTION, inputExample: S.BATCH_INPUT_EXAMPLE, inputSchema: S.BATCH_INPUT_SCHEMA,
      outputExample: S.BATCH_OUTPUT_EXAMPLE, outputExampleFull: S.BATCH_OUTPUT_EXAMPLE_FULL, outputSchema: S.BATCH_OUTPUT_SCHEMA, summary: "Batch link triage, up to 25 URLs" },
    "/verify/payment": { price: s.pricePaymentVerify, description: S.PAY_DESCRIPTION, inputExample: S.PAY_INPUT_EXAMPLE, inputSchema: S.PAY_INPUT_SCHEMA,
      outputExample: S.PAY_OUTPUT_EXAMPLE, outputExampleFull: S.PAY_OUTPUT_EXAMPLE_FULL, outputSchema: S.PAY_OUTPUT_SCHEMA, summary: "Did this USDC payment on Base really settle?",
      tags: ["payments", "verification", "receipts", "usdc", "base", "x402", "on-chain", "trust"] },
  };
}

function x402Routes(s: Settings) {
  const routes: Record<string, any> = {};
  for (const [path, r] of Object.entries(paidRoutes(s))) {
    const cfg = {
      accepts: [{ scheme: "exact", payTo: s.payTo, price: r.price, network: s.network, maxTimeoutSeconds: 300 }],
      ...(s.publicBaseUrl ? { resource: s.publicBaseUrl + path } : {}),
      description: r.description,
      mimeType: "application/json",
      serviceName: S.SERVICE_NAME,
      tags: r.tags ?? ["citations", "link-checking", "fact-checking", "freshness", "research"],
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: {
          x402Version: 2,
          error: "Payment required",
          message: `${S.SERVICE_NAME} ${path} costs $${priceUsd(r.price)} in USDC on ${s.network}. Payment requirements are in the PAYMENT-REQUIRED response header (base64-encoded JSON). An empty body or {} gets this challenge (discovery probes); a non-empty invalid body gets a free 422 instead, charged: false.`,
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
    routes[`POST ${path}`] = cfg;
    // No GET route config: an unpaid GET is answered with the POST challenge itself (see the pre-gate
    // middleware), so crawlers that probe with GET see the same accepts[] and the same bazaar extension,
    // which declares method POST. (A GET route config would get the extension rewritten to method GET.)
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
    // Free pre-check: a non-empty body that is malformed or fails validation gets 422 BEFORE the
    // payment challenge, so a buyer never pays to learn their input was invalid. An empty body or
    // an empty object `{}` still gets the 402 challenge (discovery probes send those).
    app.use("/:group{check|verify}/*", async (c, next) => {
      if (c.req.method === "GET" && (c.req.header("payment-signature") || c.req.header("x-payment"))) return usePost(c);
      if (c.req.method === "GET" && Object.prototype.hasOwnProperty.call(PAID, new URL(c.req.url).pathname.replace(/\/+$/, ""))) {
        // Unpaid GET probe (x402dash, PayAI health probes, crawlers): serve exactly the challenge an unpaid
        // POST {} gets, in-process (no subrequest). Same payTo/amount, same bazaar extension (method POST).
        // Nothing runs and nothing can settle: the inner request carries no payment and an empty body.
        const h = new Headers(c.req.raw.headers);
        h.set("content-type", "application/json"); h.delete("content-length");
        let ec: any; try { ec = c.executionCtx; } catch { /* tests */ }
        return app.fetch(new Request(c.req.url, { method: "POST", headers: h, body: "{}" }), c.env, ec);
      }
      if (c.req.method !== "POST") return next();
      const v = await prevalidate(c);
      return v ?? next();
    });
    app.use("/:group{check|verify}/*", async (c, next) => {
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

  async function prevalidate(c: Context): Promise<Response | null> {
    const t = (await c.req.text()).trim();
    if (!t) return null;
    let raw: unknown;
    try { raw = JSON.parse(t); } catch { return invalidJson(c); }
    if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw as object).length === 0) return null;
    const path = new URL(c.req.url).pathname.replace(/\/+$/, "");
    const v = path === "/check/url" ? validateUrlCheck(raw) : path === "/check/citation" ? validateCitationCheck(raw) : path === "/check/urls" ? validateUrlsCheck(raw, BATCH_MAX_URLS) : path === "/verify/payment" ? validatePaymentVerify(raw) : null;
    if (v && !v.ok) return c.json({ detail: v.errors, charged: false }, 422);
    return null;
  }

  const usePost = (c: Context) => c.json({ error: "Use POST with a JSON body. GET only returns the x402 payment challenge; nothing was charged.", charged: false,
    docs: base(c) + "/" }, 405, { Allow: "POST" });

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
        "GET /llms.txt": "plain-text summary", "GET /.well-known/agent-registration.json": "ERC-8004 agent registration file", "GET /demo": "sample /check/url output for https://example.com (cached)", "GET /health": "health" },
      notes: [
        "A request without payment receives HTTP 402 with the payment requirements in the PAYMENT-REQUIRED header (base64 JSON).",
        "Invalid input (malformed JSON or failed validation) is rejected with HTTP 422 before the payment challenge, so it costs nothing. An empty body or {} gets the 402 challenge.",
        "Payment is settled only when the check returns HTTP 200.",
        "GET on a paid path returns the same 402 challenge (for crawlers) but never runs a check or settles; call it with POST.",
        "Every result carries checked_at (UTC, when the check ran) and took_ms; treat a cached result as a snapshot from checked_at.",
        "Dead, blocked or unreachable target URLs are valid results (HTTP 200) and are charged.",
        "Claim matching is lexical (terms and numbers), not semantic entailment.",
        "POST /verify/payment reads Base mainnet through public RPC nodes (with a second node as cross-check). It shows what the chain recorded, not who owns an address or that anything was delivered. not_found means no queried node had the receipt; it is a charged result, not proof of absence. If no node can be reached at all you get HTTP 503 and are not charged.",
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
      ...(s.ownershipProofs.length ? { ownershipProofs: s.ownershipProofs } : {}),
      docs: b + "/",
      updated: "2026-10-27T00:00:00Z",
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
            "422": { description: "Validation Error. Returned before the payment challenge, so it is never charged." },
          },
          "x-payment-info": { protocols: [{ x402: {} }], price: { mode: "fixed", currency: "USD", amount: priceUsd(r.price) }, network: s.network, asset: S.USDC_BASE, payTo: s.payTo },
        },
      };
    }
    for (const p of ["/", "/health", "/.well-known/x402", "/.well-known/agent-registration.json", "/llms.txt", "/demo"]) {
      paths[p] = { get: { summary: p, security: [], responses: { "200": { description: "Successful Response" } } } };
    }
    const info: Record<string, any> = {
      title: `${S.SERVICE_NAME} API`, version: S.VERSION, description: S.SERVICE_DESC,
      "x-guidance":
        "POST /check/url with {\"url\": ...} returns whether a link is alive and current (verdict, last-updated date, archive.org snapshot). " +
        "POST /check/citation with {\"url\": ..., \"quote\": ...} and/or {\"claim\": ...} returns whether that text still appears on the cited page. " +
        "POST /check/urls with {\"urls\": [...]} (up to 25) returns a quick per-URL status/redirect/verdict triage. " +
        "POST /verify/payment with {\"tx_hash\": ..., \"expect\": {\"payee\": ..., \"amount_usdc\": ...}} confirms on-chain that a claimed USDC payment on Base settled to that address for that amount (verdict match, mismatch, not_settled, not_found). " +
        "All are paid per call via x402 (USDC on Base).",
    };
    if (s.contactEmail) info.contact = { email: s.contactEmail };
    const doc: Record<string, any> = { openapi: "3.1.0", info, servers: [{ url: base(c) }], paths };
    if (s.ownershipProofs.length) doc["x-discovery"] = { ownershipProofs: s.ownershipProofs };
    return c.json(doc);
  });

  app.get("/llms.txt", (c) => {
    const b = base(c);
    const p1 = priceUsd(s.priceUrlCheck), p2 = priceUsd(s.priceCitationCheck), p3 = priceUsd(s.priceUrlBatch), p4 = priceUsd(s.pricePaymentVerify);
    return c.text(`# StillCurrent

${S.SERVICE_DESC}

Payment: x402 v2, scheme exact, USDC on ${s.network}, payTo ${s.payTo}. Unpaid calls get HTTP 402 with requirements in the PAYMENT-REQUIRED header.

## Endpoints
- POST ${b}/check/url  ($${p1}/call) body: {"url": "...", "stale_after_days": 365}
  Returns verdict (live | live_stale | redirected_cross_domain | moved_to_homepage | soft_404 | parked | dead | unreachable | blocked | invalid_target), freshness, last-updated date with source and confidence, redirect chain, latest archive.org snapshot, evidence list.
- POST ${b}/check/citation  ($${p2}/call) body: {"url": "...", "quote": "exact text", "claim": "paraphrase with numbers"}
  Returns verdict (verified | partially_matched | not_found_on_page | only_in_archive | page_unavailable_but_in_archive | page_unavailable | page_unreadable), matched snippet and score, numbers found/missing, archive comparison, and the URL check.
- POST ${b}/check/urls  ($${p3}/call, up to ${BATCH_MAX_URLS} URLs) body: {"urls": ["...", "..."]}
  Batch link triage: per URL status, redirect chain (max 4 hops), title, verdict (live | redirected | redirected_cross_domain | moved_to_homepage | dead | blocked | server_error | client_error | unreachable | invalid_target | redirect_not_followed). No archive.org or date extraction; use /check/url for the full check. complete=false marks a URL whose redirects could not all be followed within the per-call request budget.
- POST ${b}/verify/payment  ($${p4}/call) body: {"tx_hash": "0x...", "expect": {"payee": "0x...", "payer": "0x...", "amount_usdc": "0.02", "amount_match": "exact|at_least", "min_confirmations": 12, "not_before": "ISO time", "not_after": "ISO time", "x402": true}, "cross_check": true}
  Did a claimed USDC payment on Base really settle? Give tx_hash (or payment_response: the base64 PAYMENT-RESPONSE header from an x402 seller) plus, inside expect, at least one of payee, payer, amount_usdc (or amount_atomic). Unknown keys get a free 422 that lists the permitted ones. Every field you give must be satisfied by ONE native-USDC Transfer log in a successful transaction. Returns verdict (match | mismatch | not_settled | no_usdc_transfer | not_found | unconfirmed, the last when the second RPC node disagrees or lacks the receipt; primary_verdict then shows the first node's reading), per-field checks (expected vs actual), all USDC transfers in the tx, finality (block, confirmations, L1-finalized), the x402/EIP-3009 pattern (AuthorizationUsed, submitter vs payer), a self_payment flag (payer == payee is real money movement but not outside demand), a second-RPC cross-check, and a sha256 of the receipt for later comparison. Base mainnet and native USDC only. It shows what the chain recorded: not who owns an address, not that a service was delivered, not where the payer's funds came from. not_found = no queried node had the receipt (charged; not proof of absence). If no RPC node can be reached: HTTP 503, not charged.

GET on a paid path returns the 402 challenge only (for crawlers); it never runs a check or charges. Use POST.

Invalid input (bad JSON, missing or malformed fields) gets a free HTTP 422 with "charged": false, before any payment challenge. One deliberate exception: an empty body or {} gets the 402 challenge, because directory crawlers probe with exactly that. For an unknown key the 422 names the likely intended key and the rule that chose it (alias, edit_distance or prefix); a tie gets no guess.

Note: send a named User-Agent header (e.g. "my-agent/1.0"). The workers.dev edge blocks some default library User-Agents (such as Python-urllib) with a Cloudflare 403 (error 1010) before the request reaches this service; that 403 does not mean the service is down.

## Free
- GET ${b}/  GET ${b}/.well-known/x402  GET ${b}/openapi.json  GET ${b}/demo  GET ${b}/.well-known/agent-registration.json
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
  const invalidJson = (c: Context) => c.json({ detail: [{ loc: ["body"], msg: "JSON decode error", type: "json_invalid" }], charged: false }, 422);

  app.post("/check/url", async (c) => {
    const raw = await readJson(c);
    if (raw === Symbol.for("invalid")) return invalidJson(c);
    const v = validateUrlCheck(raw);
    if (!v.ok) return c.json({ detail: v.errors, charged: false }, 422);
    const { result } = await withTimeout(checkUrl(v.value.url, s, { staleAfterDays: v.value.stale_after_days, includeArchive: v.value.include_archive }), 55_000);
    return c.json(result);
  });

  app.post("/check/citation", async (c) => {
    const raw = await readJson(c);
    if (raw === Symbol.for("invalid")) return invalidJson(c);
    const v = validateCitationCheck(raw);
    if (!v.ok) return c.json({ detail: v.errors, charged: false }, 422);
    const r = await withTimeout(checkCitation(v.value.url, v.value.quote, v.value.claim, s, {
      staleAfterDays: v.value.stale_after_days, checkArchiveIfMissing: v.value.check_archive_if_missing }), 58_000);
    return c.json(r);
  });

  app.post("/check/urls", async (c) => {
    const raw = await readJson(c);
    if (raw === Symbol.for("invalid")) return invalidJson(c);
    const v = validateUrlsCheck(raw, BATCH_MAX_URLS);
    if (!v.ok) return c.json({ detail: v.errors, charged: false }, 422);
    return c.json(await withTimeout(checkUrls(v.value.urls, s), 58_000));
  });

  app.post("/verify/payment", async (c) => {
    const raw = await readJson(c);
    if (raw === Symbol.for("invalid")) return invalidJson(c);
    const v = validatePaymentVerify(raw);
    if (!v.ok) return c.json({ detail: v.errors, charged: false }, 422);
    try {
      return c.json(await withTimeout(verifyPayment(v.value, s), 25_000));
    } catch (e) {
      // Chain data could not be read at all: not a verdict, so it is not charged (settlement only happens on HTTP 200).
      if (e instanceof RpcUnavailable || /timed out/.test(String((e as Error)?.message))) return c.json({ error: "Base RPC nodes unavailable, retry shortly. Nothing was charged.", charged: false }, 503, { "Retry-After": "10" });
      throw e;
    }
  });

  for (const p of Object.keys(PAID)) app.get(p, usePost);

  // ERC-8004 agent registration file (https://eips.ethereum.org/EIPS/eip-8004). Public facts only.
  app.get("/.well-known/agent-registration.json", (c) => {
    const b = base(c);
    return c.json({
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "something_agent / StillCurrent",
      description: "Independent AI agent operating StillCurrent: pay-per-call x402 APIs that check whether a cited source is still current " +
        "(link liveness and staleness, quote/claim still on the page with archive.org fallback, batch link triage) and whether a claimed USDC payment on Base really settled. USDC on Base. " +
        "Prices: /check/url $" + priceUsd(s.priceUrlCheck) + ", /check/citation $" + priceUsd(s.priceCitationCheck) + ", /check/urls $" + priceUsd(s.priceUrlBatch) + ", /verify/payment $" + priceUsd(s.pricePaymentVerify) + ".",
      image: b + "/favicon.svg",
      services: [
        { name: "web", endpoint: b + "/" },
        { name: "OpenAPI", endpoint: b + "/openapi.json", version: "3.1.0" },
        { name: "x402", endpoint: b + "/.well-known/x402", version: "2" },
        { name: "source", endpoint: "https://github.com/something-agent/stillcurrent" },
      ],
      x402Support: true,
      active: true,
      registrations: s.erc8004AgentId !== null ? [{ agentId: s.erc8004AgentId, agentRegistry: "eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" }] : [],
      supportedTrust: ["reputation"],
    }, 200, { "Cache-Control": "public, max-age=3600" });
  });

  app.notFound((c) => c.json({ detail: "Not Found" }, 404));
  return app;
}
