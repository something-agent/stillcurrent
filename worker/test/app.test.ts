import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { PAGE, html, json, noArchive, stubFetch } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const VARS = {
  CONTACT_EMAIL: "test@example.com",
  PAY_TO: "0x33190c9D2662F94A19CE88EA666f0ff8CeDe3700",
  X402_NETWORK: "eip155:8453",
  FACILITATOR_URL: "https://facilitator.payai.network",
  PRICE_URL_CHECK: "$0.01",
  PRICE_CITATION_CHECK: "$0.02",
  DEMO_ENABLED: "1",
};
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
let n = 0;
// a distinct env per test forces a fresh app (and payment middleware) instance
const call = (path: string, init: RequestInit = {}, env: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://stillcurrent.test${path}`, init), { ...VARS, ...env, BOT_CONTACT: `t${n++}` } as any, ctx);
const post = (path: string, body: unknown, env: Record<string, string> = {}, headers: Record<string, string> = {}) =>
  call(path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }, env);

/** Facilitator: advertises exact/eip155:8453 support; rejects any verify call. */
const facilitator = (u: URL) => {
  if (u.hostname !== "facilitator.payai.network") return undefined;
  if (u.pathname.endsWith("/supported")) return json({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
  if (u.pathname.endsWith("/verify")) return json({ isValid: false, invalidReason: "invalid_signature" });
  return json({}, 404);
};
const decode = (h: string | null) => JSON.parse(atob(h!));

describe("free routes", () => {
  it.each(["/", "/health", "/.well-known/x402", "/openapi.json", "/llms.txt", "/favicon.ico"])("%s -> 200", async (p) => {
    stubFetch(facilitator);
    const r = await call(p);
    expect(r.status).toBe(200);
  });
  it("/.well-known/x402 lists both paid resources", async () => {
    stubFetch(facilitator);
    const d = (await (await call("/.well-known/x402")).json()) as any;
    expect(JSON.stringify(d)).toContain("/check/url");
    expect(JSON.stringify(d)).toContain("/check/citation");
  });
  it("openapi has x-payment-info for paid operations", async () => {
    stubFetch(facilitator);
    const d = (await (await call("/openapi.json")).json()) as any;
    expect(d.openapi).toMatch(/^3\.1/);
    expect(JSON.stringify(d.paths["/check/url"])).toContain("x-payment-info");
  });
  it("/demo runs a free sample check", async () => {
    stubFetch(facilitator, noArchive, () => html(PAGE("Example Domain", "This domain is for use in documentation examples without needing permission.")));
    const r = await call("/demo");
    expect(r.status).toBe(200);
  });
  it("unknown route -> 404", async () => {
    stubFetch(facilitator);
    expect((await call("/nope")).status).toBe(404);
  });
});

describe("x402 payment gate", () => {
  it.each([
    ["/check/url", "10000"],
    ["/check/citation", "20000"],
  ])("unpaid POST %s -> 402 with a valid PAYMENT-REQUIRED header", async (path, amount) => {
    const calls = stubFetch(facilitator);
    const r = await post(path, { url: "https://example.com/", quote: "x" });
    expect(r.status).toBe(402);
    const pr = decode(r.headers.get("PAYMENT-REQUIRED"));
    expect(pr.x402Version).toBe(2);
    expect(pr.resource.url).toBe(`https://stillcurrent.test${path}`);
    expect(pr.resource.mimeType).toBe("application/json");
    expect(pr.accepts).toHaveLength(1);
    expect(pr.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:8453",
      amount,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x33190c9D2662F94A19CE88EA666f0ff8CeDe3700",
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" },
    });
    expect(pr.extensions.bazaar.info.input).toMatchObject({ type: "http", method: "POST", bodyType: "json" });
    expect(pr.extensions.bazaar.schema).toBeTruthy();
    expect(r.headers.get("access-control-expose-headers") ?? "").toMatch(/PAYMENT-REQUIRED/i);
    // no target fetch happened before payment
    expect(calls.filter((c) => c.includes("example.com"))).toEqual([]);
  });

  it("gate runs before validation (invalid body still gets 402)", async () => {
    stubFetch(facilitator);
    expect((await post("/check/url", "{not json")).status).toBe(402);
    expect((await post("/check/citation", {})).status).toBe(402);
  });

  it("a bogus PAYMENT-SIGNATURE is rejected with 402", async () => {
    stubFetch(facilitator);
    const r = await post("/check/url", { url: "https://example.com/" }, {}, { "PAYMENT-SIGNATURE": btoa("{}") });
    expect(r.status).toBe(402);
  });
});

describe("gate initialization", () => {
  it("concurrent first requests all get 402 (no shared init promise)", async () => {
    stubFetch(facilitator);
    const env = { BOT_CONTACT: "concurrency" };
    const reqs = ["POST", "GET", "PUT", "DELETE", "PATCH", "POST"].map((m) =>
      worker.fetch(new Request("https://stillcurrent.test/check/url", { method: m }), { ...VARS, ...env } as any, ctx),
    );
    const codes = (await Promise.all(reqs)).map((r) => r.status);
    expect(codes.filter((c) => c === 402).length).toBeGreaterThanOrEqual(2);
    expect(codes.every((c) => [402, 404, 405].includes(c))).toBe(true);
  });
  it("facilitator outage -> 503 with Retry-After, then recovers", async () => {
    stubFetch((u) => (u.hostname === "facilitator.payai.network" ? json({ error: "down" }, 502) : undefined));
    const env = { BOT_CONTACT: "outage" };
    const r1 = await worker.fetch(new Request("https://stillcurrent.test/check/url", { method: "POST" }), { ...VARS, ...env } as any, ctx);
    expect(r1.status).toBe(503);
    expect(r1.headers.get("retry-after")).toBe("30");
    vi.unstubAllGlobals();
    stubFetch(facilitator);
    const r2 = await worker.fetch(new Request("https://stillcurrent.test/check/url", { method: "POST" }), { ...VARS, ...env } as any, ctx);
    expect(r2.status).toBe(402);
  });
});

describe("test mode (X402_DISABLED=1)", () => {
  it("422 on invalid input, FastAPI-style", async () => {
    stubFetch();
    const r = await post("/check/url", { url: 5 }, { X402_DISABLED: "1" });
    expect(r.status).toBe(422);
    const d = (await r.json()) as any;
    expect(d.detail[0].loc).toEqual(["body", "url"]);
    expect((await post("/check/citation", { url: "https://example.com/" }, { X402_DISABLED: "1" })).status).toBe(422);
  });
  it("runs the check without payment", async () => {
    stubFetch(noArchive, (u) => (u.hostname === "example.com" ? html(PAGE("Example Domain", "Example text ".repeat(20))) : undefined));
    const r = await post("/check/url", { url: "https://example.com/" }, { X402_DISABLED: "1" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).verdict).toBe("live");
  });
});
