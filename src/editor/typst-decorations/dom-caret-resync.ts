// Keeps the browser's caret where CodeMirror's is after the editor redraws the
// text around it.
//
// The browser inserts each keystroke at its own caret, so the two must agree.
// CodeMirror checks after every redraw, but on WebKitGTK the check can pass
// wrongly: when nodes around the caret are replaced without the text changing
// (a highlight span removed when a pulse ends, a decoration arriving after a
// delayed parse), the selection still reports the old spot while the browser
// would edit somewhere else, so the next character lands elsewhere. CodeMirror
// has a workaround for the same problem in Chrome; this is the WebKit
// equivalent, through the public API.
//
// After each update the selection is collapsed at the DOM position CodeMirror
// resolves for the caret, always: in the failing case the reported range is the
// same node and offset, so a comparison would pass. Collapsing again makes
// WebKit re-register the position; elsewhere it is a no-op, and it costs
// microseconds.
//
// It happens around paired delimiters (`` `…` ``, `[[…]]`, and others whose
// delimiters have their own spans): CodeMirror puts the caret at offset 0 of
// the closing delimiter's text node, and WebKit's edit position drifts to the
// start of the content, so a paste, Backspace and more typing go to the wrong
// place. Tested in a real WebKitGTK window with scripts/webkit-harness
// (`h.pasteBackspaceType`), the regression test for this file.
//
// Not touched: a focused nested editor (table cell, verse canvas), a selection
// outside the editor's content, and an ongoing composition (and just after one
// ends).
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/**
 * How long after `compositionend` to leave the selection alone: WebKit commits
 * the text slightly later, and moving the selection meanwhile can misplace it.
 * CodeMirror allows the same delay.
 */
const COMPOSITION_SETTLE_MS = 100;

/** When each view last ended a composition, for the settle window above. */
const compositionEndedAt = new WeakMap<EditorView, number>();

/**
 * Collapse `domSel` at the DOM position CodeMirror resolves for the caret,
 * whether or not it already looks right (see the top of the file).
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
