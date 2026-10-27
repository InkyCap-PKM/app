// Handles "a note with this name already exists" when creating a note. Names
// are unique across the notebox (wikilinks resolve by name), so the backend
// refuses a name used in another folder, with the `note-name-conflict` code and
// the existing note's path in `detail` (see src-tauri/src/errors.rs). Every
// creation path asks the user here what they meant.

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
 * Ask how to resolve a name conflict: open the existing note, append a ZID to
 * keep both, or choose another name (cancelling any dialog aborts).
 *
 * `existingPath` is the note that has the name; `attemptedName` is the name
 * tried, filled into the rename field (the existing note's name if not given,
 * e.g. for a rule-generated name).
 *
 * Appending a ZID resolves as a `rename` with the new name, so callers just
 * retry with `res.name`, and their retry loop asks again if that collides too.
 */
export async function resolveNoteNameConflict(
  existingPath: string,
  attemptedName?: string,
): Promise<NoteNameConflictResolution> {
  const name = noteName(existingPath);
  // The base the user was aiming for — what a ZID gets appended to, and what
  // the rename field pre-fills with.
  const base = attemptedName?.replace(/\.typ$/i, "") || name;

  // Offer the ZID option only if Zettelkasten IDs are set up for the notebox.
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
