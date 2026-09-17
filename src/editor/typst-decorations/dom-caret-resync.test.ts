import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syncDomCaretToState, domCaretResync } from "./dom-caret-resync";

// jsdom's selection always agrees with itself, so the WebKit disagreement this
// guards against — the selection's anchor reporting one spot while its range
// edits at another — is stood in for by a fake selection whose range is
// somewhere other than the caret. The real thing is checked in a WebKitGTK
// window through scripts/webkit-harness.

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
    expect(syncDomCaretToState(v, sel)).toBe(true);
    const at = v.domAtPos(11);
    expect(collapses).toEqual([{ node: at.node, offset: at.offset }]);
    v.destroy();
  });

  it("leaves a range that already sits at the caret alone", () => {
    const v = mk("Hello there", 5);
    const text = v.contentDOM.querySelector(".cm-line")!.firstChild!;
    const { sel, collapses } = fakeSelection(text, 5);
    expect(syncDomCaretToState(v, sel)).toBe(false);
    expect(collapses).toEqual([]);
    v.destroy();
  });

  it("does nothing for a non-empty selection", () => {
    const v = mk("Hello there", 0);
    v.dispatch({ selection: { anchor: 0, head: 5 } });
    const text = v.contentDOM.querySelector(".cm-line")!.firstChild!;
    const { sel, collapses } = fakeSelection(text, 2);
    expect(syncDomCaretToState(v, sel)).toBe(false);
    expect(collapses).toEqual([]);
    v.destroy();
  });

  it("does nothing while the editor's content is not the focused element", () => {
    const v = mk("Hello there", 11);
    v.contentDOM.blur();
    const text = v.contentDOM.querySelector(".cm-line")!.firstChild!;
    const { sel, collapses } = fakeSelection(text, 0);
    expect(syncDomCaretToState(v, sel)).toBe(false);
    expect(collapses).toEqual([]);
    v.destroy();
  });

  it("ignores a range outside the editor", () => {
    const v = mk("Hello there", 11);
    const { sel, collapses } = fakeSelection(document.body, 0);
    expect(syncDomCaretToState(v, sel)).toBe(false);
    expect(collapses).toEqual([]);
    v.destroy();
  });
});
