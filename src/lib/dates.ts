// Date display helpers. User-facing dates (Agenda due dates, backup times)
// all go through here, so the Appearance > Date format setting controls them.
//
// The tokens are the same as the Zettelkasten ID pattern's
// (`scaffolds::moment_to_chrono_format` in Rust), so there is one syntax:
//
//   YYYY  4-digit year (2026)
//   YY    2-digit year (26)
//   MMMM  full month name (November)
//   MMM   short month name (Nov)
//   MM    2-digit month (11)
//   M     month, no padding (11)
//   DD    2-digit day (08)
//   D     day, no padding (8)
//   dddd  full weekday (Saturday)
//   ddd   short weekday (Sat)
//   HH    24-hour, padded (09)
//   H     24-hour, no padding (9)
//   hh    12-hour, padded (09)
//   h     12-hour, no padding (9)
//   mm    minute, padded (07)
//   m     minute, no padding (7)
//   ss    second, padded (03)
//   s     second, no padding (3)
//
// Other characters are kept as they are. Longer tokens match first, so `MMMM`
// isn't read as `MMM` + `M`.

import { settings } from "../stores/settings";
import { localeCode } from "./i18n";

/** Default pattern shipped with the app. Mirrors `AppearanceSettings::default`
 *  on the Rust side so the two can't drift. */
export const DEFAULT_DATE_FORMAT = "D MMM YYYY";

// Month and weekday names come from the UI language (`MMMM`/`dddd` give
// "juin"/"jeudi" in French). Formatters are cached per (locale, field), since
// creating one is slow and this runs for every date shown. Rust localizes the
// same tokens (`scaffolds::moment_to_chrono_format`), so dates written into
// files match.
const nameFormatterCache = new Map<string, Intl.DateTimeFormat>();
function localizedName(
  d: Date,
  locale: string,
  field: "month" | "weekday",
  width: "long" | "short",
): string {
  const key = `${locale}|${field}|${width}`;
  let fmt = nameFormatterCache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, { [field]: width });
    nameFormatterCache.set(key, fmt);
  }
  return fmt.format(d);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Replace moment-style tokens in `pattern` with components of `d`, drawing
 *  localized month/weekday names from `locale`. */
function applyPattern(d: Date, pattern: string, locale: string): string {
  let out = "";
  let i = 0;
  const len = pattern.length;
  while (i < len) {
    // Order matters: longer prefixes first.
    if (pattern.startsWith("YYYY", i)) { out += String(d.getFullYear()); i += 4; continue; }
    if (pattern.startsWith("YY", i))   { out += pad2(d.getFullYear() % 100); i += 2; continue; }
    if (pattern.startsWith("MMMM", i)) { out += localizedName(d, locale, "month", "long"); i += 4; continue; }
    if (pattern.startsWith("MMM", i))  { out += localizedName(d, locale, "month", "short"); i += 3; continue; }
    if (pattern.startsWith("MM", i))   { out += pad2(d.getMonth() + 1); i += 2; continue; }
    if (pattern.startsWith("M", i))    { out += String(d.getMonth() + 1); i += 1; continue; }
    if (pattern.startsWith("dddd", i)) { out += localizedName(d, locale, "weekday", "long"); i += 4; continue; }
    if (pattern.startsWith("ddd", i))  { out += localizedName(d, locale, "weekday", "short"); i += 3; continue; }
    if (pattern.startsWith("DD", i))   { out += pad2(d.getDate()); i += 2; continue; }
    if (pattern.startsWith("D", i))    { out += String(d.getDate()); i += 1; continue; }
    if (pattern.startsWith("HH", i))   { out += pad2(d.getHours()); i += 2; continue; }
    if (pattern.startsWith("H", i))    { out += String(d.getHours()); i += 1; continue; }
    if (pattern.startsWith("hh", i))   { const h = d.getHours() % 12 || 12; out += pad2(h); i += 2; continue; }
    if (pattern.startsWith("h", i))    { const h = d.getHours() % 12 || 12; out += String(h); i += 1; continue; }
    if (pattern.startsWith("mm", i))   { out += pad2(d.getMinutes()); i += 2; continue; }
    if (pattern.startsWith("m", i))    { out += String(d.getMinutes()); i += 1; continue; }
    if (pattern.startsWith("ss", i))   { out += pad2(d.getSeconds()); i += 2; continue; }
    if (pattern.startsWith("s", i))    { out += String(d.getSeconds()); i += 1; continue; }
    out += pattern[i];
    i += 1;
  }
  return out;
}

/**
 * Resolve `input` to a `Date`. ISO dates (YYYY-MM-DD) are read in local time;
 * `new Date("2024-11-08")` would read UTC and show the previous day west of
 * UTC.
 */
function toDate(input: Date | string | number): Date | null {
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : input;
  }
  if (typeof input === "number") {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Format a date with the user's pattern (or `override`). Returns `input` as a
 * string if it can't be parsed, rather than "Invalid Date".
 */
export function formatUserDate(
  input: Date | string | number,
  override?: string,
): string {
  const d = toDate(input);
  if (!d) return typeof input === "string" ? input : String(input);
  const pattern = override ?? settings.appearance.date_format ?? DEFAULT_DATE_FORMAT;
  return applyPattern(d, pattern || DEFAULT_DATE_FORMAT, localeCode());
}

/**
 * Format a date and time: the user's date pattern followed by the locale's time
 * format (backup times, last-backup indicator).
 */
export function formatUserDateTime(input: Date | string | number): string {
  const d = toDate(input);
  if (!d) return typeof input === "string" ? input : String(input);
  return `${formatUserDate(d)} ${formatUserTime(d)}`;
}

/** Format the time of day (hours and minutes) the way the UI locale writes it. */
export function formatUserTime(d: Date): string {
  return d.toLocaleTimeString(localeCode(), { hour: "2-digit", minute: "2-digit" });
}
