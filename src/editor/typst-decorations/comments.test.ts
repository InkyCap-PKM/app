import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { typst } from "codemirror-lang-typst";
import { buildDecorations, typstVisualMode } from "./visual-plugin";
import { computeProtectedRanges, pushOutOfProtected } from "./visual-protected";
import { CommentPillWidget } from "./visual-widgets";
import { commentRunStartingAt } from "./comments";

// Typst comments in the visual editor collapse to a pill per run of comment
// lines, so the writer can see that text is there; the comment stays locked
// until the pill reveals it.

const state = (doc: string) => EditorState.create({ doc, extensions: [typst()] });

/** The comment pills in a visual build, as the source each one covers. */
function pills(doc: string): string[] {
  const out: string[] = [];
  const iter = buildDecorations(state(doc)).iter();
  while (iter.value) {
    if (iter.value.spec?.widget instanceof CommentPillWidget) out.push(doc.slice(iter.from, iter.to));
    iter.next();
  }
  return out;
}

const locked = (doc: string, expandedPos: number | null = null) =>
  computeProtectedRanges(state(doc), expandedPos).map((r) => doc.slice(r.from, r.to));

describe("comment pills", () => {
  it("groups consecutive full-line comments into one pill", () => {
    const doc = "Intro\n// one\n  // two\n/* three */\nBody";
    expect(pills(doc)).toEqual(["// one\n  // two\n/* three */"]);
    expect(locked(doc)).toEqual(["// one\n  // two\n/* three */\n"]);
  });

  it("separates runs at a blank line or a line of text", () => {
    const doc = "// a\n\n// b\nText\n// c\nEnd";
    expect(pills(doc)).toEqual(["// a", "// b", "// c"]);
  });

  it("gives a comment after text its own pill over just the comment", () => {
    const doc = "Some text // aside\n// own line\nEnd";
    expect(pills(doc)).toEqual(["// aside", "// own line"]);
    expect(locked(doc)).toEqual(["// aside\n", "// own line\n"]);
  });

  it("takes a multi-line block comment into the run", () => {
    const doc = "/* a\n   b */\n// c\nEnd";
    expect(pills(doc)).toEqual(["/* a\n   b */\n// c"]);
  });

  it("leaves a `//` inside raw text alone", () => {
    expect(pills("`// not a comment`\nEnd")).toEqual([]);
  });

  it("unlocks a run while it is revealed for editing", () => {
    const doc = "Intro\n// one\n// two\nBody";
    expect(locked(doc, doc.indexOf("// one"))).toEqual([]);
  });

  it("finds the run that starts at a position", () => {
    const doc = "Intro\n// one\n// two\nBody";
    const run = commentRunStartingAt(state(doc), doc.indexOf("// one"));
    expect(run && doc.slice(run.from, run.to)).toBe("// one\n// two");
    expect(run?.lines).toBe(2);
    expect(commentRunStartingAt(state(doc), doc.indexOf("Body"))).toBeNull();
  });
});

// The caret moves around a collapsed comment and never lands inside it. It is
// pushed out the way it was travelling, so arrowing back from below a comment
// passes it instead of bouncing back.
describe("caret around a comment pill", () => {
  /** Where the caret ends up after moving from `from` to `to` in visual mode. */
  function moveCaret(doc: string, from: number, to: number): number {
    const start = EditorState.create({
      doc,
      selection: { anchor: from },
      extensions: [typst(), typstVisualMode()],
    });
    return start.update({ selection: { anchor: to } }).state.selection.main.head;
  }

  const doc = "Intro\n// one\n// two\nBody";
  const pillLineEnd = doc.indexOf("\nBody");
  const bodyStart = pillLineEnd + 1;

  it("passes a full-line comment going back", () => {
    expect(moveCaret(doc, bodyStart, pillLineEnd)).toBe(doc.indexOf("\n// one"));
  });

  it("passes a full-line comment going forward", () => {
    expect(moveCaret(doc, doc.indexOf("\n// one"), doc.indexOf("// one"))).toBe(bodyStart);
  });

  it("stops before a comment after text, where typing goes ahead of it", () => {
    const trailing = "Some text // aside\nNext";
    const commentStart = trailing.indexOf("//");
    const lineEnd = trailing.indexOf("\nNext");
    expect(moveCaret(trailing, lineEnd + 1, lineEnd)).toBe(commentStart);
    expect(moveCaret(trailing, commentStart, lineEnd)).toBe(lineEnd + 1);
    const typed = EditorState.create({
      doc: trailing,
      selection: { anchor: commentStart },
      extensions: [typst(), typstVisualMode()],
    }).update({ changes: { from: commentStart, insert: "more " } }).state.doc.toString();
    expect(typed).toBe("Some text more // aside\nNext");
  });

  it("goes forward past a range that has nothing before it", () => {
    expect(pushOutOfProtected(0, [{ from: 0, to: 5 }], -1)).toBe(5);
  });
});
