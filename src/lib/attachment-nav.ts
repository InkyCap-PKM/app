// Right-click menu for an attachment embedded in a note: the file behind an
// `#image(...)`, `#video(...)` or `#audio(...)` call.
//
// Attachments live somewhere in the notebox (Typst only reads files under the
// project root, which InkyCap sets to the notebox root), but nothing else in
// the app points from the note back to the file: global search covers notes,
// and the file tree cannot know which image the writer is looking at. The menu
// closes that gap with the same two "find this file" actions the File Actions
// menu offers for the note itself, plus opening the file in its own tab, where
// the right panel lists every note that uses it, either in place of the note
// or in a new tab.

import * as ipc from "./ipc";
import { t } from "./i18n";
import { toastError } from "../stores/toasts";
import { showContextMenu } from "./context-menu";
import { revealInFileTree } from "./file-tree-reveal";
import { attachmentViewKind } from "./media-src";
import { openTab } from "../stores/tabs";
import { openFileInDefaultApp } from "./open-link";
import { deleteActiveFileInteractive } from "./delete-file";

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
    ...(attachmentViewKind(resolved)
      ? [
          { label: t("common.open"), run: () => openResolved(resolved, "here") },
          {
            label: t("attachmentView.openInTab"),
            run: () => openResolved(resolved, "new-tab"),
          },
        ]
      : []),
    { label: t("attachmentView.openExternally"), run: () => openExternally(resolved) },
    { label: t("common.showInFileTree"), run: () => revealInFileTree(resolved) },
    { label: t("common.showInFileManager"), run: () => void showInFileManager(resolved) },
  ]);
}

/**
 * Open the notebox file named by `target` (any form `resolve_embed_path`
 * accepts) in an attachment tab, brought to the front. Used where the user
 * asks for the file itself, such as a PDF image's open button in the visual
 * editor.
 */
export async function openAttachmentInTab(target: string): Promise<void> {
  let path: string | null = null;
  try {
    path = await ipc.resolveEmbedPath(target);
  } catch (err) {
    console.error("[attachment-nav] resolve failed:", target, err);
  }
  if (!path) {
    toastError(t("attachment.menu.notFound"));
    return;
  }
  openResolved(path, "new-tab-in-front");
}

/** Open the notebox file named by `target` (any form `resolve_embed_path`
 *  accepts) in the system's default application. Used by an embed's open
 *  button when the file can't be shown inside InkyCap. */
export async function openAttachmentExternally(target: string): Promise<void> {
  let path: string | null = null;
  try {
    path = await ipc.resolveEmbedPath(target);
  } catch (err) {
    console.error("[attachment-nav] resolve failed:", target, err);
  }
  if (!path) {
    toastError(t("attachment.menu.notFound"));
    return;
  }
  openExternally(path);
}

/** Where `openResolved` shows a file: in place of the current tab (whose
 *  back arrow returns to the note), in a new tab that follows the "Switch to
 *  new tabs immediately" setting like every other "Open in new tab", or in a
 *  new tab brought to the front regardless. */
type OpenPlace = "here" | "new-tab" | "new-tab-in-front";

/** Open the resolved file `path` in an attachment tab. */
function openResolved(path: string, place: OpenPlace): void {
  const tab = { type: "attachment" as const, title: path.split("/").pop() ?? path, path };
  if (place === "here") {
    openTab(tab);
  } else {
    openTab(tab, { forceNewTab: true, newTabAction: place === "new-tab" });
  }
}

function openExternally(path: string): void {
  openFileInDefaultApp(path).catch((err) => toastError(t("editor.toast.openFailed"), err));
}

async function showInFileManager(path: string): Promise<void> {
  try {
    await ipc.showInExplorer(path);
  } catch (err) {
    toastError(t("common.showInFileManagerFailed"), err);
  }
}

/**
 * Show the file actions for an attachment open in tab `tabId` at viewport
 * coordinates `(x, y)`: open it in the default application, find it, or
 * delete it. Used by the attachment view's right-click and the right
 * panel's File Actions button.
 */
export function showAttachmentFileMenu(x: number, y: number, path: string, tabId: string): void {
  showContextMenu(x, y, [
    { label: t("attachmentView.openExternally"), run: () => openExternally(path) },
    { label: t("common.showInFileTree"), run: () => revealInFileTree(path) },
    { label: t("common.showInFileManager"), run: () => void showInFileManager(path) },
    "separator",
    { label: t("common.delete"), danger: true, run: () => void deleteActiveFileInteractive(tabId) },
  ]);
}
