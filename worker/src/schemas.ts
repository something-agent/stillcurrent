/** Static descriptions, examples and JSON schemas (mirrors the Python service). */
export const SERVICE_NAME = "StillCurrent";
export const VERSION = "0.3.0-worker";
export const SERVICE_DESC =
  "Pay-per-call checks that tell you whether a source is still current: link liveness and staleness, " +
  "and whether a quoted sentence or claim still appears on the cited page (with archive.org fallback).";
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base mainnet (eip155:8453)

export const URL_INPUT_EXAMPLE = { url: "https://www.cdc.gov/nchs/fastats/life-expectancy.htm", stale_after_days: 365 };
export const URL_OUTPUT_EXAMPLE_FULL = {
  url: "https://www.cdc.gov/nchs/fastats/life-expectancy.htm",
  verdict: "live",
  freshness: "fresh",
  usable_as_citation: true,
  recommended_action: "OK to cite.",
  evidence: [
    "HTTP 200 after 0 redirect(s)",
    "last updated 2026-09-29 (23 days ago, source text['last reviewed'], confidence medium)",
    "latest good archive.org snapshot 2026-10-16",
  ],
  checked_at: "2026-10-22T18:00:00Z",
  took_ms: 412,
  http: { reachable: true, status: 200, final_url: "https://www.cdc.gov/nchs/fastats/life-expectancy.htm",
    redirect_chain: [{ url: "https://www.cdc.gov/nchs/fastats/life-expectancy.htm", status: 200 }] },
  dates: { last_updated: { date: "2026-09-29T00:00:00Z", source: "text['last reviewed']", confidence: "medium", age_days: 23 } },
  archive: { available: true, latest_ok: { timestamp: "2026-10-16T18:35:00Z",
    url: "https://web.archive.org/web/20261016183500/https://www.cdc.gov/nchs/fastats/life-expectancy.htm" } },
};
export const URL_OUTPUT_EXAMPLE = {
  verdict: URL_OUTPUT_EXAMPLE_FULL.verdict, freshness: URL_OUTPUT_EXAMPLE_FULL.freshness,
  usable_as_citation: URL_OUTPUT_EXAMPLE_FULL.usable_as_citation, evidence: URL_OUTPUT_EXAMPLE_FULL.evidence,
  checked_at: URL_OUTPUT_EXAMPLE_FULL.checked_at, took_ms: URL_OUTPUT_EXAMPLE_FULL.took_ms,
};
export const CIT_INPUT_EXAMPLE = { url: "https://www.cdc.gov/nchs/fastats/life-expectancy.htm", claim: "Life expectancy at birth in the US was 78.4 years" };
export const CIT_OUTPUT_EXAMPLE_FULL = {
  verdict: "partially_matched",
  evidence_kind: "partial_lexical_match",
  explanation: "Only a partial / approximate match was found; the wording may have changed or been paraphrased.",
  claim_match: { verdict: "partially_supported_lexically", best_passage_coverage: 0.667, numbers_in_claim: ["78.4"],
    numbers_found_on_page: [], numbers_missing_from_page: ["78.4"],
    best_passage: "... Life expectancy at birth Both sexes: 79.0 years Males: 76.5 years Females: 81.4 years ..." },
  quote_match: null,
  archive_comparison: { snapshot_date: "2026-10-16T18:35:00Z" },
  url_check: { verdict: "live", freshness: "fresh" },
  checked_at: "2026-10-22T18:00:00Z",
  took_ms: 655,
};
export const CIT_OUTPUT_EXAMPLE = { verdict: "partially_matched", claim_match: { verdict: "partially_supported_lexically", numbers_found_on_page: [], numbers_missing_from_page: ["78.4"] }, checked_at: "2026-10-22T18:00:00Z", took_ms: 655 };

export const VERDICTS_URL = ["live", "live_stale", "redirected_cross_domain", "moved_to_homepage", "soft_404", "parked", "dead", "unreachable", "blocked", "invalid_target"];
export const VERDICTS_CIT = ["verified", "partially_matched", "not_found_on_page", "only_in_archive", "page_unavailable_but_in_archive", "page_unavailable", "page_unreadable"];

export const URL_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: VERDICTS_URL },
    freshness: { type: "string", enum: ["fresh", "stale", "possibly_stale", "unknown"] },
    usable_as_citation: { type: ["boolean", "null"] },
    recommended_action: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    http: { type: "object" }, dates: { type: "object" }, archive: { type: ["object", "null"] },
    wikipedia: { type: "object" }, legislation_gov_uk: { type: "object" },
    checked_at: { type: "string", format: "date-time", description: "UTC time the check ran. A cached result is a snapshot from this time." },
    took_ms: { type: "integer" },
  },
  required: ["verdict", "checked_at"],
};
export const CIT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: VERDICTS_CIT },
    evidence_kind: { type: ["string", "null"], enum: ["quote_text_match", "lexical_claim_match", "quote_text_match_archive", "lexical_claim_match_archive", "partial_lexical_match", null],
      description: "What backs the verdict. lexical_claim_match means the claim's terms and numbers co-occur on the page; it is NOT semantic support (an entity-number swap can still match). Treat it as retrieval, not proof." },
    explanation: { type: "string" },
    quote_match: { type: ["object", "null"] }, claim_match: { type: ["object", "null"] },
    archive_comparison: { type: ["object", "null"] }, url_check: { type: "object" },
    checked_at: { type: "string", format: "date-time", description: "UTC time the check ran. A cached result is a snapshot from this time." },
    took_ms: { type: "integer" },
  },
  required: ["verdict", "checked_at"],
};

export const URL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", maxLength: 2048, description: "Absolute http(s) URL of the source, citation or dataset to check.", title: "Url" },
    stale_after_days: { type: "integer", minimum: 1, maximum: 36500, default: 365, description: "Age (days since last update) after which a live page is reported as stale.", title: "Stale After Days" },
    include_archive: { type: "boolean", default: true, description: "Look up the latest archive.org Wayback Machine snapshot.", title: "Include Archive" },
  },
  required: ["url"],
};
export const CIT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", maxLength: 2048, description: "Absolute http(s) URL of the cited page (HTML, PDF or plain text).", title: "Url" },
    quote: { anyOf: [{ type: "string", maxLength: 2000 }, { type: "null" }], default: null, description: "Exact text the citation quotes. Matched exactly, then punctuation-insensitive, then fuzzy.", title: "Quote" },
    claim: { anyOf: [{ type: "string", maxLength: 1000 }, { type: "null" }], default: null, description: "Paraphrased claim attributed to the source. Checked lexically: key terms and every number must appear near each other.", title: "Claim" },
    stale_after_days: { type: "integer", minimum: 1, maximum: 36500, default: 365, title: "Stale After Days" },
    check_archive_if_missing: { type: "boolean", default: true, description: "If not found on the live page, also search the latest archive.org snapshot.", title: "Check Archive If Missing" },
  },
  required: ["url"],
};

export const URL_DESCRIPTION =
  "Checks whether a URL (source, citation or dataset) is still alive and current: HTTP status and redirect chain, " +
  "soft-404 / parked-domain / redirect-to-homepage detection, last-updated date from metadata or page text, latest " +
  "archive.org snapshot, and a verdict (live, live_stale, dead, moved_to_homepage, soft_404, blocked, ...) with evidence.";
export const CIT_DESCRIPTION =
  "Checks whether a quoted sentence or a claim still appears on the cited page (HTML, PDF or text). Exact, " +
  "punctuation-insensitive and fuzzy quote matching with snippet; lexical claim check incl. every number; compares with " +
  "the latest archive.org snapshot when missing; includes the full URL liveness/staleness check.";
export const BATCH_INPUT_EXAMPLE = { urls: ["https://example.com/", "https://www.x402.org/", "https://example.com/missing-page"] };
export const BATCH_OUTPUT_EXAMPLE_FULL = {
  checked: 3, unique: 3, ok: 2, not_ok: 1, incomplete: 0, verdict_counts: { live: 1, redirected: 1, dead: 1 },
  results: [
    { url: "https://example.com/", verdict: "live", ok: true, status: 200, final_url: "https://example.com/", redirect_chain: [{ url: "https://example.com/", status: 200 }], title: "Example Domain", content_type: "text/html", error: null, complete: true, elapsed_ms: 120 },
    { url: "https://www.x402.org/", verdict: "redirected", ok: true, status: 200, final_url: "https://x402.org/", redirect_chain: [{ url: "https://www.x402.org/", status: 301 }, { url: "https://x402.org/", status: 200 }], title: "x402", content_type: "text/html", error: null, complete: true, elapsed_ms: 210 },
    { url: "https://example.com/missing-page", verdict: "dead", ok: false, status: 404, final_url: "https://example.com/missing-page", redirect_chain: [{ url: "https://example.com/missing-page", status: 404 }], title: null, content_type: "text/html", error: null, complete: true, elapsed_ms: 98 },
  ],
  note: "Batch triage: one GET per hop (max 4), no archive.org lookup or date extraction. Use POST /check/url on any result for the full check.",
  checked_at: "2026-10-26T15:00:00Z", took_ms: 230,
};
export const BATCH_OUTPUT_EXAMPLE = { checked: 3, ok: 2, not_ok: 1, incomplete: 0, verdict_counts: { live: 1, redirected: 1, dead: 1 },
  results: [{ url: "https://example.com/missing-page", verdict: "dead", ok: false, status: 404, complete: true }], checked_at: "2026-10-26T15:00:00Z", took_ms: 230 };
export const VERDICTS_BATCH = ["live", "redirected", "redirected_cross_domain", "moved_to_homepage", "dead", "blocked", "server_error", "client_error", "unreachable", "invalid_target", "redirect_not_followed"];
export const BATCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    urls: { type: "array", minItems: 1, maxItems: 25, items: { type: "string", maxLength: 2048 }, description: "1 to 25 absolute http(s) URLs. Duplicates are checked once.", title: "Urls" },
  },
  required: ["urls"],
};
export const BATCH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    checked: { type: "integer" }, unique: { type: "integer" }, ok: { type: "integer" }, not_ok: { type: "integer" },
    incomplete: { type: "integer", description: "URLs whose redirect chain could not be fully followed within the per-call request budget (see pending_location)." },
    verdict_counts: { type: "object" },
    results: { type: "array", items: { type: "object", properties: { url: { type: "string" }, verdict: { type: "string", enum: VERDICTS_BATCH }, ok: { type: "boolean" },
      status: { type: ["integer", "null"] }, final_url: { type: ["string", "null"] }, redirect_chain: { type: "array" }, title: { type: ["string", "null"] },
      complete: { type: "boolean" }, pending_location: { type: "string" } }, required: ["url", "verdict", "ok", "complete"] } },
    checked_at: { type: "string", format: "date-time" }, took_ms: { type: "integer" },
  },
  required: ["checked", "results", "checked_at"],
};
export const BATCH_DESCRIPTION =
  "Link triage for up to 25 URLs in one call: HTTP status, redirect chain (up to 4 hops), page title, and a verdict per URL " +
  "(live, redirected, redirected_cross_domain, moved_to_homepage, dead, blocked, server_error, unreachable, ...). Lighter than " +
  "/check/url: no archive.org lookup or last-updated date. Use it to find which links in a document need a full check.";
if (BATCH_DESCRIPTION.length > 500) throw new Error("description too long");
if (URL_DESCRIPTION.length > 500 || CIT_DESCRIPTION.length > 500) throw new Error("description too long");
