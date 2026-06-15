//! Recurrence rules for dated reminders.
//!
//! A [`Recurrence`] describes how a `#due(...)` reminder (or a note-level
//! `#note(due: …)`) repeats. It mirrors the Typst `recurrence: (…)` dict
//! emitted by `inkycap-notebox/lib.typ` — the rule is stored Typst-side so any
//! Typst tool can read or author it, and InkyCap expands the occurrences
//! *virtually* against the current date at view time. The note source is never
//! rewritten, so a reminder keeps its single anchor date plus rule forever and
//! the user's history stays intact.
//!
//! "Reminder-only": recurrence attaches to dates, never to checkbox tasks, so
//! there is no per-occurrence completion state to track.
//!
//! Why the occurrence math lives in Rust and not in Typst (CLAUDE.md
//! Typst-first, tier 3): expansion is relative to *today* and the agenda's
//! current view window — runtime state a static `.typ` document can't know —
//! and it runs on the agenda hot path, which must not take a Typst compile per
//! view. The *rule* stays Typst-native (stored, queried, portable); only the
//! windowed expansion is Rust glue threading per-view date state.

use crate::typst_pipeline::syntax::{Dict, Value};
use chrono::{Datelike, Duration, NaiveDate, Weekday};
use serde::{Deserialize, Serialize};

/// Hard ceiling on internal occurrence stepping — a safety net against a
/// pathological rule, never reached by real agenda windows (which pass a small
/// `max`).
const ITER_CAP: usize = 4000;

/// A repeat rule for a dated reminder. Field shapes match the queryable Typst
/// dict in `inkycap-notebox/lib.typ::_fmt-recurrence`, so a value parsed from a
/// note round-trips back to the same source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recurrence {
    /// `"day" | "week" | "month" | "year"`. Validated on parse.
    pub freq: String,
    /// Repeat every N periods. Always `>= 1`.
    pub interval: u32,
    /// Weekly only: the weekdays the rule lands on, as lowercase two-letter
    /// codes (`"mo".."su"`). Empty means "the anchor's own weekday". Ignored
    /// for non-weekly frequencies.
    #[serde(default)]
    pub by_day: Vec<String>,
    /// Inclusive end date (`YYYY-MM-DD`), if the series is bounded by a date.
    #[serde(default)]
    pub until: Option<String>,
    /// Maximum number of occurrences counting from the anchor, if the series is
    /// bounded by a count.
    #[serde(default)]
    pub count: Option<u32>,
}

fn parse_iso(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok()
}

fn weekday_from_code(code: &str) -> Option<Weekday> {
    match code {
        "mo" => Some(Weekday::Mon),
        "tu" => Some(Weekday::Tue),
        "we" => Some(Weekday::Wed),
        "th" => Some(Weekday::Thu),
        "fr" => Some(Weekday::Fri),
        "sa" => Some(Weekday::Sat),
        "su" => Some(Weekday::Sun),
        _ => None,
    }
}

fn last_day_of_month(year: i32, month: u32) -> u32 {
    let (ny, nm) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    NaiveDate::from_ymd_opt(ny, nm, 1)
        .and_then(|d| d.pred_opt())
        .map(|d| d.day())
        .unwrap_or(28)
}

/// Add `months` calendar months to `date`, clamping the day to the target
/// month's length (Jan 31 + 1 month → Feb 28/29). Computed from the original
/// anchor each call (not iteratively) so a clamped month doesn't permanently
/// shrink later occurrences.
fn add_months(date: NaiveDate, months: i64) -> NaiveDate {
    let total = date.month0() as i64 + months;
    let year = date.year() + total.div_euclid(12) as i32;
    let month = total.rem_euclid(12) as u32 + 1;
    let day = date.day().min(last_day_of_month(year, month));
    NaiveDate::from_ymd_opt(year, month, day).unwrap_or(date)
}

impl Recurrence {
    /// Parse a recurrence from the Typst `recurrence: (…)` metadata dict. Returns
    /// `None` for a missing/invalid `freq` — i.e. the item simply doesn't recur.
    /// Defensive about types even though `lib.typ` already normalizes the dict.
    pub fn from_typst_dict(dict: &Dict) -> Option<Recurrence> {
        let freq = match dict.get("freq").ok()? {
            Value::Str(s) => s.as_str().to_lowercase(),
            _ => return None,
        };
        if !matches!(freq.as_str(), "day" | "week" | "month" | "year") {
            return None;
        }

        let interval = match dict.get("interval").ok() {
            Some(Value::Int(n)) if *n >= 1 => *n as u32,
            _ => 1,
        };

        let by_day = match dict.get("by-day").ok() {
            Some(Value::Array(arr)) => arr
                .iter()
                .filter_map(|v| match v {
                    Value::Str(s) => {
                        let c = s.as_str().to_lowercase();
                        weekday_from_code(&c).map(|_| c)
                    }
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };

        let until = match dict.get("until").ok() {
            Some(Value::Str(s)) => Some(s.as_str().to_string()),
            _ => None,
        };

        let count = match dict.get("count").ok() {
            Some(Value::Int(n)) if *n >= 1 => Some(*n as u32),
            _ => None,
        };

        Some(Recurrence {
            freq,
            interval,
            by_day,
            until,
            count,
        })
    }

    /// Render the rule as Typst source for a `recurrence:` argument, e.g.
    /// `(freq: "week", interval: 2, by-day: ("mo",), until: datetime(year: 2026, month: 12, day: 7))`.
    /// Emits a native `datetime(...)` for `until` (the recommended authoring
    /// form). Used when InkyCap writes a rule back into a note's source.
    pub fn to_typst_source(&self) -> String {
        let mut parts = vec![format!("freq: \"{}\"", self.freq)];
        parts.push(format!("interval: {}", self.interval.max(1)));
        if self.freq == "week" && !self.by_day.is_empty() {
            let days: Vec<String> = self.by_day.iter().map(|d| format!("\"{d}\"")).collect();
            let inner = if days.len() == 1 {
                format!("{},", days[0])
            } else {
                days.join(", ")
            };
            parts.push(format!("by-day: ({inner})"));
        }
        if let Some(d) = self.until.as_deref().and_then(parse_iso) {
            parts.push(format!(
                "until: datetime(year: {}, month: {}, day: {})",
                d.year(),
                d.month(),
                d.day()
            ));
        }
        if let Some(c) = self.count {
            parts.push(format!("count: {c}"));
        }
        format!("({})", parts.join(", "))
    }

    fn interval_i64(&self) -> i64 {
        self.interval.max(1) as i64
    }

    /// Sorted, de-duplicated weekdays for a weekly `by-day` rule (Mon-first).
    fn weekdays(&self) -> Vec<Weekday> {
        let mut days: Vec<Weekday> = self
            .by_day
            .iter()
            .filter_map(|c| weekday_from_code(c))
            .collect();
        days.sort_by_key(|w| w.num_days_from_monday());
        days.dedup();
        days
    }

    fn is_weekly_byday(&self) -> bool {
        self.freq == "week" && !self.by_day.is_empty()
    }

    /// The `k`-th occurrence (0-based) for the arithmetic frequencies
    /// (day / week-without-byday / month / year). Not used for weekly+byday,
    /// whose occurrences aren't a single arithmetic step.
    fn nth(&self, anchor: NaiveDate, k: i64) -> NaiveDate {
        let step = self.interval_i64() * k;
        match self.freq.as_str() {
            "day" => anchor + Duration::days(step),
            "week" => anchor + Duration::days(step * 7),
            "month" => add_months(anchor, step),
            "year" => add_months(anchor, step * 12),
            _ => anchor,
        }
    }

    /// Smallest `k >= 0` whose occurrence is on or after `from` (arithmetic
    /// frequencies only). Estimates from an approximate period length, then
    /// corrects in a handful of steps — so a far-past anchor never iterates the
    /// whole intervening span.
    fn first_k_at_or_after(&self, anchor: NaiveDate, from: NaiveDate) -> i64 {
        if from <= anchor {
            return 0;
        }
        let approx_period = match self.freq.as_str() {
            "day" => 1,
            "week" => 7,
            "month" => 30,
            "year" => 365,
            _ => 1,
        } * self.interval_i64();
        let span = (from - anchor).num_days();
        // Start two periods below the estimate so the correction loop only ever
        // advances (estimate can undershoot but never by much).
        let mut k = (span / approx_period - 2).max(0);
        while self.nth(anchor, k) < from {
            k += 1;
        }
        while k > 0 && self.nth(anchor, k - 1) >= from {
            k -= 1;
        }
        k
    }

    /// The inclusive end date implied by `count`, if set: the date of the
    /// `count`-th occurrence. Lets the windowed expansion treat `count` as just
    /// another upper bound and always fast-forward to the view window.
    fn count_end(&self, anchor: NaiveDate) -> Option<NaiveDate> {
        let c = self.count?;
        if c == 0 {
            return Some(anchor);
        }
        if self.is_weekly_byday() {
            // Walk occurrences from the anchor, counting (c is user-set and
            // small; capped for safety).
            let mut last = anchor;
            let mut seen = 0u32;
            'outer: for w in 0..ITER_CAP as i64 {
                let block_monday = self.weekly_block_monday(anchor, w);
                for wd in self.weekdays() {
                    let d = block_monday + Duration::days(wd.num_days_from_monday() as i64);
                    if d < anchor {
                        continue;
                    }
                    seen += 1;
                    last = d;
                    if seen >= c {
                        break 'outer;
                    }
                }
            }
            Some(last)
        } else {
            Some(self.nth(anchor, c as i64 - 1))
        }
    }

    /// Monday of the `w`-th selected week block (weekly+byday). Block 0 is the
    /// anchor's own week; blocks step by `interval` weeks (WKST = Monday).
    fn weekly_block_monday(&self, anchor: NaiveDate, w: i64) -> NaiveDate {
        let anchor_monday = anchor - Duration::days(anchor.weekday().num_days_from_monday() as i64);
        anchor_monday + Duration::days(w * self.interval_i64() * 7)
    }

    /// Occurrence dates within `[from, to]` (both inclusive), in increasing
    /// order, at most `max` of them. `anchor` is the rule's seed date. Bounds
    /// from `until` and `count` are folded in. Past occurrences (before `from`)
    /// are skipped, so callers pass `from = today` to get the upcoming series.
    pub fn occurrences(
        &self,
        anchor: NaiveDate,
        from: NaiveDate,
        to: NaiveDate,
        max: usize,
    ) -> Vec<NaiveDate> {
        if max == 0 || to < from {
            return Vec::new();
        }
        // Fold every upper bound (view window, until, count) into one end date.
        let mut end = to;
        if let Some(u) = self.until.as_deref().and_then(parse_iso) {
            end = end.min(u);
        }
        if let Some(ce) = self.count_end(anchor) {
            end = end.min(ce);
        }
        if end < from {
            return Vec::new();
        }

        let mut out = Vec::new();
        if self.is_weekly_byday() {
            let weekdays = self.weekdays();
            // Fast-forward to the block containing `from` (back up one for
            // safety), then walk blocks until past `end`.
            let from_monday = from - Duration::days(from.weekday().num_days_from_monday() as i64);
            let anchor_monday =
                anchor - Duration::days(anchor.weekday().num_days_from_monday() as i64);
            let step_days = self.interval_i64() * 7;
            let w0 = (((from_monday - anchor_monday).num_days()) / step_days - 1).max(0);
            for w in w0..(w0 + ITER_CAP as i64) {
                let block_monday = self.weekly_block_monday(anchor, w);
                if block_monday > end {
                    break;
                }
                for wd in &weekdays {
                    let d = block_monday + Duration::days(wd.num_days_from_monday() as i64);
                    if d < anchor || d < from {
                        continue;
                    }
                    if d > end {
                        break;
                    }
                    out.push(d);
                    if out.len() >= max {
                        return out;
                    }
                }
            }
        } else {
            let k0 = self.first_k_at_or_after(anchor, from);
            for i in 0..ITER_CAP as i64 {
                let d = self.nth(anchor, k0 + i);
                if d > end {
                    break;
                }
                if d >= from {
                    out.push(d);
                    if out.len() >= max {
                        break;
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        parse_iso(s).unwrap()
    }

    fn rule(freq: &str, interval: u32) -> Recurrence {
        Recurrence {
            freq: freq.to_string(),
            interval,
            by_day: Vec::new(),
            until: None,
            count: None,
        }
    }

    #[test]
    fn weekly_every_week_from_today() {
        let r = rule("week", 1);
        let occ = r.occurrences(d("2026-06-15"), d("2026-06-15"), d("2026-07-15"), 10);
        assert_eq!(
            occ,
            vec![
                d("2026-06-15"),
                d("2026-06-22"),
                d("2026-06-29"),
                d("2026-07-06"),
                d("2026-07-13"),
            ]
        );
    }

    #[test]
    fn every_other_month_skips_correctly() {
        // "Submit expense reports every other month."
        let r = rule("month", 2);
        let occ = r.occurrences(d("2026-01-31"), d("2026-01-31"), d("2026-12-31"), 12);
        // Day clamps per target month but is recomputed from the anchor, so
        // March/May/July get 31 back rather than sticking at 28.
        assert_eq!(
            occ,
            vec![
                d("2026-01-31"),
                d("2026-03-31"),
                d("2026-05-31"),
                d("2026-07-31"),
                d("2026-09-30"),
                d("2026-11-30"),
            ]
        );
    }

    #[test]
    fn yearly_recurs_on_anchor_day() {
        // "Start of the Fall term every year."
        let r = rule("year", 1);
        let occ = r.occurrences(d("2026-09-01"), d("2026-06-15"), d("2030-01-01"), 10);
        assert_eq!(
            occ,
            vec![
                d("2026-09-01"),
                d("2027-09-01"),
                d("2028-09-01"),
                d("2029-09-01"),
            ]
        );
    }

    #[test]
    fn past_anchor_fast_forwards_to_window() {
        // A weekly meeting seeded years ago: only upcoming occurrences surface,
        // and the anchor far in the past must not be iterated one-by-one.
        let r = rule("week", 1);
        let occ = r.occurrences(d("2020-01-06"), d("2026-06-15"), d("2026-06-30"), 3);
        // 2020-01-06 is a Monday; 2026-06-15 is also a Monday.
        assert_eq!(occ, vec![d("2026-06-15"), d("2026-06-22"), d("2026-06-29")]);
    }

    #[test]
    fn weekly_byday_expands_selected_weekdays() {
        // Meeting every Monday and Wednesday.
        let mut r = rule("week", 1);
        r.by_day = vec!["mo".into(), "we".into()];
        let occ = r.occurrences(d("2026-06-15"), d("2026-06-15"), d("2026-06-28"), 10);
        assert_eq!(
            occ,
            vec![
                d("2026-06-15"), // Mon
                d("2026-06-17"), // Wed
                d("2026-06-22"), // Mon
                d("2026-06-24"), // Wed
            ]
        );
    }

    #[test]
    fn biweekly_byday_steps_two_weeks() {
        let mut r = rule("week", 2);
        r.by_day = vec!["fr".into()];
        let occ = r.occurrences(d("2026-06-19"), d("2026-06-19"), d("2026-08-01"), 10);
        // 2026-06-19 is a Friday; every two weeks.
        assert_eq!(
            occ,
            vec![
                d("2026-06-19"),
                d("2026-07-03"),
                d("2026-07-17"),
                d("2026-07-31"),
            ]
        );
    }

    #[test]
    fn until_bound_stops_the_series() {
        let mut r = rule("week", 1);
        r.until = Some("2026-06-29".into());
        let occ = r.occurrences(d("2026-06-15"), d("2026-06-15"), d("2026-12-31"), 10);
        assert_eq!(occ, vec![d("2026-06-15"), d("2026-06-22"), d("2026-06-29")]);
    }

    #[test]
    fn count_bound_stops_the_series() {
        let mut r = rule("day", 1);
        r.count = Some(3);
        // Three occurrences from the anchor, total — even though the window is
        // wide.
        let occ = r.occurrences(d("2026-06-15"), d("2026-06-15"), d("2026-12-31"), 10);
        assert_eq!(occ, vec![d("2026-06-15"), d("2026-06-16"), d("2026-06-17")]);
    }

    #[test]
    fn count_bound_already_past_yields_nothing() {
        let mut r = rule("day", 1);
        r.count = Some(3); // ends 2026-06-17
        let occ = r.occurrences(d("2026-06-15"), d("2026-06-20"), d("2026-12-31"), 10);
        assert!(occ.is_empty());
    }

    #[test]
    fn max_caps_returned_occurrences() {
        let r = rule("day", 1);
        let occ = r.occurrences(d("2026-06-15"), d("2026-06-15"), d("2026-12-31"), 4);
        assert_eq!(occ.len(), 4);
    }

    #[test]
    fn future_anchor_returns_anchor_first() {
        let r = rule("month", 1);
        let occ = r.occurrences(d("2026-09-01"), d("2026-06-15"), d("2026-12-31"), 3);
        assert_eq!(occ, vec![d("2026-09-01"), d("2026-10-01"), d("2026-11-01")]);
    }

    #[test]
    fn from_dict_validates_freq() {
        let mut dict = Dict::new();
        dict.insert("freq".into(), Value::Str("nope".into()));
        assert!(Recurrence::from_typst_dict(&dict).is_none());
    }

    #[test]
    fn to_typst_source_round_trips_shape() {
        let r = Recurrence {
            freq: "week".into(),
            interval: 2,
            by_day: vec!["mo".into()],
            until: Some("2026-12-07".into()),
            count: None,
        };
        assert_eq!(
            r.to_typst_source(),
            "(freq: \"week\", interval: 2, by-day: (\"mo\",), until: datetime(year: 2026, month: 12, day: 7))"
        );
    }
}
