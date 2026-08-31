// Unit tests for the shared name/zid comparators. The load-bearing invariant
// is natural ordering of embedded digit runs: users number folders and notes
// to impose an order, and a lexicographic comparator silently defeats it by
// filing `10` between `1` and `2`.

import { describe, it, expect } from "vitest";
import { compareName, compareZid } from "./sort";

/** Sort a copy with `compareName` ascending, for readable assertions. */
const byName = (items: string[]) => [...items].sort(compareName);

describe("compareName", () => {
  it("orders digit runs numerically, not lexicographically", () => {
    expect(byName(["10 Chapter", "1 Chapter", "2 Chapter", "20 Chapter"])).toEqual([
      "1 Chapter",
      "2 Chapter",
      "10 Chapter",
      "20 Chapter",
    ]);
  });

  it("orders digits at the end of a name and in dotted versions", () => {
    expect(byName(["Note 11", "Note 2", "Note 1"])).toEqual(["Note 1", "Note 2", "Note 11"]);
    expect(byName(["v1.10.0", "v1.2.0", "v1.9.3"])).toEqual(["v1.2.0", "v1.9.3", "v1.10.0"]);
  });

  it("sorts a purely numeric filename set in numeric order", () => {
    expect(byName(["100.typ", "3.typ", "21.typ"])).toEqual(["3.typ", "21.typ", "100.typ"]);
  });

  it("does not report names differing only in case as equal", () => {
    // `sensitivity: "base"` would return 0 here, letting `Notes/` and `notes/`
    // swap places depending on the order the filesystem happened to yield.
    expect(compareName("Notes", "notes")).not.toBe(0);
  });

  it("orders case-only differences lowercase-first", () => {
    // Two folders differing only in case can coexist on a case-sensitive
    // filesystem, so they must be distinct and stably ordered rather than
    // reported equal.
    expect(byName(["NOTES", "notes", "Notes"])).toEqual(["notes", "Notes", "NOTES"]);
    expect(byName(["Ab", "aB"])).toEqual(["aB", "Ab"]);
  });

  it("sorts accented letters with their base letter, not after z", () => {
    expect(byName(["zebra", "Étude", "apple"])).toEqual(["apple", "Étude", "zebra"]);
  });

  it("matches the Rust collator exactly", () => {
    // Asserted verbatim by `matches_the_frontend_collator_exactly` in
    // src-tauri/src/sort.rs. Both sides run Unicode collation with numeric
    // ordering (ICU in the browser, ICU4X in Rust), so a file tree and a
    // collection table cannot disagree about the same notes. Change one side
    // and you must change the other.
    expect(
      byName([
        "10 Conclusion",
        "2 Methods",
        "1 Intro",
        "notes",
        "Notes",
        "NOTES",
        "Étude 10",
        "Étude 2",
        "archive",
        "Archive",
        "9 Results",
      ]),
    ).toEqual([
      "1 Intro",
      "2 Methods",
      "9 Results",
      "10 Conclusion",
      "archive",
      "Archive",
      "Étude 2",
      "Étude 10",
      "notes",
      "Notes",
      "NOTES",
    ]);
  });

  it("is reversible by swapping arguments, so descending mirrors ascending", () => {
    const asc = ["1 a", "2 a", "10 a"];
    expect([...asc].sort((a, b) => compareName(b, a))).toEqual(["10 a", "2 a", "1 a"]);
  });

  it("handles multi-byte names without desynchronizing", () => {
    expect(byName(["Étude 10", "Étude 2"])).toEqual(["Étude 2", "Étude 10"]);
    expect(byName(["日記 10", "日記 2"])).toEqual(["日記 2", "日記 10"]);
  });

  it("leaves fixed-width ISO date strings in chronological order", () => {
    expect(byName(["2026-06-14", "2026-06-02", "2025-12-31"])).toEqual([
      "2025-12-31",
      "2026-06-02",
      "2026-06-14",
    ]);
  });
});

describe("compareZid", () => {
  it("orders alphanumeric zids naturally", () => {
    const zids = ["z10", "z2", "z1"];
    expect([...zids].sort((a, b) => compareZid(a, b, "asc"))).toEqual(["z1", "z2", "z10"]);
  });

  it("keeps missing zids last in both directions", () => {
    expect(compareZid(null, "z1", "asc")).toBeGreaterThan(0);
    expect(compareZid(null, "z1", "desc")).toBeGreaterThan(0);
    expect(compareZid(null, null, "asc")).toBe(0);
  });
});
