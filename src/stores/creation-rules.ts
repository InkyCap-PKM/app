// Reactive store for creation rules.
// The toolbar and other consumers subscribe to this signal so changes
// (save, delete, toggle show_in_toolbar) reflect immediately without restart.

import { createSignal } from "solid-js";
import type { CreationRule, CreationResult } from "../lib/types";
import * as ipc from "../lib/ipc";
import { promptText } from "./prompt";
import { settings } from "./settings";
import { t } from "../lib/i18n";
import { errorCode, errorDetail } from "../lib/errors";
import { resolveNoteNameConflict } from "../lib/note-name-conflict";

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

  // Decide the initial filename override. A blank pattern can't produce one, so
  // fall back to a ZID (when enabled) or prompt up front; a non-empty pattern
  // starts with no override and lets the backend expand it (which may still
  // come back `filename-required` if it expands to nothing).
  let nameOverride: string | undefined;
  if (pattern === "") {
    if (settings.files.zettelkasten_enabled && settings.files.auto_title_as_zid) {
      nameOverride = await ipc.generateZid();
    } else {
      const name = await promptFilename(rule);
      if (name === null) return null;
      nameOverride = name;
    }
  }

  // Create, resolving the two "needs your input" outcomes by prompting and
  // retrying. The loop lets a user-chosen name that ALSO collides re-prompt:
  //  - `filename-required`: the pattern expanded to nothing — ask for a name.
  //  - `note-name-conflict`: the name already exists in another folder
  //    (filenames are notebox-globally unique) — open that note, rename, or
  //    cancel. Other errors propagate.
  for (;;) {
    try {
      return await ipc.executeCreationRule(ruleId, nameOverride, folderOverride);
    } catch (e) {
      const code = errorCode(e);
      if (code === "filename-required") {
        const name = await promptFilename(rule);
        if (name === null) return null;
        nameOverride = name;
        continue;
      }
      if (code === "note-name-conflict") {
        const existing = errorDetail(e);
        if (!existing) throw e;
        const res = await resolveNoteNameConflict(existing, nameOverride);
        if (res.action === "cancel") return null;
        if (res.action === "open") return { path: existing, cursor_offset: null };
        nameOverride = res.name;
        continue;
      }
      throw e;
    }
  }
}

export { creationRules };
