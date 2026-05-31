import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { typstKeymap } from "./keymaps";

// The codemirror-lang-typst parser loads from WASM, which Vitest's Node
// environment can't import — so these tests exercise the keymap's list
// behaviour directly (it is parser-independent: `continueList` works off the
// raw line text). They lock in the source ↔ visual shared invariant that a
// double-Enter at the end of a list exits to regular text.
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
