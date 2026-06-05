// i18n seam — one flat dictionary per locale, surfaced through two faces.
//
// Strings are keyed by dotted ID (e.g. "settings.appearance.theme.label").
// Missing keys return the key itself so unstrung literals stay visible during
// development.
//
//   ── Reactive face (Solid components) ──
//     const trans = useI18n();
//     <span>{trans("settings.appearance.theme.label")}</span>
//   Reads inside JSX / effects track the locale signal and re-render when the
//   user switches language.
//
//   ── Static face (CM6 extensions, stores, command registry) ──
//     import { t } from "../lib/i18n";
//     button.title = t("references.clearFilter");
//   `t` returns the current-locale string synchronously, outside any tracking
//   scope. It does NOT cause re-renders; consumers that build strings once
//   (CodeMirror extensions, command titles) refresh out-of-band off
//   `localeVersion()` — see src/stores/locale.ts.
//
// Conventions: namespace keys by FEATURE AREA, not component
// (`settings.*`, `references.*`, `search.*`); shared vocabulary gets shared
// keys, never per-component copies. Placeholders use single braces:
// `"{count} entries"`, resolved by the shared resolver below. Plurals use
// `.one`/`.other`/… sub-keys selected by `Intl.PluralRules` via `tPlural`.
//
// Adding a language is one step: drop `<code>.json` next to `en.json` (it is
// auto-discovered by the glob below) and add a `LOCALE_META` entry so it
// appears in the Settings → Language picker. See
// documentation/developer/CONTRIBUTING-translations.md.
//
// This module must NOT import the settings store: the command registry imports
// it, and the settings store imports the command registry, so a settings
// import here would close an import cycle. `setLocale` is therefore
// settings-agnostic; src/stores/locale.ts is the only bridge between the two.

import { createSignal } from "solid-js";
import { translator, type TemplateResolver } from "@solid-primitives/i18n";

/** A loaded locale: flat map of dotted key → translated string. */
export type FlatDict = Record<string, string>;

/** Display metadata for a locale. `dir` exists from day one so a future RTL
 *  language is an additive entry, not a redesign — RTL layout itself is out of
 *  scope for now. */
export interface LocaleMeta {
  /** BCP-47 code, also the `<html lang>` value and the locale file's basename. */
  code: string;
  /** Endonym shown in the language picker (e.g. "Français", not "French"). */
  nativeName: string;
  dir: "ltr" | "rtl";
}

export const DEFAULT_LOCALE = "en";

// Hand-maintained display metadata. A locale appears in the picker only if it
// has BOTH a loaded dictionary (a `*.json` file) AND an entry here — this keeps
// a half-added file (no metadata) from rendering a broken dropdown row.
const LOCALE_META: Record<string, Omit<LocaleMeta, "code">> = {
  en: { nativeName: "English", dir: "ltr" },
  "fr-CA": { nativeName: "Français", dir: "ltr" },
};

// ── Dictionary loading ───────────────────────────────────────────────
// Eager glob: every locale ships in the bundle and is available SYNCHRONOUSLY.
// The static `t()` cannot await, and `setLocale` must swap dictionaries
// atomically, so lazy/dynamic import is deliberately avoided here. At a handful
// of locales (~15–40 KB JSON each) the bundle cost is negligible.
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
// Single-brace `{name}` substitution. A missing param leaves `{name}` intact —
// matching the historical stub's behaviour exactly. Both `t` and the reactive
// translator route through this so the two faces never diverge.
function substitute(raw: string, params?: Record<string, string | number>): string {
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name) =>
    name in params ? String(params[name]) : `{${name}}`,
  );
}

// Adapter for @solid-primitives/i18n's translator, whose default resolver
// expects `{{ name }}` (double brace). We feed it ours so en.json's
// single-brace strings need no rewrite.
const resolveTemplate: TemplateResolver = ((raw: string, args?: Record<string, string | number>) =>
  substitute(raw, args)) as TemplateResolver;

// ── Active-locale state ──────────────────────────────────────────────
const [localeCode, setLocaleCode] = createSignal<string>(DEFAULT_LOCALE);
const [localeVersion, bumpLocaleVersion] = createSignal<number>(0);

// Non-reactive snapshot for the static face. Updated synchronously inside
// `setLocale`, BEFORE the signals are bumped, so any effect that re-runs on the
// version bump already observes the new dictionary here.
let activeDict: FlatDict = dicts[DEFAULT_LOCALE] ?? {};

/** Reactive accessor to the active dictionary; backs the component translator. */
const activeDictAccessor = (): FlatDict =>
  dicts[localeCode()] ?? dicts[DEFAULT_LOCALE] ?? {};

// One translator instance, created once. Each call reads `activeDictAccessor()`
// (and thus the locale signal), so calls inside a tracking scope re-render on
// locale change; calls outside one just return the current value.
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
 * Switch the active UI locale. Settings-agnostic by design — persistence and
 * downstream refreshes (command relocalization, CM6 reconfigure) live in
 * src/stores/locale.ts. Unknown codes fall back to the default locale.
 *
 * Mutation order is load-bearing: swap the static dict and the `<html>`
 * attributes FIRST, then the signals. Bumping a signal before the dict is
 * swapped would let a re-running effect read the previous dictionary.
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
 * Translator for Solid components. Returns a function `(key, params?)`; reads
 * inside JSX/effects track the locale and re-render on switch. Use this in new
 * or migrated components in place of the static `t`.
 */
export function useI18n(): (key: string, params?: Record<string, string | number>) => string {
  return reactiveTranslator as unknown as (
    key: string,
    params?: Record<string, string | number>,
  ) => string;
}

// ── Static face ──────────────────────────────────────────────────────
/**
 * Look up a translated string by dotted key, synchronously, with no tracking
 * scope. For CM6 extensions, stores, and the command registry. Returns the key
 * on a miss. Keeps the historical signature so existing call sites are
 * untouched. Components that should re-render on locale change use `useI18n()`.
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
 * Plural-aware lookup. Selects the `<key>.<category>` sub-key (`.one`,
 * `.other`, …) for `count` via `Intl.PluralRules`, falling back to `.other`
 * then to the bare key. `{count}` is available to the chosen string.
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

/** Locale-aware date/time formatting. Reactive when read inside a tracking
 *  scope. Note: the app's custom token date format (`settings.appearance.
 *  date_format`) is separate and not reconciled here — see the plan. */
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

