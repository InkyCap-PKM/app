// Reactive store for creation rules.
// The toolbar and other consumers subscribe to this signal so changes
// (save, delete, toggle show_in_toolbar) reflect immediately without restart.

import { createSignal } from "solid-js";
import type { CreationRule, CreationResult } from "../lib/types";
import * as ipc from "../lib/ipc";
import { promptText } from "./prompt";
import { settings } from "./settings";
import { t } from "../lib/i18n";
import { errorCode } from "../lib/errors";

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
 * Prompt the user for a filename when a rule can't resolve one on its own
 * (blank pattern, or a pattern that expanded to nothing). Returns the trimmed
 * name, or `null` if the user cancelled.
 */
async function promptFilename(rule: CreationRule | undefined): Promise<string | null> {
  const name = await promptText({
    title: t("creationRules.prompt.title", { name: rule?.name ?? t("creationRules.prompt.ruleFallback") }),
    label: t("creationRules.prompt.label"),
    placeholder: t("creationRules.prompt.placeholder"),
    hint: t("creationRules.prompt.hint"),
    confirmLabel: t("creationRules.prompt.confirm"),
    validate: (v) => (v.trim() === "" ? t("creationRules.prompt.emptyError") : null),
  });
  return name === null ? null : name.trim();
}

/**
 * Trigger a creation rule from anywhere in the app (toolbar, command
 * palette, hotkey, deep link). Handles the "needs a filename" affordance: a
 * blank pattern prompts up front; a non-empty pattern that the backend can't
 * resolve to a name (it returns `filename-required`) prompts and retries. In
 * both cases the user-entered name is passed as the title override.
 *
 * `{{title}}`/`{{slug}}` are scaffold-content variables, not filename
 * variables — a pattern made only of them expands to nothing and lands on the
 * same prompt path rather than erroring.
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
    // Blank pattern: fall back to ZID if enabled, otherwise prompt up front.
    if (settings.files.zettelkasten_enabled && settings.files.auto_title_as_zid) {
      const zidName = await ipc.generateZid();
      return ipc.executeCreationRule(ruleId, zidName, folderOverride);
    }
    const name = await promptFilename(rule);
    if (name === null) return null;
    return ipc.executeCreationRule(ruleId, name, folderOverride);
  }
  // Non-empty pattern: try it. If it expanded to nothing (e.g. `{{zid}}` with
  // Zettelkasten off, or stray content-only `{{title}}`/`{{slug}}` tokens) the
  // backend signals `filename-required` — prompt and retry with the name.
  try {
    return await ipc.executeCreationRule(ruleId, undefined, folderOverride);
  } catch (e) {
    if (errorCode(e) !== "filename-required") throw e;
    const name = await promptFilename(rule);
    if (name === null) return null;
    return ipc.executeCreationRule(ruleId, name, folderOverride);
  }
}

export { creationRules };
