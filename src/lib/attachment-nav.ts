// Right-click menu for a file embedded in a note with `#image(...)`,
// `#video(...)` or `#audio(...)`.
//
// Nothing else leads from the note to the file (search covers notes, and the
// file tree can't know which image is meant), so the menu offers the File
// Actions menu's two "find this file" actions, plus opening the file in its own
// tab (in place of the note or in a new tab), where the right panel lists every
// note that uses it.

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
 * Show the attachment menu at viewport position `(x, y)` for `target`, the path
 * as written in the call (any form `resolve_embed_path` accepts). A target that
 * isn't a file in the notebox gets an explanation instead of actions.
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
 * Open the file named by `target` (any form `resolve_embed_path` accepts) in an
 * attachment tab in front, for example from a PDF image's open button in the
 * visual editor.
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

/**
 * Open the file named by `target` (any form `resolve_embed_path` accepts) in
 * the default application, for an embed's open button when InkyCap can't show
 * it.
 */
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

/**
 * Where `openResolved` shows a file: in place of the current tab (its back
 * arrow returns to the note), in a new tab following the "Switch to new tabs
 * immediately" setting, or in a new tab in front.
 */
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
 * Show the file actions for the attachment open in tab `tabId` at `(x, y)`:
 * open in the default application, find it, or delete it. Used by the
 * attachment view's right-click and the right panel's File Actions button.
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
