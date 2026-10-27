// Lets code outside the built-in commands (external tools, declarative plugins)
// add `/` palette entries at runtime. Built-in items stay in
// command-palette.ts, which merges these in when shown, so a new entry is one
// `registerPaletteSource` call.

import type { PaletteItem } from "./command-palette";

/**
 * A source of palette items. A function, called each time the palette opens, so
 * changes (e.g. to the user's external tools) show without registering again.
 */
export type PaletteSource = () => PaletteItem[];

const sources = new Map<string, PaletteSource>();

/**
 * Register or replace a named source. The same `id` replaces the earlier source
 * rather than duplicating it. Returns a function that removes it.
 */
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
