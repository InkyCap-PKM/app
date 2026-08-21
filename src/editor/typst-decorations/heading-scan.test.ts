import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { typst } from "codemirror-lang-typst";
import { headingsInTree, scanHeadings } from "./heading-scan";

// Headings are whatever Typst's parser calls a heading — nothing more. The
// motivating case (issue #21) is `= Not a headliner` written inside a ```
// fence: a line regex sees a heading, the parser sees raw text, and the parser
// is right. These editors therefore carry the real Typst language.

function mk(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [typst()] });
  // Parsing is time-sliced; force it to completion so the scan sees a real
  // tree rather than the empty placeholder.
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

const ISSUE_21 =
  "= Headline\n"
  + "- Bullet point A\n"
  + "  - B\n"
  + "    - B.1\n"
  + "    - ```\n"
  + "= Not a headliner\n"
  + "baz\n"
  + "```\n"
  + "  - C\n"
  + "    - C.1\n";

const levelsAndText = (state: EditorState) =>
  scanHeadings(state).map((h) => [h.level, h.text] as const);

describe("scanHeadings", () => {
  it("finds ordinary headings with their level and text", () => {
    expect(levelsAndText(mk("= One\n\ntext\n\n== Two\n\n==== Four\n"))).toEqual([
      [1, "One"],
      [2, "Two"],
      [4, "Four"],
    ]);
  });

  it("reports positions at the first `=` marker", () => {
    const state = mk("intro\n\n== Section\n");
    expect(scanHeadings(state)[0].from).toBe(state.doc.line(3).from);
  });

  it("ignores heading syntax inside a fenced raw block", () => {
    // The reproduction from issue #21, verbatim: a fence nested in a list,
    // holding a line that looks exactly like a top-level heading.
    expect(levelsAndText(mk(ISSUE_21))).toEqual([[1, "Headline"]]);
  });

  it("ignores heading syntax inside an inline raw span", () => {
    expect(levelsAndText(mk("Write `= Heading` to open a section.\n"))).toEqual([]);
  });

  it("ignores heading syntax inside comments", () => {
    expect(levelsAndText(mk("/*\n= Commented out\n*/\n// = Also not one\n"))).toEqual([]);
  });

  it("keeps a heading found in a language-tagged Typst fence out of the list", () => {
    // ```typ fences are the ones most likely to hold heading syntax, since
    // they document Typst itself.
    expect(levelsAndText(mk("```typ\n= Example\n```\n\n= Real\n"))).toEqual([[1, "Real"]]);
  });

  it("finds an indented heading, which a line regex anchored at column 0 missed", () => {
    expect(levelsAndText(mk("- item\n\n  = Indented\n"))).toEqual([[1, "Indented"]]);
  });

  it("finds a heading written on its own line inside a content block", () => {
    expect(levelsAndText(mk("#callout[\n= Aside\n]\n"))).toEqual([[1, "Aside"]]);
  });

  it("leaves a heading tucked mid-line alone", () => {
    // `#callout[= Aside]` is a heading to Typst, but there is no line to fold
    // under it and no line to point the outline at, so the scan indexes only
    // headings that open their own line.
    expect(levelsAndText(mk("#callout[= Aside]\n"))).toEqual([]);
  });

  it("does not cap the level — Typst doesn't", () => {
    expect(levelsAndText(mk("======= Seven\n"))).toEqual([[7, "Seven"]]);
  });

  it("reports a heading whose text is still empty", () => {
    // The `=` the writer has just typed. Callers that render it (the outline)
    // decide whether an empty row is worth showing; the scan just reports.
    expect(levelsAndText(mk("= \n"))).toEqual([[1, ""]]);
  });

  it("leaves a trailing label out of the heading text", () => {
    // The parser ends the `Heading` node before the label, so the outline gets
    // the reader-facing title without the `<intro>` anchor a line regex kept.
    expect(levelsAndText(mk("= Intro <intro>\n"))).toEqual([[1, "Intro"]]);
  });
});

describe("headingsInTree", () => {
  it("works against a tree and text on their own, without an editor state", () => {
    const state = mk("= A\n\n== B\n");
    expect(headingsInTree(syntaxTree(state), state.doc).map((h) => h.text)).toEqual(["A", "B"]);
  });
});


// The scan reaches its answers by binary-searching the tree's child lists (see
// heading-scan.ts for why lezer's own linear traversal is too slow here). This
// pins that shortcut against the slow-but-obvious traversal it replaces: walk
// the whole tree, keep the `Heading` nodes that open their line, and the two
// must agree — on every document below, and on any the parser's shape changes
// under us.
function referenceHeadings(state: EditorState): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Heading") return;
      const line = state.doc.lineAt(node.from);
      if (state.doc.sliceString(line.from, node.from).trim() === "") {
        out.push({ from: node.from, to: node.to });
      }
      return false;
    },
  });
  return out;
}

describe("the fast descent agrees with a full tree walk", () => {
  const corpus: Record<string, string> = {
    empty: "",
    "no headings": "Just some prose.\n\nAnd a second paragraph.\n",
    "every level": "= 1\n== 2\n=== 3\n==== 4\n===== 5\n====== 6\n======= 7\n",
    "fence at the top": "```\n= Nope\n```\n\n= Yes\n",
    "fence at the end": "= Yes\n\n```\n= Nope\n```",
    "unterminated fence": "= Yes\n\n```\n= Nope\nstill raw\n",
    "nested list with a fence": ISSUE_21,
    "math block": "= Yes\n\n$ a\n= b\nc $\n",
    "block comment": "= Yes\n\n/*\n= Nope\n*/\n",
    "string in code": '= Yes\n\n#let s = "\n= Nope\n"\n',
    "content blocks": "#callout[\n= Yes\n\nbody\n]\n\n= Also yes\n",
    "heading with a label": "= Yes <yes>\n\ntext\n",
    "indented headings": "- item\n\n  = Yes\n\n\t== Also yes\n",
    "markup that looks close": "=not a heading\n== \n=\n a = b\n",
    "crlf-ish trailing spaces": "= Yes   \n\n=== Deep   \n",
    "unicode": "= Überschrift — mit Bindestrich\n\n== 日本語の見出し\n",
  };

  for (const [name, doc] of Object.entries(corpus)) {
    it(name, () => {
      const state = mk(doc);
      expect(scanHeadings(state).map((h) => ({ from: h.from, to: h.to }))).toEqual(
        referenceHeadings(state),
      );
    });
  }
});
