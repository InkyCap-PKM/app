// Renaming a collection from any part of the UI (the Collections list, the
// Collection settings pane), so every entry point updates open tabs and the
// sidebar the same way.

import { renameTabPath } from "../stores/tabs";
import * as ipc from "./ipc";
import type { CollectionInfo } from "./types";

/** Rename the collection at `oldPath` to `newName` (without the
 *  `.collection` extension), point any tab open on it at the new file, and
 *  tell the sidebar to reload its list. Bookmarks follow on the backend. */
export async function renameCollection(oldPath: string, newName: string): Promise<CollectionInfo> {
  const info = await ipc.renameCollectionFile(oldPath, newName);
  renameTabPath(oldPath, info.path, info.name);
  document.dispatchEvent(new CustomEvent("inkycap:collections-changed"));
  return info;
}
