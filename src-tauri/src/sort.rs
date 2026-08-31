//! Name ordering for user-facing lists, the Rust counterpart to the
//! frontend's `compareName` in `src/lib/sort.ts`.
//!
//! Most listings the user sees are sorted in the webview, but three orderings
//! are decided here and shipped to the frontend already sorted: collection
//! table rows, the journal scroll's paginated entries, and the scaffold
//! picker. Those need the same rules the rest of the app follows, or a
//! `10 Chapter` note lands between `1 Chapter` and `2 Chapter` in one surface
//! and after `9 Chapter` in the next.
//!
//! Both halves therefore run the *same* collation algorithm rather than two
//! approximations of it: the frontend uses the browser's `Intl.Collator`, and
//! this module uses ICU4X, which is the same Unicode collation the browser
//! implements. A hand-rolled comparator lived here briefly and got the easy
//! cases right (digits, ASCII case) while disagreeing with the frontend on
//! accented letters — `Étude` sorted after `zebra` instead of with the `E`s,
//! because code-point order is not collation order.
//!
//! `icu_collator` costs nothing to depend on: Typst's bibliography engine
//! (Hayagriva) already pulls it and its data into the binary, so this is a
//! direct dependency on a crate that was being compiled anyway.

use icu_collator::{
    options::CollatorOptions, preferences::CollationNumericOrdering, Collator, CollatorBorrowed,
    CollatorPreferences,
};
use std::cmp::Ordering;
use std::sync::OnceLock;

/// Process-wide collator. Construction parses locale data, so it happens once
/// rather than per comparison — these sorts run O(n log n) over collection
/// tables that can hold thousands of rows.
static COLLATOR: OnceLock<Option<CollatorBorrowed<'static>>> = OnceLock::new();

fn collator() -> Option<&'static CollatorBorrowed<'static>> {
    COLLATOR
        .get_or_init(|| {
            let mut prefs = CollatorPreferences::default();
            // The `-u-kn` numeric-ordering preference: digit runs compare by
            // value, so `2 Draft` precedes `10 Draft`. This is the whole
            // reason the module exists.
            prefs.numeric_ordering = Some(CollationNumericOrdering::True);
            Collator::try_new(prefs, CollatorOptions::default()).ok()
        })
        .as_ref()
}

/// Compare two names for an *ascending* sort, using Unicode collation with
/// numeric ordering. Callers wanting descending order swap the arguments
/// (`compare_name(b, a)`) rather than negating, so a tie stays a tie.
///
/// Properties that callers depend on:
///
/// * **Numbers order by value.** `2 Draft` before `10 Draft`.
/// * **Accents fold to their base letter.** `Étude` sorts among the `E`s, not
///   after `z`.
/// * **Case is a tertiary difference, never an equality.** `apple` precedes
///   `Zebra`, and `notes` / `Notes` / `NOTES` are distinct and ordered
///   lowercase-first. Two directories differing only in case can coexist on a
///   case-sensitive filesystem, and a comparator that called them equal would
///   let them swap places between queries — which breaks the journal scroll,
///   whose pagination requires a total, reproducible order.
///
/// Collation uses the CLDR root locale rather than the user's UI language.
/// The frontend collator uses the host locale, so the two can in principle
/// disagree for languages whose collation reorders base letters (Swedish
/// sorts `å` after `z`; root sorts it with `a`). They agree for every locale
/// InkyCap currently ships. Threading the UI locale down to these call sites
/// is the fix if that ever stops being true.
pub fn compare_name(a: &str, b: &str) -> Ordering {
    match collator() {
        Some(c) => c.compare(a, b),
        // Unreachable in practice: `icu_collator`'s default `compiled_data`
        // feature bakes the root collation into the binary, so construction
        // cannot fail for lack of data. Degrade to byte order rather than
        // panic in a sort comparator.
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
        // This list is asserted verbatim by `src/lib/sort.test.ts`'s
        // "matches the Rust collator exactly" case. The two comparators must
        // agree, or the file tree and a collection table disagree about the
        // same notes. Change one side and you must change the other.
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
