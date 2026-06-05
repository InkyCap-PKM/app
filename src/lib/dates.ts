// Shared date-display helpers.
//
// User-facing date strings (Agenda due dates, backup timestamps,
// last-success indicators) all funnel through this module so a single
// Appearance > Date format setting controls them.
//
// The token grammar matches the Zettelkasten ID pattern (see
// `scaffolds::moment_to_chrono_format` in the Rust backend) so users only
// have one syntax to learn:
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
// Any character that isn't a token is kept verbatim. Multi-character tokens
// are matched before single-character ones so `MMMM` isn't partially
// consumed as `MMM` + `M`.

import { settings } from "../stores/settings";
import { localeCode } from "./i18n";

/** Default pattern shipped with the app. Mirrors `AppearanceSettings::default`
 *  on the Rust side so the two can't drift. */
export const DEFAULT_DATE_FORMAT = "D MMM YYYY";

// Month and weekday NAMES come from the active UI locale, not a hardcoded
// English table, so `MMMM`/`dddd` render "juin"/"jeudi" under French and so on.
// `Intl.DateTimeFormat` instances are cached per (locale, field) — constructing
// one is comparatively expensive and these run on every date render. The Rust
// side localizes the same tokens via `chrono::format_localized` (see
// `scaffolds::moment_to_chrono_format`), so generated-in-file dates match.
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

/** Resolve `input` to a `Date`. ISO strings (YYYY-MM-DD) are parsed in the
 *  local zone — using `new Date("2024-11-08")` would shift overnight in
 *  negative-UTC locales. */
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

/** Format a date using the user's configured pattern (or `override` if
 *  given). Returns the raw string form of `input` when it can't be parsed,
 *  so display surfaces gracefully degrade rather than showing "Invalid
 *  Date". */
export function formatUserDate(
  input: Date | string | number,
  override?: string,
): string {
  const d = toDate(input);
  if (!d) return typeof input === "string" ? input : String(input);
  const pattern = override ?? settings.appearance.date_format ?? DEFAULT_DATE_FORMAT;
  return applyPattern(d, pattern || DEFAULT_DATE_FORMAT, localeCode());
}

/** Format a date-time using the user's date pattern followed by a
 *  locale-appropriate time. Used for places that show both a date and the
 *  time of day (backup mtime, last-backup indicator). */
export function formatUserDateTime(input: Date | string | number): string {
  const d = toDate(input);
  if (!d) return typeof input === "string" ? input : String(input);
  const datePart = formatUserDate(d);
  const timePart = d.toLocaleTimeString(localeCode(), {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${datePart} ${timePart}`;
}
