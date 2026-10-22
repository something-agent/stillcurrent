"""End-to-end tests of the HTTP endpoints on REAL public URLs, payment gate off (X402_DISABLED=1).
Needs internet. Results depend on third-party sites, so assertions are deliberately tolerant."""
import httpx
import pytest

pytestmark = pytest.mark.live


def post(base, path, body):
    r = httpx.post(base + path, json=body, timeout=90)
    assert r.status_code == 200, r.text
    return r.json()


def test_live_page(test_server):
    r = post(test_server, "/check/url", {"url": "https://www.legislation.gov.uk/ukpga/1998/42"})
    assert r["verdict"] in ("live", "live_stale")
    assert r["http"]["status"] == 200
    assert r["dates"]["last_updated"] is not None
    assert r["legislation_gov_uk"]["title"] == "Human Rights Act 1998"


def test_dead_404(test_server):
    r = post(test_server, "/check/url", {"url": "https://www.gov.uk/this-page-does-not-exist-stillcurrent-test"})
    assert r["verdict"] == "dead" and r["http"]["status"] == 404


def test_nxdomain(test_server):
    r = post(test_server, "/check/url", {"url": "https://stillcurrent-nonexistent-zzq81.com/x", "include_archive": False})
    assert r["verdict"] == "dead"
    assert any("DNS" in e for e in r["evidence"])


def test_wikipedia_via_api(test_server):
    r = post(test_server, "/check/url", {"url": "https://en.wikipedia.org/wiki/Hypertext_Transfer_Protocol"})
    assert r["verdict"] in ("live", "live_stale")
    assert r["wikipedia"]["exists"] is True and r["wikipedia"]["permanent_link"]
    assert r["dates"]["last_updated"]["source"] == "wikipedia.last_revision"


def test_archive_lookup(test_server):
    r = post(test_server, "/check/url", {"url": "https://example.com/"})
    assert r["verdict"] == "live"
    assert r["archive"]["available"] in (True, None)  # None = archive.org lookup failed/timed out


def test_citation_pdf_exact(test_server):
    r = post(test_server, "/check/citation", {
        "url": "https://arxiv.org/pdf/1706.03762",
        "quote": "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms"})
    assert r["verdict"] == "verified" and r["quote_match"]["match"] == "exact"


def test_citation_misquote(test_server):
    r = post(test_server, "/check/citation", {
        "url": "https://arxiv.org/abs/1706.03762",
        "quote": "The dominant sequence models are based on simple recurrent networks", "check_archive_if_missing": False})
    assert r["verdict"] in ("partially_matched", "not_found_on_page")


def test_invalid_input_422(test_server):
    assert httpx.post(test_server + "/check/url", json={"url": "notaurl"}, timeout=10).status_code == 422
    assert httpx.post(test_server + "/check/citation", json={"url": "https://example.com"}, timeout=10).status_code == 422


def test_ssrf_via_api(test_server):
    r = post(test_server, "/check/url", {"url": "http://169.254.169.254/latest/meta-data/", "include_archive": False})
    assert r["verdict"] == "invalid_target"
