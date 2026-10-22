"""StillCurrent API: x402 pay-per-call 'is it still current?' checks.

Run:  uvicorn app.main:app --host 0.0.0.0 --port 8402
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field, field_validator, model_validator

from . import __version__
from .checks import check_citation, check_url
from .config import settings

log = logging.getLogger("stillcurrent")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

SERVICE_NAME = "StillCurrent"
SERVICE_DESC = (
    "Pay-per-call checks that tell you whether a source is still current: link liveness and staleness, "
    "and whether a quoted sentence or claim still appears on the cited page (with archive.org fallback)."
)
USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"  # USDC on Base mainnet (eip155:8453)

# ------------------------------------------------------------------ models
class UrlCheckRequest(BaseModel):
    url: str = Field(..., max_length=2048, description="Absolute http(s) URL of the source, citation or dataset to check.")
    stale_after_days: int = Field(365, ge=1, le=36500, description="Age (days since last update) after which a live page is reported as stale.")
    include_archive: bool = Field(True, description="Look up the latest archive.org Wayback Machine snapshot.")

    @field_validator("url")
    @classmethod
    def _http(cls, v: str) -> str:
        v = v.strip()
        if not v.lower().startswith(("http://", "https://")):
            raise ValueError("url must start with http:// or https://")
        return v


class CitationCheckRequest(BaseModel):
    url: str = Field(..., max_length=2048, description="Absolute http(s) URL of the cited page (HTML, PDF or plain text).")
    quote: str | None = Field(None, max_length=2000, description="Exact text the citation quotes. Matched exactly, then punctuation-insensitive, then fuzzy.")
    claim: str | None = Field(None, max_length=1000, description="Paraphrased claim attributed to the source. Checked lexically: key terms and every number must appear near each other.")
    stale_after_days: int = Field(365, ge=1, le=36500)
    check_archive_if_missing: bool = Field(True, description="If not found on the live page, also search the latest archive.org snapshot.")

    @field_validator("url")
    @classmethod
    def _http(cls, v: str) -> str:
        v = v.strip()
        if not v.lower().startswith(("http://", "https://")):
            raise ValueError("url must start with http:// or https://")
        return v

    @model_validator(mode="after")
    def _one_of(self) -> "CitationCheckRequest":
        if not (self.quote and self.quote.strip()) and not (self.claim and self.claim.strip()):
            raise ValueError("provide at least one of 'quote' or 'claim'")
        return self


# ------------------------------------------------------- examples / schemas
URL_INPUT_EXAMPLE = {"url": "https://www.cdc.gov/nchs/fastats/life-expectancy.htm", "stale_after_days": 365}
URL_OUTPUT_EXAMPLE_FULL = {
    "url": "https://www.cdc.gov/nchs/fastats/life-expectancy.htm",
    "verdict": "live",
    "freshness": "fresh",
    "usable_as_citation": True,
    "recommended_action": "OK to cite.",
    "evidence": ["HTTP 200 after 0 redirect(s)", "last updated 2026-09-29 (23 days ago, source text['last reviewed'], confidence medium)",
                 "latest good archive.org snapshot 2026-10-16"],
    "http": {"reachable": True, "status": 200, "final_url": "https://www.cdc.gov/nchs/fastats/life-expectancy.htm",
             "redirect_chain": [{"url": "https://www.cdc.gov/nchs/fastats/life-expectancy.htm", "status": 200}]},
    "dates": {"last_updated": {"date": "2026-09-29T00:00:00Z", "source": "text['last reviewed']", "confidence": "medium", "age_days": 23}},
    "archive": {"available": True, "latest_ok": {"timestamp": "2026-10-16T18:35:00Z",
                "url": "https://web.archive.org/web/20261016183500/https://www.cdc.gov/nchs/fastats/life-expectancy.htm"}},
}
URL_OUTPUT_EXAMPLE = {k: URL_OUTPUT_EXAMPLE_FULL[k] for k in ("verdict", "freshness", "usable_as_citation", "evidence")}
CIT_INPUT_EXAMPLE = {"url": "https://www.cdc.gov/nchs/fastats/life-expectancy.htm",
                     "claim": "Life expectancy at birth in the US was 78.4 years"}
CIT_OUTPUT_EXAMPLE_FULL = {
    "verdict": "partially_matched",
    "explanation": "Only a partial / approximate match was found; the wording may have changed or been paraphrased.",
    "claim_match": {"verdict": "partially_supported_lexically", "best_passage_coverage": 0.667,
                    "numbers_in_claim": ["78.4"], "numbers_found_on_page": [], "numbers_missing_from_page": ["78.4"],
                    "best_passage": "... Life expectancy at birth Both sexes: 79.0 years Males: 76.5 years Females: 81.4 years ..."},
    "quote_match": None,
    "archive_comparison": {"snapshot_date": "2026-10-16T18:35:00Z"},
    "url_check": {"verdict": "live", "freshness": "fresh"},
}
CIT_OUTPUT_EXAMPLE = {"verdict": "partially_matched", "claim_match": {"verdict": "partially_supported_lexically",
                      "numbers_found_on_page": [], "numbers_missing_from_page": ["78.4"]}}
VERDICTS_URL = ["live", "live_stale", "redirected_cross_domain", "moved_to_homepage", "soft_404", "parked", "dead", "unreachable", "blocked", "invalid_target"]
VERDICTS_CIT = ["verified", "partially_matched", "not_found_on_page", "only_in_archive", "page_unavailable_but_in_archive",
                "page_unavailable", "page_unreadable"]
URL_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": VERDICTS_URL},
        "freshness": {"type": "string", "enum": ["fresh", "stale", "possibly_stale", "unknown"]},
        "usable_as_citation": {"type": ["boolean", "null"]},
        "recommended_action": {"type": "string"},
        "evidence": {"type": "array", "items": {"type": "string"}},
        "http": {"type": "object"}, "dates": {"type": "object"}, "archive": {"type": ["object", "null"]},
        "wikipedia": {"type": "object"}, "legislation_gov_uk": {"type": "object"},
    },
}
CIT_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": VERDICTS_CIT},
        "explanation": {"type": "string"},
        "quote_match": {"type": ["object", "null"]}, "claim_match": {"type": ["object", "null"]},
        "archive_comparison": {"type": ["object", "null"]}, "url_check": {"type": "object"},
    },
}
URL_DESCRIPTION = (
    "Checks whether a URL (source, citation or dataset) is still alive and current: HTTP status and redirect chain, "
    "soft-404 / parked-domain / redirect-to-homepage detection, last-updated date from metadata or page text, latest "
    "archive.org snapshot, and a verdict (live, live_stale, dead, moved_to_homepage, soft_404, blocked, ...) with evidence."
)
CIT_DESCRIPTION = (
    "Checks whether a quoted sentence or a claim still appears on the cited page (HTML, PDF or text). Exact, "
    "punctuation-insensitive and fuzzy quote matching with snippet; lexical claim check incl. every number; compares with "
    "the latest archive.org snapshot when missing; includes the full URL liveness/staleness check."
)
assert len(URL_DESCRIPTION) <= 500 and len(CIT_DESCRIPTION) <= 500

PAID_ROUTES = {
    "/check/url": {"price": settings.price_url_check, "description": URL_DESCRIPTION, "model": UrlCheckRequest,
                   "input_example": URL_INPUT_EXAMPLE, "output_example": URL_OUTPUT_EXAMPLE, "output_example_full": URL_OUTPUT_EXAMPLE_FULL, "output_schema": URL_OUTPUT_SCHEMA},
    "/check/citation": {"price": settings.price_citation_check, "description": CIT_DESCRIPTION, "model": CitationCheckRequest,
                        "input_example": CIT_INPUT_EXAMPLE, "output_example": CIT_OUTPUT_EXAMPLE, "output_example_full": CIT_OUTPUT_EXAMPLE_FULL, "output_schema": CIT_OUTPUT_SCHEMA},
}


def _input_schema(model: type[BaseModel]) -> dict[str, Any]:
    js = model.model_json_schema()
    return {"type": "object", "properties": js.get("properties", {}), "required": js.get("required", [])}


# ------------------------------------------------------------------- app
app = FastAPI(title=f"{SERVICE_NAME} API", version=__version__, description=SERVICE_DESC, openapi_url=None, docs_url="/docs", redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["*"],
                   expose_headers=["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE", "EXTENSION-RESPONSES"])

_sem = asyncio.Semaphore(8)


def build_x402_routes() -> dict[str, Any]:
    from x402.extensions.bazaar import OutputConfig, declare_discovery_extension
    from x402.http import PaymentOption
    from x402.http.types import RouteConfig

    from x402.http.types import HTTPResponseBody

    def unpaid_body_for(path: str, r: dict[str, Any]):
        def _body(context) -> HTTPResponseBody:
            return HTTPResponseBody(content_type="application/json", body={
                "x402Version": 2,
                "error": "Payment required",
                "message": f"{SERVICE_NAME} {path} costs ${_price_usd(r['price'])} in USDC on {settings.network}. "
                           "Payment requirements are in the PAYMENT-REQUIRED response header (base64-encoded JSON).",
                "accepts": [{"scheme": "exact", "network": settings.network, "asset": USDC_BASE, "amount": _atomic(r["price"]),
                             "payTo": settings.pay_to, "maxTimeoutSeconds": 300, "extra": {"name": "USD Coin", "version": "2"}}],
                "docs": (settings.public_base_url or "") + "/",
            })
        return _body

    routes = {}
    for path, r in PAID_ROUTES.items():
        routes[f"POST {path}"] = RouteConfig(
            resource=(settings.public_base_url.rstrip("/") + path) if settings.public_base_url else None,
            unpaid_response_body=unpaid_body_for(path, r),
            accepts=[PaymentOption(scheme="exact", pay_to=settings.pay_to, price=r["price"], network=settings.network)],
            description=r["description"],
            mime_type="application/json",
            service_name=SERVICE_NAME,
            tags=["citations", "link-checking", "fact-checking", "freshness", "research"],
            extensions=declare_discovery_extension(
                input=r["input_example"],
                input_schema=_input_schema(r["model"]),
                body_type="json",
                output=OutputConfig(example=r["output_example"], schema=r["output_schema"]),
            ),
        )
    return routes


def install_payment_gate(application: FastAPI) -> None:
    from x402.http import FacilitatorConfig, HTTPFacilitatorClient
    from x402.http.middleware.fastapi import PaymentMiddlewareASGI
    from x402.mechanisms.evm.exact import ExactEvmServerScheme
    from x402.server import x402ResourceServer

    facilitator = HTTPFacilitatorClient(FacilitatorConfig(url=settings.facilitator_url))
    server = x402ResourceServer(facilitator)
    server.register(settings.network, ExactEvmServerScheme())
    application.add_middleware(PaymentMiddlewareASGI, routes=build_x402_routes(), server=server)


if settings.payments_disabled:
    log.warning("X402_DISABLED=1: PAYMENT GATE IS OFF (test mode). Never expose this instance publicly.")
else:
    install_payment_gate(app)


def _base(request: Request) -> str:
    return (settings.public_base_url or str(request.base_url)).rstrip("/")


def _price_usd(p: str) -> str:
    return p.lstrip("$")


def _atomic(p: str) -> str:
    return str(round(float(_price_usd(p)) * 1_000_000))


# ------------------------------------------------------------ free routes
@app.get("/")
async def root(request: Request) -> JSONResponse:
    b = _base(request)
    return JSONResponse({
        "name": SERVICE_NAME,
        "version": __version__,
        "description": SERVICE_DESC,
        "payment": {
            "protocol": "x402 (v2, scheme 'exact')",
            "network": settings.network,
            "network_name": "Base mainnet" if settings.network == "eip155:8453" else settings.network,
            "asset": "USDC",
            "asset_address": USDC_BASE if settings.network == "eip155:8453" else None,
            "pay_to": settings.pay_to,
            "facilitator": settings.facilitator_url,
            "mode": "TEST MODE: payments disabled" if settings.payments_disabled else "live",
        },
        "endpoints": [
            {"method": "POST", "path": p, "url": b + p, "price_usd": _price_usd(r["price"]), "description": r["description"],
             "input_example": r["input_example"]}
            for p, r in PAID_ROUTES.items()
        ],
        "free": {"GET /": "this document", "GET /.well-known/x402": "x402 discovery manifest", "GET /openapi.json": "OpenAPI 3 with x-payment-info",
                 "GET /llms.txt": "plain-text summary", "GET /demo": "sample /check/url output for https://example.com (cached)", "GET /health": "health"},
        "notes": [
            "A request without payment receives HTTP 402 with the payment requirements in the PAYMENT-REQUIRED header (base64 JSON).",
            "Payment is settled only when the check returns HTTP 200; invalid input (422) is not charged.",
            "Dead, blocked or unreachable target URLs are valid results (HTTP 200) and are charged.",
            "Claim matching is lexical (terms and numbers), not semantic entailment.",
        ],
    })


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "time": datetime.now(timezone.utc).isoformat(), "payments": not settings.payments_disabled}


@app.get("/.well-known/x402")
async def well_known(request: Request) -> JSONResponse:
    b = _base(request)
    return JSONResponse({
        "version": 1,
        "x402Version": 2,
        "kind": "resource-server",
        "name": SERVICE_NAME,
        "description": SERVICE_DESC,
        "resources": [b + p for p in PAID_ROUTES],
        "resourceDetails": [
            {"url": b + p, "method": "POST", "description": r["description"], "price": {"amount": _price_usd(r["price"]), "currency": "USD"},
             "accepts": [{"scheme": "exact", "network": settings.network, "asset": USDC_BASE, "payTo": settings.pay_to, "amount": _atomic(r["price"])}]}
            for p, r in PAID_ROUTES.items()
        ],
        "docs": b + "/",
        "updated": "2026-10-21T00:00:00Z",
    }, headers={"Cache-Control": "public, max-age=3600"})


@app.get("/openapi.json")
async def openapi(request: Request) -> JSONResponse:
    spec = get_openapi(title=app.title, version=app.version, description=SERVICE_DESC, routes=app.routes)
    spec["servers"] = [{"url": _base(request)}]
    spec["info"]["x-guidance"] = (
        "POST /check/url with {\"url\": ...} returns whether a link is alive and current (verdict, last-updated date, archive.org snapshot). "
        "POST /check/citation with {\"url\": ..., \"quote\": ...} and/or {\"claim\": ...} returns whether that text still appears on the cited page. "
        "Both are paid per call via x402 (USDC on Base)."
    )
    if settings.contact_email:
        spec["info"]["contact"] = {"email": settings.contact_email}
    for path, item in spec.get("paths", {}).items():
        if path not in PAID_ROUTES:
            for op_ in item.values():
                op_["security"] = []
    for p, r in PAID_ROUTES.items():
        op = spec.get("paths", {}).get(p, {}).get("post")
        if not op:
            continue
        op["summary"] = r["description"][:120]
        op["description"] = r["description"]
        op["x-payment-info"] = {"protocols": [{"x402": {}}], "price": {"mode": "fixed", "currency": "USD", "amount": _price_usd(r["price"])},
                                "network": settings.network, "asset": USDC_BASE, "payTo": settings.pay_to}
        op.setdefault("responses", {})["402"] = {"description": "Payment Required. x402 v2 payment requirements in the PAYMENT-REQUIRED header (base64 JSON)."}
        op["responses"]["200"]["content"] = {"application/json": {"schema": r["output_schema"], "example": r["output_example_full"]}}
    return JSONResponse(spec)


LLMS = """# StillCurrent

{desc}

Payment: x402 v2, scheme exact, USDC on {network}, payTo {pay_to}. Unpaid calls get HTTP 402 with requirements in the PAYMENT-REQUIRED header.

## Endpoints
- POST {base}/check/url  (${p1}/call) body: {{"url": "...", "stale_after_days": 365}}
  Returns verdict (live | live_stale | redirected_cross_domain | moved_to_homepage | soft_404 | parked | dead | unreachable | blocked | invalid_target), freshness, last-updated date with source and confidence, redirect chain, latest archive.org snapshot, evidence list.
- POST {base}/check/citation  (${p2}/call) body: {{"url": "...", "quote": "exact text", "claim": "paraphrase with numbers"}}
  Returns verdict (verified | partially_matched | not_found_on_page | only_in_archive | page_unavailable_but_in_archive | page_unavailable | page_unreadable), matched snippet and score, numbers found/missing, archive comparison, and the URL check.

## Free
- GET {base}/  GET {base}/.well-known/x402  GET {base}/openapi.json  GET {base}/demo
"""


@app.get("/llms.txt", response_class=PlainTextResponse)
async def llms(request: Request) -> str:
    return LLMS.format(desc=SERVICE_DESC, network=settings.network, pay_to=settings.pay_to, base=_base(request),
                       p1=_price_usd(settings.price_url_check), p2=_price_usd(settings.price_citation_check))


_demo_cache: dict[str, Any] = {"t": 0.0, "data": None}
_demo_lock = asyncio.Lock()


@app.get("/demo")
async def demo() -> JSONResponse:
    """Fixed-input sample of /check/url (https://example.com), recomputed at most once per hour."""
    if not settings.demo_enabled:
        return JSONResponse({"error": "demo disabled"}, status_code=404)
    async with _demo_lock:
        if _demo_cache["data"] is None or time.time() - _demo_cache["t"] > 3600:
            r = await check_url("https://example.com/")
            r.pop("_text", None)
            _demo_cache.update(t=time.time(), data=r)
    return JSONResponse({"demo": True, "note": "Fixed sample input, cached up to 1 hour. Paid endpoints accept any URL.",
                         "endpoint": "POST /check/url", "result": _demo_cache["data"]})


# ------------------------------------------------------------ paid routes
@app.post("/check/url", summary="URL liveness + freshness check")
async def post_check_url(req: UrlCheckRequest) -> JSONResponse:
    async with _sem:
        r = await asyncio.wait_for(check_url(req.url, stale_after_days=req.stale_after_days, include_archive=req.include_archive), timeout=55)
    r.pop("_text", None)
    return JSONResponse(r)


@app.post("/check/citation", summary="Quote / claim still on the cited page?")
async def post_check_citation(req: CitationCheckRequest) -> JSONResponse:
    async with _sem:
        r = await asyncio.wait_for(check_citation(req.url, req.quote, req.claim, stale_after_days=req.stale_after_days,
                                                  check_archive_if_missing=req.check_archive_if_missing), timeout=58)
    return JSONResponse(r)
