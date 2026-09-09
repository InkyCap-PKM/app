import { describe, it, expect } from "vitest";
import { fuzzyMatch, substringMatch, compareMatches } from "./fuzzy";

// Quick open used to rank purely on points, and points rewarded matching at a
// word boundary. A three-letter query could therefore collect three boundary
// bonuses from letters scattered across a long name and beat a note whose name
// spells the query out. Ranking is now decided by the kind of match first.

/** Names ordered the way a picker would list them for `query`. */
function ranked(query: string, names: string[]): string[] {
  return names
    .map((name) => ({ name, match: fuzzyMatch(query, name) }))
    .filter((r) => r.match !== null)
    .sort((a, b) => compareMatches(a.match!, b.match!))
    .map((r) => r.name);
}

describe("contiguous matches rank above scattered ones", () => {
  const NAMES = [
    "Publishing Data Archives",
    "Personal Data Archive",
    "PDA notes",
    "Project Data Analysis and Reporting",
    "PDA",
  ];

  it("puts the exact name first and the contiguous matches next", () => {
    expect(ranked("PDA", NAMES).slice(0, 2)).toEqual(["PDA", "PDA notes"]);
  });

  it("keeps the scattered matches, but below every contiguous one", () => {
    const order = ranked("PDA", NAMES);
    // The scattered ones still appear — quick open stays forgiving.
    expect(order).toContain("Publishing Data Archives");
    expect(order.slice(0, 2)).toEqual(["PDA", "PDA notes"]);
    expect(order.indexOf("PDA notes")).toBeLessThan(
      order.indexOf("Personal Data Archive"),
    );
  });

  it("leads with kind because points alone still pick the wrong name", () => {
    // Points reward an early match and a short name, so a run buried at the
    // end of a long name scores less than three letters that happen to land
    // on word boundaries. Kind is what stops the wrong one winning.
    const contiguous = fuzzyMatch(
      "PDA",
      "Notes from the working group on handheld computing hardware, software and the rest of the update process",
    )!;
    const scattered = fuzzyMatch("PDA", "Publishing Data Archives")!;
    expect(contiguous.kind).toBe("substring");
    expect(scattered.kind).toBe("scattered");
    expect(scattered.score).toBeGreaterThan(contiguous.score);
    expect(compareMatches(contiguous, scattered)).toBeLessThan(0);
  });
});

describe("match kinds", () => {
  it("labels an exact name, ignoring case and surrounding space", () => {
    expect(fuzzyMatch("pda", "PDA")!.kind).toBe("exact");
    expect(fuzzyMatch("PDA", " PDA ")!.kind).toBe("exact");
  });

  it("labels an unbroken run inside a longer name", () => {
    expect(fuzzyMatch("cap", "InkyCap")!.kind).toBe("substring");
  });

  it("labels letters found in order with gaps", () => {
    expect(fuzzyMatch("inkbuild", "InkyCap - Build Binaries")!.kind).toBe("scattered");
  });

  it("still returns null when the letters are not all there in order", () => {
    expect(fuzzyMatch("zzz", "InkyCap")).toBeNull();
    expect(fuzzyMatch("pad", "PDA")).toBeNull();
  });
});

describe("substringMatch", () => {
  it("carries the same kinds", () => {
    expect(substringMatch("export", "Export")!.kind).toBe("exact");
    expect(substringMatch("exp", "Export")!.kind).toBe("substring");
    expect(substringMatch("exp", "edit panel")).toBeNull();
  });

  it("highlights the run it matched", () => {
    expect(substringMatch("cap", "InkyCap")!.ranges).toEqual([[4, 7]]);
  });
});
