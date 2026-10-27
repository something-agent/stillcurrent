/** Request-body validation with FastAPI-style 422 errors. */
export interface ValidationError { loc: (string | number)[]; msg: string; type: string }

export interface UrlCheckRequest { url: string; stale_after_days: number; include_archive: boolean }
export interface CitationCheckRequest { url: string; quote: string | null; claim: string | null; stale_after_days: number; check_archive_if_missing: boolean }

function checkUrlField(body: any, errs: ValidationError[]): string {
  const v = body?.url;
  if (v === undefined || v === null) { errs.push({ loc: ["body", "url"], msg: "Field required", type: "missing" }); return ""; }
  if (typeof v !== "string") { errs.push({ loc: ["body", "url"], msg: "Input should be a valid string", type: "string_type" }); return ""; }
  if (v.length > 2048) errs.push({ loc: ["body", "url"], msg: "String should have at most 2048 characters", type: "string_too_long" });
  const t = v.trim();
  if (!/^https?:\/\//i.test(t)) errs.push({ loc: ["body", "url"], msg: "Value error, url must start with http:// or https://", type: "value_error" });
  return t;
}

function intField(body: any, key: string, dflt: number, lo: number, hi: number, errs: ValidationError[]): number {
  const v = body?.[key];
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v)) { errs.push({ loc: ["body", key], msg: "Input should be a valid integer", type: "int_type" }); return dflt; }
  if (v < lo) errs.push({ loc: ["body", key], msg: `Input should be greater than or equal to ${lo}`, type: "greater_than_equal" });
  if (v > hi) errs.push({ loc: ["body", key], msg: `Input should be less than or equal to ${hi}`, type: "less_than_equal" });
  return v;
}

function boolField(body: any, key: string, dflt: boolean, errs: ValidationError[]): boolean {
  const v = body?.[key];
  if (v === undefined) return dflt;
  if (typeof v !== "boolean") { errs.push({ loc: ["body", key], msg: "Input should be a valid boolean", type: "bool_type" }); return dflt; }
  return v;
}

function optStr(body: any, key: string, max: number, errs: ValidationError[]): string | null {
  const v = body?.[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") { errs.push({ loc: ["body", key], msg: "Input should be a valid string", type: "string_type" }); return null; }
  if (v.length > max) errs.push({ loc: ["body", key], msg: `String should have at most ${max} characters`, type: "string_too_long" });
  return v;
}

function asObject(body: unknown, errs: ValidationError[]): any {
  if (body === undefined) { errs.push({ loc: ["body"], msg: "Field required", type: "missing" }); return null; }
  if (!body || typeof body !== "object" || Array.isArray(body)) { errs.push({ loc: ["body"], msg: "Input should be a valid dictionary or object", type: "model_attributes_type" }); return null; }
  return body;
}

export function validateUrlCheck(raw: unknown): { ok: true; value: UrlCheckRequest } | { ok: false; errors: ValidationError[] } {
  const errs: ValidationError[] = [];
  const body = asObject(raw, errs);
  if (!body) return { ok: false, errors: errs };
  const value = { url: checkUrlField(body, errs), stale_after_days: intField(body, "stale_after_days", 365, 1, 36500, errs), include_archive: boolField(body, "include_archive", true, errs) };
  return errs.length ? { ok: false, errors: errs } : { ok: true, value };
}

export function validateCitationCheck(raw: unknown): { ok: true; value: CitationCheckRequest } | { ok: false; errors: ValidationError[] } {
  const errs: ValidationError[] = [];
  const body = asObject(raw, errs);
  if (!body) return { ok: false, errors: errs };
  const value = {
    url: checkUrlField(body, errs),
    quote: optStr(body, "quote", 2000, errs),
    claim: optStr(body, "claim", 1000, errs),
    stale_after_days: intField(body, "stale_after_days", 365, 1, 36500, errs),
    check_archive_if_missing: boolField(body, "check_archive_if_missing", true, errs),
  };
  if (!errs.length && !(value.quote && value.quote.trim()) && !(value.claim && value.claim.trim()))
    errs.push({ loc: ["body"], msg: "Value error, provide at least one of 'quote' or 'claim'", type: "value_error" });
  return errs.length ? { ok: false, errors: errs } : { ok: true, value };
}

export interface UrlsCheckRequest { urls: string[] }

export function validateUrlsCheck(raw: unknown, maxUrls = 25): { ok: true; value: UrlsCheckRequest } | { ok: false; errors: ValidationError[] } {
  const errs: ValidationError[] = [];
  const body = asObject(raw, errs);
  if (!body) return { ok: false, errors: errs };
  const v = body.urls;
  if (v === undefined || v === null) return { ok: false, errors: [{ loc: ["body", "urls"], msg: "Field required", type: "missing" }] };
  if (!Array.isArray(v)) return { ok: false, errors: [{ loc: ["body", "urls"], msg: "Input should be a valid list", type: "list_type" }] };
  if (v.length < 1) errs.push({ loc: ["body", "urls"], msg: "List should have at least 1 item", type: "too_short" });
  if (v.length > maxUrls) errs.push({ loc: ["body", "urls"], msg: `List should have at most ${maxUrls} items`, type: "too_long" });
  const urls: string[] = [];
  v.slice(0, maxUrls).forEach((u: unknown, i: number) => {
    const e: ValidationError[] = [];
    const t = checkUrlField({ url: u }, e);
    for (const x of e) errs.push({ ...x, loc: ["body", "urls", i] });
    urls.push(t);
  });
  return errs.length ? { ok: false, errors: errs } : { ok: true, value: { urls } };
}

// ------------------------------------------------------------------ POST /verify/payment
import type { PaymentRequest } from "./receipt";
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

function addrField(obj: any, key: string, loc: (string | number)[], errs: ValidationError[]): string | null {
  const v = obj?.[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") { errs.push({ loc: [...loc, key], msg: "Input should be a valid string", type: "string_type" }); return null; }
  if (!ADDR.test(v.trim())) { errs.push({ loc: [...loc, key], msg: "Value error, must be a 0x-prefixed 20-byte hex address", type: "value_error" }); return null; }
  return v.trim().toLowerCase();
}

/** "0.02" (string) or a JSON number with at most 6 decimals -> atomic USDC units. */
export function parseUsdcAmount(v: unknown): bigint | null {
  const str = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : typeof v === "string" ? v.trim() : "";
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(str)) return null;
  const [w, f = ""] = str.split(".");
  return BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, "0"));
}

function timeField(obj: any, key: string, errs: ValidationError[]): number | null {
  const v = obj?.[key];
  if (v === undefined || v === null) return null;
  let t: number | null = null;
  if (typeof v === "number" && Number.isInteger(v) && v > 1_400_000_000 && v < 4_000_000_000) t = v;
  else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) { const ms = Date.parse(v); if (Number.isFinite(ms)) t = Math.floor(ms / 1000); }
  if (t === null) errs.push({ loc: ["body", "expect", key], msg: "Value error, use an ISO-8601 time (e.g. 2026-10-26T15:00:00Z) or unix seconds", type: "value_error" });
  return t;
}

const PAY_ALIASES: Record<string, string> = { amount: "amount_usdc", amount_usd: "amount_usdc", value: "amount_usdc", to: "payee", from: "payer", payto: "payee", pay_to: "payee", confirmations: "min_confirmations", hash: "tx_hash", transaction: "tx_hash", txhash: "tx_hash" };
/** Optimal-string-alignment edit distance (insert, delete, substitute, adjacent swap). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
/** Likely intended key: a curated alias for common wrong *names* (amount -> amount_usdc), else the
 *  nearest permitted key for *typos/truncations* (edit distance <= 2, or a unique prefix of >= 4 chars). */
export function suggestKey(k: string, allowed: Set<string>): string | null {
  const lk = k.toLowerCase();
  const alias = PAY_ALIASES[lk];
  if (alias && allowed.has(alias)) return alias;
  let best: string | null = null, bestD = Infinity, tie = false;
  for (const a of allowed) {
    const dist = editDistance(lk, a);
    if (dist < bestD) { best = a; bestD = dist; tie = false; } else if (dist === bestD) tie = true;
  }
  if (best && bestD <= 2 && !tie) return best;
  const pre = lk.length >= 4 ? [...allowed].filter((a) => a.startsWith(lk)) : [];
  return pre.length === 1 ? pre[0] : null;
}
// An unknown key costs the caller a round trip; name the permitted keys (and the likely intended one) in the free 422.
function extraMsg(k: string, allowed: Set<string>): string {
  const guess = suggestKey(k, allowed);
  return `Extra inputs are not permitted. Permitted keys here: ${[...allowed].join(", ")}` + (guess ? `. Did you mean '${guess}'?` : "");
}

export function validatePaymentVerify(raw: unknown): { ok: true; value: PaymentRequest } | { ok: false; errors: ValidationError[] } {
  const errs: ValidationError[] = [];
  const body = asObject(raw, errs);
  if (!body) return { ok: false, errors: errs };
  const allowed = new Set(["tx_hash", "payment_response", "network", "expect", "cross_check"]);
  for (const k of Object.keys(body)) if (!allowed.has(k)) errs.push({ loc: ["body", k], msg: extraMsg(k, allowed), type: "extra_forbidden" });

  let txHash: string | null = null;
  const th = body.tx_hash;
  if (th !== undefined && th !== null) {
    if (typeof th !== "string") errs.push({ loc: ["body", "tx_hash"], msg: "Input should be a valid string", type: "string_type" });
    else if (!HASH.test(th.trim())) errs.push({ loc: ["body", "tx_hash"], msg: "Value error, must be a 0x-prefixed 32-byte hex transaction hash", type: "value_error" });
    else txHash = th.trim().toLowerCase();
  }
  let claimedPayer: string | null = null;
  const pr = body.payment_response;
  if (pr !== undefined && pr !== null) {
    if (typeof pr !== "string" || pr.length > 8192) errs.push({ loc: ["body", "payment_response"], msg: "Input should be a base64 string of at most 8192 characters", type: "string_type" });
    else {
      let d: any = null;
      try { d = JSON.parse(atob(pr.trim().replace(/-/g, "+").replace(/_/g, "/"))); } catch { /* handled below */ }
      const t = d && typeof d === "object" ? d.transaction : null;
      if (typeof t !== "string" || !HASH.test(t)) errs.push({ loc: ["body", "payment_response"], msg: "Value error, not a base64 PAYMENT-RESPONSE header with a 'transaction' hash", type: "value_error" });
      else if (d.network !== undefined && d.network !== "eip155:8453" && d.network !== "base") errs.push({ loc: ["body", "payment_response"], msg: "Value error, network in the header is not Base mainnet (eip155:8453)", type: "value_error" });
      else if (d.success === false) errs.push({ loc: ["body", "payment_response"], msg: "Value error, header reports success=false (no settlement to verify)", type: "value_error" });
      else {
        if (txHash !== null && txHash !== t.toLowerCase()) errs.push({ loc: ["body"], msg: "Value error, tx_hash and payment_response name different transactions", type: "value_error" });
        txHash = t.toLowerCase();
        if (typeof d.payer === "string" && ADDR.test(d.payer)) claimedPayer = d.payer.toLowerCase();
      }
    }
  }
  if (txHash === null && !errs.length) errs.push({ loc: ["body"], msg: "Value error, provide 'tx_hash' (or a 'payment_response' header value)", type: "value_error" });

  const net = body.network;
  if (net !== undefined && net !== null && net !== "eip155:8453" && net !== "base") errs.push({ loc: ["body", "network"], msg: "Value error, only Base mainnet is supported: 'eip155:8453' (or 'base')", type: "value_error" });

  const ex = body.expect;
  if (ex === undefined || ex === null) errs.push({ loc: ["body", "expect"], msg: "Field required", type: "missing" });
  else if (typeof ex !== "object" || Array.isArray(ex)) errs.push({ loc: ["body", "expect"], msg: "Input should be a valid dictionary or object", type: "model_attributes_type" });
  const e: any = ex && typeof ex === "object" && !Array.isArray(ex) ? ex : {};
  const eAllowed = new Set(["payee", "payer", "amount_usdc", "amount_atomic", "amount_match", "min_confirmations", "not_before", "not_after", "x402"]);
  for (const k of Object.keys(e)) if (!eAllowed.has(k)) errs.push({ loc: ["body", "expect", k], msg: extraMsg(k, eAllowed), type: "extra_forbidden" });
  const payee = addrField(e, "payee", ["body", "expect"], errs);
  const payer = addrField(e, "payer", ["body", "expect"], errs);
  let amount: bigint | null = null;
  if (e.amount_usdc !== undefined && e.amount_usdc !== null) {
    amount = parseUsdcAmount(e.amount_usdc);
    if (amount === null) errs.push({ loc: ["body", "expect", "amount_usdc"], msg: "Value error, use a decimal USDC amount with at most 6 decimals, e.g. \"0.02\"", type: "value_error" });
  }
  if (e.amount_atomic !== undefined && e.amount_atomic !== null) {
    const a = e.amount_atomic;
    const s = typeof a === "number" && Number.isSafeInteger(a) && a >= 0 ? String(a) : typeof a === "string" ? a.trim() : "";
    if (!/^\d{1,18}$/.test(s)) errs.push({ loc: ["body", "expect", "amount_atomic"], msg: "Value error, use a non-negative integer of USDC base units (6 decimals), e.g. \"20000\"", type: "value_error" });
    else {
      if (amount !== null && amount !== BigInt(s)) errs.push({ loc: ["body", "expect"], msg: "Value error, amount_usdc and amount_atomic disagree", type: "value_error" });
      amount = BigInt(s);
    }
  }
  const am = e.amount_match;
  if (am !== undefined && am !== null && am !== "exact" && am !== "at_least") errs.push({ loc: ["body", "expect", "amount_match"], msg: "Input should be 'exact' or 'at_least'", type: "enum" });
  let minConf: number | null = null;
  if (e.min_confirmations !== undefined && e.min_confirmations !== null) {
    const c = e.min_confirmations;
    if (typeof c !== "number" || !Number.isInteger(c) || c < 0 || c > 1_000_000) errs.push({ loc: ["body", "expect", "min_confirmations"], msg: "Input should be an integer between 0 and 1000000", type: "int_type" });
    else minConf = c;
  }
  const notBefore = timeField(e, "not_before", errs);
  const notAfter = timeField(e, "not_after", errs);
  if (notBefore !== null && notAfter !== null && notBefore > notAfter) errs.push({ loc: ["body", "expect"], msg: "Value error, not_before is after not_after", type: "value_error" });
  let x402: boolean | null = null;
  if (e.x402 !== undefined && e.x402 !== null) { if (typeof e.x402 !== "boolean") errs.push({ loc: ["body", "expect", "x402"], msg: "Input should be a valid boolean", type: "bool_type" }); else x402 = e.x402; }
  if (ex && typeof ex === "object" && !errs.length && payee === null && payer === null && amount === null)
    errs.push({ loc: ["body", "expect"], msg: "Value error, give at least one of payee, payer, amount_usdc or amount_atomic to check", type: "value_error" });
  let cross = true;
  if (body.cross_check !== undefined && body.cross_check !== null) { if (typeof body.cross_check !== "boolean") errs.push({ loc: ["body", "cross_check"], msg: "Input should be a valid boolean", type: "bool_type" }); else cross = body.cross_check; }

  if (errs.length) return { ok: false, errors: errs };
  return { ok: true, value: { tx_hash: txHash!, claimed_payer: claimedPayer,
    expect: { payee, payer, amount_atomic: amount, amount_match: am === "at_least" ? "at_least" : "exact", min_confirmations: minConf, not_before: notBefore, not_after: notAfter, x402 },
    cross_check: cross } };
}
