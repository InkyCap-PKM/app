import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { typst } from "codemirror-lang-typst";
import { buildDecorations, rebuildDirtyLines } from "./visual-plugin";

// A cursor move rebuilds only the lines the caret left and arrived on, grown
// to cover whole block elements. The result has to match a full rebuild: any
// decoration the partial pass fails to drop stays on screen contradicting the
// fresh ones.
//
// The case that broke: a fenced code block written as a list item. Its
// `` ``` `` opens after the `- ` marker, so the range grown to the block began
// mid-line, while the block's edit-state line decorations sit at the line
// *start* — just outside the range, so they were kept and their background
// stayed painted around the re-rendered code block. The same block at the top
// level opens at column 0, where the two coincide, which is why it only showed
// up inside lists.

// Long enough that a two-line rebuild stays well under the "more than half the
// document is dirty" threshold, where `rebuildRanges` gives up and rebuilds
// everything (which would pass these assertions without exercising anything).
const TAIL = Array.from({ length: 12 }, (_, i) => `\nparagraph ${i} of trailing prose.`).join("");

const IN_LIST = [
  "= Headline",
  "- bullet a",
  "  - bullet b",
  "  - ```",
  "    = not a headline",
  "    baz",
  "    ```",
  "  - bullet c",
].join("\n") + TAIL;

const TOP_LEVEL = [
  "= Headline",
  "prose a",
  "```",
  "= not a headline",
  "baz",
  "```",
  "prose c",
].join("\n") + TAIL;

const state = (doc: string, caret: number) =>
  EditorState.create({ doc, selection: { anchor: caret }, extensions: [typst()] });

/** Stable text form of a decoration set, for comparing two builds. */
function serialize(set: DecorationSet): string[] {
  const out: string[] = [];
  const iter = set.iter();
  while (iter.value) {
    const spec = iter.value.spec ?? {};
    const kind = spec.widget ? `widget:${spec.widget.constructor.name}` : spec.class ?? "replace";
    out.push(`${iter.from}-${iter.to} ${kind}`);
    iter.next();
  }
  return out.sort();
}

/** Move the caret from `fromPos` to `toPos` the incremental way (what a real
 *  cursor move does) and the from-scratch way. */
function bothWays(doc: string, fromPos: number, toPos: number) {
  const before = state(doc, fromPos);
  const after = state(doc, toPos);
  const lineOf = (pos: number) => new Set([after.doc.lineAt(pos).number]);
  return {
    incremental: rebuildDirtyLines(
      buildDecorations(before), after, lineOf(fromPos), lineOf(toPos),
    ),
    full: buildDecorations(after),
  };
}

describe("cursor-move rebuild matches a full rebuild", () => {
  for (const [name, doc] of [["in a list", IN_LIST], ["at the top level", TOP_LEVEL]] as const) {
    describe(`fenced code block ${name}`, () => {
      const insideBlock = doc.indexOf("baz");
      const above = doc.indexOf("= Headline");
      const below = doc.lastIndexOf("paragraph 0");

      it("leaving it downward", () => {
        const { incremental, full } = bothWays(doc, insideBlock, below);
        expect(serialize(incremental)).toEqual(serialize(full));
      });

      it("leaving it upward", () => {
        const { incremental, full } = bothWays(doc, insideBlock, above);
        expect(serialize(incremental)).toEqual(serialize(full));
      });

      it("entering it", () => {
        const { incremental, full } = bothWays(doc, above, insideBlock);
        expect(serialize(incremental)).toEqual(serialize(full));
      });

      it("leaves no edit-state line styling behind the rendered block", () => {
        const { incremental } = bothWays(doc, insideBlock, below);
        const kinds = serialize(incremental);
        expect(kinds.some((k) => k.includes("widget:CodeBlockWidget"))).toBe(true);
        expect(kinds.filter((k) => k.includes("codeblock-edit"))).toEqual([]);
      });
    });
  }
});
