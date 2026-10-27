// Package export and import with a file dialog, for the collaboration panel's
// buttons and the command palette and shortcuts. The store's `exportPackage` /
// `importPackage` take a path and have no dialog, so they can be tested.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as ipc from "./ipc";
import { homeDirDefault } from "./dialog-defaults";
import { exportPackage, importPackage } from "../stores/git";
import { t } from "./i18n";

/**
 * File filter for packages: a `.zip` of the notebox's `.git`. `.inkypkg` is
 * still accepted on import for older packages.
 */
const PACKAGE_FILTERS = [{ name: "Notebox package (zip)", extensions: ["zip", "inkypkg"] }];

/**
 * Ask where to save, then export the open notebox as a package. Does nothing if
 * cancelled. `password` (optional) encrypts the archive; the recipient needs it
 * separately.
 */
export async function exportPackageInteractive(password?: string): Promise<void> {
  const dest = await ipc.pickExportFile({
    title: t("git.package.exportTitle"),
    // Start outside the notebox (home): a package saved inside the folder being
    // packaged would end up inside later packages.
    defaultPath: await homeDirDefault("notebox.zip"),
    filters: PACKAGE_FILTERS,
  });
  if (!dest) return;
  await exportPackage(dest, password?.trim() || undefined);
}

/**
 * Ask for a package file, then import (merge) it into the open notebox. Does
 * nothing if cancelled. `password` (optional) decrypts it.
 */
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
