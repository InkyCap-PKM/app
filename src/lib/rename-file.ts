// Renaming a file or folder from any part of the UI (file tree, status bar,
// File Actions menu), so every entry point saves and rewrites links the same
// way.

import { flushAllEditors, flushEditorsAt } from "../stores/editor-writes";
import { settings } from "../stores/settings";
import { renameTabPath } from "../stores/tabs";
import * as ipc from "./ipc";

/** Rename the file or folder at `oldPath` to `newName`, point any tab open
 *  on it at the new path, and return the new path. When the "update links on
 *  rename" setting is on, links to it in other notes are rewritten too. For
 *  that, every open editor is saved first: the rewrite reads the linking
 *  notes from disk, so it must see links typed but not yet saved, and an
 *  editor with unsaved text would not take in the rewritten note. */
export async function renameFile(oldPath: string, newName: string): Promise<string> {
  let newPath: string;
  if (settings.files.auto_update_links_on_rename) {
    await flushAllEditors();
    newPath = await ipc.renameAndUpdateLinks(oldPath, newName);
  } else {
    await flushEditorsAt(oldPath);
    newPath = await ipc.renameFile(oldPath, newName);
  }
  renameTabPath(oldPath, newPath);
  return newPath;
}
