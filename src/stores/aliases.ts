// Vault-scoped alias index for the wikilink autocomplete.
//
// Aliases are derived from each note's `aliases` property; the Rust
// `PropertyIndex` keeps the canonical map, and `refreshAliases()` pulls
// a snapshot over IPC.
//
// Two pieces of bookkeeping keep the snapshot honest:
//
//   • A trailing debounce coalesces bursts of refresh triggers (every
//     property write currently asks for a refresh; without this we'd
//     do N IPC roundtrips per save).
//
//   • A generation counter tracks the active vault — if the user
//     switches vaults mid-flight, a stale response from the previous
//     vault is discarded instead of overwriting the new vault's list.
//     `bumpAliasGeneration()` is called on every vault open.

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

/// Schedule a refresh of the alias index. Returns a promise that
/// resolves when the next refresh completes (or when the request is
/// superseded by a vault switch).
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
