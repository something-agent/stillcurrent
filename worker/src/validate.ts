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
