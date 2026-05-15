// In-app folder picker. A keyboard-driven, vault-scoped dialog for
// choosing a destination folder — used by the "Move file/folder to…"
// actions in the file tree context menu and the File Actions menu.
//
// Pattern mirrors stores/prompt.ts: a module-level signal holds the
// active request, a single FolderPickerHost component subscribes to it,
// and the imperative `pickFolder()` function returns a Promise.
//
// Picking is deliberately confined to folders that already exist inside
// the open vault — a user cannot move a note outside the vault, which
// keeps filesystem access scoped to the vault root (see CLAUDE.md's
// security directives). New folders are created via the existing
// "New Folder" action, not here.

import { createSignal } from "solid-js";

export interface FolderPickerOptions {
  /** Modal heading, e.g. "Move file to…". */
  title: string;
  /** Placeholder shown in the filter input. */
  placeholder?: string;
  /**
   * Absolute path of a folder to hide from the list together with all
   * of its descendants. Set when moving a folder so it cannot be moved
   * into itself or one of its own subfolders.
   */
  disallowPrefix?: string;
  /**
   * Absolute path of the item's current parent folder. Excluded from
   * the list because moving into it would be a no-op.
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
 * Open the folder picker. Resolves with the chosen folder's
 * vault-relative path (the empty string `""` denotes the vault root),
 * or `null` if the user dismissed the dialog. If a picker is already
 * open it is cancelled (resolved with `null`) before the new one opens.
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
