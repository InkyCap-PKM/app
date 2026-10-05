import { describe, expect, it } from "vitest";
import { linkTargetsInFilter } from "./filter-expr";

describe("linkTargetsInFilter", () => {
  it("collects link targets from and/or at any depth, once each", () => {
    expect(
      linkTargetsInFilter({
        and: [
          'file.links.contains("Memory")',
          'file.tags.contains("x")',
          { or: ['file.links.contains("Sleep")', 'file.links.contains("Memory")'] },
        ],
      }),
    ).toEqual(["Memory", "Sleep"]);
  });

  it("skips negated leaves and not-groups", () => {
    expect(
      linkTargetsInFilter({
        and: ['!file.links.contains("A")', 'file.backlinks.contains("B")'],
        not: ['file.links.contains("C")'],
      }),
    ).toEqual([]);
  });

  it("handles a missing group", () => {
    expect(linkTargetsInFilter(null)).toEqual([]);
  });
});
