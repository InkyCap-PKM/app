// Minimal i18n seam. Reads from a single flat strings object keyed by
// dotted ID (e.g. "settings.appearance.theme.label"). Missing keys return
// the key itself so unstrung literals are visible during development.
//
// This is intentionally a stub, not a library: it gives new strings a single
// place to flow through (`t(...)`) so a future swap to a real i18n runtime
// (with locale loading, plurals, ICU, etc.) is a one-file change.

import en from "../locales/en.json";

type Strings = Record<string, string>;

const strings: Strings = en as Strings;

/**
 * Look up a translated string by its dotted key. If the key is missing,
 * returns the key — making absent strings obvious in the UI.
 *
 * `params` performs `{name}` placeholder substitution; values are coerced
 * to strings via `String(value)`.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const raw = strings[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name) =>
    name in params ? String(params[name]) : `{${name}}`,
  );
}
