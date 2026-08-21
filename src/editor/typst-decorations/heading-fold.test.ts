import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { typst } from "codemirror-lang-typst";
import { headingFold, toggleHeadingFold } from "./heading-fold";

// Folding a heading hides every line of its section. The section ends at the
// next heading of equal or higher level — so a *false* heading ends it early,
// which is how `= Not a headliner` inside a ``` fence left the rest of the
// section on screen (issue #21). Headings now come from Typst's parser, which
// doesn't see one there at all.

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
});

function mk(doc: string): EditorView {
  const state = EditorState.create({ doc, extensions: [typst(), headingFold()] });
  // Parsing is time-sliced; force it to completion so the fold sees a real
  // tree rather than the empty placeholder.
  ensureSyntaxTree(state, state.doc.length, 5000);
  const view = new EditorView({ state, parent: document.body });
  views.push(view);
  return view;
}

/** Lines still on screen after any folding, by their source text. */
function visibleLines(view: EditorView): string[] {
  return [...view.contentDOM.querySelectorAll(".cm-line")]
    .filter((el) => !el.classList.contains("cm-heading-folded-line"))
    .map((el) => el.textContent ?? "");
}

/** Fold (or unfold) the heading that starts on line `n` (1-indexed). */
function toggleFoldAtLine(view: EditorView, n: number): void {
  view.dispatch({ effects: toggleHeadingFold.of({ pos: view.state.doc.line(n).from }) });
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

describe("heading fold", () => {
  it("hides a section's lines and leaves the heading itself visible", () => {
    const view = mk("= One\nbody\nmore\n\n= Two\ntail\n");
    toggleFoldAtLine(view, 1);
    expect(visibleLines(view)).toEqual(["= One", "= Two", "tail", ""]);
  });

  it("keeps hiding past a heading that only looks like one inside a fence", () => {
    const view = mk(ISSUE_21);
    toggleFoldAtLine(view, 1);
    // The whole document is one section, so nothing but its heading survives.
    expect(visibleLines(view)).toEqual(["= Headline"]);
  });

  it("stops at the next real heading of the same level", () => {
    const view = mk("= One\nbody\n\n== Sub\nsub body\n\n= Two\n");
    toggleFoldAtLine(view, 1);
    expect(visibleLines(view)).toEqual(["= One", "= Two", ""]);
  });

  it("unfolds back to the full document", () => {
    const view = mk(ISSUE_21);
    toggleFoldAtLine(view, 1);
    toggleFoldAtLine(view, 1);
    expect(visibleLines(view)).toEqual(ISSUE_21.split("\n"));
  });

  it("puts no fold caret on a fence line that looks like a heading", () => {
    const view = mk(ISSUE_21);
    const carets = view.contentDOM.querySelectorAll(".cm-heading-fold-caret");
    expect(carets.length).toBe(1);
  });
});
