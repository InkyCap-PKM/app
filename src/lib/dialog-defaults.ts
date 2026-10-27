// Default starting folders for native file and folder dialogs.
//
// Every `save()` / `open()` takes its `defaultPath` from a helper here, so
// dialogs never open in the process's working folder (the build folder in
// `tauri dev`). By role:
//
//   - Something outside the notebox (exports, importing archives, picking a
//     file from disk): the home folder. Exports remember the last folder used.
//   - Something tied to the current notebox (git packages, restoring into this
//     notebox, bibliography/CSL files): the notebox root.
//   - A configured location (backup destination): that setting, or home.
//
// The last export folder is kept in localStorage, not `settings.json`, since
// the notebox settings file is in git when collaborating and a local path
// doesn't belong in shared history.

import { homeDir, join, dirname } from "@tauri-apps/api/path";
import { noteboxInfo } from "../stores/notebox";
import { settings } from "../stores/settings";

const LAST_EXPORT_DIR_KEY = "inkycap:last-export-dir";

/**
 * The home folder, with an optional file name so a `save()` dialog suggests it.
 * For dialogs not tied to a notebox.
 */
export async function homeDirDefault(filename?: string): Promise<string> {
  const base = await homeDir();
  return filename ? join(base, filename) : base;
}

/**
 * The notebox root, optionally joined with more parts (e.g. a file name).
 * `undefined` with no notebox open; the caller then leaves out `defaultPath`.
 */
export async function noteboxRootDefault(
  ...segments: string[]
): Promise<string | undefined> {
  const root = noteboxInfo()?.path;
  if (!root) return undefined;
  return segments.length ? join(root, ...segments) : root;
}

/**
 * Starting folder for an export dialog: the last export folder if known,
 * otherwise home, with `filename` appended if given.
 */
export async function exportDefault(filename?: string): Promise<string> {
  const remembered = localStorage.getItem(LAST_EXPORT_DIR_KEY);
  const base = remembered ?? (await homeDir());
  return filename ? join(base, filename) : base;
}

/** Remember the folder a file was just exported to (derived from the
 *  saved file's path), so the next export defaults there. */
export async function rememberExportFile(savedFilePath: string): Promise<void> {
  try {
    localStorage.setItem(LAST_EXPORT_DIR_KEY, await dirname(savedFilePath));
  } catch {
    // Non-fatal: a bad path just means the next export falls back to home.
  }
}

/** Remember a folder the user chose as an export destination directly
 *  (folder-target exports — static site, bulk PDFs, bulk markdown). */
export function rememberExportDir(dirPath: string): void {
  localStorage.setItem(LAST_EXPORT_DIR_KEY, dirPath);
}

/** Starting location for backup dialogs: the configured backup
 *  destination if the user has set one, otherwise home. */
export async function backupDefault(): Promise<string> {
  return settings.backup.path ?? (await homeDir());
}
