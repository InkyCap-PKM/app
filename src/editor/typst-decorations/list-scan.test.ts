import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { typst } from "codemirror-lang-typst";
import { scanListItems, listSubtreeEndLine, leadingWhitespace } from "./list-scan";

// The list scan is parser-first (like heading-scan): a `- x` line only counts
// as a list item where Typst's parser emits a list/enum marker, so lines inside
// a ``` fence, a comment, or a string are excluded. Nesting itself is plain
// indentation, exercised through `listSubtreeEndLine`.

function mk(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [typst()] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

describe("scanListItems", () => {
  it("finds unordered, ordered-plus, and numbered items with their indents", () => {
    const state = mk("- a\n  + b\n  2. c\nplain\n");
    const items = scanListItems(state);
    expect(items.map((i) => [i.lineNumber, i.indent])).toEqual([
      [1, 0],
      [2, 2],
      [3, 2],
    ]);
  });

  it("requires a separator after the marker", () => {
    // "-x" is not a list item (no space); "- x" is.
    const state = mk("-x\n- y\n");
    expect(scanListItems(state).map((i) => i.lineNumber)).toEqual([2]);
  });

  it("excludes list-like lines inside a code fence", () => {
    const state = mk("- real\n```\n- fenced\n  - nested\n```\n- also real\n");
    expect(scanListItems(state).map((i) => i.lineNumber)).toEqual([1, 6]);
  });
});

describe("listSubtreeEndLine", () => {
  const doc = (s: string) => mk(s).doc;

  it("returns the item's own line for a leaf", () => {
    const d = doc("- a\n- b\n");
    expect(listSubtreeEndLine(d, 1, 0)).toBe(1);
  });

  it("extends through deeper-indented descendants", () => {
    const d = doc("- a\n  - b\n    - c\n  - d\n- e\n");
    // "- a" (indent 0) owns lines 2–4; "- e" at indent 0 ends it.
    expect(listSubtreeEndLine(d, 1, 0)).toBe(4);
  });

  it("skips interior blank lines but trims trailing ones", () => {
    const d = doc("- a\n  - b\n\n  - c\n\n- d\n");
    // Blank line 3 is interior (deeper content follows), so the subtree reaches
    // "  - c" (line 4); the blank line 5 before "- d" is not included.
    expect(listSubtreeEndLine(d, 1, 0)).toBe(4);
  });
});

describe("leadingWhitespace", () => {
  it("counts spaces and tabs", () => {
    expect(leadingWhitespace("   - x")).toBe(3);
    expect(leadingWhitespace("- x")).toBe(0);
    expect(leadingWhitespace("\t\t- x")).toBe(2);
  });
});
