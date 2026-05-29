// Default starting locations for native file/folder dialogs.
//
// Every `save()` / `open()` call in the app routes its `defaultPath`
// through one of the helpers here so the file-manager always opens
// somewhere sensible — never the process working directory (which, in
// `tauri dev`, is the build folder). The policy, by dialog role:
//
//   - Saving/finding something OUTSIDE the notebox (exports, imports of
//     foreign archives, picking an attachment off disk) → the user's
//     home directory. Exports additionally remember the last folder the
//     user exported to, so repeated exports land together.
//   - Reading/writing something tied to the CURRENT notebox (git
//     handoff packages, restore-into-this-notebox, bibliography/CSL
//     config) → the notebox root.
//   - Something the user has explicitly configured (the backup
//     destination) → that setting, falling back to home.
//
// The "last export location" is intentionally kept in localStorage, not
// in `settings.json`: it is ephemeral UI convenience state, and the
// per-notebox settings file is git-tracked under collaboration — we do
// not want a local export path creating noise in shared history.

import { homeDir, join, dirname } from "@tauri-apps/api/path";
import { noteboxInfo } from "../stores/notebox";
import { settings } from "../stores/settings";

const LAST_EXPORT_DIR_KEY = "inkycap:last-export-dir";

/** Home directory, optionally with a suggested filename appended so a
 *  `save()` dialog pre-fills the name. Used for dialogs that operate
 *  outside any notebox. */
export async function homeDirDefault(filename?: string): Promise<string> {
  const base = await homeDir();
  return filename ? join(base, filename) : base;
}

/** The current notebox root, optionally joined with sub-segments (e.g. a
 *  suggested filename). Returns `undefined` when no notebox is open, in
 *  which case the caller should omit `defaultPath` entirely. */
export async function noteboxRootDefault(
  ...segments: string[]
): Promise<string | undefined> {
  const root = noteboxInfo()?.path;
  if (!root) return undefined;
  return segments.length ? join(root, ...segments) : root;
}

/** Starting location for an export dialog: the folder of the user's most
 *  recent export if one is remembered, otherwise home. `filename`, when
 *  given, is appended so the dialog pre-fills the suggested name. */
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
