// Shared UX for "a note with this name already exists" on note creation.
//
// Filenames are notebox-globally unique (wikilinks resolve by stem), so the
// backend refuses to create a note whose name collides with one in a different
// folder, returning the `note-name-conflict` error code with the existing
// note's path in `detail` (see src-tauri/src/errors.rs). Rather than silently
// open the other note or duplicate it, every creation entry point routes the
// conflict through here to ask the user what they meant.

import { promptChoice, promptText } from "../stores/prompt";
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
 * Ask the user how to resolve a note-name collision: open the existing note, or
 * pick a different name for the new one (cancelling either dialog aborts).
 *
 * `existingPath` is the path of the note that already owns the name;
 * `attemptedName` is the name the user tried to use, pre-filled into the rename
 * field (defaults to the existing note's name when the caller didn't supply
 * one — e.g. a rule-generated filename).
 */
export async function resolveNoteNameConflict(
  existingPath: string,
  attemptedName?: string,
): Promise<NoteNameConflictResolution> {
  const name = noteName(existingPath);
  const choice = await promptChoice({
    title: t("noteConflict.title"),
    message: t("noteConflict.message", { name }),
    options: [
      { id: "open", label: t("noteConflict.open"), variant: "primary" },
      { id: "rename", label: t("noteConflict.rename"), variant: "secondary" },
    ],
  });
  if (choice === "open") return { action: "open", path: existingPath };
  if (choice !== "rename") return { action: "cancel" };

  const newName = await promptText({
    title: t("noteConflict.renameTitle"),
    label: t("noteConflict.renameLabel"),
    initialValue: attemptedName?.replace(/\.typ$/i, "") || name,
    confirmLabel: t("common.create"),
    validate: (v) => (v.trim() === "" ? t("noteConflict.emptyError") : null),
  });
  if (newName === null || newName.trim() === "") return { action: "cancel" };
  return { action: "rename", name: newName.trim() };
}
