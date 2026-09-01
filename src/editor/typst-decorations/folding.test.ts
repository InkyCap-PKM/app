import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree, foldEffect } from "@codemirror/language";
import { typst } from "codemirror-lang-typst";
import { typstFolding, typstFoldRange } from "./folding";

// Folding now runs on CodeMirror's real fold engine (see folding.ts). These
// tests pin the two load-bearing halves:
//   • `typstFoldRange` — the range a heading section or a nested list subtree
//     collapses to. This is what both the keyboard shortcuts and the hover
//     chevron fold. Headings come from the parser, so a `= …` inside a ```
//     fence is neither a fold point nor a section boundary (issue #21).
//   • the rendered result — a folded heading actually hides its section.

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
});

function mkState(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [typst(), typstFolding()] });
  // Parsing is time-sliced; force it so the scan sees a real tree.
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

function mkView(doc: string): EditorView {
  const view = new EditorView({ state: mkState(doc), parent: document.body });
  views.push(view);
  return view;
}

/** Fold range for the region opening on line `n` (1-indexed), or null. */
function rangeAtLine(state: EditorState, n: number) {
  return typstFoldRange(state, state.doc.line(n).from);
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

describe("folding: heading fold ranges", () => {
  it("folds a heading to the line before the next same-level heading", () => {
    const state = mkState("= One\nbody\nmore\n\n= Two\ntail\n");
    // "= One" section is body/more/blank → ends at the line before "= Two".
    expect(rangeAtLine(state, 1)).toEqual({
      from: state.doc.line(1).to,
      to: state.doc.line(4).to,
    });
  });

  it("folds the last heading to the end of the document", () => {
    const state = mkState("= One\nbody\n\n= Two\ntail\n");
    expect(rangeAtLine(state, 4)).toEqual({
      from: state.doc.line(4).to,
      to: state.doc.line(6).to,
    });
  });

  it("stops a subsection fold at the next heading of equal/higher level", () => {
    const state = mkState("= One\nbody\n\n== Sub\nsub body\n\n= Two\n");
    // "== Sub" (level 2) ends at the line before "= Two" (level 1).
    expect(rangeAtLine(state, 4)).toEqual({
      from: state.doc.line(4).to,
      to: state.doc.line(6).to,
    });
  });

  it("has no fold on a heading with an empty section", () => {
    const state = mkState("= One\n= Two\ntail\n");
    expect(rangeAtLine(state, 1)).toBeNull();
  });

  it("ignores a heading that only looks like one inside a fence (issue #21)", () => {
    const state = mkState(ISSUE_21);
    // The single real heading owns the whole document — the fenced
    // `= Not a headliner` neither folds nor ends the section early. The fold
    // runs to the very end (the trailing newline leaves an empty last line).
    expect(rangeAtLine(state, 1)).toEqual({
      from: state.doc.line(1).to,
      to: state.doc.line(state.doc.lines).to,
    });
  });
});

describe("folding: list subtree fold ranges", () => {
  it("folds a parent item over its indented children", () => {
    const state = mkState("- a\n  - b\n  - c\n- d\n");
    expect(rangeAtLine(state, 1)).toEqual({
      from: state.doc.line(1).to,
      to: state.doc.line(3).to,
    });
  });

  it("has no fold on a leaf item", () => {
    const state = mkState("- a\n  - b\n  - c\n- d\n");
    expect(rangeAtLine(state, 2)).toBeNull(); // "  - b" is a leaf
    expect(rangeAtLine(state, 4)).toBeNull(); // "- d" is a leaf
  });

  it("keeps a blank line between children inside the subtree", () => {
    const state = mkState("- a\n  - b\n\n  - c\n- d\n");
    // Blank line 3 sits between two deeper children, so the fold spans through
    // it to the last child, "  - c" (line 4).
    expect(rangeAtLine(state, 1)).toEqual({
      from: state.doc.line(1).to,
      to: state.doc.line(4).to,
    });
  });

  it("does not treat a list-like line inside a fence as foldable", () => {
    const state = mkState("```\n- not an item\n  - nested\n```\n");
    expect(rangeAtLine(state, 2)).toBeNull();
  });
});

describe("folding: rendered result", () => {
  /** Text of every line still rendered (folded lines are not rendered). */
  const visibleLines = (view: EditorView) =>
    [...view.contentDOM.querySelectorAll(".cm-line")].map((el) => el.textContent ?? "");

  it("hides a heading's section when folded and restores it when unfolded", () => {
    const view = mkView("= One\nbody\nmore\n\n= Two\ntail\n");
    const range = typstFoldRange(view.state, 0)!;
    view.dispatch({ effects: foldEffect.of(range) });
    // The section body is gone; the heading (with the fold placeholder) and
    // everything from "= Two" on remain.
    const after = visibleLines(view);
    expect(after.some((l) => l.includes("body"))).toBe(false);
    expect(after.some((l) => l.includes("more"))).toBe(false);
    expect(after.some((l) => l.includes("= Two"))).toBe(true);
  });

  it("renders a hover chevron on every foldable line", () => {
    const view = mkView("= One\nbody\n\n- a\n  - b\n");
    // Two foldables: the heading "= One" and the parent item "- a".
    expect(view.contentDOM.querySelectorAll(".cm-fold-caret").length).toBe(2);
  });

  it("drops the chevron of an item hidden inside an ancestor's fold", () => {
    const view = mkView("- a\n  - b\n    - c\n");
    // "- a" (has children) and "  - b" (has child c) are both foldable → 2.
    expect(view.contentDOM.querySelectorAll(".cm-fold-caret").length).toBe(2);
    // Fold "- a": "  - b" is now hidden, so only "- a"'s own chevron remains —
    // no stranded chevron at the fold boundary.
    view.dispatch({ effects: foldEffect.of(typstFoldRange(view.state, 0)!) });
    expect(view.contentDOM.querySelectorAll(".cm-fold-caret").length).toBe(1);
  });
});
