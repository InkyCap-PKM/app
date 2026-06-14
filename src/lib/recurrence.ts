// Shared helpers for the recurrence rule UI. The rule shape itself lives in
// `types.ts` (`Recurrence`); this module holds the constants and the
// human-readable summary used by both the RecurrenceEditor and the Agenda's
// recurring-row badge, so the two surfaces describe a rule identically.

import type { Recurrence } from "./types";
import { t, tPlural } from "./i18n";
import { formatUserDate } from "./dates";

/** Weekday codes in week order (Monday first, WKST = Mon to match the backend
 *  expansion). The `by_day` array is kept in this order. */
export const WEEKDAY_CODES = ["mo", "tu", "we", "th", "fr", "sa", "su"] as const;

export type Freq = Recurrence["freq"];

export const FREQ_OPTIONS: readonly Freq[] = ["day", "week", "month", "year"];

/** The rule a fresh "Repeat" toggle starts from: every week, unbounded. */
export function defaultRecurrence(): Recurrence {
  return { freq: "week", interval: 1, by_day: [], until: null, count: null };
}

/** Sort a `by_day` selection back into Monday-first week order. */
export function sortByDay(days: string[]): string[] {
  return [...new Set(days)].sort(
    (a, b) => WEEKDAY_CODES.indexOf(a as never) - WEEKDAY_CODES.indexOf(b as never),
  );
}

/** A short, human summary of a rule, e.g. "Every 2 weeks on Mon, Wed until
 *  Dec 7, 2026". Uses the static i18n face; callers that must live-update on a
 *  language switch should read `localeVersion()` in their tracking scope. */
export function formatRecurrence(rec: Recurrence): string {
  let summary = tPlural(`recurrence.summary.${rec.freq}`, rec.interval, {
    count: rec.interval,
  });

  if (rec.freq === "week" && rec.by_day.length > 0) {
    const days = sortByDay(rec.by_day)
      .map((c) => t(`recurrence.weekdayShort.${c}`))
      .join(", ");
    summary += " " + t("recurrence.summary.onDays", { days });
  }

  if (rec.until) {
    summary += " " + t("recurrence.summary.until", { date: formatUserDate(rec.until) });
  } else if (rec.count != null) {
    summary += " " + tPlural("recurrence.summary.count", rec.count, { count: rec.count });
  }

  return summary;
}
