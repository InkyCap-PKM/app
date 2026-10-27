// Removes a duplicate list marker when a copied list item is pasted after an
// existing marker.
//
// A whole-line copy of `- item` keeps its `- ` so it becomes a bullet when
// pasted into text. But pasted right after an existing marker it would give `-
// - item` (two bullets). When the caret has only indentation and a marker
// before it on its line and the pasted text starts with a marker, the pasted
// marker is dropped. Any other paste is left alone.

import { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { dispatchVisible } from "./dispatch-visible";

/** A list marker (`-`, `+`, or `N.`) plus its trailing space, at line start. */
const LEADING_MARKER = /^(\s*)(?:[-+]|\d+\.)[ \t]+/;
/** The caret's line prefix is only indentation and a marker (no text yet). */
const MARKER_ONLY_PREFIX = /^(\s*)(?:[-+]|\d+\.)[ \t]*$/;

/**
 * The text to insert (replacing the selection) when the paste would repeat a
 * list marker, or `null` to paste normally. Pure (no DOM, no dispatch), so it
 * can be unit-tested.
 */
export function listPasteInsertion(state: EditorState, clipboard: string): string | null {
  if (!clipboard || !LEADING_MARKER.test(clipboard)) return null;

  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.from);
  const before = state.doc.sliceString(line.from, sel.from);
  if (!MARKER_ONLY_PREFIX.test(before)) return null;

  let insert = clipboard.slice(clipboard.match(LEADING_MARKER)![0].length);
  // A whole-line copy of one item ends with a newline. If nothing follows the
  // caret on its line, drop one trailing newline so no empty bullet is left
  // below.
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
    dispatchVisible(view, view.state.replaceSelection(insert));
    event.preventDefault();
    return true;
  },
});
