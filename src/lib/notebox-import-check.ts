// Makes sure notes import the InkyCap notebox library
// (`#import "/.inkycap/notebox.typ": *`). Typst files made with other tools
// lack that line, so InkyCap functions like `#wikilink` and `#note` fail in
// the preview and elsewhere. Runs when a note is opened and after Typst files
// are copied or dropped into the notebox. Depending on the "Automatically add
// the InkyCap import" setting, the line is either added straight away or the
// user is asked first. The backend decides which files the check applies to
// (only `.typ` notes inside the notebox, never InkyCap's own `.inkycap/`
// files).

import { promptConfirmWithCheckbox } from "../stores/prompt";
import { settings, updateSetting } from "../stores/settings";
import { toastError, toastSuccess } from "../stores/toasts";
import { normalizePath } from "./paths";
import { t, tPlural } from "./i18n";
import * as ipc from "./ipc";

/** Notes the user chose to leave as they are. Remembered until the app
 *  restarts, so reopening or switching back to the tab doesn't ask again. */
const declined = new Set<string>();

/** Checks already running for an opened note, so a note opened in two panes
 *  at once is only handled (and asked about) once. */
const inFlight = new Map<string, Promise<void>>();

/**
 * Add the InkyCap import line to the note at `path` if it's missing, asking
 * the user first unless they've turned on automatic adding. Resolves once the
 * file on disk is in its final state, so the caller can read it afterwards.
 * Never throws: a failed check leaves the file as it is.
 */
export function ensureNoteboxImport(path: string): Promise<void> {
  const key = normalizePath(path);
  const running = inFlight.get(key);
  if (running) return running;
  const task = ensureNoteboxImports([path]).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

/**
 * Like {@link ensureNoteboxImport}, for a batch of files just brought into
 * the notebox (paths absolute or notebox-relative; non-Typst files are
 * ignored). Asks once for the whole batch rather than once per file.
 */
export async function ensureNoteboxImports(paths: string[]): Promise<void> {
  const candidates = paths.filter(
    (p) => p.toLowerCase().endsWith(".typ") && !declined.has(normalizePath(p)),
  );
  const missing = (
    await Promise.all(
      candidates.map(async (p) => {
        try {
          return (await ipc.noteMissingNoteboxImport(p)) ? p : null;
        } catch {
          // Whatever reads the file next reports any problem with it.
          return null;
        }
      }),
    )
  ).filter((p): p is string => p !== null);
  if (missing.length === 0) return;

  const nameOf = (p: string) => normalizePath(p).split("/").pop() ?? p;
  const count = missing.length;
  if (!(settings.export?.auto_add_notebox_import ?? true)) {
    const { confirmed, checked } = await promptConfirmWithCheckbox({
      title: t("noteboxImport.title"),
      message: tPlural("noteboxImport.message", count, { name: nameOf(missing[0]) }),
      confirmLabel: t("noteboxImport.add"),
      cancelLabel: t("noteboxImport.keep"),
      checkbox: { label: t("noteboxImport.always") },
    });
    if (!confirmed) {
      for (const p of missing) declined.add(normalizePath(p));
      return;
    }
    if (checked) updateSetting("export", "auto_add_notebox_import", true);
  }

  let added = 0;
  for (const p of missing) {
    try {
      if (await ipc.addNoteboxImport(p)) added += 1;
    } catch (e) {
      toastError(t("noteboxImport.addFailed", { name: nameOf(p) }), e);
    }
  }
  if (added > 0) {
    toastSuccess(tPlural("noteboxImport.added", added, { name: nameOf(missing[0]) }));
  }
}
