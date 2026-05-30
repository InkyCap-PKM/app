// Locale store — the single bridge between the settings store and the i18n
// seam. Mirrors src/stores/theme.ts: reads the persisted preference, applies it
// to the live UI, and persists user changes.
//
// `src/lib/i18n.ts` is deliberately settings-agnostic (importing the settings
// store there would close an import cycle through the command registry), so all
// settings ↔ i18n wiring lives here.

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
 * Apply the persisted UI locale on app startup. Call once in App.tsx after
 * settings load and BEFORE built-in commands are registered, so command titles
 * are built from the correct dictionary on first paint. (Command relocalization
 * is therefore not needed here — the commands don't exist yet.)
 */
export function initLocale(): void {
  setLocale(preferredLocale());
}

/**
 * Re-apply the locale from the settings store if it differs from what's active.
 * Wired to `onSettingsChange` in App.tsx so external changes (settings import,
 * sync) take effect live. The equality guard makes it idempotent and prevents
 * a notify→apply→notify loop with `setUiLocale`.
 */
export function syncLocaleFromSettings(): void {
  const code = preferredLocale();
  if (code === localeCode()) return;
  setLocale(code);
  relocalizeCommands();
}

/**
 * Switch the UI language in response to a user choice (the Settings → Language
 * picker). Applies immediately (so the switch is live) and persists. The
 * subsequent `onSettingsChange` → `syncLocaleFromSettings` is a no-op thanks to
 * the equality guard there.
 */
export function setUiLocale(code: string): void {
  if (code !== localeCode()) {
    setLocale(code);
    relocalizeCommands();
  }
  updateSetting("appearance", "ui_locale", code);
}
