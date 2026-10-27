// Store for creation rules, so the toolbar and others see changes (save,
// delete, toolbar toggle) at once.

import { createSignal } from "solid-js";
import type { CreationRule, CreationResult } from "../lib/types";
import * as ipc from "../lib/ipc";
import { promptText } from "./prompt";
import { settings } from "./settings";
import { activeNotePath } from "./tabs";
import { t } from "../lib/i18n";
import { errorCode, errorDetail } from "../lib/errors";
import { resolveNoteNameConflict } from "../lib/note-name-conflict";
import { isToolbarRule } from "../lib/creation-rule-order";

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
  return creationRules().filter(isToolbarRule);
}

/**
 * Set the rule list from one the caller already has, without reading from disk
 * (e.g. reordering in Settings), so the toolbar updates with the settings list.
 * Use `loadCreationRules` after changes on disk.
 */
export function replaceCreationRules(rules: CreationRule[]): void {
  setCreationRules(rules);
}

/** Rules eligible to register hotkeys and command-palette entries. */
export function activeRules(): CreationRule[] {
  return creationRules().filter((r) => !r.disabled);
}

/**
 * Ask for a filename when a rule can't produce one (blank pattern, or one that
 * expands to nothing). Returns the trimmed name, or `null` if cancelled.
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
 * Run a creation rule from anywhere (toolbar, command palette, hotkey, deep
 * link). A blank pattern asks for a name first; a pattern the backend can't
 * turn into a name (`filename-required`) asks and retries. The name entered is
 * passed as the title.
 *
 * `{{title}}`/`{{slug}}` are content variables, not filename variables, so a
 * pattern of only those expands to nothing and asks for a name.
 *
 * Returns the result, or `null` if the name prompt was cancelled. Other errors
 * are thrown.
 */
export async function triggerCreationRule(
  ruleId: string,
  options?: { targetFolder?: string; scaffoldOverride?: string },
): Promise<CreationResult | null> {
  const folderOverride = options?.targetFolder;
  const scaffoldOverride = options?.scaffoldOverride;
  let rule = creationRules().find((r) => r.id === ruleId);
  // Rule not cached: the store hasn't loaded for this notebox yet (e.g. the
  // startup load ran before a notebox was open). Load and retry, so the real
  // `filename_pattern` decides whether to ask for a name.
  if (!rule) {
    await loadCreationRules();
    rule = creationRules().find((r) => r.id === ruleId);
  }
  // If it's still missing, fall through to the backend, which resolves the
  // rule from disk and returns a clear error if it truly doesn't exist.
  const pattern = rule?.filename_pattern.trim() ?? "?";

  // Initial filename. A blank pattern can't give one, so use a ZID (if enabled)
  // or ask; otherwise the backend expands the pattern (and may still return
  // `filename-required`).
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

  // Create, prompting and retrying for the two outcomes that need input (so a
  // chosen name that also collides asks again):
  // - `filename-required`: the pattern expanded to nothing; ask for a name.
  // - `note-name-conflict`: the name exists in another folder (names are unique
  //   across the notebox); open that note, rename or cancel.
  // Other errors are thrown.
  for (;;) {
    try {
      return await ipc.executeCreationRule(
        ruleId,
        nameOverride,
        folderOverride,
        scaffoldOverride,
        activeNotePath(),
      );
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
