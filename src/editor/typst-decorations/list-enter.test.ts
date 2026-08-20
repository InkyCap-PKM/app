import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { typstKeymap } from "./keymaps";

// These editors are built without a Typst language, so there is no syntax
// tree to consult — which is fine, because the keymap's list behaviour is
// parser-independent (`continueList` works off the raw line text). They lock
// in the source ↔ visual shared invariant that a double-Enter at the end of a
// list exits to regular text.
//
// (An earlier version of this note claimed Vitest's Node environment cannot
// import the codemirror-lang-typst WASM parser. It can — see
// typst-snippet-lang.test.ts, which parses Typst directly. Tests that need a
// real syntax tree are therefore possible; these simply don't need one.)
function mk(doc: string) {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [keymap.of(typstKeymap)],
    }),
    parent: document.body,
  });
}

function pressEnter(view: EditorView): boolean {
  for (const b of typstKeymap) {
    if (b.key === "Enter" && b.run && b.run(view)) return true;
  }
  return false;
}

describe("list Enter behaviour", () => {
  it("continues a bulleted list", () => {
    const v = mk("- apple");
    pressEnter(v);
    expect(v.state.doc.toString()).toBe("- apple\n- ");
    v.destroy();
  });

  it("increments a numbered list", () => {
    const v = mk("1. apple");
    pressEnter(v);
    expect(v.state.doc.toString()).toBe("1. apple\n2. ");
    v.destroy();
  });

  it("preserves indentation when continuing a nested item", () => {
    const v = mk("- a\n  - b");
    pressEnter(v);
    expect(v.state.doc.toString()).toBe("- a\n  - b\n  - ");
    v.destroy();
  });

  it("ends the list when Enter is pressed on an empty item (same-line)", () => {
    const v = mk("- apple\n- ");
    pressEnter(v);
    expect(v.state.doc.toString()).toBe("- apple\n");
    expect(v.state.selection.main.head).toBe("- apple\n".length);
    v.destroy();
  });

  it("ends a nested list, clearing the empty nested marker", () => {
    const v = mk("- a\n  - b\n  - ");
    pressEnter(v);
    expect(v.state.doc.toString()).toBe("- a\n  - b\n");
    v.destroy();
  });

  // Visual-mode tolerance: the bullet's atomic widget spans [line.from,
  // afterMarker], so a click at the start of an item's text can round the caret
  // to the line start. Enter must still split cleanly at the content start
  // rather than inserting a newline ahead of the marker (which would double the
  // bullet). Splitting at line start pushes the text down under a fresh marker.
  it("splits at content start when the caret is rounded to the line start", () => {
    const v = mk("- apple");
    v.dispatch({ selection: { anchor: 0 } }); // line.from, before the marker
    pressEnter(v);
    expect(v.state.doc.toString()).toBe("- \n- apple");
    // Caret lands before "apple" on the new bulleted line.
    expect(v.state.selection.main.head).toBe("- \n- ".length);
    v.destroy();
  });

  // Visual-mode tolerance: if the caret lands back on the previous (non-empty)
  // item after the empty bullet was inserted below, the second Enter still
  // exits by clearing that trailing empty marker.
  it("ends the list when the caret sits on the item above an empty marker", () => {
    const doc = "- apple\n- ";
    const v = mk(doc);
    // Put the caret at the end of the first (non-empty) item.
    v.dispatch({ selection: { anchor: "- apple".length } });
    pressEnter(v);
    expect(v.state.doc.toString()).toBe("- apple\n");
    v.destroy();
  });
});
