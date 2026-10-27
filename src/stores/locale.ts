// Locale store: connects the settings store and the i18n layer, like
// src/stores/theme.ts. Reads the saved language, applies it, and saves changes.
//
// `src/lib/i18n.ts` doesn't import settings (that would create an import cycle
// through the command registry), so all of the connection is here.

import { settings, updateSetting } from "./settings";
import { setLocale, localeCode, isLocaleAvailable, DEFAULT_LOCALE } from "../lib/i18n";
import { relocalizeCommands } from "../lib/commands";

/** Resolve the persisted preference to a code we actually have a dictionary
 *  for, falling back to the default locale. */
function preferredLocale(): string {
  const pref = settings.appearance.ui_locale || DEFAULT_LOCALE;
  return isLocaleAvailable(pref) ? pref : DEFAULT_LOCALE;
}

/**
 * Apply the saved UI language at startup. Call once in App.tsx after settings
 * load and before built-in commands are registered, so their titles use the
 * right language from the start.
 */
export function initLocale(): void {
  setLocale(preferredLocale());
}

/**
 * Apply the language from settings if it differs from the current one.
 * Connected to `onSettingsChange` in App.tsx so outside changes (settings
 * import, sync) apply live; the comparison avoids a loop with `setUiLocale`.
 */
export function syncLocaleFromSettings(): void {
  const code = preferredLocale();
  if (code === localeCode()) return;
  setLocale(code);
  relocalizeCommands();
}

/**
 * Switch the UI language when the user picks one (Settings → Language): apply
 * at once and save. The `syncLocaleFromSettings` that follows does nothing.
 */
export function setUiLocale(code: string): void {
  if (code !== localeCode()) {
    setLocale(code);
    relocalizeCommands();
  }
  updateSetting("appearance", "ui_locale", code);
}
