//! Rust → Typst glue for the collaboration review primitives.
//!
//! Per CLAUDE.md's Typst-first principle the *rendering* of a declined-change
//! record lives in the `inkycap-notebox` Typst package
//! (`#review-reject` in `lib.typ`); this module only builds the call string
//! Rust emits when it has data to record, and assembles the per-collection
//! **rejection-log note** that those calls accumulate in.
//!
//! The `#review` (inline reviewer comment) primitive is authored entirely on
//! the frontend via the `/` command palette, so it needs no Rust builder —
//! only `#review-reject` is host-emitted (on a Reject decision in
//! `collab_review_apply`).

use crate::notebox_package;
use crate::typst_pipeline::book_wrapper::typst_escape;

/// A `#review-reject("target", "reason", by: "…", on: "…")` call — the entry
/// appended to a collection's rejection-log note when an incoming change is
/// declined. `by` / `on` are omitted when `None`/empty so the rendered
/// attribution stays clean. All interpolated strings are escaped for safe
/// embedding in a Typst quoted-string literal.
pub fn review_reject_call(
    target: &str,
    reason: &str,
    by: Option<&str>,
    on: Option<&str>,
) -> String {
    let mut named = String::new();
    if let Some(by) = by.filter(|s| !s.is_empty()) {
        named.push_str(&format!(", by: \"{}\"", typst_escape(by)));
    }
    if let Some(on) = on.filter(|s| !s.is_empty()) {
        named.push_str(&format!(", on: \"{}\"", typst_escape(on)));
    }
    format!(
        "#review-reject(\"{}\", \"{}\"{})",
        typst_escape(target),
        typst_escape(reason),
        named
    )
}

/// The title of a collection's rejection-log note. Kept as a function (not a
/// format at the call site) so the "is this the log note?" check and the
/// "create the log note" path can't drift.
pub fn rejection_log_title(collection_name: &str) -> String {
    format!("{collection_name} — Rejected Changes")
}

/// Assemble the full content of a rejection-log note after appending one new
/// `#review-reject(...)` entry.
///
/// - `existing` is the note's current content, or `None` to create it.
/// - When creating, a header is emitted: the package import, a `#note(...)`
///   carrying only the title (deliberately **no** `collection` property, so
///   the log is local audit and never travels back in a package), and a
///   heading. New entries are appended after the header, newest last.
///
/// The entry is separated by a blank line so the rendered blocks don't run
/// together. Returns the content to write through `NoteboxStorage`.
pub fn append_to_rejection_log(
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
            let title = rejection_log_title(collection_name);
            format!(
                "{import}\n#note(title: \"{title}\")\n\n= Rejected changes\n\nIncoming changes you declined while reviewing collaboration packages, \
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
    fn reject_call_omits_absent_named_args() {
        let call = review_reject_call("My Note", "Out of scope", None, None);
        assert_eq!(call, "#review-reject(\"My Note\", \"Out of scope\")");
    }

    #[test]
    fn reject_call_includes_present_named_args() {
        let call = review_reject_call("My Note", "Stale", Some("alice"), Some("2026-05-22"));
        assert_eq!(
            call,
            "#review-reject(\"My Note\", \"Stale\", by: \"alice\", on: \"2026-05-22\")"
        );
    }

    #[test]
    fn reject_call_treats_empty_named_args_as_absent() {
        let call = review_reject_call("N", "R", Some(""), Some(""));
        assert_eq!(call, "#review-reject(\"N\", \"R\")");
    }

    #[test]
    fn reject_call_escapes_quotes_and_backslashes() {
        let call = review_reject_call("A \"B\"", "path C:\\x", None, None);
        assert_eq!(call, "#review-reject(\"A \\\"B\\\"\", \"path C:\\\\x\")");
    }

    #[test]
    fn create_log_emits_header_with_title_and_no_collection_prop() {
        let entry = review_reject_call("Note X", "Reason", Some("me"), Some("2026-05-22"));
        let out = append_to_rejection_log(None, &entry, "My Project");
        assert!(out.starts_with("#import \"/.inkycap/notebox.typ\": *\n"));
        assert!(out.contains("#note(title: \"My Project — Rejected Changes\")"));
        assert!(out.contains("= Rejected changes"));
        // The log must never re-enter the collection it audits.
        assert!(!out.contains("collection:"));
        assert!(out.trim_end().ends_with(&entry));
    }

    #[test]
    fn append_keeps_prior_entries_and_adds_newest_last() {
        let first = review_reject_call("A", "r1", None, None);
        let created = append_to_rejection_log(None, &first, "Col");
        let second = review_reject_call("B", "r2", None, None);
        let appended = append_to_rejection_log(Some(&created), &second, "Col");
        let i1 = appended.find(&first).expect("first entry retained");
        let i2 = appended.find(&second).expect("second entry present");
        assert!(i1 < i2, "newest entry appended last");
        // No header duplication on append.
        assert_eq!(appended.matches("= Rejected changes").count(), 1);
    }
}
