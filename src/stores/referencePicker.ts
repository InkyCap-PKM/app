// The reference picker as a Promise: asks which bibliography reference a
// literature note is about, when a scaffold with `{{ref…}}` variables is used
// without one. Like stores/folderPicker.ts: a signal holds the request,
// ReferencePickerHost renders it, and `pickReference()` returns a Promise.

import { createSignal } from "solid-js";
import type { BibEntry } from "../lib/types";

interface ReferencePickerState {
  resolve: (entry: BibEntry | null) => void;
}

const [activeReferencePicker, setActiveReferencePicker] =
  createSignal<ReferencePickerState | null>(null);

export { activeReferencePicker };

/**
 * Open the reference picker. Resolves with the chosen reference, or `null` if
 * dismissed. An open picker is cancelled (`null`) first.
 */
export function pickReference(): Promise<BibEntry | null> {
  activeReferencePicker()?.resolve(null);
  return new Promise<BibEntry | null>((resolve) => {
    setActiveReferencePicker({ resolve });
  });
}

/** Internal: used by ReferencePickerHost to settle the active request. */
export function resolveReferencePicker(entry: BibEntry | null) {
  const cur = activeReferencePicker();
  if (!cur) return;
  setActiveReferencePicker(null);
  cur.resolve(entry);
}
