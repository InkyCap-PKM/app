import { describe, it, expect } from "vitest";
import { Text } from "@codemirror/state";
import { listBlockRange, renumberListLines } from "./list-renumber";

/** Renumber a whole document written as one string, for readable tests. */
function renumber(doc: string): string {
  return renumberListLines(doc.split("\n")).join("\n");
}

describe("renumberListLines", () => {
  it("restarts the count at each nesting level", () => {
    expect(renumber("1. one\n  2. nested\n  3. nested\n4. two")).toBe(
      "1. one\n  1. nested\n  2. nested\n2. two",
    );
  });

  it("leaves a correctly numbered list alone", () => {
    const doc = "1. one\n  1. a\n  2. b\n2. two";
    expect(renumber(doc)).toBe(doc);
  });

  it("keeps the number the writer started the list with", () => {
    expect(renumber("5. five\n9. six")).toBe("5. five\n6. six");
  });

  it("starts a nested run at 1 even when the list starts elsewhere", () => {
    expect(renumber("5. five\n  7. a\n  9. b")).toBe("5. five\n  1. a\n  2. b");
  });

  it("never rewrites `+` markers but counts them in the same run", () => {
    expect(renumber("+ a\n3. b\n+ c\n9. d")).toBe("+ a\n2. b\n+ c\n4. d");
  });

  it("leaves bullets alone and treats them as a separate list", () => {
    expect(renumber("- a\n- b\n  3. x\n  7. y")).toBe("- a\n- b\n  1. x\n  2. y");
  });

  it("keeps counting across a blank line, which Typst treats as one list", () => {
    expect(renumber("1. a\n\n5. b\n\n9. c")).toBe("1. a\n\n2. b\n\n3. c");
  });

  it("restarts after a paragraph of prose ends the list", () => {
    expect(renumber("1. a\n2. b\n\nProse.\n\n7. c\n9. d")).toBe(
      "1. a\n2. b\n\nProse.\n\n7. c\n8. d",
    );
  });

  it("ignores a wrapped continuation line", () => {
    expect(renumber("1. a\n   more text\n5. b")).toBe("1. a\n   more text\n2. b");
  });

  it("restarts a deeper level each time it is re-entered", () => {
    expect(renumber("1. a\n  4. x\n  5. y\n2. b\n  8. p\n  9. q")).toBe(
      "1. a\n  1. x\n  2. y\n2. b\n  1. p\n  2. q",
    );
  });

  it("widens a marker past nine without disturbing the text", () => {
    const lines = Array.from({ length: 11 }, (_, i) => `1. item ${i}`);
    expect(renumberListLines(lines)[10]).toBe("11. item 10");
  });

  it("treats a bare marker with no separator as prose ending the list", () => {
    // `2.` with nothing after it is text the writer is still typing, not an
    // item — so the list below it counts as a fresh one and keeps its number.
    expect(renumber("1. a\n2.\n5. b")).toBe("1. a\n2.\n5. b");
  });
});

describe("listBlockRange", () => {
  it("spans the items around the given line", () => {
    const doc = Text.of(["Intro.", "", "1. a", "2. b", "3. c", "", "After."]);
    expect(listBlockRange(doc, 4)).toEqual([3, 5]);
  });

  it("includes continuation lines and interior blanks", () => {
    const doc = Text.of(["1. a", "   wrapped", "", "2. b", "Prose."]);
    expect(listBlockRange(doc, 1)).toEqual([1, 4]);
  });

  it("stops at a raw block fence", () => {
    const doc = Text.of(["1. a", "```", "  2. code", "```", "2. b"]);
    expect(listBlockRange(doc, 1)).toEqual([1, 1]);
  });

  it("returns the line itself when it stands alone", () => {
    const doc = Text.of(["Prose.", "1. only", "More prose."]);
    expect(listBlockRange(doc, 2)).toEqual([2, 2]);
  });
});
