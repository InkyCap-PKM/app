// In-app folder picker: a keyboard-friendly dialog for choosing a folder in the
// notebox, for "Move file/folder to…" in the file tree menu and File Actions
// menu. Like stores/prompt.ts: a signal holds the request, FolderPickerHost
// renders it, and `pickFolder()` returns a Promise.
//
// Only existing folders in the open notebox are offered, so nothing can be
// moved outside it. New folders are made with "New Folder", not here.

import { createSignal } from "solid-js";

export interface FolderPickerOptions {
  /** Modal heading, e.g. "Move file to…". */
  title: string;
  /** Placeholder shown in the filter input. */
  placeholder?: string;
  /**
   * Absolute path of a folder to hide with all its subfolders, so a folder
   * can't be moved into itself.
   */
  disallowPrefix?: string;
  /**
   * Absolute path of the item's current folder, hidden since moving there would
   * do nothing.
   */
  currentParent?: string;
}

interface FolderPickerState extends FolderPickerOptions {
  resolve: (value: string | null) => void;
}

const [activeFolderPicker, setActiveFolderPicker] =
  createSignal<FolderPickerState | null>(null);

export { activeFolderPicker };

/**
 * Open the folder picker. Resolves with the chosen folder's notebox-relative
 * path (`""` is the root), or `null` if dismissed. An open picker is cancelled
 * (`null`) first.
 */
export function pickFolder(
  opts: FolderPickerOptions,
): Promise<string | null> {
  const existing = activeFolderPicker();
  if (existing) existing.resolve(null);
  return new Promise<string | null>((resolve) => {
    setActiveFolderPicker({ ...opts, resolve });
  });
}

/** Internal: used by FolderPickerHost to settle the active request. */
export function resolveFolderPicker(value: string | null) {
  const cur = activeFolderPicker();
  if (!cur) return;
  setActiveFolderPicker(null);
  cur.resolve(value);
}
