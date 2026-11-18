// Literature notes: notes about one bibliography reference. The reference is
// the note's `source` property (`source: <otlet1934>`, shown as `@otlet1934`),
// and a scaffold's `{{ref}}` / `{{ref.FIELD}}` variables copy its details into
// the note when it is created (see src-tauri/src/scaffolds/reference.rs).

import * as ipc from "./ipc";
import { t } from "./i18n";
import type { ContextMenuEntry } from "./context-menu";
import { triggerCreationRule } from "../stores/creation-rules";
import { activeNotePath, openCreatedNote } from "../stores/tabs";
import { flushEditorsAt } from "../stores/editor-writes";
import { bumpPropertyVersion } from "../stores/notebox";
import { showToast, toastError } from "../stores/toasts";
import { pickReference } from "../stores/referencePicker";
import { promptChoice } from "../stores/prompt";

/** A bibliography reference, as both the bibliography and a note's citations
 *  list one. */
export interface Reference {
  key: string;
  title: string | null;
}

/** The reference variables named in the scaffold help text. */
export const REFERENCE_VARIABLES = "{{ref}}, {{ref.title}}, {{ref.author}}, {{ref.year}}";

/** The scaffolds that make literature notes: those using `{{ref…}}`. */
export async function literatureScaffolds(): Promise<ipc.TemplateEntry[]> {
  return (await ipc.listScaffoldEntries()).filter((e) => e.uses_reference);
}

/**
 * Create a literature note about `entry` from the scaffold named `scaffold`,
 * with the New Note rule (folder, name, ZID), and open it.
 */
export async function newLiteratureNote(entry: Reference, scaffold: string): Promise<void> {
  try {
    const result = await triggerCreationRule("new-note", {
      scaffoldOverride: scaffold,
      reference: { key: entry.key, title: entry.title ?? "" },
    });
    if (!result) return;
    const name = result.path.split("/").pop() ?? entry.key;
    openCreatedNote(
      { type: "file", title: name, path: result.path },
      { cursorOffset: result.cursor_offset ?? undefined },
    );
  } catch (e) {
    toastError(t("literatureNotes.createFailed"), e);
  }
}

/** Make `entry` the `source` of the note at `path` (`source: <key>`). */
export async function useAsSource(path: string, entry: Reference): Promise<void> {
  try {
    // Save the editor first: the backend reads and rewrites the file.
    await flushEditorsAt(path);
    await ipc.updateProperty(path, "source", `@${entry.key}`);
    bumpPropertyVersion();
    // The editor reloads the file; the reading view recompiles.
    document.dispatchEvent(new CustomEvent("inkycap:note-property-changed", { detail: { path } }));
    document.dispatchEvent(new CustomEvent("inkycap:note-saved", { detail: { path } }));
  } catch (e) {
    toastError(t("literatureNotes.setSourceFailed"), e);
  }
}

/**
 * The right-click menu for a reference: "New literature note" for each
 * literature scaffold (named when there are several, or a hint when there are
 * none), and "Use as this note's source" while a note is open.
 */
export async function referenceMenuEntries(entry: Reference): Promise<ContextMenuEntry[]> {
  const entries: ContextMenuEntry[] = [];
  let scaffolds: ipc.TemplateEntry[] = [];
  try {
    scaffolds = await literatureScaffolds();
  } catch {
    // Listed as having no literature scaffold.
  }
  if (scaffolds.length === 0) {
    entries.push({ hint: t("literatureNotes.noScaffold") });
  } else if (scaffolds.length === 1) {
    const only = scaffolds[0].name;
    entries.push({ label: t("literatureNotes.newNote"), run: () => void newLiteratureNote(entry, only) });
  } else {
    for (const s of scaffolds) {
      entries.push({
        label: t("literatureNotes.newNoteFrom", { scaffold: s.name }),
        run: () => void newLiteratureNote(entry, s.name),
      });
    }
  }
  const note = activeNotePath();
  if (note && /\.typ$/i.test(note)) {
    entries.push("separator", {
      label: t("literatureNotes.useAsSource"),
      run: () => void useAsSource(note, entry),
    });
  }
  return entries;
}

/**
 * "New literature note" from the command palette: ask which reference, then
 * which literature scaffold when there are several.
 */
export async function newLiteratureNoteFromPicker(): Promise<void> {
  let scaffolds: ipc.TemplateEntry[] = [];
  try {
    scaffolds = await literatureScaffolds();
  } catch (e) {
    toastError(t("literatureNotes.createFailed"), e);
    return;
  }
  if (scaffolds.length === 0) {
    showToast("info", t("literatureNotes.noScaffold"));
    return;
  }
  const entry = await pickReference();
  if (!entry) return;
  const scaffold =
    scaffolds.length === 1
      ? scaffolds[0].name
      : await promptChoice({
          title: t("literatureNotes.chooseScaffoldTitle"),
          message: t("literatureNotes.chooseScaffoldMessage"),
          options: scaffolds.map((s) => ({ id: s.name, label: s.name })),
        });
  if (!scaffold) return;
  await newLiteratureNote(entry, scaffold);
}
