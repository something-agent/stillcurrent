import { describe, expect, it } from "vitest";
import * as tu from "../src/textutil";

describe("parseDate", () => {
  const iso = (s: string) => tu.parseDate(s)?.toISOString().slice(0, 10) ?? null;
  it.each([
    ["2024-03-12", "2024-03-12"],
    ["2024-03-12T10:00:00Z", "2024-03-12"],
    ["20240312", "2024-03-12"],
    ["12 March 2024", "2024-03-12"],
    ["March 12, 2024", "2024-03-12"],
    ["Mar 12, 2024", "2024-03-12"],
  ])("%s", (inp, out) => expect(iso(inp)).toBe(out));
  it("rejects implausible dates", () => {
    expect(tu.parseDate("1850-01-01")).toBeNull();
    expect(tu.parseDate("2999-01-01")).toBeNull();
    expect(tu.parseDate("not a date")).toBeNull();
  });
});

describe("parseHtml", () => {
  const doc = `<html><head><title>T &amp; Co</title>
    <meta property="article:modified_time" content="2025-01-02T03:04:05Z">
    <script type="application/ld+json">{"@type":"Article","datePublished":"2024-05-06"}</script>
    <style>.x{}</style></head><body><nav>menu</nav><p>Hello&nbsp;<b>world</b> &#8212; ok</p>
    <time class="updated" datetime="2023-07-08">July</time><script>var x=1</script></body></html>`;
  const p = tu.parseHtml(doc);
  it("title and text", () => {
    expect(p.title).toBe("T & Co");
    expect(p.text).toContain("Hello world");
    expect(p.text).not.toContain("var x");
  });
  it("finds date candidates", () => {
    const c = tu.extractDateCandidates(p, null);
    const srcs = c.map((x) => `${x.kind}:${x.source}:${x.date.slice(0, 10)}`);
    expect(srcs.join(" ")).toContain("2025-01-02");
    expect(srcs.join(" ")).toContain("published");
    expect(srcs.join(" ")).toContain("2024-05-06");
    expect(srcs.join(" ")).toContain("time[updated]:2023-07-08");
  });
});

describe("normalize", () => {
  it("folds quotes, dashes, whitespace and compatibility forms", () => {
    expect(tu.normalize("“Smart”  ‘quotes’ — ﬁne\n")).toBe(`"Smart" 'quotes' - fine`);
  });
});
