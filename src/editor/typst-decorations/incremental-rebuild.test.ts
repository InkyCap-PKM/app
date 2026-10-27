import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { typstLanguage } from "../typst-language";
import { buildDecorations, rebuildDirtyLines, rebuildDocChange } from "./visual-plugin";

// A cursor move rebuilds only the lines the caret left and reached, widened to
// whole block elements. The result must equal a full rebuild: a decoration the
// partial pass fails to remove stays on screen.
//
// The case that failed: a code block in a list item. Its `` ``` `` starts after
// `- `, so the widened range began mid-line, while the block's line decorations
// sit at the line start, just outside it, so they were kept and their
// background stayed around the code block. At the top level the block starts at
// column 0, so only lists were affected.

// Long enough that a two-line rebuild stays well under the "more than half the
// document changed" threshold, above which `rebuildRanges` rebuilds everything
// (which would pass without testing anything).
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
  EditorState.create({ doc, selection: { anchor: caret }, extensions: [typstLanguage()] });

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

// Deleting a whole call with Backspace moves its pill (a zero-width widget at
// the call start) to the end of the line, or onto an emptied line. The rebuild
// must remove it.
describe("document-edit rebuild drops the pill of a deleted call", () => {
  for (const line of ['#due("2026-10-01")', '- #due("2026-10-01")', 'Words #due("2026-10-01")']) {
    it(`deleting the call in \`${line}\``, () => {
      const doc = `Intro line.\n${line}` + TAIL;
      const callFrom = doc.indexOf("#due");
      const callTo = doc.indexOf(")", callFrom) + 1;
      const before = state(doc, callTo);
      const tr = before.update({ changes: { from: callFrom, to: callTo }, selection: { anchor: callFrom } });
      const incremental = rebuildDocChange(buildDecorations(before), tr);
      expect(serialize(incremental)).toEqual(serialize(buildDecorations(tr.state)));
      expect(serialize(incremental).some((d) => d.includes("FuncPillWidget"))).toBe(false);
    });
  }
});

// Closing an unclosed delimiter changes how everything after it parses: the
// lines it swallowed become list items and headings again. They are outside the
// edit, so the rebuild must find them by comparing the parse trees before and
// after.
describe("document-edit rebuild follows a parse change below the edit", () => {
  const BELOW = "\n- a bullet\n=== A heading\n- another bullet" + TAIL;

  for (const [name, open, close] of [
    ["content bracket", "#highlight[unclosed", "]"],
    ["inline raw", "`unclosed", "`"],
  ] as const) {
    it(`closing an unterminated ${name}`, () => {
      const doc = `Intro line.\n${open}` + BELOW;
      const at = doc.indexOf(open) + open.length;
      const before = state(doc, at);
      const tr = before.update({ changes: { from: at, insert: close }, selection: { anchor: at + 1 } });
      const incremental = rebuildDocChange(buildDecorations(before), tr);
      expect(serialize(incremental)).toEqual(serialize(buildDecorations(tr.state)));
    });

    it(`opening an unterminated ${name}`, () => {
      const doc = `Intro line.\n${open}${close}` + BELOW;
      const at = doc.indexOf(open) + open.length;
      const before = state(doc, at + 1);
      const tr = before.update({ changes: { from: at, to: at + 1 }, selection: { anchor: at } });
      const incremental = rebuildDocChange(buildDecorations(before), tr);
      expect(serialize(incremental)).toEqual(serialize(buildDecorations(tr.state)));
    });
  }
});
