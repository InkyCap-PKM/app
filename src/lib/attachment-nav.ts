// Right-click menu for an attachment embedded in a note: the file behind an
// `#image(...)`, `#video(...)` or `#audio(...)` call.
//
// Attachments live somewhere in the notebox (Typst only reads files under the
// project root, which InkyCap sets to the notebox root), but nothing else in
// the app points from the note back to the file: global search covers notes,
// and the file tree cannot know which image the writer is looking at. The menu
// closes that gap with the same two "find this file" actions the File Actions
// menu offers for the note itself.

import * as ipc from "./ipc";
import { t } from "./i18n";
import { toastError } from "../stores/toasts";
import { showContextMenu } from "./context-menu";
import { revealInFileTree } from "./file-tree-reveal";

/**
 * Show the attachment menu at viewport coordinates `(x, y)` for `target`, the
 * path exactly as written in the call (root-absolute, relative, or a bare
 * filename — every form `resolve_embed_path` accepts). A target that does not
 * resolve to a file in the notebox gets an explanatory line instead of actions.
 */
export async function showAttachmentContextMenu(
  x: number,
  y: number,
  target: string,
): Promise<void> {
  let path: string | null = null;
  try {
    path = await ipc.resolveEmbedPath(target);
  } catch (err) {
    console.error("[attachment-nav] resolve failed:", target, err);
  }

  if (!path) {
    showContextMenu(x, y, [{ hint: t("attachment.menu.notFound") }]);
    return;
  }

  const resolved = path;
  showContextMenu(x, y, [
    { label: t("common.showInFileTree"), run: () => revealInFileTree(resolved) },
    { label: t("common.showInFileManager"), run: () => void showInFileManager(resolved) },
  ]);
}

async function showInFileManager(path: string): Promise<void> {
  try {
    await ipc.showInExplorer(path);
  } catch (err) {
    toastError(t("common.showInFileManagerFailed"), err);
  }
}
