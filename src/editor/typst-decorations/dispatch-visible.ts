import type { EditorView } from "@codemirror/view";
import type { TransactionSpec } from "@codemirror/state";

/**
 * Apply an edit the writer just triggered from the keyboard, and keep the
 * caret on screen.
 *
 * CodeMirror scrolls only when a transaction asks it to. A command that leaves
 * the flag out lets the caret slip below the bottom of the page — most visibly
 * when pressing Enter on the last visible line, where the new line lands just
 * out of sight and stays there until some later keystroke happens to scroll it
 * back. Every keystroke-driven command dispatches through here so none of them
 * can forget.
 *
 * Not for edits the writer didn't just ask for — reloading a file from disk,
 * a property-panel write, a background reindex — which should leave the
 * reader's place alone.
 */
export function dispatchVisible(view: EditorView, spec: TransactionSpec): void {
  view.dispatch({ ...spec, scrollIntoView: true });
}
