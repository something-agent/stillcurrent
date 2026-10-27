/** Static descriptions, examples and JSON schemas (mirrors the Python service). */
export const SERVICE_NAME = "StillCurrent";
export const VERSION = "0.4.0-worker";
export const SERVICE_DESC =
  "Pay-per-call checks that tell you whether a source is still current (link liveness and staleness, whether a quoted sentence or claim " +
  "still appears on the cited page, with archive.org fallback) and whether a claimed USDC payment on Base really settled (to the right address, for the right amount).";
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

// ---------------------------------------------------------------- POST /verify/payment
export const PAY_INPUT_EXAMPLE = {
  tx_hash: "0x2d3fd6ac0f26fb81d8763c0a4dc723a3e209a9a5da12946cdc6c20dd587666c1",
  expect: { payee: "0x33190c9D2662F94A19CE88EA666f0ff8CeDe3700", amount_usdc: "0.10", min_confirmations: 12, x402: true },
};
export const VERDICTS_PAY = ["match", "mismatch", "not_settled", "not_found", "no_usdc_transfer"];
export const PAY_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    tx_hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$", description: "Base mainnet transaction hash of the claimed payment. Give this or payment_response.", title: "Tx Hash" },
    payment_response: { type: "string", maxLength: 8192, description: "Alternative to tx_hash: the base64 PAYMENT-RESPONSE (or X-PAYMENT-RESPONSE) header a seller returned after an x402 settlement. The transaction hash (and payer, if named) are taken from it.", title: "Payment Response" },
    network: { type: "string", enum: ["eip155:8453", "base"], default: "eip155:8453", description: "Only Base mainnet is supported.", title: "Network" },
    expect: {
      type: "object", additionalProperties: false,
      description: "The claim to check. Give at least one of payee, payer, amount_usdc, amount_atomic. Every field you give must be satisfied by one single USDC Transfer in the transaction.",
      properties: {
        payee: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "Address that should have received the USDC." },
        payer: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "Address that should have sent the USDC." },
        amount_usdc: { type: "string", description: "Decimal USDC amount with at most 6 decimals, e.g. \"0.02\". A JSON number is accepted too." },
        amount_atomic: { type: "string", description: "Same amount in USDC base units (6 decimals), e.g. \"20000\". If both are given they must agree." },
        amount_match: { type: "string", enum: ["exact", "at_least"], default: "exact" },
        min_confirmations: { type: "integer", minimum: 0, maximum: 1000000, description: "Require at least this many blocks on top (inclusive of the block itself). Base blocks are about 2 s apart." },
        not_before: { type: "string", description: "ISO-8601 time or unix seconds: the block must be at or after this." },
        not_after: { type: "string", description: "ISO-8601 time or unix seconds: the block must be at or before this." },
        x402: { type: "boolean", description: "true: require the EIP-3009 AuthorizationUsed pattern an x402 'exact' payment leaves; false: require its absence." },
      },
    },
    cross_check: { type: "boolean", default: true, description: "Ask a second, independent RPC node for the same receipt and report whether it agrees." },
  },
  required: ["expect"],
};
export const PAY_OUTPUT_EXAMPLE_FULL: any = {
  network: "eip155:8453", asset: "USDC", asset_address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  tx_hash: "0x2d3fd6ac0f26fb81d8763c0a4dc723a3e209a9a5da12946cdc6c20dd587666c1",
  verdict: "match", settled: true, matched: true,
  explanation: "Settled: the transaction succeeded and the chain shows a USDC Transfer of 0.10 from 0x33190c9d2662f94a19ce88ea666f0ff8cede3700 to 0x33190c9d2662f94a19ce88ea666f0ff8cede3700 that satisfies every field you supplied.",
  matched_transfer: { log_index: 637, from: "0x33190c9d2662f94a19ce88ea666f0ff8cede3700", to: "0x33190c9d2662f94a19ce88ea666f0ff8cede3700", amount_atomic: "100000", amount_usdc: "0.10" },
  matching_transfers: 1,
  checks: [
    { check: "tx_succeeded", expected: "success", actual: "success", pass: true },
    { check: "payee_received_usdc", expected: "0x33190c9d2662f94a19ce88ea666f0ff8cede3700", actual: "0x33190c9d2662f94a19ce88ea666f0ff8cede3700", pass: true },
    { check: "amount_exact", expected: "0.10", actual: "0.10", pass: true },
    { check: "min_confirmations", expected: 12, actual: 20848, pass: true },
    { check: "x402_exact_pattern", expected: true, actual: true, pass: true },
  ],
  finality: { block_number: 53118178, block_hash: "0x7b86fa1f816605dfd8a0fb11cf53c39e9177fd091cc88922027d66eb45271207", block_time: "2026-10-26T14:41:43.000Z", confirmations: 20848, finalized_block: 53138470, is_l1_finalized: true },
  x402: { eip3009_authorization_used: true, authorizer: "0x33190c9d2662f94a19ce88ea666f0ff8cede3700", submitted_by: "0xc6699d2aada6c36dfea5c248dd70f9cb0235cb63", submitted_to_usdc_contract: false, pattern: "eip3009_via_other_contract" },
  counterparty: { payer: "0x33190c9d2662f94a19ce88ea666f0ff8cede3700", payee: "0x33190c9d2662f94a19ce88ea666f0ff8cede3700", self_payment: true,
    note: "self_payment=true means payer and payee are the same address: the transfer is real but is not outside demand." },
  rpc: { primary: "mainnet.base.org", witnesses: ["mainnet.base.org", "base-rpc.publicnode.com"], independent_rpc_agrees: true },
  evidence: { receipt_sha256: "285677f045c5c4dcc33058f3f730d1fc3d770e130f39430745affeac5d8c2089", rpc_methods: ["eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber", "eth_blockNumber"] },
  caveats: [], limits: ["Reads Base mainnet state through public RPC nodes. A match shows the chain has that USDC Transfer; it does not show who controls either address, that anything was delivered, or where the payer's funds came from."],
  checked_at: "2026-10-27T02:16:38Z", took_ms: 173,
};
export const PAY_OUTPUT_EXAMPLE = { verdict: "match", settled: true, matched: true, matched_transfer: PAY_OUTPUT_EXAMPLE_FULL.matched_transfer,
  finality: { confirmations: 20848, is_l1_finalized: true }, counterparty: { self_payment: true }, checked_at: "2026-10-27T02:16:38Z", took_ms: 173 };
export const PAY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: VERDICTS_PAY, description: "match: every supplied field satisfied by one USDC Transfer in a successful tx. mismatch: tx is real but a field differs (see checks). not_settled: tx reverted. no_usdc_transfer: succeeded but moved no native USDC. not_found: no queried node has the receipt (absence of evidence, not proof)." },
    settled: { type: "boolean" }, matched: { type: "boolean" }, explanation: { type: "string" },
    matched_transfer: { type: ["object", "null"] }, matching_transfers: { type: "integer" },
    transfers: { type: "array", items: { type: "object" }, description: "Native-USDC Transfer logs in the transaction (max 25)." },
    checks: { type: "array", items: { type: "object", properties: { check: { type: "string" }, expected: {}, actual: {}, pass: { type: "boolean" } } } },
    finality: { type: "object" }, x402: { type: "object" }, counterparty: { type: ["object", "null"] }, rpc: { type: "object" }, evidence: { type: "object" },
    caveats: { type: "array", items: { type: "string" } }, limits: { type: "array", items: { type: "string" } },
    checked_at: { type: "string", format: "date-time", description: "UTC time the chain was read. Finality and confirmations are as of this time." },
    took_ms: { type: "integer" },
  },
  required: ["verdict", "checked_at"],
};
export const PAY_DESCRIPTION =
  "Verify a claimed USDC payment on Base: given a tx hash (or an x402 PAYMENT-RESPONSE header) and what you expect (payee, payer, amount, time window, " +
  "confirmations), reads the chain and returns match / mismatch / not_settled / not_found with per-field checks, finality, the x402 EIP-3009 pattern, " +
  "a self-payment flag and a second-RPC cross-check. Cannot show who owns an address or that a service was delivered.";
if (PAY_DESCRIPTION.length > 500) throw new Error("description too long");
