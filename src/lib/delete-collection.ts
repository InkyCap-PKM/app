// Deleting a collection from any part of the UI (the Collections list's
// right-click menu, the Collection settings pane), so every entry point asks
// the same question and cleans up open tabs and the sidebar the same way.

import { closeTab, tabs } from "../stores/tabs";
import { promptConfirm } from "../stores/prompt";
import { toastError } from "../stores/toasts";
import * as ipc from "./ipc";
import { t } from "./i18n";
import { pathEquals } from "./paths";

/** Ask the user to confirm, then delete the `.collection` file at `path`,
 *  close any tab open on it, and tell the sidebar to reload its list. The
 *  member notes are untouched. No-op when the user declines; errors surface
 *  as a toast. Resolves `true` only when the collection was deleted. */
export async function deleteCollectionInteractive(path: string, name: string): Promise<boolean> {
  const confirmed = await promptConfirm({
    title: t("collection.delete.title"),
    message: t("collection.delete.body", { name }),
    confirmLabel: t("common.delete"),
    cancelLabel: t("common.cancel"),
    danger: true,
  });
  if (!confirmed) return false;
  try {
    await ipc.deleteCollectionFile(path);
  } catch (e) {
    toastError(t("collection.delete.failed"), e);
    return false;
  }
  const openTab = tabs.find((tab) => tab.type === "collection" && pathEquals(tab.path, path));
  if (openTab) closeTab(openTab.id);
  document.dispatchEvent(new CustomEvent("inkycap:collections-changed"));
  return true;
}
