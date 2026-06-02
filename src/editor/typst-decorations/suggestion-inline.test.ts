import { describe, it, expect } from "vitest";
import { typstInlineSegments } from "./widgets";

// The SuggestionWidget renders a proposed-text body as a WYSIWYM mark. A Typst
// hard line break (`\` + whitespace/end) must read as a line break, not a stray
// backslash — `typstInlineSegments` splits the body into per-line segments.
describe("typstInlineSegments", () => {
  it("leaves plain text as a single segment", () => {
    expect(typstInlineSegments("hello world")).toEqual(["hello world"]);
  });

  it("treats a trailing backslash as a line break (the reported bug)", () => {
    expect(typstInlineSegments("line one\\")).toEqual(["line one", ""]);
  });

  it("splits a mid-text hard break", () => {
    expect(typstInlineSegments("a\\ b")).toEqual(["a", " b"]);
  });

  it("collapses a literal newline to a space (Typst paragraph rule)", () => {
    expect(typstInlineSegments("a\nb")).toEqual(["a b"]);
  });

  it("keeps a non-linebreak backslash literal", () => {
    // A backslash not followed by whitespace/end is not a hard break.
    expect(typstInlineSegments("C:\\path")).toEqual(["C:\\path"]);
  });
});
