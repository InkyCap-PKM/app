// Shared UX for "a note with this name already exists" on note creation.
//
// Filenames are notebox-globally unique (wikilinks resolve by stem), so the
// backend refuses to create a note whose name collides with one in a different
// folder, returning the `note-name-conflict` error code with the existing
// note's path in `detail` (see src-tauri/src/errors.rs). Rather than silently
// open the other note or duplicate it, every creation entry point routes the
// conflict through here to ask the user what they meant.

import { promptChoice, promptText } from "../stores/prompt";
import { settings } from "../stores/settings";
import * as ipc from "./ipc";
import { t } from "./i18n";

/** What the user chose when told the name already exists. */
export type NoteNameConflictResolution =
  | { action: "open"; path: string }
  | { action: "rename"; name: string }
  | { action: "cancel" };

/** The display name (no folder, no `.typ`) of a notebox-relative or absolute
 *  note path. */
function noteName(path: string): string {
  return (path.split(/[/\\]/).pop() ?? path).replace(/\.typ$/i, "");
}

/**
 * Ask the user how to resolve a note-name collision: open the existing note,
 * append a ZID to keep both, or pick a different name for the new one
 * (cancelling any dialog aborts).
 *
 * `existingPath` is the path of the note that already owns the name;
 * `attemptedName` is the name the user tried to use, pre-filled into the rename
 * field (defaults to the existing note's name when the caller didn't supply
 * one — e.g. a rule-generated filename).
 *
 * The "append ZID" path resolves as a `rename` with a generated name, so
 * callers need no extra branch: they already retry creation with `res.name`,
 * and their retry loop re-prompts in the (vanishingly unlikely) event that the
 * ZID-suffixed name collides too.
 */
export async function resolveNoteNameConflict(
  existingPath: string,
  attemptedName?: string,
): Promise<NoteNameConflictResolution> {
  const name = noteName(existingPath);
  // The base the user was aiming for — what a ZID gets appended to, and what
  // the rename field pre-fills with.
  const base = attemptedName?.replace(/\.typ$/i, "") || name;

  // Only offer the ZID shortcut when the notebox is actually configured for
  // Zettelkasten IDs; with the feature off (or no pattern) there is nothing
  // meaningful to append.
  const canAppendZid =
    settings.files.zettelkasten_enabled && settings.files.zid_pattern.trim() !== "";

  const choice = await promptChoice({
    title: t("noteConflict.title"),
    message: canAppendZid
      ? t("noteConflict.messageWithZid", { name })
      : t("noteConflict.message", { name }),
    options: [
      { id: "open", label: t("noteConflict.open"), variant: "primary" },
      ...(canAppendZid
        ? [{ id: "appendZid", label: t("noteConflict.appendZid"), variant: "secondary" as const }]
        : []),
      { id: "rename", label: t("noteConflict.rename"), variant: "secondary" as const },
    ],
  });
  if (choice === "open") return { action: "open", path: existingPath };

  if (choice === "appendZid") {
    // Generated backend-side so the ZID honours the user's `zid_pattern`
    // setting rather than reimplementing the format here.
    const zid = await ipc.generateZid();
    if (!zid.trim()) return { action: "cancel" };
    return { action: "rename", name: `${base} ${zid.trim()}` };
  }

  if (choice !== "rename") return { action: "cancel" };

  const newName = await promptText({
    title: t("noteConflict.renameTitle"),
    label: t("noteConflict.renameLabel"),
    initialValue: base,
    confirmLabel: t("common.create"),
    validate: (v) => (v.trim() === "" ? t("noteConflict.emptyError") : null),
  });
  if (newName === null || newName.trim() === "") return { action: "cancel" };
  return { action: "rename", name: newName.trim() };
}
