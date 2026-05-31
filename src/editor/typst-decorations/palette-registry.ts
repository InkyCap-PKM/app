// Command-palette registry — the seam that lets parts of the app *outside* the
// built-in command set contribute `/`-palette entries at runtime: the
// external-tool bridge and declarative plugin manifests. The built-in items
// stay in command-palette.ts; this module holds the additive contributions,
// which command-palette.ts merges in at display time.
//
// Keeping this a registry (rather than editing the static array in several
// places) is the Tier-1 substrate the plan calls for: new palette entries land
// as a single `registerPaletteSource` call instead of edits scattered through
// unrelated modules.

import type { PaletteItem } from "./command-palette";

/** A source of additional palette items. A function (not a static array) so
 *  items can be recomputed lazily every time the palette opens — e.g. when the
 *  user's registered external-tool list changes, the source reflects it without
 *  re-registering. */
export type PaletteSource = () => PaletteItem[];

const sources = new Map<string, PaletteSource>();

/** Register (or replace) a named source of palette items. The `id` namespaces
 *  the source so a later registration from the same provider replaces rather
 *  than duplicates. Returns a disposer that removes it again. */
export function registerPaletteSource(id: string, source: PaletteSource): () => void {
  sources.set(id, source);
  return () => {
    if (sources.get(id) === source) sources.delete(id);
  };
}

/** All items contributed by registered sources, flattened. A throwing source is
 *  isolated and skipped so one bad plugin can't break the palette. */
export function getRegisteredPaletteItems(): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const [id, source] of sources) {
    try {
      items.push(...source());
    } catch (err) {
      console.error(`palette source "${id}" threw; skipping its items`, err);
    }
  }
  return items;
}
