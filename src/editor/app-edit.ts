// Edits the app makes to the open note's text on the writer's behalf, such as
// recording a source in `#note(...)` or adding a package import above the
// notebox import: places the writer can't type in.

import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { externalReload } from "./typst-decorations/visual-protected";

/**
 * Replace the editor's text with `transform`'s result, changing only the span
 * that differs, so the cursor and the rest of the note are untouched and the
 * change is one undo step. Marked as the app's own edit, so the locks on the
 * note's header (import line, `#note(...)`) let it through.
 *
 * `transform` may be async (a backend call); if the writer types meanwhile, it
 * runs again on the new text, up to three times. Resolves to whether the text
 * was changed.
 */
export async function editAsApp(
  view: EditorView,
  transform: (text: string) => Promise<string>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = view.state.doc.toString();
    const after = await transform(before);
    if (after === before) return false;
    if (view.state.doc.toString() !== before) continue;
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let endBefore = before.length;
    let endAfter = after.length;
    while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
      endBefore--;
      endAfter--;
    }
    view.dispatch({
      changes: { from: start, to: endBefore, insert: after.slice(start, endAfter) },
      annotations: [externalReload.of(true), Transaction.addToHistory.of(true)],
    });
    return true;
  }
  return false;
}
