// Alias index for wikilink suggestions in the current notebox.
//
// Aliases come from each note's `aliases` property; the Rust `PropertyIndex`
// holds the map, and `refreshAliases()` fetches a copy.
//
//   - A trailing debounce merges bursts of refresh requests (every property
//     write asks for one).
//   - A generation counter tracks the notebox, so a late reply for the previous
//     notebox after a switch is discarded. `bumpAliasGeneration()` is called on
//     every notebox open.

import { createSignal } from "solid-js";
import type { AliasEntry } from "../lib/ipc";
import * as ipc from "../lib/ipc";

const REFRESH_DEBOUNCE_MS = 200;

const [aliases, setAliases] = createSignal<AliasEntry[]>([]);

let generation = 0;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let pendingResolvers: Array<() => void> = [];

export function bumpAliasGeneration(): void {
  generation += 1;
  // Drop any pending refresh against the previous generation.
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  for (const resolve of pendingResolvers) resolve();
  pendingResolvers = [];
  setAliases([]);
}

/// Schedule an alias refresh. The promise resolves when the next refresh
/// finishes (or is cancelled by a notebox switch).
export function refreshAliases(): Promise<void> {
  return new Promise((resolve) => {
    pendingResolvers.push(resolve);
    if (pendingTimer !== null) return;
    pendingTimer = setTimeout(async () => {
      pendingTimer = null;
      const myGeneration = generation;
      const resolvers = pendingResolvers;
      pendingResolvers = [];
      try {
        const entries = await ipc.getAllAliases();
        if (myGeneration === generation) {
          setAliases(entries);
        }
      } catch (err) {
        console.error("Failed to load aliases:", err);
      } finally {
        for (const r of resolvers) r();
      }
    }, REFRESH_DEBOUNCE_MS);
  });
}

export { aliases };
