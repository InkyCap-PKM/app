import type { EditorView } from "@codemirror/view";
import type { TransactionSpec } from "@codemirror/state";

/**
 * Apply an edit the user just made from the keyboard and keep the caret on
 * screen.
 *
 * CodeMirror scrolls only when a transaction asks it to. A command that doesn't
 * would let the caret slip below the page, most visibly with Enter on the last
 * visible line, where the new line stays just out of sight. Every keystroke
 * command dispatches through here.
 *
 * Not for edits the user didn't just make (reloading a file, a property panel
 * write, a background reindex), which should leave the reader's place alone.
 */
export function dispatchVisible(view: EditorView, spec: TransactionSpec): void {
  view.dispatch({ ...spec, scrollIntoView: true });
}
