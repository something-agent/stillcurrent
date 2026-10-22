/** Static descriptions, examples and JSON schemas (mirrors the Python service). */
export const SERVICE_NAME = "StillCurrent";
export const VERSION = "0.2.0-worker";
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
  http: { reachable: true, status: 200, final_url: "https://www.cdc.gov/nchs/fastats/life-expectancy.htm",
    redirect_chain: [{ url: "https://www.cdc.gov/nchs/fastats/life-expectancy.htm", status: 200 }] },
  dates: { last_updated: { date: "2026-09-29T00:00:00Z", source: "text['last reviewed']", confidence: "medium", age_days: 23 } },
  archive: { available: true, latest_ok: { timestamp: "2026-10-16T18:35:00Z",
    url: "https://web.archive.org/web/20261016183500/https://www.cdc.gov/nchs/fastats/life-expectancy.htm" } },
};
export const URL_OUTPUT_EXAMPLE = {
  verdict: URL_OUTPUT_EXAMPLE_FULL.verdict, freshness: URL_OUTPUT_EXAMPLE_FULL.freshness,
  usable_as_citation: URL_OUTPUT_EXAMPLE_FULL.usable_as_citation, evidence: URL_OUTPUT_EXAMPLE_FULL.evidence,
};
export const CIT_INPUT_EXAMPLE = { url: "https://www.cdc.gov/nchs/fastats/life-expectancy.htm", claim: "Life expectancy at birth in the US was 78.4 years" };
export const CIT_OUTPUT_EXAMPLE_FULL = {
  verdict: "partially_matched",
  explanation: "Only a partial / approximate match was found; the wording may have changed or been paraphrased.",
  claim_match: { verdict: "partially_supported_lexically", best_passage_coverage: 0.667, numbers_in_claim: ["78.4"],
    numbers_found_on_page: [], numbers_missing_from_page: ["78.4"],
    best_passage: "... Life expectancy at birth Both sexes: 79.0 years Males: 76.5 years Females: 81.4 years ..." },
  quote_match: null,
  archive_comparison: { snapshot_date: "2026-10-16T18:35:00Z" },
  url_check: { verdict: "live", freshness: "fresh" },
};
export const CIT_OUTPUT_EXAMPLE = { verdict: "partially_matched", claim_match: { verdict: "partially_supported_lexically", numbers_found_on_page: [], numbers_missing_from_page: ["78.4"] } };

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
  },
};
export const CIT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: VERDICTS_CIT },
    explanation: { type: "string" },
    quote_match: { type: ["object", "null"] }, claim_match: { type: ["object", "null"] },
    archive_comparison: { type: ["object", "null"] }, url_check: { type: "object" },
  },
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
if (URL_DESCRIPTION.length > 500 || CIT_DESCRIPTION.length > 500) throw new Error("description too long");
