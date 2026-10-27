// "Copy from existing notebox" dialog state. Like prompt and toasts: a signal
// holds the request, a host component renders it, and `promptNoteboxSeed()`
// returns a Promise that `pickAndOpenNotebox` awaits before opening.

import { createSignal } from "solid-js";
import type { NoteboxRegistryEntry } from "../lib/types";
import { pathEquals } from "../lib/paths";
import * as ipc from "../lib/ipc";
import { t } from "../lib/i18n";
import { toastError, toastWarning } from "./toasts";

export interface NoteboxSeedRequest {
  /** Absolute path of the notebox being added — the destination of any
   *  copy. Displayed in the header so users see which folder they picked. */
  targetPath: string;
  /** Existing noteboxes available as the source for the copy. The picker
   *  shows these as options; selecting one becomes the seed source. */
  sources: NoteboxRegistryEntry[];
}

/**
 * The user's choice: `"copy"` with a path copies from that notebox; `"skip"`
 * opens with defaults.
 */
export type NoteboxSeedChoice =
  | { action: "copy"; sourcePath: string }
  | { action: "skip" };

interface NoteboxSeedState extends NoteboxSeedRequest {
  resolve: (choice: NoteboxSeedChoice) => void;
}

const [activeNoteboxSeed, setActiveNoteboxSeed] =
  createSignal<NoteboxSeedState | null>(null);

export { activeNoteboxSeed };

/**
 * Open the copy-from-existing dialog and resolve with the choice. Skipping
 * (Esc, backdrop click, "Use defaults") gives `{ action: "skip" }`.
 */
export function promptNoteboxSeed(
  request: NoteboxSeedRequest,
): Promise<NoteboxSeedChoice> {
  const existing = activeNoteboxSeed();
  if (existing) existing.resolve({ action: "skip" });
  return new Promise<NoteboxSeedChoice>((resolve) => {
    setActiveNoteboxSeed({ ...request, resolve });
  });
}

/** Internal: used by NoteboxSeedHost to settle the active dialog. */
export function resolveNoteboxSeed(choice: NoteboxSeedChoice) {
  const cur = activeNoteboxSeed();
  if (!cur) return;
  setActiveNoteboxSeed(null);
  cur.resolve(choice);
}

/**
 * Offer to fill a new notebox from an existing one, and copy if accepted. No
 * prompt if the target is already a notebox or there's no other notebox to copy
 * from.
 *
 * Called from every "add notebox" path (`pickAndOpenNotebox` and Settings' "New
 * notebox" form), so the prompt is the same either way.
 *
 * Errors in the check or the copy are logged, and the function returns without
 * blocking the caller.
 */
export async function maybeSeedNotebox(
  targetPath: string,
  registry: NoteboxRegistryEntry[],
): Promise<void> {
  let fresh: boolean;
  try {
    fresh = !(await ipc.noteboxIsExisting(targetPath));
  } catch (e) {
    console.warn("notebox seed: freshness check failed:", e);
    return;
  }
  if (!fresh) return;

  const sources = registry.filter((e) => !pathEquals(e.path, targetPath));
  if (sources.length === 0) return;

  // Most-recently-opened first — the most likely source.
  const sorted = [...sources].sort((a, b) => b.last_opened - a.last_opened);
  const choice = await promptNoteboxSeed({ targetPath, sources: sorted });
  if (choice.action !== "copy") return;

  try {
    const result = await ipc.seedNoteboxFromSource(targetPath, choice.sourcePath);
    for (const w of result.warnings) toastWarning(w);
  } catch (e) {
    toastError(t("noteboxSeed.copyFailed"), e);
  }
}
