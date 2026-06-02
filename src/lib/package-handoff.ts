// Offline package-handoff gestures, driven by a file dialog.
//
// These wrap the store's `exportPackage` / `importPackage` with the
// open/save dialog so the whole gesture lives in one place — shared by the
// collaboration panel's Export/Import buttons and the command-palette /
// keyboard-shortcut entries. The store functions stay dialog-free (they take a
// resolved path) so they remain unit-testable; this is the thin UI seam.

import { save, open as openDialog } from "@tauri-apps/plugin-dialog";
import { homeDirDefault } from "./dialog-defaults";
import { exportPackage, importPackage } from "../stores/git";
import { t } from "./i18n";

/** Filename filter for package archives. A package is a plain `.zip` (of the
 *  notebox's `.git`); `.inkypkg` is still accepted on import for packages
 *  exported by earlier builds. */
const PACKAGE_FILTERS = [{ name: "Notebox package (zip)", extensions: ["zip", "inkypkg"] }];

/** Prompt for a destination file, then export the open notebox as a package.
 *  No-op if the user cancels the save dialog. `password` (optional) encrypts the
 *  archive — the recipient needs it out of band. */
export async function exportPackageInteractive(password?: string): Promise<void> {
  const dest = await save({
    title: t("git.package.exportTitle"),
    // Default OUTSIDE the notebox (home), never the notebox root: writing the
    // handoff package into the very folder being packaged would fold prior
    // packages into each new one.
    defaultPath: await homeDirDefault("notebox.zip"),
    filters: PACKAGE_FILTERS,
  });
  if (!dest) return;
  await exportPackage(dest, password?.trim() || undefined);
}

/** Prompt for a package file, then import (reconcile) it into the open notebox.
 *  No-op if the user cancels the open dialog. `password` (optional) decrypts an
 *  encrypted archive. */
export async function importPackageInteractive(password?: string): Promise<void> {
  const picked = await openDialog({
    multiple: false,
    title: t("git.package.importTitle"),
    defaultPath: await homeDirDefault(),
    filters: PACKAGE_FILTERS,
  });
  if (typeof picked !== "string") return;
  await importPackage(picked, password?.trim() || undefined);
}
