import { describe, expect, it } from "vitest";
import { matchClaim, matchQuote, normNum, regDomain } from "../src/checks";

const TEXT =
  "Life expectancy for the U.S. population in 2022 was 77.5 years. The death rate rose slightly. " +
  "Python is a high-level, general-purpose programming language. Its design philosophy emphasizes code readability.";

describe("matchQuote", () => {
  it("exact (case-insensitive) with occurrences", () => {
    const r = matchQuote("python is a high-level", TEXT);
    expect(r.match).toBe("exact");
    expect(r.score).toBe(100);
    expect(r.occurrences).toBe(1);
  });
  it("ignores punctuation differences", () => {
    expect(matchQuote("Python is a high level general purpose programming language", TEXT).match).toBe("exact_ignoring_punctuation");
  });
  it("fuzzy for a typo", () => {
    const r = matchQuote("Python is a high-level, general-purpose programing language", TEXT);
    expect(r.match).toBe("fuzzy");
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.matched_text.toLowerCase()).toContain("programming");
  });
  it("not_found for unrelated text", () => {
    expect(matchQuote("Completely unrelated sentence about zebras migrating", TEXT).match).toBe("not_found");
  });
});

describe("matchClaim", () => {
  it("supported when terms and numbers co-occur", () => {
    const r = matchClaim("US life expectancy in 2022 was 77.5 years", TEXT);
    expect(r.verdict).toBe("supported_lexically");
    expect(r.numbers_missing_from_page).toEqual([]);
  });
  it("partial when a number is missing", () => {
    const r = matchClaim("US life expectancy in 2022 was 78.4 years", TEXT);
    expect(r.verdict).toBe("partially_supported_lexically");
    expect(r.numbers_missing_from_page).toEqual(["78.4"]);
  });
  it("not_found when unrelated", () => {
    expect(matchClaim("Zebras migrate across the Serengeti", TEXT).verdict).toBe("not_found");
  });
});

describe("helpers", () => {
  it("normNum", () => {
    expect(normNum("1,000")).toBe("1000");
    expect(normNum("77.50")).toBe("77.5");
    expect(normNum("12%")).toBe("12");
  });
  it("regDomain", () => {
    expect(regDomain("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(regDomain("news.example.com")).toBe("example.com");
  });
});
