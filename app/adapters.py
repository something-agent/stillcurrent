"""Site adapters for sources that block generic fetchers but offer official free APIs."""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote, unquote, urlsplit

from .config import settings
from .fetcher import FetchResult, Hop, fetch

_WIKI_HOST = re.compile(r"^(?P<lang>[a-z\-]{2,12})(?:\.m)?\.wikipedia\.org$")
WIKI_UA = settings.user_agent


def wikipedia_title(url: str) -> tuple[str, str] | None:
    p = urlsplit(url)
    m = _WIKI_HOST.match(p.hostname or "")
    if not m or not p.path.startswith("/wiki/"):
        return None
    title = unquote(p.path[len("/wiki/"):])
    if not title:
        return None
    return m.group("lang"), title


async def wikipedia_fetch(url: str, max_bytes: int) -> tuple[FetchResult, dict[str, Any]] | None:
    """Fetch a Wikipedia article through the MediaWiki Action + REST APIs (Wikimedia blocks generic HTTP clients)."""
    wt = wikipedia_title(url)
    if not wt:
        return None
    lang, title = wt
    base = f"https://{lang}.wikipedia.org"
    api = (f"{base}/w/api.php?action=query&prop=revisions%7Cinfo&rvprop=timestamp%7Cids&inprop=url"
           f"&redirects=1&format=json&formatversion=2&titles={quote(title, safe='')}")
    meta_r = await fetch(api, max_bytes=500_000, timeout=12, user_agent=WIKI_UA, accept="application/json")
    if meta_r.status != 200:
        return None
    import json

    try:
        data = json.loads(meta_r.text())
        page = data["query"]["pages"][0]
    except Exception:
        return None
    info: dict[str, Any] = {"source": "MediaWiki Action API", "api_url": api}
    redirects = data["query"].get("redirects") or []
    if redirects:
        info["redirected_to_title"] = redirects[-1].get("to")
    res = FetchResult(requested_url=url)
    if page.get("missing") or page.get("invalid"):
        info["exists"] = False
        res.status = 404
        res.final_url = url
        res.hops = [Hop(url, 404)]
        return res, info
    rev = (page.get("revisions") or [{}])[0]
    info.update({
        "exists": True,
        "title": page.get("title"),
        "last_revision_timestamp": rev.get("timestamp"),
        "last_revision_id": rev.get("revid"),
        "permanent_link": f"{base}/w/index.php?title={quote(page.get('title', '').replace(' ', '_'))}&oldid={rev.get('revid')}" if rev.get("revid") else None,
    })
    html_url = f"{base}/w/rest.php/v1/page/{quote(page['title'].replace(' ', '_'), safe='')}/html"
    html_r = await fetch(html_url, max_bytes=max_bytes, timeout=15, user_agent=WIKI_UA, accept="text/html")
    final = page.get("fullurl") or url
    if html_r.status == 200:
        html_r.requested_url = url
        html_r.final_url = final
        html_r.hops = [Hop(url, 200)] if not redirects else [Hop(url, 301), Hop(final, 200)]
        # surface the revision timestamp as a high-confidence modified date
        html_r.headers["x-wiki-last-revision"] = rev.get("timestamp") or ""
        return html_r, info
    res.status, res.final_url, res.hops = html_r.status, final, [Hop(url, html_r.status)]
    res.error, res.error_detail = html_r.error, html_r.error_detail
    return res, info
