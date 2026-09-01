import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldedRanges, foldEffect } from "@codemirror/language";
import { typstKeymap } from "./keymaps";

// Shift-Alt-Arrow reorders a list item AND its nested subtree: a parent moves
// as a group, a leaf moves alone (issue #24 outliner move). It swaps places
// with the adjacent same-indent sibling's whole subtree, keeps explicit `N.`
// numbers in document order, and consumes the key (no page scroll) at a list
// edge. Parser-independent, so no Typst language is configured here.

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
});

function mk(doc: string, anchor: number): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor } }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

/** Run a Shift-Alt-Arrow binding by name, returning whether it was consumed. */
function move(view: EditorView, dir: "Up" | "Down"): boolean {
  const b = typstKeymap.find((k) => k.key === `Shift-Alt-Arrow${dir}`)!;
  return !!b.run!(view);
}

/** Offset of the start of `substr` in the doc (for placing the caret). */
const at = (doc: string, substr: string) => doc.indexOf(substr);

describe("moveListItem: subtree-aware reorder", () => {
  it("moves a parent item up together with its children", () => {
    const doc = "- a\n- b\n  - b1\n";
    const view = mk(doc, at(doc, "- b")); // caret on the parent "- b"
    expect(move(view, "Up")).toBe(true);
    expect(view.state.doc.toString()).toBe("- b\n  - b1\n- a\n");
  });

  it("moves a parent item down together with its children", () => {
    const doc = "- a\n  - a1\n- b\n";
    const view = mk(doc, at(doc, "- a")); // caret on the parent "- a"
    expect(move(view, "Down")).toBe(true);
    expect(view.state.doc.toString()).toBe("- b\n- a\n  - a1\n");
  });

  it("moves a leaf child past its sibling without disturbing the parent", () => {
    const doc = "- p\n  - c1\n  - c2\n";
    const view = mk(doc, at(doc, "- c2"));
    expect(move(view, "Up")).toBe(true);
    expect(view.state.doc.toString()).toBe("- p\n  - c2\n  - c1\n");
  });

  it("keeps the caret on the moved item's text", () => {
    const doc = "- a\n- b\n  - b1\n";
    const bText = at(doc, "b\n"); // inside "- b"'s text
    const view = mk(doc, bText);
    move(view, "Up");
    // "- b" is now the first line; the caret still sits on its "b".
    const head = view.state.selection.main.head;
    expect(view.state.doc.sliceString(head, head + 1)).toBe("b");
  });

  it("keeps explicit numbers in document order when reordering", () => {
    const doc = "1. first\n2. second\n";
    const view = mk(doc, at(doc, "1. first"));
    expect(move(view, "Down")).toBe(true);
    // Content swaps, numbering stays 1., 2. by position.
    expect(view.state.doc.toString()).toBe("1. second\n2. first\n");
  });

  it("consumes the key at the top of a list without moving", () => {
    const doc = "- a\n- b\n";
    const view = mk(doc, at(doc, "- a"));
    expect(move(view, "Up")).toBe(true); // consumed
    expect(view.state.doc.toString()).toBe(doc); // unchanged
  });

  it("consumes the key at the bottom of a list without moving", () => {
    const doc = "- a\n- b\n";
    const view = mk(doc, at(doc, "- b"));
    expect(move(view, "Down")).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("swaps past a blank-line gap between two items, keeping the gap", () => {
    const doc = "- a\n\n- b\n";
    const view = mk(doc, at(doc, "- b"));
    expect(move(view, "Up")).toBe(true);
    expect(view.state.doc.toString()).toBe("- b\n\n- a\n");
  });

  it("keeps a collapsed parent folded after it moves", () => {
    const doc = "- a\n- b\n  - b1\n  - b2\n";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: at(doc, "- b") },
        extensions: [codeFolding()],
      }),
      parent: document.body,
    });
    views.push(view);
    // Fold "- b"'s subtree: from the end of its line to the end of "  - b2".
    view.dispatch({ effects: foldEffect.of({ from: 7, to: 21 }) });
    move(view, "Up");
    // "- b" is now the first line; its fold should have travelled with it,
    // now covering the subtree at the top of the document (offsets 3..17).
    const ranges: Array<[number, number]> = [];
    foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
      ranges.push([from, to]);
    });
    expect(ranges).toEqual([[3, 17]]);
  });
});
