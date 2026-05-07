// Reactive store for creation rules.
// The toolbar and other consumers subscribe to this signal so changes
// (save, delete, toggle show_in_toolbar) reflect immediately without restart.

import { createSignal } from "solid-js";
import type { CreationRule } from "../lib/types";
import * as ipc from "../lib/ipc";

const [creationRules, setCreationRules] = createSignal<CreationRule[]>([]);

export async function loadCreationRules(): Promise<void> {
  try {
    const rules = await ipc.listCreationRules();
    setCreationRules(rules);
  } catch (e) {
    console.error("Failed to load creation rules:", e);
  }
}

export function toolbarRules(): CreationRule[] {
  return creationRules().filter((r) => r.show_in_toolbar);
}

export { creationRules };
