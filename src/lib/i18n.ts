// Translation layer: one flat dictionary per locale, used in two ways. Keys are
// dotted IDs (e.g. "settings.appearance.theme.label"); a missing key returns
// the key itself, so untranslated strings are visible.
//
//   ── Reactive (Solid components) ──
//     const trans = useI18n();
//     <span>{trans("settings.appearance.theme.label")}</span>
//   Reads inside JSX and effects re-render on a language switch.
//
//   ── Static (CM6 extensions, stores, command registry) ──
//     import { t } from "../lib/i18n";
//     button.title = t("references.clearFilter");
//   `t` returns the current string without tracking. Code that builds strings
//   once refreshes on `localeVersion()` (see src/stores/locale.ts).
//
// Group keys by feature area (`settings.*`, `references.*`, `search.*`), not
// component, and reuse shared keys. Placeholders use single braces (`"{count}
// entries"`); plurals use `.one` / `.other` sub-keys through `tPlural`.
//
// To add a language, put `<code>.json` beside `en.json` (picked up by the glob
// below) and add a `LOCALE_META` entry. See
// documentation/developer/CONTRIBUTING-translations.md.
//
// This module must not import the settings store, which imports the command
// registry, which imports this; src/stores/locale.ts connects them.

import { createSignal } from "solid-js";
import { translator, type TemplateResolver } from "@solid-primitives/i18n";

/** A loaded locale: flat map of dotted key → translated string. */
export type FlatDict = Record<string, string>;

/**
 * Display data for a locale. `dir` is there so a right-to-left language can be
 * added later; RTL layout itself isn't supported yet.
 */
export interface LocaleMeta {
  /** BCP-47 code, also the `<html lang>` value and the locale file's basename. */
  code: string;
  /** Endonym shown in the language picker (e.g. "Français", not "French"). */
  nativeName: string;
  dir: "ltr" | "rtl";
}

export const DEFAULT_LOCALE = "en";

// A locale appears in the picker only with both a dictionary file and an entry
// here.
const LOCALE_META: Record<string, Omit<LocaleMeta, "code">> = {
  en: { nativeName: "English", dir: "ltr" },
  "fr-CA": { nativeName: "Français", dir: "ltr" },
};

// ── Dictionary loading ───────────────────────────────────────────────
// Eager glob, so every dictionary is available synchronously: `t()` can't wait,
// and `setLocale` swaps dictionaries in one step. The few JSON files cost
// little.
const modules = import.meta.glob<FlatDict>("../locales/*.json", {
  eager: true,
  import: "default",
});

const dicts: Record<string, FlatDict> = {};
for (const [path, dict] of Object.entries(modules)) {
  const code = path.replace(/^.*\/(.+)\.json$/, "$1");
  dicts[code] = dict;
}

/** Locales offered in the Settings → Language picker (file + metadata both
 *  present). Order follows insertion; English first. */
export const AVAILABLE_LOCALES: LocaleMeta[] = Object.keys(dicts)
  .filter((code) => code in LOCALE_META)
  .map((code) => ({ code, ...LOCALE_META[code] }));

// ── Placeholder resolution (shared by both faces) ────────────────────
// `{name}` substitution; a missing parameter leaves `{name}`. Both faces use
// it.
function substitute(raw: string, params?: Record<string, string | number>): string {
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name) =>
    name in params ? String(params[name]) : `{${name}}`,
  );
}

// @solid-primitives/i18n expects `{{ name }}`; give it our resolver so en.json
//   can keep single braces.
const resolveTemplate: TemplateResolver = ((raw: string, args?: Record<string, string | number>) =>
  substitute(raw, args)) as TemplateResolver;

// ── Active-locale state ──────────────────────────────────────────────
const [localeCode, setLocaleCode] = createSignal<string>(DEFAULT_LOCALE);
const [localeVersion, bumpLocaleVersion] = createSignal<number>(0);

// The dictionary for `t`, replaced in `setLocale` before the signals change, so
// effects re-running on the change see the new one.
let activeDict: FlatDict = dicts[DEFAULT_LOCALE] ?? {};

/** Reactive accessor to the active dictionary; backs the component translator. */
const activeDictAccessor = (): FlatDict =>
  dicts[localeCode()] ?? dicts[DEFAULT_LOCALE] ?? {};

// One translator. Each call reads `activeDictAccessor()`, so calls in a
// tracking scope update on a language change.
const reactiveTranslator = translator(activeDictAccessor, resolveTemplate);

/** Current locale code (reactive). */
export { localeCode };

/** Bumped on every successful `setLocale`. Static consumers (CM6 extensions,
 *  command titles) subscribe to this to rebuild themselves with fresh strings. */
export { localeVersion };

/** True if a dictionary is loaded for `code`. */
export function isLocaleAvailable(code: string): boolean {
  return code in dicts;
}

/**
 * Switch the UI language. Persistence and refreshes (commands, CM6) are in
 * src/stores/locale.ts. Unknown codes fall back to the default.
 *
 * Order matters: replace the dictionary and the `<html>` attributes first, then
 * the signals, so a re-running effect never reads the old dictionary.
 */
export function setLocale(code: string): void {
  const resolved = code in dicts ? code : DEFAULT_LOCALE;
  activeDict = dicts[resolved] ?? dicts[DEFAULT_LOCALE] ?? {};
  const dir = LOCALE_META[resolved]?.dir ?? "ltr";
  const html = document.documentElement;
  html.setAttribute("lang", resolved);
  html.setAttribute("dir", dir);
  setLocaleCode(resolved);
  bumpLocaleVersion((n) => n + 1);
}

// ── Reactive face ────────────────────────────────────────────────────
/**
 * Translator for Solid components: `(key, params?)`, re-rendering on a
 * language switch. Prefer it to the static `t` in components.
 */
export function useI18n(): (key: string, params?: Record<string, string | number>) => string {
  return reactiveTranslator as unknown as (
    key: string,
    params?: Record<string, string | number>,
  ) => string;
}

// ── Static face ──────────────────────────────────────────────────────
/**
 * A translated string by dotted key, synchronously and without tracking, for
 * CM6 extensions, stores and the command registry. Returns the key when
 * missing. Components that re-render on a language switch use `useI18n()`.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const raw = activeDict[key] ?? key;
  return substitute(raw, params);
}

// ── Plurals + Intl formatting ────────────────────────────────────────
const pluralRulesCache = new Map<string, Intl.PluralRules>();
const numberFormatCache = new Map<string, Intl.NumberFormat>();
const dateFormatCache = new Map<string, Intl.DateTimeFormat>();

function pluralRulesFor(locale: string): Intl.PluralRules {
  let r = pluralRulesCache.get(locale);
  if (!r) {
    r = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, r);
  }
  return r;
}

/**
 * Plural-aware lookup: picks `<key>.<category>` (`.one`, `.other`, …) for `count`
 * with `Intl.PluralRules`, falling back to `.other`, then the bare key. `{count}`
 * is available in the string.
 *
 *   en.json:  "references.entry.one": "entry", "references.entry.other": "entries"
 *   tPlural("references.entry", 3)  →  "entries"
 */
export function tPlural(
  key: string,
  count: number,
  params?: Record<string, string | number>,
): string {
  const category = pluralRulesFor(localeCode()).select(count);
  const raw = activeDict[`${key}.${category}`] ?? activeDict[`${key}.other`] ?? key;
  return substitute(raw, { count, ...params });
}

/** Locale-aware number formatting. Reactive when read inside a tracking scope. */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  const locale = localeCode();
  const cacheKey = `${locale}|${options ? JSON.stringify(options) : ""}`;
  let fmt = numberFormatCache.get(cacheKey);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, options);
    numberFormatCache.set(cacheKey, fmt);
  }
  return fmt.format(value);
}

/**
 * Locale-aware date and time formatting, reactive in a tracking scope. The
 * app's own date format setting (`settings.appearance.date_format`) is
 * separate.
 */
export function formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  const locale = localeCode();
  const cacheKey = `${locale}|${options ? JSON.stringify(options) : ""}`;
  let fmt = dateFormatCache.get(cacheKey);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, options);
    dateFormatCache.set(cacheKey, fmt);
  }
  return fmt.format(value);
}

