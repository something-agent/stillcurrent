"""HTML/PDF text extraction and date detection."""
from __future__ import annotations

import io
import json
import re
import unicodedata
import warnings
from datetime import datetime, timezone
from typing import Any

from bs4 import BeautifulSoup, XMLParsedAsHTMLWarning
from dateutil import parser as dateparser

warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)

MIN_YEAR = 1990

MODIFIED_META = {
    "article:modified_time", "og:updated_time", "last-modified", "lastmod", "dcterms.modified",
    "dc.date.modified", "dc.modified", "modified", "revised", "dc.date.updated", "updated",
    "date-modified", "article.updated", "parsely-pub-date-modified",
}
PUBLISHED_META = {
    "article:published_time", "og:published_time", "date", "dcterms.date", "dc.date", "dcterms.created",
    "dc.date.issued", "dcterms.issued", "citation_publication_date", "citation_date",
    "citation_online_date", "pubdate", "publish-date", "publication_date", "sailthru.date",
}

_MONTHS = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
_DATE_PAT = (
    r"(?P<date>"
    r"\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?"
    rf"|\d{{1,2}}(?:st|nd|rd|th)?\s+{_MONTHS}\.?,?\s+\d{{4}}"
    rf"|{_MONTHS}\.?\s+\d{{1,2}}(?:st|nd|rd|th)?,?\s+\d{{4}}"
    r"|\d{1,2}/\d{1,2}/\d{4}"
    r"|\d{1,2}\.\d{1,2}\.\d{4}"
    rf"|{_MONTHS}\.?\s+\d{{4}}"
    r")"
)
_UPDATED_TEXT_RE = re.compile(
    r"(?P<label>(?:page\s+)?last\s+(?:updated|modified|revised|reviewed|edited|changed)(?:\s+date)?(?:\s+on)?"
    r"|(?:updated|modified|revised|reviewed)(?:\s+on)?|as\s+of|current\s+as\s+of|data\s+as\s+of)"
    r"\s*[:\-–—]?\s*" + _DATE_PAT,
    re.IGNORECASE,
)
_COPYRIGHT_RE = re.compile(r"(?:©|&copy;|\(c\)|copyright)\s*(?:\d{4}\s*[-–]\s*)?(?P<year>(?:19|20)\d{2})", re.IGNORECASE)


def parse_date(s: str, *, dayfirst: bool | None = None) -> datetime | None:
    s = (s or "").strip()
    if not s or len(s) > 64:
        return None
    try:
        if dayfirst is None:
            dayfirst = bool(re.match(r"^\d{1,2}\.\d{1,2}\.\d{4}$", s))
        dt = dateparser.parse(s, dayfirst=dayfirst, default=datetime(2000, 1, 1))
    except (ValueError, OverflowError, TypeError):
        return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    if dt.year < MIN_YEAR or (dt - now).days > 1:
        return None
    return dt


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def make_soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "html.parser")


def html_title(soup: BeautifulSoup) -> str | None:
    if soup.title and soup.title.string:
        return " ".join(soup.title.string.split())[:300]
    return None


def html_to_text(soup: BeautifulSoup) -> str:
    for tag in soup(["script", "style", "noscript", "template", "svg"]):
        tag.decompose()
    text = soup.get_text(" ")
    return re.sub(r"\s+", " ", text).strip()


def pdf_to_text(data: bytes, max_pages: int = 300) -> tuple[str, dict[str, Any]]:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    meta: dict[str, Any] = {}
    try:
        info = reader.metadata or {}
        for k in ("/ModDate", "/CreationDate", "/Title"):
            if info.get(k):
                meta[k.strip("/")] = str(info.get(k))
    except Exception:
        pass
    parts = []
    for i, page in enumerate(reader.pages):
        if i >= max_pages:
            break
        try:
            parts.append(page.extract_text() or "")
        except Exception:
            continue
    return re.sub(r"\s+", " ", " ".join(parts)).strip(), meta


def pdf_date(s: str) -> datetime | None:
    m = re.match(r"D:(\d{4})(\d{2})?(\d{2})?", s or "")
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2) or 1), int(m.group(3) or 1)
    try:
        dt = datetime(y, mo, d, tzinfo=timezone.utc)
    except ValueError:
        return None
    return dt if MIN_YEAR <= dt.year and dt <= datetime.now(timezone.utc) else None


def _walk_jsonld(obj: Any, out: list[tuple[str, str]]) -> None:
    if isinstance(obj, dict):
        for k in ("dateModified", "datePublished", "dateCreated", "uploadDate"):
            v = obj.get(k)
            if isinstance(v, str):
                out.append((k, v))
        for v in obj.values():
            if isinstance(v, (dict, list)):
                _walk_jsonld(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _walk_jsonld(v, out)


def extract_date_candidates(soup: BeautifulSoup | None, text: str | None) -> list[dict[str, Any]]:
    """Return candidate dates: {kind: modified|published|copyright, source, raw, date}."""
    cands: list[dict[str, Any]] = []

    def add(kind: str, source: str, raw: str, dt: datetime | None) -> None:
        if dt is not None:
            cands.append({"kind": kind, "source": source, "raw": raw[:80], "date": _iso(dt)})

    if soup is not None:
        for m in soup.find_all("meta"):
            key = (m.get("property") or m.get("name") or m.get("itemprop") or m.get("http-equiv") or "").strip().lower()
            content = m.get("content")
            if not key or not content:
                continue
            if key in MODIFIED_META or key == "datemodified":
                add("modified", f"meta[{key}]", content, parse_date(content))
            elif key in PUBLISHED_META or key == "datepublished":
                add("published", f"meta[{key}]", content, parse_date(content))
        for s in soup.find_all("script", attrs={"type": "application/ld+json"}):
            try:
                data = json.loads(s.string or "")
            except Exception:
                continue
            found: list[tuple[str, str]] = []
            _walk_jsonld(data, found)
            for k, v in found[:20]:
                add("modified" if k == "dateModified" else "published", f"json-ld.{k}", v, parse_date(v))
        for t in soup.find_all("time"):
            attrs = " ".join([*(t.get("class") or []), t.get("itemprop") or "", t.get("id") or ""]).lower()
            dtv = t.get("datetime") or t.get_text(" ", strip=True)
            if any(w in attrs for w in ("updated", "modified", "revised")):
                add("modified", "time[updated]", dtv, parse_date(dtv))
            elif any(w in attrs for w in ("published", "pubdate", "datepublished")):
                add("published", "time[published]", dtv, parse_date(dtv))

    if text:
        seen = 0
        for m in _UPDATED_TEXT_RE.finditer(text[:2_000_000]):
            raw = m.group("date")
            label = " ".join(m.group("label").lower().split())
            add("modified", f"text['{label}']", m.group(0), parse_date(raw))
            seen += 1
            if seen >= 10:
                break
        years = [int(m.group("year")) for m in _COPYRIGHT_RE.finditer(text[-20000:] + " " + text[:5000])]
        years = [y for y in years if MIN_YEAR <= y <= datetime.now(timezone.utc).year]
        if years:
            y = max(years)
            cands.append({"kind": "copyright", "source": "copyright notice", "raw": f"© {y}", "date": f"{y}-01-01T00:00:00Z"})
    return cands


# ---------- text normalisation for quote matching ----------
_TRANS = str.maketrans({
    "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'", "\u2032": "'",
    "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u201f": '"', "\u2033": '"',
    "\u2013": "-", "\u2014": "-", "\u2212": "-", "\u2010": "-", "\u2011": "-",
    "\u00a0": " ", "\u2009": " ", "\u202f": " ", "\u200b": "", "\u00ad": "",
    "\u2026": "...",
})


def normalize(s: str) -> str:
    s = unicodedata.normalize("NFKC", s).translate(_TRANS)
    return re.sub(r"\s+", " ", s).strip()
