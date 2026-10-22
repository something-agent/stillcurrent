"""Core check logic: URL liveness/freshness and citation/quote verification."""
from __future__ import annotations

import asyncio
import re
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import quote as urlquote
from urllib.parse import urlsplit

import httpx
from rapidfuzz import fuzz

from . import textutil as tu
from .adapters import wikipedia_fetch
from .fetcher import FetchResult, fetch

ARCHIVE_TIMEOUT = 12.0

_SOFT404_TITLE = re.compile(
    r"\b(404|410)\b|page not found|not found|no longer (?:available|exists)|page (?:does not|doesn'?t) exist|"
    r"page (?:has been|was) (?:removed|deleted|moved)|error 404|cannot be found|can'?t be found|could ?n[o']t be found",
    re.I,
)
_SOFT404_BODY = re.compile(
    r"page (?:you (?:are|were) looking for|you requested) (?:could ?n[o']t be found|(?:does not|doesn'?t|no longer) exists?|"
    r"(?:has been|was|may have been) (?:removed|moved|deleted)|cannot be found|is not available)|"
    r"\b404\b[^.]{0,40}(?:not found|error)|page not found|no longer available|this page (?:does not|doesn'?t) exist",
    re.I,
)
_PARKED = re.compile(
    r"(?:this|the) domain (?:name )?(?:is|may be) for sale|buy this domain|domain (?:is )?parked|parked (?:free|domain)|"
    r"sedoparking|hugedomains|dan\.com|afternic|domain for sale|this domain has expired",
    re.I,
)
_CHALLENGE = re.compile(r"just a moment\.\.\.|attention required|cf-chl|challenge-platform|captcha|access denied|are you a robot|enable javascript and cookies", re.I)

STRUCTURED_SOURCES = ("meta[", "json-ld.", "time[", "wikipedia.")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _reg_domain(host: str | None) -> str:
    host = (host or "").lower().rstrip(".")
    parts = host.split(".")
    if len(parts) >= 3 and len(parts[-1]) == 2 and parts[-2] in {"co", "com", "org", "gov", "ac", "net", "edu", "gob", "go"}:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


# ---------------------------------------------------------------- archive.org
async def archive_latest(url: str, client: httpx.AsyncClient | None = None) -> dict[str, Any]:
    """Latest Wayback Machine snapshot (any status) and latest snapshot that returned HTTP 200."""
    out: dict[str, Any] = {"source": "web.archive.org CDX API"}
    own = client is None
    client = client or httpx.AsyncClient(timeout=ARCHIVE_TIMEOUT)
    base = "https://web.archive.org/cdx/search/cdx"
    try:
        async def q(extra: str) -> list[str] | None:
            r = await client.get(f"{base}?url={urlquote(url, safe='')}&output=json&limit=-1&fl=timestamp,original,statuscode{extra}", timeout=ARCHIVE_TIMEOUT)
            if r.status_code != 200:
                raise httpx.HTTPError(f"CDX HTTP {r.status_code}")
            rows = r.json() if r.text.strip() else []
            return rows[1] if len(rows) > 1 else None

        latest, latest_ok = await asyncio.gather(q(""), q("&filter=statuscode:200"), return_exceptions=True)
        for key, row in (("latest", latest), ("latest_ok", latest_ok)):
            if isinstance(row, Exception):
                out[key] = None
                out.setdefault("errors", []).append(f"{key}: {type(row).__name__} {str(row)[:120]}")
            elif row:
                ts, orig, status = row[0], row[1], row[2]
                dt = datetime.strptime(ts, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
                out[key] = {
                    "timestamp": _iso(dt),
                    "status": int(status) if status.isdigit() else None,
                    "url": f"https://web.archive.org/web/{ts}/{orig}",
                    "raw_url": f"https://web.archive.org/web/{ts}id_/{orig}",
                    "age_days": (_now() - dt).days,
                }
            else:
                out[key] = None
        out["available"] = bool(out.get("latest") or out.get("latest_ok"))
        if out.get("errors") and not out["available"]:
            out["available"] = None  # unknown: lookup failed
    except Exception as e:  # noqa: BLE001
        out.update(available=None, error=f"{type(e).__name__}: {str(e)[:200]}")
    finally:
        if own:
            await client.aclose()
    return out


# ------------------------------------------------------- legislation.gov.uk
async def legislation_gov_uk_facts(url: str) -> dict[str, Any] | None:
    """Factual metadata for legislation.gov.uk items (not an in-force verdict)."""
    parts = urlsplit(url)
    if parts.hostname not in ("www.legislation.gov.uk", "legislation.gov.uk"):
        return None
    m = re.match(r"^/([a-z]+)/(\d{4}|[A-Za-z0-9-]+/\d{4})/(\d+)", parts.path)
    if not m:
        return None
    base = f"https://www.legislation.gov.uk/{m.group(1)}/{m.group(2)}/{m.group(3)}"
    r = await fetch(base + "/introduction/data.xml", max_bytes=3_000_000, timeout=15)
    if r.status != 200:
        return {"source": base + "/introduction/data.xml", "error": r.error or f"HTTP {r.status}"}
    x = r.text()

    def g(pat: str) -> str | None:
        mm = re.search(pat, x)
        return mm.group(1).strip() if mm else None

    effects = re.findall(r'<ukm:UnappliedEffect\b[^>]*\bType="([^"]+)"', x)
    return {
        "source": base + "/introduction/data.xml",
        "title": g(r"<dc:title>([^<]+)</dc:title>"),
        "document_status": g(r'<ukm:DocumentStatus Value="([^"]+)"'),
        "revised_text_valid_from": g(r"<dct:valid>([^<]+)</dct:valid>"),
        "metadata_modified": g(r"<dc:modified>([^<]+)</dc:modified>"),
        "outstanding_unapplied_effects": len(effects),
        "unapplied_effect_types_sample": sorted(set(effects))[:10],
        "note": "legislation.gov.uk editorial metadata. Outstanding effects mean the revised text may not yet show all amendments/repeals. This is not a legal in-force determination.",
    }


# -------------------------------------------------------------- URL check
def _collect_dates(fr: FetchResult, soup, text: str | None, pdf_meta: dict | None) -> list[dict[str, Any]]:
    """Gather date candidates from markup (soup must still contain <script> tags), visible text, PDF metadata and headers."""
    cands = tu.extract_date_candidates(soup, None) if soup is not None else []
    cands += tu.extract_date_candidates(None, text) if text else []
    if pdf_meta:
        for k, kind in (("ModDate", "modified"), ("CreationDate", "published")):
            dt = tu.pdf_date(pdf_meta.get(k, ""))
            if dt:
                cands.append({"kind": kind, "source": f"pdf.{k}", "raw": pdf_meta[k][:40], "date": _iso(dt)})
    wrev = fr.headers.get("x-wiki-last-revision")
    if wrev:
        cands.append({"kind": "modified", "source": "wikipedia.last_revision", "raw": wrev, "date": wrev})
    lm = fr.headers.get("last-modified")
    if lm:
        try:
            lm_dt = parsedate_to_datetime(lm)
            if lm_dt.tzinfo is None:
                lm_dt = lm_dt.replace(tzinfo=timezone.utc)
            date_hdr = fr.headers.get("date")
            ref = parsedate_to_datetime(date_hdr) if date_hdr else _now()
            dynamic = abs((ref - lm_dt).total_seconds()) < 300
            cands.append({"kind": "modified", "source": "http.Last-Modified" + (" (generated at request time; ignored)" if dynamic else ""),
                          "raw": lm, "date": _iso(lm_dt)})
        except Exception:
            pass
    seen, out = set(), []
    for c in cands:
        key = (c["source"], c["date"])
        if key not in seen:
            seen.add(key)
            out.append(c)
    return out


def parse_body(fr: FetchResult) -> tuple[Any, str | None, str | None, dict | None]:
    """Return (soup, title, text, pdf_meta)."""
    ct = fr.content_type
    body = fr.body
    if not body:
        return None, None, None, None
    if ct == "application/pdf" or body[:5] == b"%PDF-":
        try:
            text, meta = tu.pdf_to_text(body)
            return None, meta.get("Title"), text, meta
        except Exception:
            return None, None, None, None
    if ct in ("text/html", "application/xhtml+xml", "") or (b"<html" in body[:2000].lower()):
        soup = tu.make_soup(fr.text())
        title = tu.html_title(soup)
        # extract dates before html_to_text strips scripts (json-ld lives in <script>)
        return soup, title, None, None
    if ct.startswith("text/") or ct in ("application/json", "application/xml", "application/csv"):
        return None, None, re.sub(r"\s+", " ", fr.text()).strip(), None
    return None, None, None, None


async def check_url(url: str, *, stale_after_days: int = 365, include_archive: bool = True, max_bytes: int = 2_000_000) -> dict[str, Any]:
    t0 = time.monotonic()
    wiki_task = asyncio.create_task(wikipedia_fetch(url, max_bytes))
    arch_task = asyncio.create_task(archive_latest(url)) if include_archive else None
    leg_task = asyncio.create_task(legislation_gov_uk_facts(url))

    wiki = None
    try:
        wiki = await wiki_task
    except Exception:  # noqa: BLE001
        wiki = None
    if wiki:
        fr, wiki_info = wiki
    else:
        wiki_info = None
        fr = await fetch(url, max_bytes=max_bytes)
    if not wiki and fr.error in ("timeout", "connect_error") or (fr.status is not None and fr.status >= 500):
        await asyncio.sleep(1.0)
        retry = await fetch(url, max_bytes=max_bytes)
        if retry.status is not None and (fr.status is None or retry.status < fr.status):
            fr = retry
    soup, title, text, pdf_meta = parse_body(fr)
    if soup is not None:
        structured = _collect_dates(fr, soup, None, None)
        text = tu.html_to_text(soup)  # strips scripts, so collect structured dates first
        dates = _pick_from(structured + _collect_dates(FetchResult(requested_url=url), None, text, None), is_html=True)
    else:
        dates = _pick_from(_collect_dates(fr, None, text, pdf_meta))

    evidence: list[str] = []
    verdict = "live"
    reachable = fr.status is not None
    final = fr.final_url or (fr.hops[-1].url if fr.hops else url)
    req_parts, fin_parts = urlsplit(url), urlsplit(final)

    if fr.error == "blocked_target":
        verdict = "invalid_target"
        evidence.append(f"refused: {fr.error_detail}")
    elif fr.error == "dns_error":
        verdict = "dead"
        evidence.append(f"DNS lookup failed for {req_parts.hostname if not fr.hops else urlsplit(fr.hops[-1].url).hostname} ({fr.error_detail})")
    elif fr.error in ("connect_error", "timeout", "tls_error", "http_error", "too_many_redirects"):
        verdict = "unreachable"
        evidence.append(f"{fr.error}: {fr.error_detail} (retried once)")
    elif fr.status in (404, 410):
        verdict = "dead"
        evidence.append(f"HTTP {fr.status} {'Gone' if fr.status == 410 else 'Not Found'}")
    elif fr.status in (401, 403, 429, 451) or (fr.status == 503 and text and _CHALLENGE.search((title or "") + " " + text[:3000])):
        verdict = "blocked"
        evidence.append(f"HTTP {fr.status}: access denied / bot protection / rate limit; liveness inconclusive")
        if text and _CHALLENGE.search((title or "") + " " + text[:3000]):
            evidence.append("bot-challenge page detected")
    elif fr.status is not None and fr.status >= 500:
        verdict = "unreachable"
        evidence.append(f"HTTP {fr.status} server error (retried once)")
    elif fr.status is not None and fr.status >= 400:
        verdict = "dead"
        evidence.append(f"HTTP {fr.status}")
    else:
        snippet = (text or "")[:4000]
        if title and _SOFT404_TITLE.search(title):
            verdict = "soft_404"
            evidence.append(f"HTTP {fr.status} but page title says: '{title[:120]}'")
        elif text is not None and len(text) < 6000 and _SOFT404_BODY.search(snippet):
            verdict = "soft_404"
            m = _SOFT404_BODY.search(snippet)
            evidence.append(f"HTTP {fr.status} but page text says: '{m.group(0)[:120]}'")
        elif _PARKED.search((title or "") + " " + snippet):
            verdict = "parked"
            evidence.append("domain-parking / for-sale page detected")
        elif fr.status and 200 <= fr.status < 300 and _CHALLENGE.search((title or "")) and len(text or "") < 3000:
            verdict = "blocked"
            evidence.append(f"bot-challenge page served with HTTP {fr.status}; content not visible")
        elif fr.status == 202 or (soup is not None and len(text or "") < 40 and not title
                                  and b"<script" in fr.body.lower() and b"ld+json" not in fr.body.lower()):
            verdict = "blocked"
            evidence.append(f"HTTP {fr.status} with an empty page (likely a JavaScript/WAF challenge); content not visible, liveness inconclusive")
        elif len(req_parts.path.strip("/")) > 0 and fin_parts.path.strip("/") in ("", "en", "en-us", "en-gb", "index.html", "home") and len(fr.hops) > 1:
            verdict = "moved_to_homepage"
            evidence.append(f"deep link redirected to site root {final}; original content likely removed")
        else:
            evidence.append(f"HTTP {fr.status} after {len(fr.hops) - 1} redirect(s)")
    if len(fr.hops) > 1:
        if _reg_domain(req_parts.hostname) != _reg_domain(fin_parts.hostname):
            evidence.append(f"redirected to a different domain: {fin_parts.hostname}")
            if verdict == "live":
                verdict = "redirected_cross_domain"
        elif req_parts.path.rstrip("/") != fin_parts.path.rstrip("/"):
            evidence.append(f"redirected to a different path: {fin_parts.path or '/'}")

    freshness = "unknown"
    lu = dates.get("last_updated")
    if lu:
        freshness = "stale" if lu["age_days"] > stale_after_days else "fresh"
        evidence.append(f"last updated {lu['date'][:10]} ({lu['age_days']} days ago, source {lu['source']}, confidence {lu['confidence']})")
    elif dates.get("published"):
        p = dates["published"]
        evidence.append(f"no update date found; published {p['date'][:10]} ({p['age_days']} days ago)")
        if p["age_days"] > stale_after_days:
            freshness = "possibly_stale"
    elif dates.get("copyright_year"):
        cy = dates["copyright_year"]
        evidence.append(f"no update date found; newest copyright year {cy} (weak signal)")
        if _now().year - cy >= 2:
            freshness = "possibly_stale"
    if verdict == "live" and freshness == "stale":
        verdict = "live_stale"

    leg = None
    try:
        leg = await asyncio.wait_for(leg_task, timeout=15)
    except Exception:
        leg = None
    if leg and isinstance(leg.get("outstanding_unapplied_effects"), int) and leg["outstanding_unapplied_effects"] > 0:
        evidence.append(f"legislation.gov.uk lists {leg['outstanding_unapplied_effects']} outstanding effect(s) not yet applied to the revised text")

    archive = None
    if arch_task:
        try:
            archive = await asyncio.wait_for(arch_task, timeout=ARCHIVE_TIMEOUT + 2)
        except Exception as e:  # noqa: BLE001
            archive = {"available": None, "error": f"{type(e).__name__}"}
        if archive.get("latest_ok"):
            evidence.append(f"latest good archive.org snapshot {archive['latest_ok']['timestamp'][:10]}")
        elif archive.get("available") is False:
            evidence.append("no archive.org snapshot exists")

    usable = {"live": True, "live_stale": True, "blocked": None, "unreachable": None, "redirected_cross_domain": None}.get(verdict, False)
    action = {
        "live": "OK to cite.",
        "live_stale": f"Reachable but last updated more than {stale_after_days} days ago; check for a newer source.",
        "blocked": "Site blocked automated access; verify manually or cite an archived copy.",
        "unreachable": "Temporarily unreachable; retry later or cite an archived copy.",
        "invalid_target": "Not a public http(s) URL.",
        "redirected_cross_domain": "Now redirects to another domain; confirm the destination still holds the cited content (rebrand vs. replacement).",
    }.get(verdict, "Link is dead or content removed; replace it or cite the archived snapshot.")
    if not usable and archive and archive.get("latest_ok"):
        action += f" Archived copy: {archive['latest_ok']['url']}"

    out = {
        "url": url,
        "verdict": verdict,
        "freshness": freshness,
        "usable_as_citation": usable,
        "recommended_action": action,
        "evidence": evidence,
        "http": {
            "reachable": reachable,
            "status": fr.status,
            "final_url": fr.final_url,
            "redirect_chain": [{"url": h.url, "status": h.status} for h in fr.hops],
            "content_type": fr.content_type or None,
            "content_length_read": len(fr.body),
            "error": fr.error,
            "error_detail": fr.error_detail,
            "etag": fr.headers.get("etag"),
            "last_modified_header": fr.headers.get("last-modified"),
            "elapsed_ms": fr.elapsed_ms,
        },
        "page": {"title": title, "text_chars": len(text) if text else 0},
        "dates": {k: v for k, v in dates.items() if k != "candidates"} | {"candidates": dates["candidates"][:10]},
        "archive": archive,
        "checked_at": _iso(_now()),
        "took_ms": int((time.monotonic() - t0) * 1000),
    }
    if leg:
        out["legislation_gov_uk"] = leg
    if wiki_info:
        out["wikipedia"] = wiki_info
    # stash for citation check (not serialised)
    out["_text"] = text
    return out


def _pick_from(cands: list[dict], is_html: bool = False) -> dict:
    def pick(pred):
        group = [c for c in cands if pred(c)]
        return max(group, key=lambda c: c["date"]) if group else None

    best = (
        pick(lambda c: c["kind"] == "modified" and c["source"].startswith(STRUCTURED_SOURCES + ("pdf.",)))
        or pick(lambda c: c["kind"] == "modified" and re.match(r"text\['(page )?last ", c["source"]))
        or pick(lambda c: c["kind"] == "modified" and c["source"].startswith("text["))
        or pick(lambda c: c["source"] == "http.Last-Modified")
    )
    published = pick(lambda c: c["kind"] == "published")
    copyright_ = pick(lambda c: c["kind"] == "copyright")
    result: dict[str, Any] = {"last_updated": None, "published": None, "copyright_year": None, "candidates": cands[:25]}
    if best:
        dt = datetime.fromisoformat(best["date"].replace("Z", "+00:00"))
        conf = "high" if best["source"].startswith(STRUCTURED_SOURCES + ("pdf.",)) else ("medium" if best["source"].startswith(("text['last", "text['page", "http.")) else "low")
        if best["source"] == "http.Last-Modified" and is_html:
            conf = "low"  # on HTML pages this header often reflects the CMS/CDN render time, not a content change
        result["last_updated"] = {"date": best["date"], "source": best["source"], "raw": best["raw"], "confidence": conf, "age_days": (_now() - dt).days}
    if published:
        dt = datetime.fromisoformat(published["date"].replace("Z", "+00:00"))
        result["published"] = {"date": published["date"], "source": published["source"], "age_days": (_now() - dt).days}
    if copyright_:
        result["copyright_year"] = int(copyright_["date"][:4])
    return result


# ---------------------------------------------------------- citation check
STOPWORDS = set("""a an the and or but if of to in on at by for with from as is are was were be been being this that these those it its
into than then there their they them we you he she his her our your not no nor so such can could would should may might will shall
do does did has have had which who whom whose what when where why how all any both each few more most other some same own only very
also just about over under after before between through during per via""".split())
_NUM_RE = re.compile(r"(?<![\w.])[-+]?\d[\d,]*(?:\.\d+)?%?")
_WORD_RE = re.compile(r"[a-z][a-z'\-]{2,}")
_SENT_SPLIT = re.compile(r"(?<=[.!?;])\s+(?=[A-Z0-9\"'(\[])")


def _norm_num(s: str) -> str:
    s = s.replace(",", "").rstrip("%")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s.lstrip("+")


def _stem(w: str) -> str:
    w = w.strip("'-")
    for suf in ("ations", "ation", "ingly", "ings", "ing", "edly", "ies", "ied", "ers", "est", "ed", "es", "ly", "s"):
        if len(w) > len(suf) + 3 and w.endswith(suf):
            return w[: -len(suf)]
    return w


def _snippet(text: str, start: int, end: int, ctx: int = 160) -> str:
    a, b = max(0, start - ctx), min(len(text), end + ctx)
    return ("…" if a > 0 else "") + text[a:b] + ("…" if b < len(text) else "")


def match_quote(quote: str, text: str) -> dict[str, Any]:
    nq, nt = tu.normalize(quote), tu.normalize(text)
    lq, lt = nq.lower(), nt.lower()
    if not lq:
        return {"match": "not_checked"}
    same_len = len(lt) == len(nt)
    idx = lt.find(lq)
    if idx >= 0:
        src = nt if same_len else lt
        return {"match": "exact", "score": 100.0, "occurrences": lt.count(lq), "snippet": _snippet(src, idx, idx + len(lq)),
                "matched_text": src[idx: idx + len(lq)], "position": round(idx / max(1, len(lt)), 4)}
    # fuzzy: punctuation/whitespace-insensitive pass, then edit-distance alignment
    strip = lambda s: re.sub(r"[^\w]+", " ", s).strip()  # noqa: E731
    if strip(lq) and strip(lq) in strip(lt):
        sl, st = strip(lq), strip(lt)
        i = st.find(sl)
        return {"match": "exact_ignoring_punctuation", "score": 99.0, "snippet": _snippet(st, i, i + len(sl)), "matched_text": st[i:i + len(sl)],
                "position": round(i / max(1, len(st)), 4)}
    hay = lt[:3_000_000]
    al = fuzz.partial_ratio_alignment(lq, hay, score_cutoff=0)
    score = round(al.score, 1) if al else 0.0
    if al and score >= 60:
        src = nt if same_len else lt
        # widen to the window the alignment covered
        s0, s1 = al.dest_start, al.dest_end
        while s0 > 0 and not src[s0 - 1].isspace() and s0 > al.dest_start - 30:
            s0 -= 1
        while s1 < len(src) and not src[s1].isspace() and s1 < al.dest_end + 30:
            s1 += 1
        match = "fuzzy" if score >= 90 else ("partial" if score >= 75 else "weak")
        return {"match": match, "score": score, "snippet": _snippet(src, s0, s1), "matched_text": src[s0:s1],
                "position": round(s0 / max(1, len(lt)), 4)}
    return {"match": "not_found", "score": score}


def match_claim(claim: str, text: str) -> dict[str, Any]:
    """Lexical support check: key terms + every number in the claim, best supporting passage."""
    nc, nt = tu.normalize(claim), tu.normalize(text)
    nums = sorted({_norm_num(n) for n in _NUM_RE.findall(nc) if _norm_num(n)})
    text_nums = {_norm_num(n) for n in _NUM_RE.findall(nt)}
    words = [w for w in _WORD_RE.findall(nc.lower()) if w not in STOPWORDS]
    stems = sorted({_stem(w) for w in words})
    sents = []
    for sent in _SENT_SPLIT.split(nt):
        sent = sent.strip()
        while len(sent) > 300:  # break run-on text (menus, tables) into ~300-char pieces at a space
            cut = sent.rfind(" ", 150, 300)
            cut = cut if cut > 0 else 300
            sents.append(sent[:cut])
            sent = sent[cut:].strip()
        if sent:
            sents.append(sent)
    best = (0.0, -1, "")
    if stems or nums:
        for i in range(len(sents)):
            window = " ".join(sents[i:i + 2])
            wl = window.lower()
            wstems = {_stem(w) for w in _WORD_RE.findall(wl)}
            wnums = {_norm_num(n) for n in _NUM_RE.findall(window)}
            hit_w = sum(1 for s in stems if s in wstems)
            hit_n = sum(1 for n in nums if n in wnums)
            denom = len(stems) + 2 * len(nums)
            score = (hit_w + 2 * hit_n) / denom if denom else 0.0
            if score > best[0]:
                best = (score, i, window)
            if i > 20000:
                break
    found_nums = [n for n in nums if n in text_nums]
    missing_nums = [n for n in nums if n not in text_nums]
    all_stems = {_stem(w) for w in _WORD_RE.findall(nt.lower())}
    term_cov = round(sum(1 for s in stems if s in all_stems) / len(stems), 3) if stems else None
    cov = round(best[0], 3)
    if cov >= 0.8 and not missing_nums:
        verdict = "supported_lexically"
    elif cov >= 0.5:
        verdict = "partially_supported_lexically"
    else:
        verdict = "not_found"
    if missing_nums and verdict == "supported_lexically":
        verdict = "partially_supported_lexically"
    return {
        "verdict": verdict,
        "best_passage": best[2][:1200] if best[1] >= 0 else None,
        "best_passage_coverage": cov,
        "page_term_coverage": term_cov,
        "numbers_in_claim": nums,
        "numbers_found_on_page": found_nums,
        "numbers_missing_from_page": missing_nums,
        "method": "lexical: share of the claim's key terms and numbers found within a 2-sentence (max ~600 char) window. This is not semantic entailment; a negated or reworded claim can still score high.",
    }


async def _archived_text(raw_url: str) -> str | None:
    fr = await fetch(raw_url, max_bytes=8_000_000, timeout=20)
    if fr.status != 200:
        return None
    soup, _t, text, _m = parse_body(fr)
    if soup is not None:
        text = tu.html_to_text(soup)
    return text


async def check_citation(url: str, quote: str | None, claim: str | None, *, stale_after_days: int = 365,
                         check_archive_if_missing: bool = True) -> dict[str, Any]:
    t0 = time.monotonic()
    # citation pages are fetched with a larger cap so long reports / PDFs can be searched
    url_result = await check_url(url, stale_after_days=stale_after_days, max_bytes=10_000_000)
    text = url_result.pop("_text", None)
    if url_result["verdict"] not in ("live", "live_stale", "redirected_cross_domain"):
        text = None  # error pages, soft-404s, parked pages and homepages are not the cited content
    out: dict[str, Any] = {"url": url, "quote": quote, "claim": claim}
    live_q = match_quote(quote, text) if (quote and text) else None
    live_c = match_claim(claim, text) if (claim and text) else None

    found_live = (live_q and live_q["match"] in ("exact", "exact_ignoring_punctuation", "fuzzy")) or (
        live_c and live_c["verdict"] == "supported_lexically")
    archived = None
    arch = url_result.get("archive") or {}
    snap = arch.get("latest_ok")
    if check_archive_if_missing and not found_live and snap:
        atext = await _archived_text(snap["raw_url"])
        if atext:
            archived = {"snapshot": snap["url"], "snapshot_date": snap["timestamp"]}
            if quote:
                archived["quote"] = match_quote(quote, atext)
            if claim:
                archived["claim"] = match_claim(claim, atext)
        else:
            archived = {"snapshot": snap["url"], "error": "could not read archived snapshot"}

    # overall verdict
    def q_ok(m):
        return m and m.get("match") in ("exact", "exact_ignoring_punctuation", "fuzzy")

    def c_ok(m):
        return m and m.get("verdict") == "supported_lexically"

    def weak(m):
        return m and (m.get("match") in ("partial",) or m.get("verdict") == "partially_supported_lexically")

    if text is None:
        verdict = "page_unreadable" if url_result["verdict"] in ("live", "live_stale", "redirected_cross_domain") else "page_unavailable"
    elif (quote and q_ok(live_q)) or (not quote and c_ok(live_c)):
        verdict = "verified"
    elif weak(live_q) or weak(live_c):
        verdict = "partially_matched"
    else:
        verdict = "not_found_on_page"
    if verdict != "verified" and archived and (q_ok(archived.get("quote")) or (not quote and c_ok(archived.get("claim")))):
        verdict = "only_in_archive" if text is not None else "page_unavailable_but_in_archive"

    explain = {
        "verified": "The quoted text (or all key terms and numbers of the claim) appears on the live page.",
        "partially_matched": "Only a partial / approximate match was found; the wording may have changed or been paraphrased.",
        "not_found_on_page": "The quote/claim was not found on the live page.",
        "only_in_archive": "Not on the live page, but present in the latest archive.org snapshot; the source content has probably changed.",
        "page_unavailable_but_in_archive": "Live page unavailable; the text is present in the latest archive.org snapshot.",
        "page_unavailable": "The page could not be fetched; see url_check for why.",
        "page_unreadable": "The page loaded but no text could be extracted (e.g. JavaScript-only page or unsupported format).",
    }[verdict]

    out.update({
        "verdict": verdict,
        "explanation": explain,
        "quote_match": live_q,
        "claim_match": live_c,
        "archive_comparison": archived,
        "url_check": url_result,
        "took_ms": int((time.monotonic() - t0) * 1000),
    })
    return out
