# StillCurrent: Cloudflare Workers port

**Live:** https://stillcurrent.something-agent.workers.dev (for example `curl -si -X POST https://stillcurrent.something-agent.workers.dev/check/url`
returns the 402 challenge).

A TypeScript port of the Python StillCurrent service (repo root) for the **Cloudflare Workers free plan**. It has the same routes,
prices, responses and check logic. It uses the official x402 v2 TypeScript SDK (`@x402/hono`, `@x402/core`, `@x402/evm`,
`@x402/extensions` for Bazaar) with the PayAI facilitator. The receive address is public; the Worker holds no key and never signs.

| Route | Price |
|---|---|
| `POST /check/url` | $0.01 USDC (Base, `eip155:8453`, `exact`) |
| `POST /check/citation` | $0.02 USDC |
| `GET /`, `/health`, `/.well-known/x402`, `/openapi.json`, `/llms.txt`, `/demo` | free |

Configuration lives in `wrangler.toml` `[vars]`. `PUBLIC_BASE_URL` is optional: without it, the 402 `resource.url` and the
discovery docs use the request origin, which on Workers is already `https://stillcurrent.<subdomain>.workers.dev`.

## Develop and test locally (no Cloudflare account needed)
```bash
npm ci
npm test                    # vitest: text/date parsing, matching, URL verdicts, PDF, payment gate (fetch stubbed, offline)
npm run typecheck
npm run probe               # wrangler dev + curl: free routes 200, unpaid POSTs 402 with a decoded PAYMENT-REQUIRED header
npx wrangler dev --var X402_DISABLED:1 --port 8788   # TEST MODE (gate off), localhost only
```

## Deploy
```bash
CLOUDFLARE_API_TOKEN=<token with the "Edit Cloudflare Workers" template> CLOUDFLARE_ACCOUNT_ID=<account id> npx wrangler deploy
```
`PUBLIC_BASE_URL` in `wrangler.toml` must match the deployed origin. Afterwards,
`curl -si -X POST https://stillcurrent.something-agent.workers.dev/check/url -H 'content-type: application/json' -d '{}'`
should return `402` with a `PAYMENT-REQUIRED` header.

## Workers free-plan fit
* **CPU (10 ms/request on Free):** fetch wait time does not count, only parsing and matching do. A typical HTML page of
  100 to 300 KB takes a few ms. Inputs are capped: 1 MB per page for `/check/url`, 2 MB for `/check/citation`, 12 MB of inflated PDF
  streams, 300 PDF pages, 2M fuzzy-alignment cells, and the first 500 characters of a quote. Very large pages (about 1 MB HTML
  plus a fuzzy quote) or large PDFs can take 30 to 100 ms. Cloudflare tolerates occasional overruns but may terminate a request
  (error 1102) if it happens consistently. The Python service has no such limit.
* **Subrequests (50 per invocation):** at most 8 redirects per fetch, plus one retry, Wikipedia API (2), archive.org CDX (2),
  legislation.gov.uk (1), DNS-over-HTTPS (1), and archived copy (≤ 9). That stays under 50. No more than 6 simultaneous connections.
* **Requests:** 100,000 per day on Free.

## Differences from the Python service
* **PDF text:** a built-in best-effort extractor that handles FlateDecode, object streams, and ToUnicode CMaps (simple and
  Type0 fonts), and uses glyph widths for word spacing. Encrypted PDFs and fonts without ToUnicode or standard encodings may
  give partial text. The Python service uses pypdf.
* **Fuzzy quote score:** an approximation of rapidfuzz `partial_ratio` (windowed semi-global alignment). Scores can differ by a
  point or two; the bands are the same (≥ 90 fuzzy, ≥ 75 partial, ≥ 60 weak).
* **DNS:** Workers have no resolver API, so NXDOMAIN is detected with DNS-over-HTTPS (cloudflare-dns.com) after a failed fetch.
  Private and loopback IP literals, `localhost`, and single-label hosts are refused before any fetch, and again on every redirect hop.
* **Payment-gate init:** each request fetches the facilitator's `/supported` on its own until one has initialized the gate. The
  SDK default shares a single init promise across requests, and on Workers that hung concurrent first requests.
* **Cloudflare edge:** `workers.dev` blocks the default `Python-urllib/*` User-Agent with error 1010 before the Worker runs.
  Clients using `requests`, `httpx`, Node, Go or curl are not affected.
* **Log noise:** the Bazaar extension's Ajv schema compiler cannot run under Workers (it needs code generation), so a
  validation warning is logged. The discovery extension is still emitted in full in the 402 header.

Layout: `src/index.ts` (entry), `src/app.ts` (routes, x402 gate, discovery docs), `src/checks.ts` (URL and citation checks,
archive.org, Wikipedia, legislation.gov.uk), `src/fetcher.ts` (safe fetch), `src/textutil.ts` and `src/pdf.ts` (extraction),
`src/schemas.ts`, `src/validate.ts`, `src/config.ts`. License: MIT.
