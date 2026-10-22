import { afterEach, describe, expect, it, vi } from "vitest";
import { deflateSync } from "node:zlib";
import { checkCitation, checkUrl } from "../src/checks";
import { pdfExtract } from "../src/pdf";
import { PAGE, html, json, noArchive, redirect, settings, stubFetch } from "./helpers";

afterEach(() => vi.unstubAllGlobals());
const S = settings();
const opts = { includeArchive: false };

describe("checkUrl verdicts", () => {
  it("live + fresh from meta modified date", async () => {
    const recent = new Date(Date.now() - 10 * 86400e3).toISOString();
    stubFetch((u) => (u.hostname === "docs.example.org" ? html(PAGE("Guide", "x".repeat(500), `<meta property="article:modified_time" content="${recent}">`)) : undefined));
    const { result } = await checkUrl("https://docs.example.org/guide", S, opts);
    expect(result.verdict).toBe("live");
    expect(result.freshness).toBe("fresh");
    expect(result.dates.last_updated.source).toBe("meta[article:modified_time]");
  });

  it("live_stale from an old Last-Modified header", async () => {
    stubFetch((u) => (u.hostname === "old.example.org" ? new Response("plain text body", { headers: { "content-type": "text/plain", "last-modified": "Mon, 27 Aug 2007 17:15:36 GMT" } }) : undefined));
    const { result } = await checkUrl("https://old.example.org/file.txt", S, opts);
    expect(result.verdict).toBe("live_stale");
    expect(result.dates.last_updated.source).toBe("http.Last-Modified");
  });

  it("dead on 404", async () => {
    stubFetch((u) => (u.hostname === "a.example.org" ? html(PAGE("Not here", "gone"), 404) : undefined));
    const { result } = await checkUrl("https://a.example.org/x", S, opts);
    expect(result.verdict).toBe("dead");
    expect(result.http.status).toBe(404);
  });

  it("soft_404 when a 200 page says not found", async () => {
    stubFetch((u) => (u.hostname === "b.example.org" ? html(PAGE("Page not found", "Sorry, the page you requested could not be found.")) : undefined));
    expect((await checkUrl("https://b.example.org/missing", S, opts)).result.verdict).toBe("soft_404");
  });

  it("moved_to_homepage on deep link redirect to root", async () => {
    stubFetch((u) =>
      u.hostname === "c.example.org" ? (u.pathname === "/" ? html(PAGE("Home", "welcome ".repeat(50))) : redirect("https://c.example.org/")) : undefined,
    );
    const { result } = await checkUrl("https://c.example.org/old/article", S, opts);
    expect(result.verdict).toBe("moved_to_homepage");
    expect(result.http.redirect_chain.map((h: any) => h.status)).toEqual([301, 200]);
  });

  it("redirected_cross_domain", async () => {
    stubFetch(
      (u) => (u.hostname === "d.example.org" ? redirect("https://other.example.net/page", 302) : undefined),
      (u) => (u.hostname === "other.example.net" ? html(PAGE("Other", "content ".repeat(50))) : undefined),
    );
    expect((await checkUrl("https://d.example.org/page", S, opts)).result.verdict).toBe("redirected_cross_domain");
  });

  it("parked domain", async () => {
    stubFetch((u) => (u.hostname === "e.example.org" ? html(PAGE("e.example.org", "This domain is for sale! Buy this domain today.")) : undefined));
    expect((await checkUrl("https://e.example.org/", S, opts)).result.verdict).toBe("parked");
  });

  it("invalid_target for private addresses, without fetching", async () => {
    const calls = stubFetch();
    for (const u of ["http://127.0.0.1/", "http://10.0.0.5/x", "http://localhost:8080/", "http://[::1]/", "http://169.254.169.254/latest/meta-data"]) {
      expect((await checkUrl(u, S, opts)).result.verdict).toBe("invalid_target");
    }
    expect(calls.filter((c) => !c.includes("web.archive.org"))).toEqual([]);
  });

  it("refuses a redirect into a private address", async () => {
    stubFetch((u) => (u.hostname === "f.example.org" ? redirect("http://192.168.1.1/admin") : undefined));
    expect((await checkUrl("https://f.example.org/", S, opts)).result.verdict).toBe("invalid_target");
  });

  it("archive lookup is reported", async () => {
    stubFetch(
      (u) => (u.hostname === "g.example.org" ? html(PAGE("G", "content ".repeat(50))) : undefined),
      (u) => (u.hostname === "web.archive.org" ? json([["timestamp", "original", "statuscode"], ["20240102030405", "https://g.example.org/", "200"]]) : undefined),
    );
    const { result } = await checkUrl("https://g.example.org/", S, { includeArchive: true });
    expect(result.archive.available).toBe(true);
    expect(result.archive.latest_ok.url).toBe("https://web.archive.org/web/20240102030405/https://g.example.org/");
  });
});

describe("checkCitation", () => {
  it("verified exact quote", async () => {
    stubFetch(noArchive, (u) => (u.hostname === "h.example.org" ? html(PAGE("H", "<p>The bridge opened to traffic in 1932 after six years of work.</p>")) : undefined));
    const r = await checkCitation("https://h.example.org/", "opened to traffic in 1932", null, S);
    expect(r.verdict).toBe("verified");
    expect(r.quote_match.match).toBe("exact");
  });

  it("not_found_on_page", async () => {
    stubFetch(noArchive, (u) => (u.hostname === "h.example.org" ? html(PAGE("H", "<p>Nothing relevant here at all, just text.</p>")) : undefined));
    const r = await checkCitation("https://h.example.org/", "opened to traffic in 1932", null, S);
    expect(r.verdict).toBe("not_found_on_page");
  });
});

describe("PDF extraction", () => {
  const pdf = (content: string, extraObjs = "", fontRes = "") => {
    const z = deflateSync(Buffer.from(content, "latin1"));
    const head =
      "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n" +
      `3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R ${fontRes} >> >> /Contents 4 0 R >> endobj\n` +
      `4 0 obj << /Length ${z.length} /Filter /FlateDecode >> stream\n`;
    const tail =
      "\nendstream endobj\n5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n" + extraObjs +
      "6 0 obj << /ModDate (D:20200102030405Z) /Title (Test doc) >> endobj\ntrailer << /Root 1 0 R /Info 6 0 R >>\n%%EOF";
    return new Uint8Array(Buffer.concat([Buffer.from(head, "latin1"), z, Buffer.from(tail, "latin1")]));
  };

  it("extracts Tj/TJ text with word gaps and metadata", async () => {
    const r = await pdfExtract(pdf("BT /F1 12 Tf 72 700 Td (Hello) Tj [(Wor) -20 (ld) -400 (again)] TJ 0 -14 Td (Next line) Tj ET"));
    expect(r.text).toContain("Hello");
    expect(r.text).toContain("World again");
    expect(r.text).toMatch(/again\s+Next line/);
    expect(r.meta.ModDate).toBe("D:20200102030405Z");
  });

  it("decodes hex strings through a ToUnicode CMap", async () => {
    const cmap = "begincmap 1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <01> <0048> <02> <0069> endbfchar endcmap";
    const z = deflateSync(Buffer.from(cmap, "latin1"));
    const extra = `7 0 obj << /Length ${z.length} /Filter /FlateDecode >> stream\n${z.toString("latin1")}\nendstream endobj\n8 0 obj << /Type /Font /Subtype /TrueType /ToUnicode 7 0 R >> endobj\n`;
    const r = await pdfExtract(pdf("BT /F2 12 Tf 72 700 Td <0102> Tj ET", extra, "/F2 8 0 R"));
    expect(r.text.trim()).toBe("Hi");
  });
});
