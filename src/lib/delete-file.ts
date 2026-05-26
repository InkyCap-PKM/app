// Interactive "Delete file" flow: confirm with the user, delete the
// note on disk, and close its tab. Shared by the File Actions menu
// (RightPanel) and the Ctrl+D command so both entry points behave
// identically.

import { ask } from "@tauri-apps/plugin-dialog";
import { getActiveTab, closeTab } from "../stores/tabs";
import * as ipc from "./ipc";
import { toastError } from "../stores/toasts";

/** Confirm and permanently delete the active file tab's note, then
 *  close the tab. No-op when the active tab is not a file or the user
 *  declines the confirmation. Errors surface as a toast. */
export async function deleteActiveFileInteractive(): Promise<void> {
  const tab = getActiveTab();
  // A staged collaboration-review tab is a transient merge artifact, not a
  // note the user owns — deleting it would break finalize. Guard here so the
  // Ctrl+Shift+D command, the File Actions menu, and any future caller are
  // all covered.
  if (!tab || tab.type !== "file" || tab.collab) return;
  const confirmed = await ask("Delete this file permanently?", {
    title: "Delete file",
    kind: "warning",
  });
  if (!confirmed) return;
  try {
    await ipc.deleteFile(tab.path);
    closeTab(tab.id);
  } catch (err) {
    toastError("Delete failed", err);
  }
}
