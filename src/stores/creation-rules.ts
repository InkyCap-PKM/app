// Reactive store for creation rules.
// The toolbar and other consumers subscribe to this signal so changes
// (save, delete, toggle show_in_toolbar) reflect immediately without restart.

import { createSignal } from "solid-js";
import type { CreationRule, CreationResult } from "../lib/types";
import * as ipc from "../lib/ipc";
import { promptText } from "./prompt";
import { settings } from "./settings";

const [creationRules, setCreationRules] = createSignal<CreationRule[]>([]);

export async function loadCreationRules(): Promise<void> {
  try {
    const rules = await ipc.listCreationRules();
    setCreationRules(rules);
  } catch (e) {
    console.error("Failed to load creation rules:", e);
  }
}

/** Rules eligible to render as toolbar buttons. */
export function toolbarRules(): CreationRule[] {
  return creationRules().filter((r) => r.show_in_toolbar && !r.disabled);
}

/** Rules eligible to register hotkeys and command-palette entries. */
export function activeRules(): CreationRule[] {
  return creationRules().filter((r) => !r.disabled);
}

/**
 * Trigger a creation rule from anywhere in the app (toolbar, command
 * palette, hotkey, deep link). Handles the "blank filename pattern"
 * affordance: if the rule has no pattern, the user is prompted for a
 * filename before the backend creates the file.
 *
 * Returns the backend result on success, or `null` if the user cancelled
 * the filename prompt. Other errors propagate.
 */
export async function triggerCreationRule(
  ruleId: string,
  options?: { targetFolder?: string },
): Promise<CreationResult | null> {
  const folderOverride = options?.targetFolder;
  let rule = creationRules().find((r) => r.id === ruleId);
  // If the rule isn't cached yet, the store hasn't loaded for this notebox
  // (e.g. a fresh install where the startup load ran before a notebox was
  // open). Load it now and retry, so we can read the real `filename_pattern`
  // and decide whether to prompt — rather than calling the backend blind and
  // having it reject an empty-pattern rule with "filename-required".
  if (!rule) {
    await loadCreationRules();
    rule = creationRules().find((r) => r.id === ruleId);
  }
  // If it's still missing, fall through to the backend, which resolves the
  // rule from disk and returns a clear error if it truly doesn't exist.
  const pattern = rule?.filename_pattern.trim() ?? "?";
  if (pattern === "") {
    // Blank pattern: fall back to ZID if enabled, otherwise prompt
    if (settings.files.zettelkasten_enabled && settings.files.auto_title_as_zid) {
      const zidName = await ipc.generateZid();
      return ipc.executeCreationRule(ruleId, zidName, folderOverride);
    }
    const name = await promptText({
      title: `New note from "${rule?.name ?? "rule"}"`,
      label: "Filename",
      placeholder: "untitled",
      hint: "No extension needed — `.typ` is added automatically.",
      confirmLabel: "Create",
      validate: (v) =>
        v.trim() === "" ? "Filename cannot be empty" : null,
    });
    if (name === null) return null;
    return ipc.executeCreationRule(ruleId, name.trim(), folderOverride);
  }
  return ipc.executeCreationRule(ruleId, undefined, folderOverride);
}

export { creationRules };
