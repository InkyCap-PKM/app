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
// actually edit at has moved. CodeMirror reads the anchor, sees nothing wrong,
// and the next character lands somewhere else. The same family of bug exists
// in Chrome and CodeMirror carries a workaround for it there; this is the
// WebKit equivalent, done from the outside through the public API.
//
// After each update the selection is collapsed at the DOM position CodeMirror
// itself resolves for the caret — *unconditionally*, even when the browser's
// reported range already names that exact node and offset. Comparing first
// cannot work: in the repro below the reported range is the same node object
// at the same offset as the caret's, and the browser still edits elsewhere, so
// any comparison passes while the bug is live. Re-running collapse() with the
// resolved coordinates makes WebKit re-register the position; when the
// selection already sits there it is a no-op for every other engine, and it
// measures at a few microseconds, so running it on every update is free.
//
// The divergence shows up around paired delimiters (`` `…` ``, `[[…]]`, and
// any start/stop region whose delimiters are wrapped in their own spans):
// CodeMirror parks the caret at offset 0 of the closing delimiter's text node,
// and WebKit's editing position drifts to the start of the enclosed content —
// a paste between the delimiters followed by Backspace and more typing then
// inserts at that stale spot. Verified end-to-end in a real WebKitGTK window
// through scripts/webkit-harness (`h.pasteBackspaceType`), which is the
// regression test for this file.
//
// Left alone: a focused nested editor (a table cell, a verse canvas), which
// owns its own selection; a selection the user made outside the editor's
// content; a composition in progress, and the short window after one ends
// while the browser is still committing the text.
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/**
 * How long after `compositionend` to leave the selection alone. WebKit commits
 * the composed text a little after the event fires, and moving the selection
 * in that window can drop the text at the wrong place. CodeMirror allows for
 * the same delay internally.
 */
const COMPOSITION_SETTLE_MS = 100;

/** When each view last ended a composition, for the settle window above. */
const compositionEndedAt = new WeakMap<EditorView, number>();

/**
 * Re-collapses `domSel` at the DOM position CodeMirror resolves for the caret,
 * so the browser types where the caret is. Runs whether or not the browser's
 * range looks correct; see the note at the top of the file.
 */
export function syncDomCaretToState(view: EditorView, domSel: Selection): void {
  if (view.composing) return;
  const endedAt = compositionEndedAt.get(view);
  if (endedAt !== undefined && Date.now() - endedAt < COMPOSITION_SETTLE_MS) return;
  const sel = view.state.selection.main;
  if (!sel.empty) return;
  if (view.root.activeElement !== view.contentDOM) return;
  // A selection the user made elsewhere (a tooltip, a panel) is theirs to keep.
  const range = domSel.rangeCount > 0 ? domSel.getRangeAt(0) : null;
  if (range && !view.contentDOM.contains(range.startContainer)) return;
  let at: { node: Node; offset: number };
  try {
    // The same side CodeMirror places the caret on, so this never moves it
    // across a decoration boundary.
    at = view.domAtPos(sel.head, sel.assoc < 0 ? -1 : 1);
  } catch {
    // The caret's line is not drawn (scrolled far away, folded); CodeMirror
    // places the selection itself when it comes back into view.
    return;
  }
  domSel.collapse(at.node, at.offset);
}

function selectionOf(view: EditorView): Selection | null {
  const root = view.root as Document | ShadowRoot;
  return (root as Document).getSelection?.() ?? view.dom.ownerDocument.getSelection();
}

function sync(view: EditorView) {
  const domSel = selectionOf(view);
  if (domSel) syncDomCaretToState(view, domSel);
}

export const domCaretResync: Extension = [
  EditorView.updateListener.of((update) => sync(update.view)),
  EditorView.domEventObservers({
    compositionend(_event, view) {
      compositionEndedAt.set(view, Date.now());
      // The update that commits the composed text lands inside the settle
      // window and is skipped, so catch up once the window has passed.
      setTimeout(() => {
        if (view.dom.isConnected) sync(view);
      }, COMPOSITION_SETTLE_MS);
    },
  }),
];
