import { describe, it, expect } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { focusedLineNumbers, resolveFocusScope } from "./focus-mode";

// "Focus mode" and "Dim unfocused text" are two settings over one idea: an
// area around the caret is focused, and the rest is not. Focus mode tints the
// focused area; dimming fades everything else. Either must work without the
// other — dimming used to be silently ignored whenever focus mode was off.

describe("resolveFocusScope", () => {
  it("uses the focus mode's own scope when one is set", () => {
    expect(resolveFocusScope("line", false)).toBe("line");
    expect(resolveFocusScope("section", false)).toBe("section");
  });

  it("keeps the focus mode's scope when dimming is also on", () => {
    expect(resolveFocusScope("line", true)).toBe("line");
  });

  it("falls back to the paragraph when only dimming is on", () => {
    // The regression this guards: with focus mode off there was no scope, so
    // dimming had nothing to leave clear and never drew anything.
    expect(resolveFocusScope("none", true)).toBe("section");
  });

  it("resolves to nothing when neither setting asks for anything", () => {
    expect(resolveFocusScope("none", false)).toBeNull();
  });
});

/** State with the caret at the first `|` in `doc` (removed from the text). */
function stateWithCaret(doc: string) {
  const at = doc.indexOf("|");
  return EditorState.create({ doc: doc.replace("|", ""), selection: { anchor: at } });
}

const PARAGRAPHS = "one\ntwo\n\nthree\nfour\nfive\n\nsix";

describe("focusedLineNumbers", () => {
  it("focuses only the caret's line under the line scope", () => {
    const state = stateWithCaret("one\ntwo\n\nthree\nfo|ur\nfive\n\nsix");
    expect([...focusedLineNumbers(state, "line")]).toEqual([5]);
  });

  it("focuses the whole paragraph under the section scope", () => {
    const state = stateWithCaret("one\ntwo\n\nthree\nfo|ur\nfive\n\nsix");
    expect([...focusedLineNumbers(state, "section")].sort((a, b) => a - b)).toEqual([4, 5, 6]);
  });

  it("stops at the blank lines bounding the paragraph", () => {
    const state = stateWithCaret("one\nt|wo\n\nthree\nfour\nfive\n\nsix");
    expect([...focusedLineNumbers(state, "section")].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("keeps both neighbours clear when the caret sits on a blank line", () => {
    // Line 3 is the blank line between the first two paragraphs. A paragraph
    // is bounded by blank lines, so a caret on one belongs to the paragraphs
    // on either side rather than to nothing — which also stops the whole
    // document from fading out while the writer is between paragraphs.
    const state = stateWithCaret("one\ntwo\n|\nthree\nfour\nfive\n\nsix");
    expect([...focusedLineNumbers(state, "section")].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("covers every line a selection spans", () => {
    const doc = PARAGRAPHS;
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf("two"), head: doc.indexOf("three") + 1 },
    });
    expect([...focusedLineNumbers(state, "line")].sort((a, b) => a - b)).toEqual([2, 3, 4]);
  });

  it("grows every paragraph a selection touches under the section scope", () => {
    const doc = PARAGRAPHS;
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf("two"), head: doc.indexOf("three") + 1 },
    });
    // Both paragraphs, plus the blank line the selection crosses.
    expect([...focusedLineNumbers(state, "section")].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("focuses each caret of a multi-cursor selection", () => {
    const doc = PARAGRAPHS;
    const state = EditorState.create({
      doc,
      selection: EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.cursor(doc.indexOf("six")),
      ]),
      // CodeMirror keeps only the main range unless this is on.
      extensions: EditorState.allowMultipleSelections.of(true),
    });
    expect([...focusedLineNumbers(state, "line")].sort((a, b) => a - b)).toEqual([1, 8]);
  });
});
