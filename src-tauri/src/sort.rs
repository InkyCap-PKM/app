//! Name ordering for lists the user sees, the counterpart of `compareName` in
//! `src/lib/sort.ts`.
//!
//! A few lists are sorted here and sent already ordered (collection rows, the
//! journal scroll's entries, the scaffold picker); they must follow the same
//! rules as the rest of the app, or `10 Chapter` would sit in different places
//! in different views. Both sides use the same collation: the frontend
//! `Intl.Collator`, this module ICU4X (the same Unicode collation). Code-point
//! order isn't collation order (`Étude` would sort after `zebra`).
//!
//! `icu_collator` adds nothing to the build: Hayagriva already depends on it.

use icu_collator::{
    options::CollatorOptions, preferences::CollationNumericOrdering, Collator, CollatorBorrowed,
    CollatorPreferences,
};
use std::cmp::Ordering;
use std::sync::OnceLock;

/// One collator for the process, since building it parses locale data and these
/// sorts can run over thousands of rows.
static COLLATOR: OnceLock<Option<CollatorBorrowed<'static>>> = OnceLock::new();

fn collator() -> Option<&'static CollatorBorrowed<'static>> {
    COLLATOR
        .get_or_init(|| {
            let mut prefs = CollatorPreferences::default();
            // Numeric ordering (`-u-kn`): digit runs compare by value, so `2
            // Draft` precedes `10 Draft`.
            prefs.numeric_ordering = Some(CollationNumericOrdering::True);
            Collator::try_new(prefs, CollatorOptions::default()).ok()
        })
        .as_ref()
}

/// Compare two names for an ascending sort with Unicode collation and numeric
/// ordering. For descending, swap the arguments (`compare_name(b, a)`) so ties
/// stay ties.
///
/// * Numbers order by value: `2 Draft` before `10 Draft`.
/// * Accents sort with their base letter: `Étude` among the `E`s.
/// * Case is a tie-breaker, never equality: `apple` before `Zebra`, and `notes`
///   / `Notes` / `NOTES` are distinct, lowercase first. Folders differing only
///   in case can coexist, and calling them equal would let them swap between
///   queries, breaking the journal scroll's pagination.
///
/// Uses the CLDR root locale, not the UI language. The frontend uses the host
/// locale, so they could differ for languages that reorder letters (Swedish
/// puts `å` after `z`); they agree for every language InkyCap ships. If that
/// changes, pass the UI locale down to these calls.
pub fn compare_name(a: &str, b: &str) -> Ordering {
    match collator() {
        Some(c) => c.compare(a, b),
        // Can't happen in practice (the root collation is built in); fall back
        // to byte order rather than panic in a comparator.
        None => a.cmp(b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sort with `compare_name` and return the result, for readable assertions.
    fn sorted(items: &[&str]) -> Vec<String> {
        let mut v: Vec<String> = items.iter().map(|s| s.to_string()).collect();
        v.sort_by(|a, b| compare_name(a, b));
        v
    }

    #[test]
    fn orders_digit_runs_numerically() {
        assert_eq!(
            sorted(&["10 Chapter", "1 Chapter", "2 Chapter", "20 Chapter"]),
            vec!["1 Chapter", "2 Chapter", "10 Chapter", "20 Chapter"]
        );
    }

    #[test]
    fn orders_digits_inside_and_at_end_of_a_name() {
        assert_eq!(
            sorted(&["Note 11", "Note 2", "Note 1"]),
            vec!["Note 1", "Note 2", "Note 11"]
        );
        assert_eq!(
            sorted(&["v1.10.0", "v1.2.0", "v1.9.3"]),
            vec!["v1.2.0", "v1.9.3", "v1.10.0"]
        );
    }

    #[test]
    fn folds_case_for_the_primary_comparison() {
        assert_eq!(sorted(&["Zebra", "apple"]), vec!["apple", "Zebra"]);
    }

    #[test]
    fn names_differing_only_in_case_get_a_stable_total_order() {
        // Not "equal" — a case-insensitive-only comparator would let these
        // swap places between runs and break journal-scroll pagination.
        assert_ne!(compare_name("Notes", "notes"), Ordering::Equal);
    }

    #[test]
    fn matches_the_frontend_collator_exactly() {
        // `src/lib/sort.test.ts` checks this list verbatim ("matches the Rust
        // collator exactly"). Change both sides together.
        assert_eq!(
            sorted(&[
                "10 Conclusion",
                "2 Methods",
                "1 Intro",
                "notes",
                "Notes",
                "NOTES",
                "Étude 10",
                "Étude 2",
                "archive",
                "Archive",
                "9 Results",
            ]),
            vec![
                "1 Intro",
                "2 Methods",
                "9 Results",
                "10 Conclusion",
                "archive",
                "Archive",
                "Étude 2",
                "Étude 10",
                "notes",
                "Notes",
                "NOTES",
            ]
        );
    }

    #[test]
    fn sorts_accented_letters_with_their_base_letter() {
        // The specific bug the hand-rolled comparator had: code-point order
        // puts every accented Latin letter after `z`.
        assert_eq!(
            sorted(&["zebra", "Étude", "apple"]),
            vec!["apple", "Étude", "zebra"]
        );
        assert_eq!(
            sorted(&["Étude 10", "Étude 2", "Ébauche 3"]),
            vec!["Ébauche 3", "Étude 2", "Étude 10"]
        );
    }

    #[test]
    fn handles_non_latin_and_punctuation_names() {
        assert_eq!(sorted(&["日記 10", "日記 2"]), vec!["日記 2", "日記 10"]);
        assert_eq!(
            sorted(&["“Quoted” 10", "“Quoted” 9"]),
            vec!["“Quoted” 9", "“Quoted” 10"]
        );
    }

    #[test]
    fn handles_empty_and_prefix_names() {
        assert_eq!(compare_name("", ""), Ordering::Equal);
        assert_eq!(compare_name("", "a"), Ordering::Less);
        assert_eq!(compare_name("Note", "Note 2"), Ordering::Less);
    }

    #[test]
    fn preserves_iso_date_ordering() {
        assert_eq!(
            sorted(&["2026-06-14", "2026-06-02", "2025-12-31"]),
            vec!["2025-12-31", "2026-06-02", "2026-06-14"]
        );
    }
}
