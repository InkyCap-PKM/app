//! Rust → Typst glue for the collaboration review primitives.
//!
//! Per CLAUDE.md's Typst-first principle the *rendering* of a review decision
//! lives in the `inkycap-notebox` Typst package (`#review-decision` in
//! `lib.typ`); this module only builds the call string Rust emits when it has
//! a decision to record, and assembles the per-collection **review-log note**
//! that those calls accumulate in.
//!
//! The `#annotation` (inline margin comment) primitive is authored entirely on
//! the frontend via the `/` command palette, so it needs no Rust builder —
//! only `#review-decision` is host-emitted (when a decision is applied, or a
//! bare comment is left, in `collab_review_apply` / `collab_review_comment`).

use crate::notebox_package;
use crate::typst_pipeline::book_wrapper::typst_escape;

/// The decision a `#review-decision(...)` entry records. The string form is
/// what Typst's `_decision-color` / `_decision-label` switch on, so the two
/// must stay in lock-step (one is tested against the other in `lib.typ`'s
/// `review_primitives` compile test).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReviewAction {
    Accepted,
    Rejected,
    Commented,
}

impl ReviewAction {
    /// The lowercase string passed as the Typst `action` argument.
    pub fn as_typ(self) -> &'static str {
        match self {
            ReviewAction::Accepted => "accepted",
            ReviewAction::Rejected => "rejected",
            ReviewAction::Commented => "commented",
        }
    }
}

/// A `#review-decision("target", "action", note: "…", by: "…", on: "…")` call
/// — the entry appended to a collection's review-log note when a decision is
/// applied or a bare comment is left. `note` / `by` / `on` are omitted when
/// empty so the rendered entry stays clean (an accept with no comment is just
/// a one-line log row). All interpolated strings are escaped for safe
/// embedding in a Typst quoted-string literal.
pub fn review_decision_call(
    target: &str,
    action: ReviewAction,
    note: &str,
    by: Option<&str>,
    on: Option<&str>,
) -> String {
    let mut named = String::new();
    if !note.is_empty() {
        named.push_str(&format!(", note: \"{}\"", typst_escape(note)));
    }
    if let Some(by) = by.filter(|s| !s.is_empty()) {
        named.push_str(&format!(", by: \"{}\"", typst_escape(by)));
    }
    if let Some(on) = on.filter(|s| !s.is_empty()) {
        named.push_str(&format!(", on: \"{}\"", typst_escape(on)));
    }
    format!(
        "#review-decision(\"{}\", \"{}\"{})",
        typst_escape(target),
        action.as_typ(),
        named
    )
}

/// The title of a collection's review-log note. Kept as a function (not a
/// format at the call site) so the "is this the log note?" check and the
/// "create the log note" path can't drift.
pub fn review_log_title(collection_name: &str) -> String {
    format!("{collection_name} — Review Log")
}

/// Assemble the full content of a review-log note after appending one new
/// `#review-decision(...)` entry.
///
/// - `existing` is the note's current content, or `None` to create it.
/// - When creating, a header is emitted: the package import, a `#note(...)`
///   carrying only the title (deliberately **no** `collection` property, so
///   the log is local audit and never travels back in a package), and a
///   heading. New entries are appended after the header, newest last.
///
/// The entry is separated by a blank line so the rendered blocks don't run
/// together. Returns the content to write through `NoteboxStorage`.
pub fn append_to_review_log(
    existing: Option<&str>,
    entry_call: &str,
    collection_name: &str,
) -> String {
    match existing {
        Some(current) => {
            let trimmed = current.trim_end();
            format!("{trimmed}\n\n{entry_call}\n")
        }
        None => {
            let title = review_log_title(collection_name);
            format!(
                "{import}\n#note(title: \"{title}\")\n\n= Review log\n\nDecisions and comments recorded while reviewing collaboration packages, \
                 newest last. This note is local — it is not shared back to collaborators.\n\n{entry_call}\n",
                import = notebox_package::import_line(),
                title = typst_escape(&title),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_call_omits_absent_named_args() {
        let call = review_decision_call("My Note", ReviewAction::Rejected, "Out of scope", None, None);
        assert_eq!(call, "#review-decision(\"My Note\", \"rejected\", note: \"Out of scope\")");
    }

    #[test]
    fn decision_call_includes_present_named_args() {
        let call = review_decision_call(
            "My Note",
            ReviewAction::Rejected,
            "Stale",
            Some("alice"),
            Some("2026-05-22"),
        );
        assert_eq!(
            call,
            "#review-decision(\"My Note\", \"rejected\", note: \"Stale\", by: \"alice\", on: \"2026-05-22\")"
        );
    }

    #[test]
    fn decision_call_treats_empty_note_and_attribution_as_absent() {
        // An accept with no comment and no attribution is a bare one-liner.
        let call = review_decision_call("N", ReviewAction::Accepted, "", Some(""), Some(""));
        assert_eq!(call, "#review-decision(\"N\", \"accepted\")");
    }

    #[test]
    fn decision_call_escapes_quotes_and_backslashes() {
        let call = review_decision_call("A \"B\"", ReviewAction::Commented, "path C:\\x", None, None);
        assert_eq!(
            call,
            "#review-decision(\"A \\\"B\\\"\", \"commented\", note: \"path C:\\\\x\")"
        );
    }

    #[test]
    fn action_strings_match_lib_typ_switch() {
        assert_eq!(ReviewAction::Accepted.as_typ(), "accepted");
        assert_eq!(ReviewAction::Rejected.as_typ(), "rejected");
        assert_eq!(ReviewAction::Commented.as_typ(), "commented");
    }

    #[test]
    fn create_log_emits_header_with_title_and_no_collection_prop() {
        let entry =
            review_decision_call("Note X", ReviewAction::Rejected, "Reason", Some("me"), Some("2026-05-22"));
        let out = append_to_review_log(None, &entry, "My Project");
        assert!(out.starts_with("#import \"/.inkycap/notebox.typ\": *\n"));
        assert!(out.contains("#note(title: \"My Project — Review Log\")"));
        assert!(out.contains("= Review log"));
        // The log must never re-enter the collection it audits.
        assert!(!out.contains("collection:"));
        assert!(out.trim_end().ends_with(&entry));
    }

    #[test]
    fn append_keeps_prior_entries_and_adds_newest_last() {
        let first = review_decision_call("A", ReviewAction::Rejected, "r1", None, None);
        let created = append_to_review_log(None, &first, "Col");
        let second = review_decision_call("B", ReviewAction::Accepted, "r2", None, None);
        let appended = append_to_review_log(Some(&created), &second, "Col");
        let i1 = appended.find(&first).expect("first entry retained");
        let i2 = appended.find(&second).expect("second entry present");
        assert!(i1 < i2, "newest entry appended last");
        // No header duplication on append.
        assert_eq!(appended.matches("= Review log").count(), 1);
    }
}
