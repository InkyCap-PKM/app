// Interactive "Delete file" flow: confirm with the user, delete the
// note on disk, and close its tab. Shared by the File Actions menu
// (RightPanel) and the Ctrl+D command so both entry points behave
// identically.

import { getActiveTab, closeTab } from "../stores/tabs";
import { promptConfirm } from "../stores/prompt";
import * as ipc from "./ipc";
import { t } from "./i18n";
import { toastError } from "../stores/toasts";

/** Confirm and permanently delete the active file tab's note, then
 *  close the tab. No-op when the active tab is not a file or the user
 *  declines the confirmation. Errors surface as a toast. */
export async function deleteActiveFileInteractive(): Promise<void> {
  const tab = getActiveTab();
  if (!tab || tab.type !== "file") return;
  const confirmed = await promptConfirm({
    title: t("fileActions.deleteTitle"),
    message: t("fileActions.deleteConfirm"),
    confirmLabel: t("common.delete"),
    cancelLabel: t("common.cancel"),
  });
  if (!confirmed) return;
  try {
    await ipc.deleteFile(tab.path);
    closeTab(tab.id);
  } catch (err) {
    toastError(t("fileActions.deleteFailed"), err);
  }
}
