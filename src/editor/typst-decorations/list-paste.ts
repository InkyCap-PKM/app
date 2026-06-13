// List-paste normalization — strips a duplicate list marker when a copied list
// item is pasted onto another list item.
//
// A whole-line copy of `- item` carries its `- ` marker so the item can be
// pasted into prose and reappear as a complete bullet. But when the caret
// already sits immediately after an existing marker, inserting that text
// verbatim produces a double bullet (`- - item` → `• • item`). This handler
// detects exactly that case — the caret preceded on its line by nothing but
// indentation and a marker, and clipboard text that itself begins with a
// marker — and drops the pasted line's leading marker so the existing one is
// reused. Every other paste position falls through untouched.

import { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";

/** A list marker (`-`, `+`, or `N.`) plus its trailing space, at line start. */
const LEADING_MARKER = /^(\s*)(?:[-+]|\d+\.)[ \t]+/;
/** The caret's line prefix is only indentation and a marker (no text yet). */
const MARKER_ONLY_PREFIX = /^(\s*)(?:[-+]|\d+\.)[ \t]*$/;

/**
 * Given the current editor state and pasted plain text, return the text that
 * should actually be inserted (replacing the selection) when the paste would
 * otherwise duplicate a list marker, or `null` when this handler does not apply
 * and the paste should proceed normally. Pure — no DOM, no dispatch — so it can
 * be unit-tested directly.
 */
export function listPasteInsertion(state: EditorState, clipboard: string): string | null {
  if (!clipboard || !LEADING_MARKER.test(clipboard)) return null;

  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.from);
  const before = state.doc.sliceString(line.from, sel.from);
  if (!MARKER_ONLY_PREFIX.test(before)) return null;

  let insert = clipboard.slice(clipboard.match(LEADING_MARKER)![0].length);
  // A linewise single-item copy ends in a newline. When the caret's line has
  // no text after it, drop one trailing newline so the item lands on this line
  // cleanly instead of leaving a dangling empty bullet below.
  const after = state.doc.sliceString(sel.to, line.to);
  if (after.length === 0 && insert.endsWith("\n")) {
    insert = insert.replace(/\n$/, "");
  }
  return insert;
}

export const listPasteHandler = EditorView.domEventHandlers({
  paste(event, view) {
    const clipboard = event.clipboardData?.getData("text/plain") ?? "";
    const insert = listPasteInsertion(view.state, clipboard);
    if (insert === null) return false;
    view.dispatch(view.state.replaceSelection(insert));
    event.preventDefault();
    return true;
  },
});
