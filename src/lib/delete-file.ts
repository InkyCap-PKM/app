// Interactive "Delete file" flow: confirm with the user, delete the
// note or attachment on disk, and close its tab. Shared by the File Actions
// menus (RightPanel, AttachmentPanel) and the Ctrl+D command so every entry
// point behaves identically.

import { getActiveTab, closeTab, tabs } from "../stores/tabs";
import { promptConfirm } from "../stores/prompt";
import * as ipc from "./ipc";
import { t, tPlural } from "./i18n";
import { toastError } from "../stores/toasts";

/** Confirm and delete the note or attachment shown in tab `tabId` (the
 *  active tab when omitted), then close the tab. An attachment that notes
 *  still use says how many in the confirmation. No-op when the tab shows
 *  neither or the user declines the confirmation. Errors surface as a toast. */
export async function deleteActiveFileInteractive(tabId?: string): Promise<void> {
  const tab = tabId ? tabs.find((t) => t.id === tabId) : getActiveTab();
  if (!tab || (tab.type !== "file" && tab.type !== "attachment")) return;
  let message = t("fileActions.deleteConfirm");
  if (tab.type === "attachment") {
    const users = await ipc.getAttachmentReferences(tab.path).catch(() => []);
    if (users.length > 0) {
      message = tPlural("attachmentView.deleteConfirmUsed", users.length, {
        count: users.length,
      });
    }
  }
  const confirmed = await promptConfirm({
    title: t("fileActions.deleteTitle"),
    message,
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
