import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { typstKeymap, listContentStart } from "./keymaps";
import { listPasteHandler, listPasteInsertion } from "./list-paste";

// Parser-independent unit tests for the in-page list editing affordances:
// smart Home (caret lands on the text, after the marker) and the list-paste
// marker de-duplication. Both work off raw line text, so no WASM parser is
// needed.

function mk(doc: string, anchor = doc.length) {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [keymap.of(typstKeymap), listPasteHandler],
    }),
    parent: document.body,
  });
}

function pressHome(view: EditorView, shift = false): boolean {
  for (const b of typstKeymap) {
    if (b.key !== "Home") continue;
    const run = shift ? b.shift : b.run;
    if (run && run(view)) return true;
  }
  return false;
}

describe("listContentStart", () => {
  it("returns the position after a bullet marker", () => {
    const state = EditorState.create({ doc: "- item" });
    expect(listContentStart(state.doc.lineAt(0))).toBe(2);
  });

  it("returns the position after a numbered marker", () => {
    const state = EditorState.create({ doc: "1. item" });
    expect(listContentStart(state.doc.lineAt(0))).toBe(3);
  });

  it("accounts for leading indentation on nested items", () => {
    const state = EditorState.create({ doc: "  - item" });
    expect(listContentStart(state.doc.lineAt(0))).toBe(4);
  });

  it("falls back to first non-whitespace on a non-list line", () => {
    const state = EditorState.create({ doc: "   prose" });
    expect(listContentStart(state.doc.lineAt(0))).toBe(3);
  });
});

describe("smart Home", () => {
  it("lands on the text after the bullet, not before it", () => {
    const v = mk("- item 4");
    pressHome(v);
    expect(v.state.selection.main.head).toBe(2); // after "- "
    v.destroy();
  });

  it("toggles to the true line start on a second press", () => {
    const v = mk("- item 4");
    pressHome(v);
    pressHome(v);
    expect(v.state.selection.main.head).toBe(0);
    v.destroy();
  });

  it("Shift-Home extends to content start, then to line start including the marker", () => {
    const doc = "- item 4";
    const v = mk(doc);
    pressHome(v, true);
    expect(v.state.selection.main.from).toBe(2);
    expect(v.state.selection.main.to).toBe(doc.length);
    pressHome(v, true);
    // Second Shift-Home extends across the marker so a copy carries the bullet.
    expect(v.state.selection.main.from).toBe(0);
    v.destroy();
  });
});

describe("listPasteInsertion", () => {
  function state(doc: string, anchor: number) {
    return EditorState.create({ doc, selection: { anchor } });
  }

  it("drops a duplicate marker when pasting onto an empty bullet", () => {
    // Caret sits right after a fresh "- " bullet.
    expect(listPasteInsertion(state("- ", 2), "- item 4")).toBe("item 4");
  });

  it("strips a trailing newline from a linewise copy onto an empty bullet", () => {
    expect(listPasteInsertion(state("  - ", 4), "- item 4\n")).toBe("item 4");
  });

  it("keeps the leading marker of subsequent items in a multi-item paste", () => {
    expect(listPasteInsertion(state("- ", 2), "- a\n- b")).toBe("a\n- b");
  });

  it("leaves a normal mid-text paste untouched", () => {
    // Caret inside the word, not right after the marker.
    expect(listPasteInsertion(state("- hello", 4), "- item 4")).toBeNull();
  });

  it("ignores clipboard text that is not a list item", () => {
    expect(listPasteInsertion(state("- ", 2), "plain text")).toBeNull();
  });

  it("is exposed as an editor extension", () => {
    expect(listPasteHandler).toBeDefined();
  });
});
