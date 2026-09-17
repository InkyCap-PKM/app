// Keeps the browser's caret where CodeMirror's caret is after the editor
// rebuilds the text around it.
//
// Every keystroke is inserted by the browser at *its* caret, so the two have
// to agree. CodeMirror checks after each redraw and rewrites the browser's
// selection when the two positions differ. On WebKitGTK that check can pass
// when it should not: after the nodes around the caret are replaced without
// the text changing (a highlight span being removed once a pulse ends, an
// inline decoration arriving after a delayed parse), the selection's reported
// anchor still names the old, correct spot while the range the browser will
// actually edit at has moved, usually to the start of the line. CodeMirror
// reads the anchor, sees nothing wrong, and the next character lands at the
// start of the line instead of under the caret. The same family of bug exists
// in Chrome and CodeMirror carries a workaround for it there; this is the
// WebKit equivalent, done from the outside through the public API.
//
// After each update the range's start is mapped back to a document position.
// If it is not the caret's, the selection is collapsed at the DOM position
// CodeMirror itself resolves for the caret, which the browser then honours.
// Nothing happens while the two agree, so this is free in the normal case.
//
// Only a plain caret is handled. A focused nested editor (a table cell, a
// verse canvas) owns its own selection and is left alone, and a composition
// in progress must not have its selection touched.
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/**
 * Re-collapses `domSel` at the caret if the range it would edit at maps to a
 * different document position. Returns true when it had to.
 */
export function syncDomCaretToState(view: EditorView, domSel: Selection): boolean {
  if (view.composing) return false;
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  if (view.root.activeElement !== view.contentDOM) return false;
  if (domSel.rangeCount === 0) return false;
  const range = domSel.getRangeAt(0);
  if (!view.contentDOM.contains(range.startContainer)) return false;
  let rangePos: number;
  let at: { node: Node; offset: number };
  try {
    rangePos = view.posAtDOM(range.startContainer, range.startOffset);
    if (range.collapsed && rangePos === sel.head) return false;
    at = view.domAtPos(sel.head);
  } catch {
    // The caret's line is not drawn (scrolled far away, folded); CodeMirror
    // places the selection itself when it comes back into view.
    return false;
  }
  domSel.collapse(at.node, at.offset);
  return true;
}

function selectionOf(view: EditorView): Selection | null {
  const root = view.root as Document | ShadowRoot;
  return (root as Document).getSelection?.() ?? view.dom.ownerDocument.getSelection();
}

export const domCaretResync: Extension = EditorView.updateListener.of((update) => {
  const domSel = selectionOf(update.view);
  if (domSel) syncDomCaretToState(update.view, domSel);
});
