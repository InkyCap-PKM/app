// Interactive "Delete file" flow: confirm with the user, delete the
// note on disk, and close its tab. Shared by the File Actions menu
// (RightPanel) and the Ctrl+D command so both entry points behave
// identically.

import { ask } from "@tauri-apps/plugin-dialog";
import { getActiveTab, closeTab } from "../stores/tabs";
import * as ipc from "./ipc";
import { t } from "./i18n";
import { toastError } from "../stores/toasts";

/** Confirm and permanently delete the active file tab's note, then
 *  close the tab. No-op when the active tab is not a file or the user
 *  declines the confirmation. Errors surface as a toast. */
export async function deleteActiveFileInteractive(): Promise<void> {
  const tab = getActiveTab();
  if (!tab || tab.type !== "file") return;
  const confirmed = await ask(t("fileActions.deleteConfirm"), {
    title: t("fileActions.deleteTitle"),
    kind: "warning",
  });
  if (!confirmed) return;
  try {
    await ipc.deleteFile(tab.path);
    closeTab(tab.id);
  } catch (err) {
    toastError(t("fileActions.deleteFailed"), err);
  }
}
