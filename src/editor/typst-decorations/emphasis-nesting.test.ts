import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { typst } from "codemirror-lang-typst";
import { buildDecorations } from "./visual-plugin";
import { FuncPillWidget } from "./visual-widgets";

// Direct formatting (`*bold*`, `_italic_`) reveals its delimiters when the
// caret lands inside, so they can be edited. That reveal used to skip the
// node's children too, which dropped anything nested inside — a
// `#highlight[…]` in a bold run lost its fill and its pill and showed as raw
// source. These pin that the reveal is limited to the delimiters.

/** Names of every pill widget in the decoration set. */
function pillNames(doc: string, caret: number): string[] {
  const state = EditorState.create({
    doc,
    selection: { anchor: caret },
    extensions: [typst()],
  });
  const names: string[] = [];
  const iter = buildDecorations(state).iter();
  while (iter.value) {
    const widget = iter.value.spec?.widget;
    if (widget instanceof FuncPillWidget) names.push(widget.funcName);
    iter.next();
  }
  return names;
}

/** True when the character at `pos` is hidden (replaced by a zero-width range). */
function isHidden(doc: string, caret: number, pos: number): boolean {
  const state = EditorState.create({
    doc,
    selection: { anchor: caret },
    extensions: [typst()],
  });
  let hidden = false;
  buildDecorations(state).between(pos, pos + 1, (from, to, value) => {
    if (from === pos && to === pos + 1 && value.spec?.widget == null) hidden = true;
  });
  return hidden;
}

describe("a call nested in bold/italic keeps its own decoration", () => {
  const BOLD = "*a #highlight[b] c*";
  const ITALIC = "_a #highlight[b] c_";

  it("shows the highlight pill with the caret inside the bold run", () => {
    expect(pillNames(BOLD, BOLD.indexOf("b"))).toContain("highlight");
  });

  it("shows the highlight pill with the caret inside the italic run", () => {
    expect(pillNames(ITALIC, ITALIC.indexOf("b"))).toContain("highlight");
  });

  it("still hides the `*` delimiters when the caret is outside the run", () => {
    const doc = `${BOLD}\ntrailing`;
    const away = doc.length;
    expect(isHidden(doc, away, 0)).toBe(true);
    expect(isHidden(doc, away, BOLD.length - 1)).toBe(true);
  });

  it("reveals the `*` delimiters when the caret is inside the run", () => {
    const caret = BOLD.indexOf("b");
    expect(isHidden(BOLD, caret, 0)).toBe(false);
    expect(isHidden(BOLD, caret, BOLD.length - 1)).toBe(false);
  });
});
