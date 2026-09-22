import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView, Decoration } from "@codemirror/view";
import { syncDomCaretToState, domCaretResync } from "./dom-caret-resync";

// jsdom's selection always agrees with itself, so the WebKit misbehaviour this
// guards against — the browser editing at a different spot than the range it
// reports — cannot be reproduced here. A fake selection stands in, and these
// tests cover when the sync runs and where it puts the caret. The real thing is
// checked in a WebKitGTK window through scripts/webkit-harness
// (`h.pasteBackspaceType`).
//
// The sync re-asserts the caret whether or not the browser's range already
// looks right, because a range that looks right proves nothing on WebKit.

function mk(doc: string, anchor: number) {
  const view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor }, extensions: [domCaretResync] }),
    parent: document.body,
  });
  view.contentDOM.focus();
  return view;
}

/** A selection whose editable range sits at `node`/`offset`, recording any collapse. */
function fakeSelection(node: Node, offset: number, collapsed = true) {
  const collapses: { node: Node | null; offset: number }[] = [];
  const sel = {
    rangeCount: 1,
    getRangeAt: () => ({ startContainer: node, startOffset: offset, collapsed }),
    collapse: (n: Node | null, o?: number) => collapses.push({ node: n, offset: o ?? 0 }),
  } as unknown as Selection;
  return { sel, collapses };
}

describe("syncDomCaretToState", () => {
  it("moves the browser's range back to the caret when it has drifted", () => {
    const v = mk("Hello there", 11);
    const text = v.contentDOM.querySelector(".cm-line")!.firstChild!;
    const { sel, collapses } = fakeSelection(text, 0);
    syncDomCaretToState(v, sel);
    const at = v.domAtPos(11);
    expect(collapses).toEqual([{ node: at.node, offset: at.offset }]);
    v.destroy();
  });

  it("re-asserts a range that already sits at the caret", () => {
    const v = mk("Hello there", 5);
    const text = v.contentDOM.querySelector(".cm-line")!.firstChild!;
    const { sel, collapses } = fakeSelection(text, 5);
    syncDomCaretToState(v, sel);
    const at = v.domAtPos(5);
    expect(collapses).toEqual([{ node: at.node, offset: at.offset }]);
    v.destroy();
  });

  it("resolves the caret on the side the cursor is associated with", () => {
    // A mark ending at position 5 splits the line into two text nodes, so the
    // two sides of position 5 are different DOM spots. The caret carries which
    // one it belongs to, and the sync has to honour it or it would move the
    // caret across the mark's boundary.
    const marked = [domCaretResync, EditorView.decorations.of(
      Decoration.set([Decoration.mark({ class: "test-mark" }).range(0, 5)]),
    )];
    const v = new EditorView({
      state: EditorState.create({ doc: "Hello there", extensions: marked }),
      parent: document.body,
    });
    v.contentDOM.focus();
    v.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(5, -1)]) });
    expect(v.domAtPos(5, -1)).not.toEqual(v.domAtPos(5, 1));
    const { sel, collapses } = fakeSelection(v.contentDOM, 0);
    syncDomCaretToState(v, sel);
    const at = v.domAtPos(5, -1);
    expect(collapses).toEqual([{ node: at.node, offset: at.offset }]);
    v.destroy();
  });

  it("does nothing for a non-empty selection", () => {
    const v = mk("Hello there", 0);
    v.dispatch({ selection: { anchor: 0, head: 5 } });
    const text = v.contentDOM.querySelector(".cm-line")!.firstChild!;
    const { sel, collapses } = fakeSelection(text, 2);
    syncDomCaretToState(v, sel);
    expect(collapses).toEqual([]);
    v.destroy();
  });

  it("does nothing while the editor's content is not the focused element", () => {
    const v = mk("Hello there", 11);
    v.contentDOM.blur();
    const text = v.contentDOM.querySelector(".cm-line")!.firstChild!;
    const { sel, collapses } = fakeSelection(text, 0);
    syncDomCaretToState(v, sel);
    expect(collapses).toEqual([]);
    v.destroy();
  });

  it("leaves a selection the user made outside the editor's content alone", () => {
    const v = mk("Hello there", 11);
    const { sel, collapses } = fakeSelection(document.body, 0);
    syncDomCaretToState(v, sel);
    expect(collapses).toEqual([]);
    v.destroy();
  });

  it("waits out the window after a composition ends", () => {
    const v = mk("Hello there", 11);
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    const text = v.contentDOM.querySelector(".cm-line")!.firstChild!;
    const { sel, collapses } = fakeSelection(text, 0);
    syncDomCaretToState(v, sel);
    expect(collapses).toEqual([]);
    v.destroy();
  });
});
