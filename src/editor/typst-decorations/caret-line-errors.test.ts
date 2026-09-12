import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { typst } from "codemirror-lang-typst";
import { caretLineErrorRanges } from "./caret-line-errors";

// A `$` with no partner yet is an error token to the parser. While the caret
// is on its line the writer is still typing it, so the red error styling is
// muted there and kept everywhere else.

function ranges(doc: string, caret: number) {
  return caretLineErrorRanges(EditorState.create({ doc, selection: { anchor: caret }, extensions: [typst()] }));
}

describe("caretLineErrorRanges", () => {
  it("covers an unclosed `$` on the caret's line", () => {
    expect(ranges("text $ a", 8)).toEqual([{ from: 5, to: 6 }]);
  });

  it("leaves an unclosed `$` alone once the caret is on another line", () => {
    expect(ranges("text $ a\nelsewhere", 12)).toEqual([]);
  });

  it("reports nothing for a closed equation", () => {
    expect(ranges("text $ a $ b", 12)).toEqual([]);
  });
});
