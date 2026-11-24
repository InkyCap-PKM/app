// The citation style picker as a Promise: lists every style built into Typst
// so one can be chosen by name (the bibliography pill's "More styles…"). Like
// stores/referencePicker.ts: a signal holds the request,
// CitationStylePickerHost renders it, and `pickCitationStyle()` returns a
// Promise.

import { createSignal } from "solid-js";

interface CitationStylePickerState {
  /** The style in use, highlighted when the picker opens. */
  current: string | null;
  resolve: (style: string | null) => void;
}

const [activeCitationStylePicker, setActiveCitationStylePicker] =
  createSignal<CitationStylePickerState | null>(null);

export { activeCitationStylePicker };

/**
 * Open the style picker. Resolves with the chosen style's name (or a `.csl`
 * path typed into the search box), or `null` if dismissed. An open picker is
 * cancelled (`null`) first.
 */
export function pickCitationStyle(current: string | null): Promise<string | null> {
  activeCitationStylePicker()?.resolve(null);
  return new Promise<string | null>((resolve) => {
    setActiveCitationStylePicker({ current, resolve });
  });
}

/** Internal: used by CitationStylePickerHost to settle the active request. */
export function resolveCitationStylePicker(style: string | null) {
  const cur = activeCitationStylePicker();
  if (!cur) return;
  setActiveCitationStylePicker(null);
  cur.resolve(style);
}
