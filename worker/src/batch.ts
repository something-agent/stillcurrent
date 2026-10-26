/**
 * POST /check/urls: link triage for up to 25 URLs in one paid call.
 *
 * Cloudflare Workers Free allows 50 subrequests per invocation (every redirect hop counts, and the
 * x402 facilitator verify/settle calls count too). So the batch check is deliberately lighter than
 * /check/url: one GET per hop, no archive.org lookup, no DNS-over-HTTPS diagnosis, at most
 * BATCH_MAX_HOPS hops per URL, and a shared hop budget. Every URL gets its first request; redirects
 * are followed while budget remains. A URL whose redirect could not be followed is reported with
 * complete=false and the pending Location, never silently dropped.
 */
import { assertPublicUrl, classifyError } from "./fetcher";
import type { Settings } from "./config";
import { regDomain } from "./checks";

export const BATCH_MAX_URLS = 25;
export const BATCH_SUBREQUEST_BUDGET = 44; // 50 minus headroom for facilitator /supported, /verify, /settle
export const BATCH_MAX_HOPS = 4;
const CONCURRENCY = 6; // Workers: at most 6 connections waiting for headers per invocation
const TIMEOUT_MS = 8000;
const PEEK_BYTES = 16_384;

export type BatchVerdict = "live" | "redirected" | "redirected_cross_domain" | "moved_to_homepage" | "dead" | "blocked" |
  "server_error" | "client_error" | "unreachable" | "invalid_target" | "redirect_not_followed";

export interface BatchItem {
  url: string; verdict: BatchVerdict; ok: boolean; status: number | null; final_url: string | null;
  redirect_chain: { url: string; status: number | null }[]; title: string | null; content_type: string | null;
  error: string | null; complete: boolean; pending_location?: string; elapsed_ms: number;
}

class Budget { constructor(public left: number) {} take(): boolean { if (this.left <= 0) return false; this.left--; return true; } }

async function peekTitle(resp: Response): Promise<string | null> {
  const ct = resp.headers.get("content-type") || "";
  if (!resp.body || !/html/i.test(ct)) { try { await resp.body?.cancel(); } catch { /* ignore */ } return null; }
  const reader = resp.body.getReader();
  let buf = ""; const dec = new TextDecoder();
  try {
    while (buf.length < PEEK_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (/<\/title>/i.test(buf)) break;
    }
  } finally { try { await reader.cancel(); } catch { /* ignore */ } }
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(buf);
  return m ? m[1].replace(/\s+/g, " ").trim().slice(0, 200) || null : null;
}

async function triage(url: string, s: Settings, budget: Budget): Promise<BatchItem> {
  const t0 = Date.now();
  const out: BatchItem = { url, verdict: "unreachable", ok: false, status: null, final_url: null, redirect_chain: [], title: null,
    content_type: null, error: null, complete: true, elapsed_ms: 0 };
  let current = url;
  const finish = () => { out.elapsed_ms = Date.now() - t0; return out; };
  for (let hop = 0; hop < BATCH_MAX_HOPS; hop++) {
    try { assertPublicUrl(current, s); } catch (e) { out.verdict = "invalid_target"; out.error = (e as Error).message; return finish(); }
    if (!budget.take()) { out.verdict = "redirect_not_followed"; out.complete = false; out.pending_location = current; return finish(); }
    let resp: Response;
    try {
      resp = await fetch(current, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "User-Agent": s.userAgent, Accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8" } });
    } catch (e) {
      out.redirect_chain.push({ url: current, status: null });
      out.error = classifyError(e).code; out.verdict = "unreachable"; return finish();
    }
    out.redirect_chain.push({ url: current, status: resp.status });
    const loc = resp.headers.get("location");
    if ([301, 302, 303, 307, 308].includes(resp.status) && loc) {
      try { await resp.body?.cancel(); } catch { /* ignore */ }
      try { current = new URL(loc, current).toString(); } catch { out.verdict = "unreachable"; out.error = "invalid redirect location"; return finish(); }
      continue;
    }
    out.status = resp.status; out.final_url = current; out.content_type = resp.headers.get("content-type");
    out.title = resp.status < 400 ? await peekTitle(resp) : (await resp.body?.cancel().catch(() => {}), null);
    const st = resp.status;
    if (st >= 200 && st < 300) {
      const a = new URL(url), f = new URL(current);
      const redirected = out.redirect_chain.length > 1;
      if (redirected && regDomain(a.hostname) !== regDomain(f.hostname)) out.verdict = "redirected_cross_domain";
      else if (redirected && a.pathname.replace(/\/+$/, "") !== "" && f.pathname.replace(/\/+$/, "") === "") out.verdict = "moved_to_homepage";
      else out.verdict = redirected ? "redirected" : "live";
      out.ok = out.verdict === "live" || out.verdict === "redirected";
    } else if (st === 404 || st === 410) out.verdict = "dead";
    else if (st === 401 || st === 403 || st === 429 || st === 451) out.verdict = "blocked";
    else if (st >= 500) out.verdict = "server_error";
    else out.verdict = "client_error";
    return finish();
  }
  out.verdict = "redirect_not_followed"; out.complete = false; out.pending_location = current; out.error = `more than ${BATCH_MAX_HOPS - 1} redirects`;
  return finish();
}

export async function checkUrls(urls: string[], s: Settings) {
  const t0 = Date.now();
  const unique = [...new Set(urls)];
  // Each URL's first request comes from a reserved slot, so early redirect chains cannot starve later URLs.
  const shared = new Budget(Math.max(0, BATCH_SUBREQUEST_BUDGET - unique.length));
  const results = new Map<string, BatchItem>();
  let i = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, unique.length) }, async () => {
    while (i < unique.length) {
      const u = unique[i++];
      let first = true;
      const b = { take: () => { if (first) { first = false; return true; } return shared.take(); } } as Budget;
      results.set(u, await triage(u, s, b));
    }
  });
  await Promise.all(workers);
  const items = urls.map((u) => results.get(u)!);
  const counts: Record<string, number> = {};
  for (const it of items) counts[it.verdict] = (counts[it.verdict] || 0) + 1;
  return {
    checked: items.length, unique: unique.length, ok: items.filter((x) => x.ok).length, not_ok: items.filter((x) => !x.ok).length,
    incomplete: items.filter((x) => !x.complete).length, verdict_counts: counts, results: items,
    note: "Batch triage: one GET per hop (max " + BATCH_MAX_HOPS + "), no archive.org lookup or date extraction. Use POST /check/url on any result for the full check.",
    checked_at: new Date(t0).toISOString().replace(/\.\d{3}Z$/, "Z"), took_ms: Date.now() - t0,
  };
}
