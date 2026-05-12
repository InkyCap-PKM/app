import type { EditorView } from "@codemirror/view";
import * as ipc from "./ipc";
import { typstStringEscape } from "./typst";

export type AttachmentFunc = "image" | "embed";

/**
 * Open the native attachment picker, copy each selected file into the
 * vault's configured attachment folder, and replace the editor range
 * `[from, to]` with `#image("/<path>")` (or `#embed(...)`) calls for
 * each picked file. Vault-root-absolute path emission is the load-bearing
 * invariant — see CLAUDE.md's portable-paths principle.
 *
 * If the user cancels the picker, the editor range is left untouched
 * (the slash-trigger or selection is preserved so the user can keep
 * typing or invoke a different command).
 */
export async function pickAndInsertAttachments(
  view: EditorView,
  from: number,
  to: number,
  func: AttachmentFunc,
): Promise<void> {
  let saved: string[];
  try {
    saved = await ipc.pickAndUploadToAttachments();
  } catch (err) {
    console.error(`[attachment-insert] picker failed for ${func}:`, err);
    return;
  }

  if (saved.length === 0) return; // user cancelled

  const calls = saved.map(
    (rel) => `#${func}("/${typstStringEscape(rel)}")`,
  );
  const insert = calls.join("\n");

  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
  });
  view.focus();
}
