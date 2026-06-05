// Interactive "Move file to…" flow: prompt for a destination folder,
// move the note on disk, and re-point the open tab at the new path.
// Shared by the File Actions menu (RightPanel) and the Ctrl+M command
// so both entry points behave identically.

import { getActiveTab, closeTab, openTab } from "../stores/tabs";
import { pickFolder } from "../stores/folderPicker";
import * as ipc from "./ipc";
import { t } from "./i18n";
import { toastError } from "../stores/toasts";

/** Open the notebox-scoped folder picker for the active file tab and
 *  move the note into the chosen folder. No-op when the active tab is
 *  not a file. Errors surface as a toast. */
export async function moveActiveFileInteractive(): Promise<void> {
  const tab = getActiveTab();
  if (!tab || tab.type !== "file") return;
  try {
    // The picker returns a notebox-relative path ("" for the root),
    // exactly the shape `move_file` expects.
    const slash = tab.path.lastIndexOf("/");
    const currentParent = slash >= 0 ? tab.path.slice(0, slash) : undefined;
    const dest = await pickFolder({
      title: t("leftSidebar.moveFile"),
      currentParent,
    });
    if (dest == null) return;
    const newPath = await ipc.moveFile(tab.path, dest);
    const name = newPath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? tab.title;
    closeTab(tab.id);
    openTab({ type: "file", title: name, path: newPath }, { forceNewTab: true });
  } catch (err) {
    toastError(t("fileActions.moveFailed"), err);
  }
}
