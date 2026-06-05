// "Copy from existing notebox" dialog state.
//
// Mirrors the prompt/toast pattern: a module-level signal holds the active
// request, a single host component subscribes to it, and the imperative
// `promptNoteboxSeed()` function returns a Promise so the
// `pickAndOpenNotebox` flow can `await` the user's choice before opening.

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

/** What the user chose in the dialog.
 *  - `"copy"` with a path: seed the new notebox from that source.
 *  - `"skip"`: open with defaults, no copy. */
export type NoteboxSeedChoice =
  | { action: "copy"; sourcePath: string }
  | { action: "skip" };

interface NoteboxSeedState extends NoteboxSeedRequest {
  resolve: (choice: NoteboxSeedChoice) => void;
}

const [activeNoteboxSeed, setActiveNoteboxSeed] =
  createSignal<NoteboxSeedState | null>(null);

export { activeNoteboxSeed };

/** Open the seed-from-existing dialog and resolve with the user's choice.
 *  Skipping (Esc, backdrop click, "Use defaults" button) resolves with
 *  `{ action: "skip" }`. */
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

/** Offer the user a chance to seed a fresh notebox from an existing one,
 *  then carry out the copy if they accept. Skips the prompt (returns
 *  silently) when (a) the target already has per-notebox settings or
 *  (b) there are no existing noteboxes available as sources.
 *
 *  Designed to be called from every "add notebox" entry point — the
 *  picker-based `pickAndOpenNotebox` and the Settings panel's "New
 *  notebox" form — so users get the same prompt regardless of which
 *  flow they took.
 *
 *  Best-effort: any error in the freshness check or copy IPC is logged
 *  and the function returns rather than blocking the caller. */
export async function maybeSeedNotebox(
  targetPath: string,
  registry: NoteboxRegistryEntry[],
): Promise<void> {
  let fresh: boolean;
  try {
    fresh = !(await ipc.noteboxHasUserSettings(targetPath));
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
