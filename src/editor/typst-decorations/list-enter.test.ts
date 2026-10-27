import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { typstKeymap } from "./keymaps";

// These editors have no Typst language, so no syntax tree; the list keymap
// doesn't need one (`continueList` uses the line text). They check that in both
// modes a double Enter at the end of a list returns to regular text.
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

  // Visual mode: the bullet widget spans [line.from, afterMarker], so a click
  // at the start of an item's text can put the caret at the line start. Enter
  // must still split at the start of the content, not add a newline before the
  // marker (which would double the bullet).
  it("splits at content start when the caret is rounded to the line start", () => {
    const v = mk("- apple");
    v.dispatch({ selection: { anchor: 0 } }); // line.from, before the marker
    pressEnter(v);
    expect(v.state.doc.toString()).toBe("- \n- apple");
    // Caret lands before "apple" on the new bulleted line.
    expect(v.state.selection.main.head).toBe("- \n- ".length);
    v.destroy();
  });

  // Visual mode: if the caret ends up on the item above the new empty bullet, a
  // second Enter still ends the list by removing that empty marker.
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

describe("numbered list Enter leaves existing numbers alone", () => {
  // An explicit `N.` is printed as typed. Enter only writes the new line;
  // numbers are brought back in order on Tab and Shift+Tab, when the list's
  // shape changes.
  it("inserts mid-list without rewriting the items below", () => {
    const doc = "1. one\n2. two\n3. three";
    const v = mk(doc);
    v.dispatch({ selection: { anchor: "1. one".length } });
    pressEnter(v);
    expect(v.state.doc.toString()).toBe("1. one\n2. \n2. two\n3. three");
    expect(v.state.selection.main.head).toBe("1. one\n2. ".length);
    v.destroy();
  });

  it("numbers a new nested item from its own level", () => {
    const doc = "1. one\n  1. child";
    const v = mk(doc);
    pressEnter(v);
    expect(v.state.doc.toString()).toBe("1. one\n  1. child\n  2. ");
    v.destroy();
  });

  it("carries the text right of the caret onto the new item", () => {
    const doc = "1. onetwo\n2. three";
    const v = mk(doc);
    v.dispatch({ selection: { anchor: "1. one".length } });
    pressEnter(v);
    expect(v.state.doc.toString()).toBe("1. one\n2. two\n2. three");
    expect(v.state.selection.main.head).toBe("1. one\n2. ".length);
    v.destroy();
  });

  it("keeps a restart the writer typed", () => {
    const doc = "1. one\n1. again";
    const v = mk(doc);
    pressEnter(v);
    expect(v.state.doc.toString()).toBe("1. one\n1. again\n2. ");
    v.destroy();
  });
});
