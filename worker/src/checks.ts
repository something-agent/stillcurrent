/** Core check logic: URL liveness/freshness and citation/quote verification (port of the Python app/checks.py). */
import type { Settings } from "./config";
import { contentType, emptyResult, safeFetch, textOf, type FetchResult } from "./fetcher";
import * as tu from "./textutil";

export const ARCHIVE_TIMEOUT_MS = 12_000;

const SOFT404_TITLE = /\b(404|410)\b|page not found|not found|no longer (?:available|exists)|page (?:does not|doesn'?t) exist|page (?:has been|was) (?:removed|deleted|moved)|error 404|cannot be found|can'?t be found|could ?n[o']t be found/i;
const SOFT404_BODY = /page (?:you (?:are|were) looking for|you requested) (?:could ?n[o']t be found|(?:does not|doesn'?t|no longer) exists?|(?:has been|was|may have been) (?:removed|moved|deleted)|cannot be found|is not available)|\b404\b[^.]{0,40}(?:not found|error)|page not found|no longer available|this page (?:does not|doesn'?t) exist/i;
const PARKED = /(?:this|the) domain (?:name )?(?:is|may be) for sale|buy this domain|domain (?:is )?parked|parked (?:free|domain)|sedoparking|hugedomains|dan\.com|afternic|domain for sale|this domain has expired/i;
const CHALLENGE = /just a moment\.\.\.|attention required|cf-chl|challenge-platform|captcha|access denied|are you a robot|enable javascript and cookies/i;

const STRUCTURED_SOURCES = ["meta[", "json-ld.", "time[", "wikipedia."];
const startsWithAny = (s: string, pre: string[]) => pre.some((p) => s.startsWith(p));
const ageDays = (iso: string, now: Date) => Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function regDomain(host: string | null | undefined): string {
  const h = (host || "").toLowerCase().replace(/\.$/, "");
  const parts = h.split(".");
  if (parts.length >= 3 && parts[parts.length - 1].length === 2 && ["co", "com", "org", "gov", "ac", "net", "edu", "gob", "go"].includes(parts[parts.length - 2]))
    return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

function hostOf(u: string): string {
  try { return new URL(u).hostname; } catch { return ""; }
}
function pathOf(u: string): string {
  try { return new URL(u).pathname; } catch { return ""; }
}
const stripSlashes = (s: string) => s.replace(/^\/+|\/+$/g, "");

// ---------------------------------------------------------------- archive.org
export async function archiveLatest(url: string, settings: Settings, now = new Date()): Promise<Record<string, any>> {
  const out: Record<string, any> = { source: "web.archive.org CDX API" };
  const base = "https://web.archive.org/cdx/search/cdx";
  const q = async (extra: string): Promise<string[] | null> => {
    const r = await fetch(`${base}?url=${encodeURIComponent(url)}&output=json&limit=-1&fl=timestamp,original,statuscode${extra}`, {
      headers: { "User-Agent": settings.userAgent }, signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
    });
    if (r.status !== 200) { try { await r.body?.cancel(); } catch { /* */ } throw new Error(`CDX HTTP ${r.status}`); }
    const t = (await r.text()).trim();
    const rows = t ? JSON.parse(t) : [];
    return rows.length > 1 ? rows[1] : null;
  };
  try {
    const settled = await Promise.allSettled([q(""), q("&filter=statuscode:200")]);
    (["latest", "latest_ok"] as const).forEach((key, i) => {
      const s = settled[i];
      if (s.status === "rejected") {
        out[key] = null;
        (out.errors ||= []).push(`${key}: ${(s.reason as Error)?.name || "Error"} ${String((s.reason as Error)?.message || s.reason).slice(0, 120)}`);
      } else if (s.value) {
        const [ts, orig, status] = s.value;
        const dt = new Date(Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10) || 0, +ts.slice(10, 12) || 0, +ts.slice(12, 14) || 0));
        out[key] = {
          timestamp: tu.iso(dt),
          status: /^\d+$/.test(status) ? parseInt(status, 10) : null,
          url: `https://web.archive.org/web/${ts}/${orig}`,
          raw_url: `https://web.archive.org/web/${ts}id_/${orig}`,
          age_days: Math.floor((now.getTime() - dt.getTime()) / 86_400_000),
        };
      } else {
        out[key] = null;
      }
    });
    out.available = Boolean(out.latest || out.latest_ok);
    if (out.errors && !out.available) out.available = null; // unknown: lookup failed
  } catch (e) {
    out.available = null;
    out.error = `${(e as Error).name}: ${String((e as Error).message).slice(0, 200)}`;
  }
  return out;
}

// ------------------------------------------------------- legislation.gov.uk
export async function legislationGovUkFacts(url: string, settings: Settings): Promise<Record<string, any> | null> {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.hostname !== "www.legislation.gov.uk" && u.hostname !== "legislation.gov.uk") return null;
  const m = u.pathname.match(/^\/([a-z]+)\/(\d{4}|[A-Za-z0-9-]+\/\d{4})\/(\d+)/);
  if (!m) return null;
  const base = `https://www.legislation.gov.uk/${m[1]}/${m[2]}/${m[3]}`;
  const r = await safeFetch(base + "/introduction/data.xml", settings, { maxBytes: 3_000_000, timeoutMs: 15_000 });
  if (r.status !== 200) return { source: base + "/introduction/data.xml", error: r.error || `HTTP ${r.status}` };
  const x = textOf(r);
  const g = (re: RegExp) => { const mm = x.match(re); return mm ? mm[1].trim() : null; };
  const effects = [...x.matchAll(/<ukm:UnappliedEffect\b[^>]*\bType="([^"]+)"/g)].map((mm) => mm[1]);
  return {
    source: base + "/introduction/data.xml",
    title: g(/<dc:title>([^<]+)<\/dc:title>/),
    document_status: g(/<ukm:DocumentStatus Value="([^"]+)"/),
    revised_text_valid_from: g(/<dct:valid>([^<]+)<\/dct:valid>/),
    metadata_modified: g(/<dc:modified>([^<]+)<\/dc:modified>/),
    outstanding_unapplied_effects: effects.length,
    unapplied_effect_types_sample: [...new Set(effects)].sort().slice(0, 10),
    note: "legislation.gov.uk editorial metadata. Outstanding effects mean the revised text may not yet show all amendments/repeals. This is not a legal in-force determination.",
  };
}

// ---------------------------------------------------------------- Wikipedia
const WIKI_HOST = /^(?<lang>[a-z-]{2,12})(?:\.m)?\.wikipedia\.org$/;

export function wikipediaTitle(url: string): [string, string] | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const m = u.hostname.match(WIKI_HOST);
  if (!m || !u.pathname.startsWith("/wiki/")) return null;
  let title: string;
  try { title = decodeURIComponent(u.pathname.slice(6)); } catch { title = u.pathname.slice(6); }
  if (!title) return null;
  return [m.groups!.lang, title];
}

/** Fetch a Wikipedia article through the MediaWiki Action + REST APIs (Wikimedia blocks generic HTTP clients). */
export async function wikipediaFetch(url: string, maxBytes: number, settings: Settings): Promise<[FetchResult, Record<string, any>] | null> {
  const wt = wikipediaTitle(url);
  if (!wt) return null;
  const [lang, title] = wt;
  const base = `https://${lang}.wikipedia.org`;
  const api = `${base}/w/api.php?action=query&prop=revisions%7Cinfo&rvprop=timestamp%7Cids&inprop=url&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(title)}`;
  const metaR = await safeFetch(api, settings, { maxBytes: 500_000, timeoutMs: 12_000, accept: "application/json" });
  if (metaR.status !== 200) return null;
  let data: any, page: any;
  try {
    data = JSON.parse(textOf(metaR));
    page = data.query.pages[0];
  } catch {
    return null;
  }
  const info: Record<string, any> = { source: "MediaWiki Action API", api_url: api };
  const redirects = data.query.redirects || [];
  if (redirects.length) info.redirected_to_title = redirects[redirects.length - 1].to;
  const res = emptyResult(url);
  if (page.missing || page.invalid) {
    info.exists = false;
    res.status = 404;
    res.finalUrl = url;
    res.hops = [{ url, status: 404 }];
    return [res, info];
  }
  const rev = (page.revisions || [{}])[0];
  const encTitle = (t: string) => encodeURIComponent(t.replace(/ /g, "_")).replace(/%2F/g, "/");
  Object.assign(info, {
    exists: true,
    title: page.title,
    last_revision_timestamp: rev.timestamp,
    last_revision_id: rev.revid,
    permanent_link: rev.revid ? `${base}/w/index.php?title=${encTitle(page.title || "")}&oldid=${rev.revid}` : null,
  });
  const htmlUrl = `${base}/w/rest.php/v1/page/${encodeURIComponent(page.title.replace(/ /g, "_"))}/html`;
  const htmlR = await safeFetch(htmlUrl, settings, { maxBytes, timeoutMs: 15_000, accept: "text/html" });
  const final = page.fullurl || url;
  if (htmlR.status === 200) {
    htmlR.requestedUrl = url;
    htmlR.finalUrl = final;
    htmlR.hops = redirects.length ? [{ url, status: 301 }, { url: final, status: 200 }] : [{ url, status: 200 }];
    htmlR.headers["x-wiki-last-revision"] = rev.timestamp || "";
    return [htmlR, info];
  }
  res.status = htmlR.status;
  res.finalUrl = final;
  res.hops = [{ url, status: htmlR.status }];
  res.error = htmlR.error;
  res.errorDetail = htmlR.errorDetail;
  return [res, info];
}

// -------------------------------------------------------------- URL check
interface Parsed {
  html: tu.ParsedHtml | null;
  title: string | null;
  text: string | null;
  pdfMeta: Record<string, string> | null;
}

export async function parseBody(fr: FetchResult): Promise<Parsed> {
  const ct = contentType(fr);
  const body = fr.body;
  if (!body.byteLength) return { html: null, title: null, text: null, pdfMeta: null };
  const head = tu.latin1Decode(body.subarray(0, 2000));
  if (ct === "application/pdf" || head.startsWith("%PDF-")) {
    try {
      const { text, meta } = await tu.pdfExtract(body);
      return { html: null, title: meta["Title"] || null, text, pdfMeta: meta };
    } catch {
      return { html: null, title: null, text: null, pdfMeta: null };
    }
  }
  if (["text/html", "application/xhtml+xml", ""].includes(ct) || head.toLowerCase().includes("<html")) {
    const html = tu.parseHtml(textOf(fr));
    return { html, title: html.title, text: null, pdfMeta: null };
  }
  if (ct.startsWith("text/") || ["application/json", "application/xml", "application/csv"].includes(ct)) {
    return { html: null, title: null, text: textOf(fr).replace(/\s+/g, " ").trim(), pdfMeta: null };
  }
  return { html: null, title: null, text: null, pdfMeta: null };
}

function collectDates(fr: FetchResult | null, html: tu.ParsedHtml | null, text: string | null, pdfMeta: Record<string, string> | null, now: Date): tu.DateCandidate[] {
  const cands: tu.DateCandidate[] = [];
  if (html) cands.push(...tu.extractDateCandidates(html, null, now));
  if (text) cands.push(...tu.extractDateCandidates(null, text, now));
  if (pdfMeta) {
    for (const [k, kind] of [["ModDate", "modified"], ["CreationDate", "published"]] as const) {
      const dt = tu.pdfDate(pdfMeta[k], now);
      if (dt) cands.push({ kind, source: `pdf.${k}`, raw: pdfMeta[k].slice(0, 40), date: tu.iso(dt) });
    }
    if (pdfMeta["XmpModifyDate"]) {
      const dt = tu.parseDate(pdfMeta["XmpModifyDate"], now);
      if (dt) cands.push({ kind: "modified", source: "pdf.XmpModifyDate", raw: pdfMeta["XmpModifyDate"].slice(0, 40), date: tu.iso(dt) });
    }
  }
  if (fr) {
    const wrev = fr.headers["x-wiki-last-revision"];
    if (wrev) cands.push({ kind: "modified", source: "wikipedia.last_revision", raw: wrev, date: wrev });
    const lm = fr.headers["last-modified"];
    if (lm) {
      const t = Date.parse(lm);
      if (!Number.isNaN(t)) {
        const dh = fr.headers["date"] ? Date.parse(fr.headers["date"]) : NaN;
        const ref = Number.isNaN(dh) ? now.getTime() : dh;
        const dynamic = Math.abs(ref - t) < 300_000;
        cands.push({ kind: "modified", source: "http.Last-Modified" + (dynamic ? " (generated at request time; ignored)" : ""), raw: lm, date: tu.iso(new Date(t)) });
      }
    }
  }
  const seen = new Set<string>();
  return cands.filter((c) => { const k = c.source + "|" + c.date; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function pickFrom(cands: tu.DateCandidate[], isHtml = false, now = new Date()): Record<string, any> {
  const pick = (pred: (c: tu.DateCandidate) => boolean) => {
    const g = cands.filter(pred);
    return g.length ? g.reduce((a, b) => (b.date > a.date ? b : a)) : null;
  };
  const best =
    pick((c) => c.kind === "modified" && startsWithAny(c.source, [...STRUCTURED_SOURCES, "pdf."])) ||
    pick((c) => c.kind === "modified" && /^text\['(page )?last /.test(c.source)) ||
    pick((c) => c.kind === "modified" && c.source.startsWith("text[")) ||
    pick((c) => c.source === "http.Last-Modified");
  const published = pick((c) => c.kind === "published");
  const copyright = pick((c) => c.kind === "copyright");
  const result: Record<string, any> = { last_updated: null, published: null, copyright_year: null, candidates: cands.slice(0, 25) };
  if (best) {
    let conf = startsWithAny(best.source, [...STRUCTURED_SOURCES, "pdf."]) ? "high" : startsWithAny(best.source, ["text['last", "text['page", "http."]) ? "medium" : "low";
    if (best.source === "http.Last-Modified" && isHtml) conf = "low"; // often the CMS/CDN render time on HTML pages
    result.last_updated = { date: best.date, source: best.source, raw: best.raw, confidence: conf, age_days: ageDays(best.date, now) };
  }
  if (published) result.published = { date: published.date, source: published.source, age_days: ageDays(published.date, now) };
  if (copyright) result.copyright_year = parseInt(copyright.date.slice(0, 4), 10);
  return result;
}

export interface UrlCheckOutput {
  result: Record<string, any>;
  text: string | null;
}

export async function checkUrl(url: string, settings: Settings, opts: { staleAfterDays?: number; includeArchive?: boolean; maxBytes?: number } = {}): Promise<UrlCheckOutput> {
  const staleAfterDays = opts.staleAfterDays ?? 365;
  const includeArchive = opts.includeArchive ?? true;
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const t0 = Date.now();
  const now = new Date();
  const wikiP = wikipediaFetch(url, maxBytes, settings).catch(() => null);
  const archP = includeArchive ? archiveLatest(url, settings, now).catch((e) => ({ available: null, error: (e as Error).name })) : null;
  const legP = legislationGovUkFacts(url, settings).catch(() => null);

  const wiki = await wikiP;
  let fr: FetchResult;
  let wikiInfo: Record<string, any> | null = null;
  if (wiki) {
    [fr, wikiInfo] = wiki;
  } else {
    fr = await safeFetch(url, settings, { maxBytes });
  }
  if ((!wiki && (fr.error === "timeout" || fr.error === "connect_error")) || (fr.status !== null && fr.status >= 500)) {
    await sleep(1000);
    const retry = await safeFetch(url, settings, { maxBytes });
    if (retry.status !== null && (fr.status === null || retry.status < fr.status)) fr = retry;
  }
  const parsed = await parseBody(fr);
  let { text } = parsed;
  const { html, title, pdfMeta } = parsed;
  let dates: Record<string, any>;
  if (html) {
    const structured = collectDates(fr, html, null, null, now);
    text = html.text;
    dates = pickFrom([...structured, ...collectDates(null, null, text, null, now)], true, now);
  } else {
    dates = pickFrom(collectDates(fr, null, text, pdfMeta, now), false, now);
  }

  const evidence: string[] = [];
  let verdict = "live";
  const reachable = fr.status !== null;
  const final = fr.finalUrl || (fr.hops.length ? fr.hops[fr.hops.length - 1].url : url);
  const reqHost = hostOf(url), finHost = hostOf(final);
  const reqPath = pathOf(url), finPath = pathOf(final);
  const challengeHit = text ? CHALLENGE.test((title || "") + " " + text.slice(0, 3000)) : false;

  if (fr.error === "blocked_target") {
    verdict = "invalid_target";
    evidence.push(`refused: ${fr.errorDetail}`);
  } else if (fr.error === "dns_error") {
    verdict = "dead";
    evidence.push(`DNS lookup failed for ${fr.hops.length ? hostOf(fr.hops[fr.hops.length - 1].url) : reqHost} (${fr.errorDetail})`);
  } else if (["connect_error", "timeout", "tls_error", "http_error", "too_many_redirects"].includes(fr.error || "")) {
    verdict = "unreachable";
    evidence.push(`${fr.error}: ${fr.errorDetail} (retried once)`);
  } else if (fr.status === 404 || fr.status === 410) {
    verdict = "dead";
    evidence.push(`HTTP ${fr.status} ${fr.status === 410 ? "Gone" : "Not Found"}`);
  } else if ([401, 403, 429, 451].includes(fr.status!) || (fr.status === 503 && challengeHit)) {
    verdict = "blocked";
    evidence.push(`HTTP ${fr.status}: access denied / bot protection / rate limit; liveness inconclusive`);
    if (challengeHit) evidence.push("bot-challenge page detected");
  } else if (fr.status !== null && fr.status >= 500) {
    verdict = "unreachable";
    evidence.push(`HTTP ${fr.status} server error (retried once)`);
  } else if (fr.status !== null && fr.status >= 400) {
    verdict = "dead";
    evidence.push(`HTTP ${fr.status}`);
  } else {
    const snippet = (text || "").slice(0, 4000);
    const bodyLower = tu.latin1Decode(fr.body.subarray(0, 200_000)).toLowerCase();
    let m: RegExpMatchArray | null;
    if (title && SOFT404_TITLE.test(title)) {
      verdict = "soft_404";
      evidence.push(`HTTP ${fr.status} but page title says: '${title.slice(0, 120)}'`);
    } else if (text !== null && text.length < 6000 && (m = snippet.match(SOFT404_BODY))) {
      verdict = "soft_404";
      evidence.push(`HTTP ${fr.status} but page text says: '${m[0].slice(0, 120)}'`);
    } else if (PARKED.test((title || "") + " " + snippet)) {
      verdict = "parked";
      evidence.push("domain-parking / for-sale page detected");
    } else if (fr.status && fr.status >= 200 && fr.status < 300 && CHALLENGE.test(title || "") && (text || "").length < 3000) {
      verdict = "blocked";
      evidence.push(`bot-challenge page served with HTTP ${fr.status}; content not visible`);
    } else if (fr.status === 202 || (html && (text || "").length < 40 && !title && bodyLower.includes("<script") && !bodyLower.includes("ld+json"))) {
      verdict = "blocked";
      evidence.push(`HTTP ${fr.status} with an empty page (likely a JavaScript/WAF challenge); content not visible, liveness inconclusive`);
    } else if (stripSlashes(reqPath).length > 0 && ["", "en", "en-us", "en-gb", "index.html", "home"].includes(stripSlashes(finPath)) && fr.hops.length > 1) {
      verdict = "moved_to_homepage";
      evidence.push(`deep link redirected to site root ${final}; original content likely removed`);
    } else {
      evidence.push(`HTTP ${fr.status} after ${fr.hops.length - 1} redirect(s)`);
    }
  }
  if (fr.hops.length > 1) {
    if (regDomain(reqHost) !== regDomain(finHost)) {
      evidence.push(`redirected to a different domain: ${finHost}`);
      if (verdict === "live") verdict = "redirected_cross_domain";
    } else if (reqPath.replace(/\/+$/, "") !== finPath.replace(/\/+$/, "")) {
      evidence.push(`redirected to a different path: ${finPath || "/"}`);
    }
  }

  let freshness = "unknown";
  const lu = dates.last_updated;
  if (lu) {
    freshness = lu.age_days > staleAfterDays ? "stale" : "fresh";
    evidence.push(`last updated ${lu.date.slice(0, 10)} (${lu.age_days} days ago, source ${lu.source}, confidence ${lu.confidence})`);
  } else if (dates.published) {
    const p = dates.published;
    evidence.push(`no update date found; published ${p.date.slice(0, 10)} (${p.age_days} days ago)`);
    if (p.age_days > staleAfterDays) freshness = "possibly_stale";
  } else if (dates.copyright_year) {
    const cy = dates.copyright_year;
    evidence.push(`no update date found; newest copyright year ${cy} (weak signal)`);
    if (now.getUTCFullYear() - cy >= 2) freshness = "possibly_stale";
  }
  if (verdict === "live" && freshness === "stale") verdict = "live_stale";

  const leg = await Promise.race([legP, sleep(15_000).then(() => null)]);
  if (leg && typeof leg.outstanding_unapplied_effects === "number" && leg.outstanding_unapplied_effects > 0)
    evidence.push(`legislation.gov.uk lists ${leg.outstanding_unapplied_effects} outstanding effect(s) not yet applied to the revised text`);

  let archive: Record<string, any> | null = null;
  if (archP) {
    archive = await Promise.race([archP, sleep(ARCHIVE_TIMEOUT_MS + 2000).then(() => ({ available: null, error: "TimeoutError" }))]);
    if (archive!.latest_ok) evidence.push(`latest good archive.org snapshot ${archive!.latest_ok.timestamp.slice(0, 10)}`);
    else if (archive!.available === false) evidence.push("no archive.org snapshot exists");
  }

  const usableMap: Record<string, boolean | null> = { live: true, live_stale: true, blocked: null, unreachable: null, redirected_cross_domain: null };
  const usable = verdict in usableMap ? usableMap[verdict] : false;
  const actions: Record<string, string> = {
    live: "OK to cite.",
    live_stale: `Reachable but last updated more than ${staleAfterDays} days ago; check for a newer source.`,
    blocked: "Site blocked automated access; verify manually or cite an archived copy.",
    unreachable: "Temporarily unreachable; retry later or cite an archived copy.",
    invalid_target: "Not a public http(s) URL.",
    redirected_cross_domain: "Now redirects to another domain; confirm the destination still holds the cited content (rebrand vs. replacement).",
  };
  let action = actions[verdict] ?? "Link is dead or content removed; replace it or cite the archived snapshot.";
  if (!usable && archive && archive.latest_ok) action += ` Archived copy: ${archive.latest_ok.url}`;

  const { candidates, ...dateRest } = dates;
  const out: Record<string, any> = {
    url,
    verdict,
    freshness,
    usable_as_citation: usable,
    recommended_action: action,
    evidence,
    http: {
      reachable,
      status: fr.status,
      final_url: fr.finalUrl,
      redirect_chain: fr.hops.map((h) => ({ url: h.url, status: h.status })),
      content_type: contentType(fr) || null,
      content_length_read: fr.body.byteLength,
      truncated: fr.truncated,
      error: fr.error,
      error_detail: fr.errorDetail,
      etag: fr.headers["etag"] ?? null,
      last_modified_header: fr.headers["last-modified"] ?? null,
      elapsed_ms: fr.elapsedMs,
    },
    page: { title, text_chars: text ? text.length : 0 },
    dates: { ...dateRest, candidates: candidates.slice(0, 10) },
    archive,
    checked_at: tu.iso(new Date()),
    took_ms: Date.now() - t0,
  };
  if (leg) out.legislation_gov_uk = leg;
  if (wikiInfo) out.wikipedia = wikiInfo;
  return { result: out, text };
}

// ---------------------------------------------------------- citation check
const STOPWORDS = new Set(`a an the and or but if of to in on at by for with from as is are was were be been being this that these those it its
into than then there their they them we you he she his her our your not no nor so such can could would should may might will shall
do does did has have had which who whom whose what when where why how all any both each few more most other some same own only very
also just about over under after before between through during per via`.split(/\s+/));
const NUM_RE = /(?<![\p{L}\p{N}_.])[-+]?\d[\d,]*(?:\.\d+)?%?/gu;
const WORD_RE = /[a-z][a-z'\-]{2,}/g;
const SENT_SPLIT = /(?<=[.!?;])\s+(?=[A-Z0-9"'(\[])/;

export function normNum(s: string): string {
  let t = s.replace(/,/g, "").replace(/%+$/, "");
  if (t.includes(".")) t = t.replace(/0+$/, "").replace(/\.+$/, "");
  return t.replace(/^\++/, "");
}

export function stem(w0: string): string {
  const w = w0.replace(/^['-]+|['-]+$/g, "");
  for (const suf of ["ations", "ation", "ingly", "ings", "ing", "edly", "ies", "ied", "ers", "est", "ed", "es", "ly", "s"]) {
    if (w.length > suf.length + 3 && w.endsWith(suf)) return w.slice(0, -suf.length);
  }
  return w;
}

function snippet(text: string, start: number, end: number, ctx = 160): string {
  const a = Math.max(0, start - ctx), b = Math.min(text.length, end + ctx);
  return (a > 0 ? "…" : "") + text.slice(a, b) + (b < text.length ? "…" : "");
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const stripPunct = (s: string) => s.replace(/[^\p{L}\p{N}_]+/gu, " ").trim();

/**
 * Approximate rapidfuzz partial_ratio_alignment: semi-global indel alignment of the quote against
 * candidate windows located via the quote's longest words. Bounded work for the Workers CPU budget.
 */
export function partialAlign(q: string, hay: string): { score: number; start: number; end: number } | null {
  if (!q || !hay) return null;
  const qq = q.length > 500 ? q.slice(0, 500) : q;
  const m = qq.length;
  const pad = Math.ceil(m * 0.25) + 10;
  const words = [...new Set(qq.split(" ").filter((w) => w.length >= 4))].sort((a, b) => b.length - a.length).slice(0, 6);
  const budget = 2_000_000; // DP cells; ~10-15 ms worst case
  const maxCands = Math.max(1, Math.floor(budget / (m * (m + 2 * pad))));
  const starts: number[] = [];
  const keys = new Set<number>();
  const bucket = Math.max(20, Math.floor(m / 4));
  outer: for (const w of words) {
    const off = qq.indexOf(w);
    let p = hay.indexOf(w);
    let n = 0;
    while (p >= 0 && n < 40) {
      const s = Math.max(0, p - off);
      const k = Math.round(s / bucket);
      if (!keys.has(k)) { keys.add(k); starts.push(s); if (starts.length >= maxCands) break outer; }
      p = hay.indexOf(w, p + 1);
      n++;
    }
  }
  if (!starts.length) return null;
  let best: { score: number; start: number; end: number } | null = null;
  const prev = new Int32Array(m + 1), cur = new Int32Array(m + 1);
  const prevS = new Int32Array(m + 1), curS = new Int32Array(m + 1);
  for (const s0 of starts) {
    const a = Math.max(0, s0 - pad), b = Math.min(hay.length, s0 + m + pad);
    // column-wise DP over hay positions; rows over quote chars. Free start anywhere in [a, b).
    for (let i = 0; i <= m; i++) { prev[i] = i; prevS[i] = a; }
    let bestD = prev[m], bestEnd = a, bestStart = a;
    for (let j = a; j < b; j++) {
      const c = hay.charCodeAt(j);
      cur[0] = 0; curS[0] = j + 1;
      for (let i = 1; i <= m; i++) {
        let d = prev[i] + 1, st = prevS[i]; // skip hay char (insertion)
        const del = cur[i - 1] + 1; // skip quote char
        if (del < d) { d = del; st = curS[i - 1]; }
        if (qq.charCodeAt(i - 1) === c && prev[i - 1] < d) { d = prev[i - 1]; st = prevS[i - 1]; }
        cur[i] = d; curS[i] = st;
      }
      if (cur[m] < bestD) { bestD = cur[m]; bestEnd = j + 1; bestStart = curS[m]; }
      prev.set(cur); prevS.set(curS);
    }
    const len = bestEnd - bestStart;
    const score = round(100 * (1 - bestD / (m + Math.max(len, 1))), 1);
    if (!best || score > best.score) best = { score: Math.max(0, score), start: bestStart, end: bestEnd };
  }
  return best;
}

export function matchQuote(quote: string, text: string): Record<string, any> {
  const nq = tu.normalize(quote), nt = tu.normalize(text);
  const lq = nq.toLowerCase(), lt = nt.toLowerCase();
  if (!lq) return { match: "not_checked" };
  const sameLen = lt.length === nt.length;
  const idx = lt.indexOf(lq);
  if (idx >= 0) {
    const src = sameLen ? nt : lt;
    let occ = 0;
    for (let p = lt.indexOf(lq); p >= 0; p = lt.indexOf(lq, p + lq.length)) occ++;
    return { match: "exact", score: 100.0, occurrences: occ, snippet: snippet(src, idx, idx + lq.length), matched_text: src.slice(idx, idx + lq.length), position: round(idx / Math.max(1, lt.length), 4) };
  }
  const sl = stripPunct(lq), st = stripPunct(lt);
  if (sl && st.includes(sl)) {
    const i = st.indexOf(sl);
    return { match: "exact_ignoring_punctuation", score: 99.0, snippet: snippet(st, i, i + sl.length), matched_text: st.slice(i, i + sl.length), position: round(i / Math.max(1, st.length), 4) };
  }
  const hay = lt.slice(0, 3_000_000);
  const al = partialAlign(lq, hay);
  const score = al ? al.score : 0.0;
  if (al && score >= 60) {
    const src = sameLen ? nt : lt;
    let s0 = al.start, s1 = al.end;
    while (s0 > 0 && !/\s/.test(src[s0 - 1]) && s0 > al.start - 30) s0--;
    while (s1 < src.length && !/\s/.test(src[s1]) && s1 < al.end + 30) s1++;
    const match = score >= 90 ? "fuzzy" : score >= 75 ? "partial" : "weak";
    return { match, score, snippet: snippet(src, s0, s1), matched_text: src.slice(s0, s1), position: round(s0 / Math.max(1, lt.length), 4) };
  }
  return { match: "not_found", score };
}

export function matchClaim(claim: string, text: string): Record<string, any> {
  const nc = tu.normalize(claim), nt = tu.normalize(text);
  const nums = [...new Set([...nc.matchAll(NUM_RE)].map((m) => normNum(m[0])).filter(Boolean))].sort();
  const textNums = new Set([...nt.matchAll(NUM_RE)].map((m) => normNum(m[0])));
  const words = (nc.toLowerCase().match(WORD_RE) || []).filter((w) => !STOPWORDS.has(w));
  const stems = [...new Set(words.map(stem))].sort();
  const sents: string[] = [];
  for (let sent of nt.split(SENT_SPLIT)) {
    sent = sent.trim();
    while (sent.length > 300) {
      let cut = sent.lastIndexOf(" ", 300);
      if (cut < 150) cut = 300;
      sents.push(sent.slice(0, cut));
      sent = sent.slice(cut).trim();
    }
    if (sent) sents.push(sent);
  }
  let best: [number, number, string] = [0, -1, ""];
  // Only tokenize sentences that can contribute (contain a claim stem as a substring, or a digit when
  // the claim has numbers): keeps the scan well under the Workers CPU budget on 1 MB pages.
  const EMPTY = new Set<string>();
  const sentStems: Array<Set<string>> = [];
  const sentNums: Array<Set<string>> = [];
  const allStems = new Set<string>();
  for (const s of sents) {
    const sl = s.toLowerCase();
    const wordHit = stems.some((st) => sl.includes(st));
    const numHit = nums.length > 0 && /\d/.test(s);
    let ws = EMPTY;
    if (wordHit) {
      ws = new Set((sl.match(WORD_RE) || []).map(stem));
      for (const w of ws) allStems.add(w);
    }
    sentStems.push(ws);
    sentNums.push(numHit ? new Set([...s.matchAll(NUM_RE)].map((m) => normNum(m[0]))) : EMPTY);
  }
  if (stems.length || nums.length) {
    const denom = stems.length + 2 * nums.length;
    for (let i = 0; i < sents.length && i <= 20000; i++) {
      if (sentStems[i] === EMPTY && sentNums[i] === EMPTY && (i + 1 >= sents.length || (sentStems[i + 1] === EMPTY && sentNums[i + 1] === EMPTY))) continue;
      const has = (set: Array<Set<string>>, x: string) => set[i].has(x) || (i + 1 < sents.length && set[i + 1].has(x));
      const hitW = stems.filter((s) => has(sentStems, s)).length;
      const hitN = nums.filter((n) => has(sentNums, n)).length;
      const score = denom ? (hitW + 2 * hitN) / denom : 0;
      if (score > best[0]) best = [score, i, sents.slice(i, i + 2).join(" ")];
    }
  }
  const found = nums.filter((n) => textNums.has(n));
  const missing = nums.filter((n) => !textNums.has(n));
  const termCov = stems.length ? round(stems.filter((s) => allStems.has(s)).length / stems.length, 3) : null;
  const cov = round(best[0], 3);
  let verdict = cov >= 0.8 && !missing.length ? "supported_lexically" : cov >= 0.5 ? "partially_supported_lexically" : "not_found";
  if (missing.length && verdict === "supported_lexically") verdict = "partially_supported_lexically";
  return {
    verdict,
    best_passage: best[1] >= 0 ? best[2].slice(0, 1200) : null,
    best_passage_coverage: cov,
    page_term_coverage: termCov,
    numbers_in_claim: nums,
    numbers_found_on_page: found,
    numbers_missing_from_page: missing,
    method: "lexical: share of the claim's key terms and numbers found within a 2-sentence (max ~600 char) window. This is not semantic entailment; a negated or reworded claim can still score high.",
  };
}

async function archivedText(rawUrl: string, settings: Settings, maxBytes: number): Promise<string | null> {
  const fr = await safeFetch(rawUrl, settings, { maxBytes, timeoutMs: 20_000 });
  if (fr.status !== 200) return null;
  const p = await parseBody(fr);
  return p.html ? p.html.text : p.text;
}

export async function checkCitation(
  url: string, quote: string | null, claim: string | null, settings: Settings,
  opts: { staleAfterDays?: number; checkArchiveIfMissing?: boolean; maxBytes?: number } = {},
): Promise<Record<string, any>> {
  const t0 = Date.now();
  const maxBytes = opts.maxBytes ?? 2_000_000;
  const checkArchive = opts.checkArchiveIfMissing ?? true;
  const { result: urlResult, text: liveText } = await checkUrl(url, settings, { staleAfterDays: opts.staleAfterDays ?? 365, maxBytes });
  let text = liveText;
  if (!["live", "live_stale", "redirected_cross_domain"].includes(urlResult.verdict)) text = null; // error/soft-404/parked/homepage pages are not the cited content
  const out: Record<string, any> = { url, quote, claim };
  const liveQ = quote && text ? matchQuote(quote, text) : null;
  const liveC = claim && text ? matchClaim(claim, text) : null;
  const qOk = (m: any) => Boolean(m && ["exact", "exact_ignoring_punctuation", "fuzzy"].includes(m.match));
  const cOk = (m: any) => Boolean(m && m.verdict === "supported_lexically");
  const weak = (m: any) => Boolean(m && (m.match === "partial" || m.verdict === "partially_supported_lexically"));
  const foundLive = qOk(liveQ) || cOk(liveC);
  let archived: Record<string, any> | null = null;
  const snap = (urlResult.archive || {}).latest_ok;
  if (checkArchive && !foundLive && snap) {
    const atext = await archivedText(snap.raw_url, settings, maxBytes);
    if (atext) {
      archived = { snapshot: snap.url, snapshot_date: snap.timestamp };
      if (quote) archived.quote = matchQuote(quote, atext);
      if (claim) archived.claim = matchClaim(claim, atext);
    } else {
      archived = { snapshot: snap.url, error: "could not read archived snapshot" };
    }
  }
  let verdict: string;
  if (text === null) verdict = ["live", "live_stale", "redirected_cross_domain"].includes(urlResult.verdict) ? "page_unreadable" : "page_unavailable";
  else if ((quote && qOk(liveQ)) || (!quote && cOk(liveC))) verdict = "verified";
  else if (weak(liveQ) || weak(liveC)) verdict = "partially_matched";
  else verdict = "not_found_on_page";
  if (verdict !== "verified" && archived && (qOk(archived.quote) || (!quote && cOk(archived.claim))))
    verdict = text !== null ? "only_in_archive" : "page_unavailable_but_in_archive";
  const explain: Record<string, string> = {
    verified: quote
      ? "The quoted text appears on the live page."
      : "All key terms and numbers of the claim appear near each other on the live page (lexical match only, not semantic entailment: swapped entity-number pairs or negations can still match).",
    partially_matched: "Only a partial / approximate match was found; the wording may have changed or been paraphrased.",
    not_found_on_page: "The quote/claim was not found on the live page.",
    only_in_archive: "Not on the live page, but present in the latest archive.org snapshot; the source content has probably changed.",
    page_unavailable_but_in_archive: "Live page unavailable; the text is present in the latest archive.org snapshot.",
    page_unavailable: "The page could not be fetched; see url_check for why.",
    page_unreadable: "The page loaded but no text could be extracted (e.g. JavaScript-only page or unsupported format).",
  };
  // evidence_kind says what kind of evidence backs the verdict, so clients don't silently upgrade a lexical claim match into "claim supported".
  let evidence_kind: string | null = null;
  if (verdict === "verified") evidence_kind = quote ? "quote_text_match" : "lexical_claim_match";
  else if (verdict === "only_in_archive" || verdict === "page_unavailable_but_in_archive")
    evidence_kind = quote && qOk(archived?.quote) ? "quote_text_match_archive" : "lexical_claim_match_archive";
  else if (verdict === "partially_matched") evidence_kind = "partial_lexical_match";
  Object.assign(out, {
    verdict,
    evidence_kind,
    explanation: explain[verdict],
    quote_match: liveQ,
    claim_match: liveC,
    archive_comparison: archived,
    url_check: urlResult,
    checked_at: tu.iso(new Date()),
    took_ms: Date.now() - t0,
  });
  return out;
}
