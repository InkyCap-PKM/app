import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history, historyKeymap, undo } from "@codemirror/commands";
import { typstKeymap, listContentStart, smartIndentListsFacet } from "./keymaps";
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

/** An editor with a selection range, optionally with smart list indent on. */
function mkSel(doc: string, anchor: number, head: number, smart = false) {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [history(), keymap.of([...typstKeymap, ...historyKeymap]), smartIndentListsFacet.of(smart)],
    }),
    parent: document.body,
  });
}

function pressTab(view: EditorView, shift = false): boolean {
  for (const b of typstKeymap) {
    if (b.key !== (shift ? "Shift-Tab" : "Tab")) continue;
    if (b.run && b.run(view)) return true;
  }
  return false;
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

describe("list indent over a selection", () => {
  const list = "- one\n- two\n- three";

  it("indents every selected item, not just the caret's line", () => {
    const v = mkSel(list, 0, list.length);
    expect(pressTab(v)).toBe(true);
    expect(v.state.doc.toString()).toBe("  - one\n  - two\n  - three");
    v.destroy();
  });

  it("keeps the selection over the same text so Tab can repeat", () => {
    const v = mkSel(list, 0, list.length);
    pressTab(v);
    pressTab(v);
    expect(v.state.doc.toString()).toBe("    - one\n    - two\n    - three");
    v.destroy();
  });

  it("leaves out a line the selection only reaches the start of", () => {
    // Selection ends at the very start of "- three".
    const v = mkSel(list, 0, "- one\n- two\n".length);
    pressTab(v);
    expect(v.state.doc.toString()).toBe("  - one\n  - two\n- three");
    v.destroy();
  });

  it("outdents every selected item", () => {
    const v = mkSel("  - one\n  - two", 0, 15);
    expect(pressTab(v, true)).toBe(true);
    expect(v.state.doc.toString()).toBe("- one\n- two");
    v.destroy();
  });

  it("outdents the items that can move and leaves column-0 items alone", () => {
    const doc = "- one\n  - two";
    const v = mkSel(doc, 0, doc.length);
    pressTab(v, true);
    expect(v.state.doc.toString()).toBe("- one\n- two");
    v.destroy();
  });

  it("skips non-list lines inside the selection", () => {
    const doc = "- one\nprose\n- two";
    const v = mkSel(doc, 0, doc.length);
    pressTab(v);
    expect(v.state.doc.toString()).toBe("  - one\nprose\n  - two");
    v.destroy();
  });

  it("indents numbered items too", () => {
    const doc = "1. one\n2. two";
    const v = mkSel(doc, 0, doc.length);
    pressTab(v);
    expect(v.state.doc.toString()).toBe("  1. one\n  2. two");
    v.destroy();
  });

  it("shifts a nested child once when it is also selected (smart indent)", () => {
    const doc = "- one\n  - child\n- two";
    const v = mkSel(doc, 0, doc.length, true);
    pressTab(v);
    expect(v.state.doc.toString()).toBe("  - one\n    - child\n  - two");
    v.destroy();
  });

  it("leaves an unselected child behind, making it a sibling", () => {
    // "Animals" and two of its three children are selected; "Rocks" is not.
    const doc = "- Animals\n  - Dogs\n  - Birds\n  - Rocks";
    const v = mkSel(doc, 0, doc.indexOf("  - Rocks"), true);
    pressTab(v);
    expect(v.state.doc.toString()).toBe("  - Animals\n    - Dogs\n    - Birds\n  - Rocks");
    v.destroy();
  });

  it("keeps explicit numbering when a numbered group is indented", () => {
    const doc = "1. Dogs\n2. Birds\n3. Rocks";
    const v = mkSel(doc, 0, doc.length);
    pressTab(v);
    expect(v.state.doc.toString()).toBe("  1. Dogs\n  2. Birds\n  3. Rocks");
    v.destroy();
  });

  it("moves a wrapped continuation line with its item", () => {
    const doc = "- one\n  continued\n- two";
    const v = mkSel(doc, 0, doc.length);
    pressTab(v);
    expect(v.state.doc.toString()).toBe("  - one\n    continued\n  - two");
    v.destroy();
  });

  it("still drags children when the caret sits in one item (smart indent)", () => {
    const doc = "- Animals\n  - Dogs\n- Plants";
    const v = mkSel(doc, 3, 3, true);
    pressTab(v);
    expect(v.state.doc.toString()).toBe("  - Animals\n    - Dogs\n- Plants");
    v.destroy();
  });

  it("undoes the whole gesture in one step", () => {
    const doc = "- one\n- two\n- three\n- four";
    const v = mkSel(doc, 0, doc.length);
    pressTab(v);
    expect(v.state.doc.toString()).not.toBe(doc);
    undo(v);
    expect(v.state.doc.toString()).toBe(doc);
    v.destroy();
  });

  it("undoes an outdent in one step", () => {
    const doc = "  - one\n  - two\n  - three";
    const v = mkSel(doc, 0, doc.length);
    pressTab(v, true);
    undo(v);
    expect(v.state.doc.toString()).toBe(doc);
    v.destroy();
  });

  it("still indents a single item under a plain caret", () => {
    const v = mkSel("- one", 3, 3);
    pressTab(v);
    expect(v.state.doc.toString()).toBe("  - one");
    expect(v.state.selection.main.head).toBe(5);
    v.destroy();
  });

  it("does not handle Tab when the selection holds no list items", () => {
    const doc = "prose\nmore prose";
    const v = mkSel(doc, 0, doc.length);
    expect(pressTab(v)).toBe(false);
    v.destroy();
  });
});
