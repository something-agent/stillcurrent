"""The unpaid request must yield a valid x402 v2 402 challenge for Base mainnet USDC -> PAY_TO."""
import base64
import json

import httpx
import pytest
from x402.http.utils import decode_payment_required_header
from x402.schemas.payments import PaymentRequired

from .conftest import PAY_TO

USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"


@pytest.mark.parametrize("path,amount,body", [
    ("/check/url", "10000", {"url": "https://example.com"}),
    ("/check/citation", "20000", {"url": "https://example.com", "quote": "Example Domain"}),
])
def test_unpaid_returns_402_with_requirements(paid_server, path, amount, body):
    r = httpx.post(paid_server + path, json=body, timeout=20)
    assert r.status_code == 402
    hdr = r.headers["payment-required"]
    pr = decode_payment_required_header(hdr)  # official SDK parser
    assert isinstance(pr, PaymentRequired)
    assert pr.x402_version == 2
    assert len(pr.accepts) == 1
    a = pr.accepts[0]
    assert a.scheme == "exact"
    assert a.network == "eip155:8453"              # Base mainnet
    assert a.asset.lower() == USDC_BASE.lower()     # USDC on Base
    assert a.amount == amount                       # atomic units (6 decimals)
    assert a.pay_to == PAY_TO
    assert a.extra == {"name": "USD Coin", "version": "2"}
    assert pr.resource.url == "https://stillcurrent.example" + path
    raw = json.loads(base64.b64decode(hdr))
    bz = raw["extensions"]["bazaar"]
    assert bz["info"]["input"]["method"] == "POST"
    assert bz["info"]["input"]["bodyType"] == "json"
    assert "url" in bz["schema"]["properties"]["input"]["properties"]["body"]["properties"]
    assert len(raw["resource"]["description"]) <= 500
    # body mirrors the requirements for legacy parsers
    jb = r.json()
    assert jb["accepts"][0]["payTo"] == PAY_TO and jb["accepts"][0]["amount"] == amount


def test_gate_runs_before_validation(paid_server):
    # Discovery crawlers probe with empty / example bodies: they must get 402, not 422.
    r = httpx.post(paid_server + "/check/url", content=b"", timeout=20)
    assert r.status_code == 402
    r = httpx.post(paid_server + "/check/citation", json={}, timeout=20)
    assert r.status_code == 402


def test_bogus_payment_rejected(paid_server):
    junk = base64.b64encode(b'{"x402Version":2,"payload":{}}').decode()
    r = httpx.post(paid_server + "/check/url", json={"url": "https://example.com"}, headers={"PAYMENT-SIGNATURE": junk}, timeout=30)
    assert r.status_code in (400, 402)
    assert "verdict" not in r.text


def test_free_discovery_routes(paid_server):
    root = httpx.get(paid_server + "/", timeout=10).json()
    assert root["payment"]["pay_to"] == PAY_TO and root["payment"]["network"] == "eip155:8453"
    assert {e["path"] for e in root["endpoints"]} == {"/check/url", "/check/citation"}
    wk = httpx.get(paid_server + "/.well-known/x402", timeout=10).json()
    assert wk["version"] == 1 and wk["resources"] == ["https://stillcurrent.example/check/url", "https://stillcurrent.example/check/citation"]
    spec = httpx.get(paid_server + "/openapi.json", timeout=10).json()
    op = spec["paths"]["/check/url"]["post"]
    assert op["x-payment-info"]["price"] == {"mode": "fixed", "currency": "USD", "amount": "0.01"}
    assert "402" in op["responses"]
    assert "StillCurrent" in httpx.get(paid_server + "/llms.txt", timeout=10).text
