# StillCurrent

Pay-per-call checks for AI agents and researchers: **is this URL/source still alive and current?** and **does this citation
still say what it is quoted for?** Paid per request with [x402](https://www.x402.org/) (USDC on Base). No accounts, no API keys.

Two paid endpoints, USDC on **Base mainnet** via the **x402 v2** protocol (`exact` scheme), settled through the
**PayAI facilitator** (no account or API key). Receive address (public): `0x33190c9D2662F94A19CE88EA666f0ff8CeDe3700`.
The service never holds a private key, never signs, never sends funds. It only advertises `payTo`.

| Endpoint | Price | What it answers |
|---|---|---|
| `POST /check/url` | $0.01 | Is this link alive and current? Status and redirect chain; soft-404, parked-domain, redirect-to-homepage, WAF/bot-wall and cross-domain-redirect detection; last-updated date (meta/JSON-LD/`<time>`/visible "Last updated/reviewed" text/PDF metadata/Last-Modified) with source and confidence; latest archive.org snapshot (any status and latest HTTP-200); verdict, evidence, and a recommended action. |
| `POST /check/citation` | $0.02 | Does the quoted text or claim still appear on the cited page (HTML, PDF, text)? Quote matching runs exact, then punctuation/case-insensitive, then fuzzy (score, snippet, matched text). Claims are checked lexically: key terms plus **every number** must appear, and the best passage is returned. If the text is not on the live page, it is compared against the latest archive.org snapshot (`only_in_archive` = the source changed). The response also includes the full URL check. |

Site adapters: **Wikipedia** goes through the official MediaWiki APIs and returns the last revision timestamp and a permanent `oldid` link. **legislation.gov.uk** returns factual editorial metadata: revised-text date and the count/types of outstanding unapplied effects. This is *not* a legal in-force verdict. A general law-in-force endpoint was left out on purpose because it could not be made reliable without per-provision parsing.

Free routes: `GET /` (service JSON), `GET /.well-known/x402` (x402scan v1 fan-out plus IETF-draft v2 fields), `GET /openapi.json`
(with `x-payment-info`, `402` responses, `info.x-guidance`), `GET /llms.txt`, `GET /health`, and `GET /demo`. The demo returns a fixed-input sample:
`/check/url` on example.com, recomputed at most hourly. It cannot be used to check arbitrary URLs, so it does not undercut payment.

## Payment behaviour
* Unpaid request → `402` with `PAYMENT-REQUIRED` header (base64 JSON, x402 v2) incl. Bazaar discovery extension (input schema +
  example, output example) and a JSON body mirroring `accepts` for legacy parsers. The gate runs **before** body validation, so
  crawlers probing with empty bodies get 402, not 422.
* Settlement happens only when the handler returns < 400. Invalid input (422) is not charged. A dead, blocked, or unreachable *target*
  is still a successful check (200) and is charged.
* Amounts: `/check/url` = `10000`, `/check/citation` = `20000` (USDC atomic units, 6 dp). Asset `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
* PayAI fee: the facilitator charges the *seller* in credits. Base `exact` is about 2.09 credits ($0.0021) per settlement (live rate
  `GET https://facilitator.payai.network/pricing`). The 1,000 free credits per payTo therefore cover about 480 Base settlements, not 1,000.
  After that the operator prepays ($1 = 1,000 credits) and sets `PAYAI_API_KEY_ID/SECRET`. Check
  the balance status: `curl "https://facilitator.payai.network/free-credits?payTo=<addr>&network=eip155:8453"`.

## Safety
* SSRF guard: http/https only, no URL credentials, every redirect hop resolved and refused if any address is non-public
  (loopback, RFC1918, link-local/metadata, CGNAT, …). Behind fake-IP DNS resolvers (198.18/15) real addresses come from
  Cloudflare DNS-over-HTTPS, which also gives true NXDOMAIN detection. Residual risk: DNS rebinding between check and connect.
* Size caps (2 MB URL check, 10 MB citation, 300 PDF pages). Time caps (15 s per fetch, 55–58 s per call). Max 8 concurrent checks.
* Discovery text is descriptive only (no imperative "agent instructions") to pass the Bazaar metadata policy.
* Outbound User-Agent: `Mozilla/5.0 (compatible; StillCurrentBot/0.1; link and citation checker; +<PUBLIC_BASE_URL>; <CONTACT_EMAIL>)`.
  Wikimedia requires contact info, so set `PUBLIC_BASE_URL` and `CONTACT_EMAIL` in production (`BOT_CONTACT` overrides both).

## Run
```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.lock     # or requirements.txt (direct pins)
scripts/run_local.sh paid 8402      # payment gate ON (needs outbound access to facilitator.payai.network at startup)
scripts/run_local.sh test 8403      # TEST MODE: X402_DISABLED=1, gate OFF; for logic tests only, bind localhost
scripts/probe_402.sh http://127.0.0.1:8402   # print + decode the 402 challenge
```
Config is via env vars; see `.env.example`. Production: `PUBLIC_BASE_URL=https://<host>` so `resource.url` and discovery docs use https.
Docker: `docker build -t stillcurrent . && docker run -p 7860:7860 -e PUBLIC_BASE_URL=https://... stillcurrent`
(the image listens on `${PORT}`, default 7860; platforms that inject `PORT`, such as Render, override it).

## Deploy
**Cloudflare Workers (free plan, no card):** `worker/` is a TypeScript port of this service using the official x402 v2 TS SDK.
It has the same routes, prices and check logic. See [`worker/README.md`](worker/README.md); deploy with
`CLOUDFLARE_API_TOKEN=... npx wrangler deploy` from `worker/`.

**Docker (any container host):** `render.yaml` is a Render Blueprint for one Docker web service (health check `/health`). Set
`PUBLIC_BASE_URL=https://<host>` (on Render it falls back to `RENDER_EXTERNAL_URL` if empty) and `CONTACT_EMAIL`. Render's
free instances sleep after 15 min idle (~1 min cold start).

## Tests
```bash
.venv/bin/python -m pytest -q             # all 34 (live ones hit real websites)
.venv/bin/python -m pytest -q -m "not live"
```
* `tests/test_payment_gate.py` starts a real server with the gate ON and decodes the 402 with the official SDK parser
  (`x402.http.utils.decode_payment_required_header`). It asserts x402Version 2, scheme exact, network eip155:8453, USDC asset,
  amounts, payTo, EIP-712 domain extra, https resource URL, and Bazaar extension. It also checks 402-before-validation, rejection of a
  bogus payment header, and the discovery docs.
* `tests/test_logic_offline.py`: verdicts against a local HTTP server (live, stale, 404, soft-404, parked, redirect-to-home,
  bot wall, JSON-LD dates), quote/claim matching levels, date parsing, and SSRF refusals.
* `tests/test_live_endpoints.py`: real URLs through the HTTP API in test mode (legislation.gov.uk, gov.uk 404, NXDOMAIN, Wikipedia
  API adapter, archive.org, arXiv PDF exact quote, misquote, 422s, metadata-IP SSRF).

## Known limits
* JS-only pages give `page_unreadable` or no dates. Sites behind Cloudflare/Akamai/AWS WAF challenges (Stack Overflow, congress.gov,
  census.gov, EUR-Lex) return `blocked` (inconclusive) plus the archive.org snapshot. No headless browser is used.
* Claim checks are lexical, not semantic entailment. A negated claim can still score high, and the output says so.
* No ownership proof in discovery docs, because that would require signing with the wallet, which is out of scope.

## Layout
`app/main.py` (FastAPI app, x402 gate, discovery routes) · `app/checks.py` (URL/citation logic, archive.org, legislation.gov.uk)
· `app/adapters.py` (Wikipedia) · `app/fetcher.py` (safe fetch) · `app/textutil.py` (text/date extraction) · `app/config.py`
· `docs/402-sample.txt` (decoded 402 challenge) · `worker/` (Cloudflare Workers port, TypeScript)

## License
MIT
