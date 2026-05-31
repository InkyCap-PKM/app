import { describe, it, expect } from "vitest";
import { wikilinkScore } from "./wikilink-match";

describe("wikilinkScore", () => {
  it("matches everything on an empty query", () => {
    expect(wikilinkScore("", "Anything")).toBe(0);
  });

  it("ranks an exact (case-insensitive) match highest", () => {
    const exact = wikilinkScore("cirfa", "CIRFA")!;
    const substr = wikilinkScore("cirfa", "CIRFA Annual Report")!;
    expect(exact).not.toBeNull();
    expect(exact).toBeGreaterThan(substr);
  });

  it("does not match scattered letters (no loose subsequence)", () => {
    // "cirfa" is NOT a contiguous substring of "Acadia University".
    expect(wikilinkScore("cirfa", "Acadia University")).toBeNull();
  });

  it("returns null for a nonsense multi-token query", () => {
    // Neither "asd" nor "dthe" is a substring of these names.
    expect(wikilinkScore("asd dthe", "Acadia University")).toBeNull();
    expect(wikilinkScore("asd dthe", "Brock University")).toBeNull();
  });

  it("ranks a whole-string prefix above a mid-word substring", () => {
    const prefix = wikilinkScore("aca", "Acadia University")!;
    const mid = wikilinkScore("aca", "Université de l'Acadie")!;
    expect(prefix).toBeGreaterThan(mid);
  });

  it("matches a multi-word query when every token is a substring", () => {
    expect(
      wikilinkScore("digital humanities", "Alliance of Digital Humanities Organizations"),
    ).not.toBeNull();
    expect(
      wikilinkScore("digital zzz", "Alliance of Digital Humanities Organizations"),
    ).toBeNull();
  });

  it("prefers shorter (more specific) targets among substring matches", () => {
    const short = wikilinkScore("uni", "Uni")!;
    const long = wikilinkScore("uni", "Uniabcdefghij")!;
    expect(short).toBeGreaterThan(long);
  });
});
