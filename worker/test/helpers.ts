import { vi } from "vitest";
import { loadSettings, type Env } from "../src/config";

export type Route = (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined;

/** Replace global fetch with a router; unmatched requests fail like a refused connection. */
export function stubFetch(...routes: Route[]) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(u.href);
    for (const r of routes) {
      const res = await r(u, init);
      if (res) return res;
    }
    throw new TypeError(`fetch failed: no stub for ${u.href}`);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

export const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
export const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
export const redirect = (to: string, status = 301) => new Response(null, { status, headers: { location: to } });

/** archive.org CDX: no snapshots; Wikipedia/legislation APIs are not hit for these hosts. */
export const noArchive: Route = (u) => (u.hostname === "web.archive.org" ? json([]) : undefined);

export const settings = (env: Env = {}) => loadSettings({ CONTACT_EMAIL: "test@example.com", ...env });

export const PAGE = (title: string, body: string, head = "") =>
  `<!doctype html><html><head><title>${title}</title>${head}</head><body><main>${body}</main></body></html>`;
