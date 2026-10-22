"""Deterministic logic tests against a local HTTP server (no internet needed except none)."""
import asyncio
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from app import checks
from app import textutil as tu
from app.config import settings
from app.fetcher import fetch

PAGES = {
    "/fresh": (200, {"Content-Type": "text/html"}, """<html><head><title>Report</title>
        <meta property="article:modified_time" content="{recent}"></head>
        <body><p>Unemployment rose to 4.3% in September, the Bureau said.</p>
        <p>The quick brown fox jumps over the lazy dog.</p></body></html>"""),
    "/stale": (200, {"Content-Type": "text/html"}, "<html><head><title>Old</title></head><body><p>Last updated: March 3, 2019</p><p>Some data.</p></body></html>"),
    "/gone": (404, {"Content-Type": "text/html"}, "<html><title>Not here</title></html>"),
    "/soft": (200, {"Content-Type": "text/html"}, "<html><head><title>Page Not Found | Site</title></head><body>Sorry</body></html>"),
    "/parked": (200, {"Content-Type": "text/html"}, "<html><head><title>example.org</title></head><body>This domain is for sale! Buy this domain today.</body></html>"),
    "/deep/article/123": (301, {"Location": "/"}, ""),
    "/": (200, {"Content-Type": "text/html"}, "<html><head><title>Home</title></head><body>Welcome home</body></html>"),
    "/denied": (403, {"Content-Type": "text/html"}, "<html><title>Just a moment...</title></html>"),
    "/jsonld": (200, {"Content-Type": "text/html"}, '<html><head><script type="application/ld+json">{"@type":"Dataset","dateModified":"2020-01-15","datePublished":"2018-05-01"}</script></head><body>dataset</body></html>'),
}


class H(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        from datetime import datetime, timedelta, timezone
        status, headers, body = PAGES.get(self.path, (404, {}, "nope"))
        body = body.replace("{recent}", (datetime.now(timezone.utc) - timedelta(days=10)).strftime("%Y-%m-%dT%H:%M:%SZ"))
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, *a):
        pass


@pytest.fixture(scope="module")
def local():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    old = settings.allow_private_targets
    settings.allow_private_targets = True
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    settings.allow_private_targets = old
    srv.shutdown()


def run(coro):
    return asyncio.run(coro)


@pytest.mark.parametrize("path,verdict,freshness", [
    ("/fresh", "live", "fresh"),
    ("/stale", "live_stale", "stale"),
    ("/gone", "dead", "unknown"),
    ("/soft", "soft_404", "unknown"),
    ("/parked", "parked", "unknown"),
    ("/deep/article/123", "moved_to_homepage", "unknown"),
    ("/denied", "blocked", "unknown"),
    ("/jsonld", "live_stale", "stale"),
])
def test_url_verdicts(local, path, verdict, freshness):
    r = run(checks.check_url(local + path, include_archive=False))
    assert r["verdict"] == verdict, r["evidence"]
    assert r["freshness"] == freshness
    assert r["evidence"]


def test_jsonld_dates(local):
    r = run(checks.check_url(local + "/jsonld", include_archive=False))
    assert r["dates"]["last_updated"]["date"].startswith("2020-01-15")
    assert r["dates"]["last_updated"]["confidence"] == "high"
    assert r["dates"]["published"]["date"].startswith("2018-05-01")


def test_citation_exact_and_claim(local):
    r = run(checks.check_citation(local + "/fresh", "the quick brown fox jumps over the lazy dog", None, check_archive_if_missing=False))
    assert r["verdict"] == "verified" and r["quote_match"]["match"] == "exact"
    r = run(checks.check_citation(local + "/fresh", None, "unemployment rose to 4.3% in September", check_archive_if_missing=False))
    assert r["verdict"] == "verified" and r["claim_match"]["numbers_found_on_page"] == ["4.3"]
    r = run(checks.check_citation(local + "/fresh", None, "unemployment rose to 5.1% in September", check_archive_if_missing=False))
    assert r["verdict"] == "partially_matched" and r["claim_match"]["numbers_missing_from_page"] == ["5.1"]
    r = run(checks.check_citation(local + "/gone", "anything", None, check_archive_if_missing=False))
    assert r["verdict"] == "page_unavailable"


def test_quote_matching_levels():
    text = "He said: \u201cWe will not raise taxes\u2014ever.\u201d Then he left the building."
    assert checks.match_quote('"We will not raise taxes-ever."', text)["match"] == "exact"
    assert checks.match_quote("we will not raise taxes ever", text)["match"] == "exact_ignoring_punctuation"
    assert checks.match_quote("We would not raise taxes ever", text)["match"] in ("fuzzy", "partial")
    assert checks.match_quote("The moon is made of cheese", text)["match"] in ("not_found", "weak")


def test_text_dates():
    c = tu.extract_date_candidates(None, "Page last reviewed: 29 September 2026. Content source: X")
    assert any(x["date"].startswith("2026-09-29") for x in c)
    c = tu.extract_date_candidates(None, "Last Modified Date: October 3, 2025")
    assert any(x["date"].startswith("2025-10-03") for x in c)
    assert tu.parse_date("2999-01-01") is None  # future dates rejected


@pytest.mark.parametrize("url", [
    "http://127.0.0.1/", "http://localhost:8080/", "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/", "http://[::1]/", "file:///etc/passwd", "ftp://example.com/", "http://user:pw@example.com/",
])
def test_ssrf_blocked(url, monkeypatch):
    monkeypatch.setattr(settings, "allow_private_targets", False)
    r = run(fetch(url))
    assert r.error == "blocked_target", (url, r.error)
