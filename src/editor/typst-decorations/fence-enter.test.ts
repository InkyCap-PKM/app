import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { typst } from "codemirror-lang-typst";
import { ensureSyntaxTree } from "@codemirror/language";
import { typstKeymap } from "./keymaps";

// Enter at the end of a freshly-opened code fence steps into the block's empty
// body line rather than pushing a second blank line into it. Pairs with the
// ``` gesture in auto-pair-typst.ts, which now leaves the caret on the fence so
// the language can be typed: ``` → `typ` → Enter → code.
//
// These editors carry the real Typst language: the rule asks the syntax tree
// whether a fence opens or closes a block, which is the whole point — counting
// backticks in TypeScript got that wrong (see stepIntoOpenFence).

function mk(doc: string, head: number) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: head },
      extensions: [typst(), keymap.of(typstKeymap)],
    }),
    parent: document.body,
  });
  // Parsing is time-sliced; force it to completion so the first Enter sees a
  // real tree rather than the empty placeholder.
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  return view;
}

function pressEnter(view: EditorView): boolean {
  for (const b of typstKeymap) {
    if (b.key === "Enter" && b.run && b.run(view)) return true;
  }
  return false;
}

/** Caret at the end of line `n` (1-indexed) of `doc`. */
const endOfLine = (doc: string, n: number) => {
  const state = EditorState.create({ doc });
  return state.doc.line(n).to;
};

describe("Enter on an open code fence", () => {
  it("steps into the empty body instead of adding a line", () => {
    const doc = "```typ\n\n```";
    const v = mk(doc, endOfLine(doc, 1));
    expect(pressEnter(v)).toBe(true);
    expect(v.state.doc.toString()).toBe(doc); // nothing inserted
    expect(v.state.selection.main.head).toBe(v.state.doc.line(2).from);
    v.destroy();
  });

  it("works for a fence with no language", () => {
    const doc = "```\n\n```";
    const v = mk(doc, endOfLine(doc, 1));
    expect(pressEnter(v)).toBe(true);
    expect(v.state.doc.toString()).toBe(doc);
    expect(v.state.selection.main.head).toBe(v.state.doc.line(2).from);
    v.destroy();
  });

  it("works for an indented fence", () => {
    const doc = "  ```rust\n\n  ```";
    const v = mk(doc, endOfLine(doc, 1));
    expect(pressEnter(v)).toBe(true);
    expect(v.state.doc.toString()).toBe(doc);
    v.destroy();
  });

  it("leaves a second Enter alone, so the body can grow normally", () => {
    // Caret is now on the empty body line; that line is not a fence, so the
    // rule must not fire and Enter falls through to the default handler.
    const doc = "```typ\n\n```";
    const v = mk(doc, endOfLine(doc, 2));
    expect(pressEnter(v)).toBe(false);
    v.destroy();
  });

  it("does not fire when the body already has content", () => {
    const doc = "```typ\n#let x = 1\n```";
    const v = mk(doc, endOfLine(doc, 1));
    expect(pressEnter(v)).toBe(false);
    v.destroy();
  });

  it("does not fire on a closing fence that happens to precede a blank line", () => {
    // The narrowness that matters: ` ``` ` closing a block, with a blank line
    // and another block below, must not be mistaken for an opener.
    const doc = "```typ\n#let x = 1\n```\n\n```";
    const v = mk(doc, endOfLine(doc, 3));
    expect(pressEnter(v)).toBe(false);
    v.destroy();
  });

  it("does not fire mid-line", () => {
    const doc = "```typ\n\n```";
    const v = mk(doc, 3); // between the fence and the language tag
    expect(pressEnter(v)).toBe(false);
    v.destroy();
  });

  it("does not fire on prose that merely precedes a blank line", () => {
    const doc = "some prose\n\n```";
    const v = mk(doc, endOfLine(doc, 1));
    expect(pressEnter(v)).toBe(false);
    v.destroy();
  });

  it("does not fire when the block is unterminated", () => {
    // No closing fence below — the shape the gesture produces is absent, so
    // Enter must behave normally rather than jumping the caret somewhere odd.
    const doc = "```typ\n\nprose";
    const v = mk(doc, endOfLine(doc, 1));
    expect(pressEnter(v)).toBe(false);
    v.destroy();
  });
});
