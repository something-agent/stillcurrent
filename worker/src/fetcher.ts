/**
 * Safe HTTP fetching with manual redirect handling and target checks.
 *
 * Every hop (initial URL and each redirect target) is checked: http/https only, no URL credentials,
 * no localhost-style names, no non-public IP literals. On Cloudflare Workers, outbound fetch() leaves
 * from Cloudflare's edge, which cannot reach the operator's private network, so hostname-to-private-IP
 * DNS tricks do not expose internal services the way they would on a VM. Bodies are size-capped and
 * requests are time-capped. Each hop is one Workers subrequest (free plan: 50 per invocation).
 */
import type { Settings } from "./config";

export const MAX_REDIRECTS = 8;
export const DEFAULT_TIMEOUT_MS = 15_000;

export class BlockedTarget extends Error {}

export interface Hop {
  url: string;
  status: number | null;
  location?: string | null;
}

export interface FetchResult {
  requestedUrl: string;
  finalUrl: string | null;
  status: number | null;
  hops: Hop[];
  headers: Record<string, string>;
  body: Uint8Array;
  truncated: boolean;
  error: string | null; // dns_error, connect_error, timeout, tls_error, blocked_target, too_many_redirects, http_error
  errorDetail: string | null;
  elapsedMs: number;
}

export function emptyResult(url: string): FetchResult {
  return { requestedUrl: url, finalUrl: null, status: null, hops: [], headers: {}, body: new Uint8Array(0), truncated: false, error: null, errorDetail: null, elapsedMs: 0 };
}

export function contentType(fr: FetchResult): string {
  return (fr.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
}

export function charset(fr: FetchResult): string | null {
  const ct = fr.headers["content-type"] || "";
  for (const part of ct.split(";").slice(1)) {
    const [k, ...rest] = part.trim().split("=");
    const v = rest.join("=");
    if (k.toLowerCase() === "charset" && v) return v.replace(/["' ]/g, "");
  }
  return null;
}

export function textOf(fr: FetchResult): string {
  const enc = charset(fr) || "utf-8";
  try {
    return new TextDecoder(enc).decode(fr.body);
  } catch {
    return new TextDecoder("utf-8").decode(fr.body);
  }
}

// ------------------------------------------------------------------ target checks
function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

const V4_BLOCKS: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

export function isPublicIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  for (const [base, bits] of V4_BLOCKS) {
    const b = ipv4ToInt(base)!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((n & mask) >>> 0) === ((b & mask) >>> 0)) return false;
  }
  return true;
}

export function isPublicIPv6(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (s === "::" || s === "::1") return false;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIPv4(mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(s)) return false; // hex-form mapped v4: refuse
  if (/^f[cd]/.test(s)) return false; // fc00::/7 ULA
  if (/^fe[89ab]/.test(s)) return false; // fe80::/10 link-local
  if (/^ff/.test(s)) return false; // multicast
  if (/^2001:0?db8:/.test(s)) return false; // documentation
  if (/^(64:ff9b|100):/.test(s)) return false; // NAT64 / discard
  return true;
}

export function assertPublicUrl(raw: string, settings: Settings): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedTarget("not a valid absolute URL");
  }
  const scheme = u.protocol.replace(":", "");
  if (scheme !== "http" && scheme !== "https") throw new BlockedTarget(`scheme '${scheme}' not allowed (http/https only)`);
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) throw new BlockedTarget("URL has no host");
  if (u.username || u.password) throw new BlockedTarget("credentials in URL are not allowed");
  if (settings.allowPrivateTargets) return;
  if (host === "localhost" || host === "localhost.localdomain" || /\.(local|internal|localhost)$/.test(host))
    throw new BlockedTarget("local hostnames are not allowed");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (!isPublicIPv4(host)) throw new BlockedTarget("host is a non-public address");
  } else if (host.startsWith("[") || host.includes(":")) {
    if (!isPublicIPv6(host)) throw new BlockedTarget("host is a non-public address");
  } else if (/^[0-9.x]+$/.test(host) || /^\d+$/.test(host)) {
    throw new BlockedTarget("numeric host forms are not allowed");
  } else if (!host.includes(".")) {
    throw new BlockedTarget("single-label hostnames are not allowed");
  }
}

// --------------------------------------------------------------- DNS diagnostics
const DOH_URL = "https://cloudflare-dns.com/dns-query";

/** Called only after a fetch failed: distinguishes NXDOMAIN / no records from connection errors (1-2 subrequests). */
export async function dnsProblem(host: string): Promise<string | null> {
  if (/^[\d.]+$/.test(host) || host.includes(":")) return null;
  try {
    let any = false;
    for (const t of ["A", "AAAA"]) {
      const r = await fetch(`${DOH_URL}?name=${encodeURIComponent(host)}&type=${t}`, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(6000),
      });
      const d: any = await r.json();
      if (d.Status === 3) return "NXDOMAIN (domain does not exist)";
      if (d.Status !== 0 && d.Status !== undefined) return `DNS error status ${d.Status}`;
      if ((d.Answer || []).some((a: any) => a.type === 1 || a.type === 28)) any = true;
      if (any) return null;
    }
    return any ? null : "no A/AAAA records";
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------ fetch
export interface FetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  userAgent?: string;
  accept?: string;
}

async function readCapped(resp: Response, maxBytes: number): Promise<{ body: Uint8Array; truncated: boolean }> {
  if (!resp.body) return { body: new Uint8Array(0), truncated: false };
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= maxBytes) {
      truncated = true;
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
  }
  const out = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const n = Math.min(c.byteLength, out.byteLength - off);
    out.set(c.subarray(0, n), off);
    off += n;
    if (off >= out.byteLength) break;
  }
  return { body: out, truncated };
}

export function classifyError(e: unknown): { code: string; detail: string } {
  const name = (e as any)?.name || "Error";
  const msg = String((e as any)?.message || e).slice(0, 300);
  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out/i.test(msg)) return { code: "timeout", detail: name };
  if (/ssl|tls|certificate/i.test(msg)) return { code: "tls_error", detail: msg };
  return { code: "connect_error", detail: msg };
}

/** GET a URL, following up to MAX_REDIRECTS redirects manually (each hop is checked). */
export async function safeFetch(url: string, settings: Settings, opts: FetchOptions = {}): Promise<FetchResult> {
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const res = emptyResult(url);
  const t0 = Date.now();
  const headers: Record<string, string> = { "User-Agent": opts.userAgent || settings.userAgent };
  if (opts.accept === undefined) {
    headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7";
    headers["Accept-Language"] = "en;q=0.9,*;q=0.5";
  } else {
    headers["Accept"] = opts.accept;
  }
  const deadline = t0 + timeoutMs + 5000;
  let current = url;
  try {
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      try {
        assertPublicUrl(current, settings);
      } catch (e) {
        res.error = "blocked_target";
        res.errorDetail = (e as Error).message;
        return res;
      }
      const remaining = Math.max(1000, deadline - Date.now());
      let resp: Response;
      try {
        resp = await fetch(current, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(Math.min(timeoutMs, remaining)) });
      } catch (e) {
        const host = new URL(current).hostname;
        const dns = await dnsProblem(host);
        if (dns) {
          res.error = "dns_error";
          res.errorDetail = dns;
        } else {
          const c = classifyError(e);
          res.error = c.code;
          res.errorDetail = c.detail;
        }
        res.hops.push({ url: current, status: null });
        return res;
      }
      const loc = resp.headers.get("location");
      // Cloudflare edge answers 530 (error 1016) when the origin hostname does not resolve.
      if (resp.status === 530) {
        const dns = await dnsProblem(new URL(current).hostname);
        if (dns) {
          try { await resp.body?.cancel(); } catch { /* ignore */ }
          res.error = "dns_error";
          res.errorDetail = dns;
          res.hops.push({ url: current, status: null });
          return res;
        }
      }
      res.hops.push({ url: current, status: resp.status, location: loc });
      if ([301, 302, 303, 307, 308].includes(resp.status) && loc) {
        try { await resp.body?.cancel(); } catch { /* ignore */ }
        try {
          current = new URL(loc, current).toString();
        } catch {
          res.error = "http_error";
          res.errorDetail = `invalid redirect location: ${loc.slice(0, 200)}`;
          return res;
        }
        continue;
      }
      res.finalUrl = current;
      res.status = resp.status;
      resp.headers.forEach((v, k) => { res.headers[k.toLowerCase()] = v; });
      try {
        const { body, truncated } = await readCapped(resp, maxBytes);
        res.body = body;
        res.truncated = truncated;
      } catch (e) {
        const c = classifyError(e);
        res.error = c.code === "connect_error" ? "http_error" : c.code;
        res.errorDetail = c.detail;
      }
      return res;
    }
    res.error = "too_many_redirects";
    res.errorDetail = `>${MAX_REDIRECTS} redirects`;
    return res;
  } finally {
    res.elapsedMs = Date.now() - t0;
  }
}
