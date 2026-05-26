//! Render a note's incoming changes as inline `#suggestion` markup — the core
//! of the one-review-surface model.
//!
//! Given the merge base, *my* working copy, and *their* fetched copy, this
//! produces a **staged copy**: my source with their changes overlaid as
//! `#suggestion(...)` calls (the same primitive the visual editor and
//! [`crate::typst_pipeline::suggestion`] already understand). The user resolves
//! those inline; resolving them *is* the merge.
//!
//! ## Approach
//! A line-level diff of *mine → theirs* drives the rendering: every region
//! where theirs differs becomes one suggestion — `insert` (theirs added),
//! `delete` (theirs removed), or `replace` (theirs rewrote). This gives the
//! round-trip the plan requires: accepting every suggestion yields *theirs*,
//! rejecting every suggestion yields *mine*; with none resolved the staged copy
//! compiles and reads as tracked changes.
//!
//! The merge base classifies each region as **clean** or **conflict**: a region
//! is a conflict when the lines it touches in *mine* also differ from *base*
//! (both sides edited the same place). Clean regions are bulk-acceptable; the
//! caller is handed the byte offsets of the conflict suggestions so it can hold
//! those back for a hand decision. With no merge base (unrelated histories)
//! everything is treated as clean — the degenerate "all incoming" case.
//!
//! ## Safety (per CLAUDE.md)
//! Bodies are placed verbatim in `[...]` content brackets because they are
//! Typst markup, not strings (escaping would corrupt `*bold*`/`$math$`). Line
//! splitting scans for the ASCII `\n` byte only, so it never lands inside a
//! multi-byte character. As a backstop the staged copy is parsed with the real
//! Typst parser; if rendering introduced parse errors that *mine* did not have
//! (e.g. a hunk cut through a `#func[...]` call and unbalanced its brackets),
//! the whole note falls back to the raw-diff view — correctness over coverage.
//! Incoming hunks that already *are* `#suggestion`/`#annotation` markup pass
//! through verbatim rather than being wrapped again. And when a *changed* hunk
//! holds existing tracked-changes markup mid-content (so it can't pass through
//! cleanly), the whole note falls back to the raw diff rather than nest a
//! suggestion inside a suggestion.

use similar::{capture_diff_slices, Algorithm, DiffOp};

use crate::typst_pipeline::suggestion::{suggestion_call, SuggestionKind};

/// Outcome of rendering one note's incoming changes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StagedRender {
    /// Rendered successfully as inline suggestions.
    Suggestions(StagedSuggestions),
    /// The diff could not be safely rendered; the caller should show the
    /// raw-diff view for this note instead. `reason` is for logging/UI.
    Fallback { reason: String },
}

/// A staged note plus the metadata the review layer needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedSuggestions {
    /// Staged source: *mine* with theirs' changes overlaid as `#suggestion`s.
    pub source: String,
    /// Total number of suggestions rendered.
    pub total: usize,
    /// Byte offsets (the `#` of each call) of suggestions that are conflicts —
    /// both sides edited the region. Excluded from bulk-accept; resolved by
    /// hand. A subset of all rendered suggestions.
    pub conflicts: Vec<usize>,
}

/// Render `theirs` as inline suggestions over `mine`, using `base` (the merge
/// base, if any) to flag conflicts. `by`/`on` attribute the suggestions (the
/// incoming commit's author + date).
pub fn render_incoming(
    base: Option<&str>,
    mine: &str,
    theirs: &str,
    by: Option<&str>,
    on: Option<&str>,
) -> StagedRender {
    // Identical content ⇒ nothing to review.
    if mine == theirs {
        return StagedRender::Suggestions(StagedSuggestions {
            source: mine.to_string(),
            total: 0,
            conflicts: Vec::new(),
        });
    }

    let mine_lines = split_lines_keep_terminator(mine);
    let theirs_lines = split_lines_keep_terminator(theirs);
    // Which of *my* lines are unchanged from base (so a hunk touching only
    // these is a clean incoming change, not a conflict). Absent a base, we
    // cannot tell — treat all as clean.
    let from_base = base.map(|b| mine_from_base_flags(b, &mine_lines));

    let ops = capture_diff_slices(Algorithm::Myers, &mine_lines, &theirs_lines);

    let mut out = String::with_capacity(theirs.len().max(mine.len()) + 64);
    let mut conflicts = Vec::new();
    let mut total = 0usize;

    for op in ops {
        match op {
            DiffOp::Equal { old_index, len, .. } => {
                for line in &mine_lines[old_index..old_index + len] {
                    out.push_str(line);
                }
            }
            DiffOp::Delete {
                old_index, old_len, ..
            } => {
                let body = concat_lines(&mine_lines[old_index..old_index + old_len]);
                // Deleting a region that holds existing tracked-changes markup
                // would wrap a suggestion in a suggestion — bail to the raw diff.
                if contains_tracked_markup(&body) {
                    return fallback_markup_overlap();
                }
                let conflict = is_conflict(&from_base, old_index, old_len);
                emit_suggestion(
                    &mut out,
                    SuggestionKind::Delete,
                    &body,
                    None,
                    by,
                    on,
                    conflict,
                    &mut conflicts,
                    &mut total,
                );
            }
            DiffOp::Insert {
                new_index, new_len, ..
            } => {
                let body = concat_lines(&theirs_lines[new_index..new_index + new_len]);
                // Markup mid-hunk (not a clean whole-hunk passthrough) would nest.
                if !is_passthrough_markup(&body) && contains_tracked_markup(&body) {
                    return fallback_markup_overlap();
                }
                // A pure insertion touches no lines of mine, so it can never be
                // a conflict on its own.
                emit_suggestion(
                    &mut out,
                    SuggestionKind::Insert,
                    &body,
                    None,
                    by,
                    on,
                    false,
                    &mut conflicts,
                    &mut total,
                );
            }
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                let old = concat_lines(&mine_lines[old_index..old_index + old_len]);
                let body = concat_lines(&theirs_lines[new_index..new_index + new_len]);
                // Either side carrying existing tracked-changes markup in the
                // changed region would produce a suggestion-within-a-suggestion;
                // fall back rather than emit stacked markup. (A clean whole-hunk
                // suggestion in `body` still passes through via emit_suggestion.)
                if contains_tracked_markup(&old)
                    || (!is_passthrough_markup(&body) && contains_tracked_markup(&body))
                {
                    return fallback_markup_overlap();
                }
                let conflict = is_conflict(&from_base, old_index, old_len);
                emit_suggestion(
                    &mut out,
                    SuggestionKind::Replace,
                    &body,
                    Some(&old),
                    by,
                    on,
                    conflict,
                    &mut conflicts,
                    &mut total,
                );
            }
        }
    }

    // Backstop: the staged copy must not introduce parse errors that mine did
    // not already have (a hunk that unbalanced a `#func[...]`, math block, …).
    if parse_error_count(&out) > parse_error_count(mine) {
        return StagedRender::Fallback {
            reason: "rendering incoming changes as suggestions produced invalid Typst".into(),
        };
    }

    StagedRender::Suggestions(StagedSuggestions {
        source: out,
        total,
        conflicts,
    })
}

/// Emit one suggestion (or pass incoming markup through verbatim) into `out`,
/// recording its offset when it is a conflict and bumping the count.
#[allow(clippy::too_many_arguments)]
fn emit_suggestion(
    out: &mut String,
    kind: SuggestionKind,
    body: &str,
    old: Option<&str>,
    by: Option<&str>,
    on: Option<&str>,
    conflict: bool,
    conflicts: &mut Vec<usize>,
    total: &mut usize,
) {
    // Hand-authored suggestion/annotation markup arrives as itself — wrapping
    // it would make a "suggestion of a suggestion".
    if kind != SuggestionKind::Delete && is_passthrough_markup(body) {
        out.push_str(body);
        return;
    }
    if conflict {
        conflicts.push(out.len());
    }
    out.push_str(&suggestion_call(kind, body, old, by, on));
    *total += 1;
}

/// True when a hunk over `mine[start..start+len]` is a conflict: the region is
/// non-empty and at least one of those lines differs from the merge base
/// (i.e. I edited it too). With no base information, never a conflict.
fn is_conflict(from_base: &Option<Vec<bool>>, start: usize, len: usize) -> bool {
    match from_base {
        None => false,
        Some(flags) => len > 0 && (start..start + len).any(|i| !flags.get(i).copied().unwrap_or(true)),
    }
}

/// Whether `text` already is a single `#suggestion`/`#annotation` call (and so
/// should pass through rather than be wrapped).
fn is_passthrough_markup(text: &str) -> bool {
    let t = text.trim_start();
    (t.starts_with("#suggestion(") || t.starts_with("#annotation(") || t.starts_with("#annotation["))
        && parse_error_count(text) == 0
}

/// Whether `text` contains tracked-changes markup (`#suggestion`/`#annotation`)
/// *anywhere*, not just at the start. When a changed hunk's content holds such
/// markup, wrapping it as a suggestion would nest a suggestion inside a
/// suggestion (the "stacked" markup a reviewer sees as raw text); rendering
/// bails to the raw-diff view for that note instead — correctness over coverage,
/// like the parse backstop. (A whole-hunk passthrough is handled separately and
/// does not reach this check.)
fn contains_tracked_markup(text: &str) -> bool {
    text.contains("#suggestion(") || text.contains("#annotation(") || text.contains("#annotation[")
}

/// The fallback returned when an incoming change overlaps existing tracked
/// changes (see [`contains_tracked_markup`]).
fn fallback_markup_overlap() -> StagedRender {
    StagedRender::Fallback {
        reason: "incoming change overlaps existing tracked-changes markup".into(),
    }
}

/// Split keeping line terminators so concatenation reproduces the input
/// byte-for-byte. Scans for the ASCII `\n` byte only — never lands inside a
/// multi-byte UTF-8 sequence (utf8-safe: `\n` cannot appear within one).
fn split_lines_keep_terminator(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = s.as_bytes();
    let mut start = 0;
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'\n' {
            out.push(&s[start..=i]);
            start = i + 1;
        }
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

fn concat_lines(lines: &[&str]) -> String {
    lines.concat()
}

/// Flags, per *mine* line, whether that line is unchanged from `base`.
fn mine_from_base_flags(base: &str, mine_lines: &[&str]) -> Vec<bool> {
    let base_lines = split_lines_keep_terminator(base);
    let mut flags = vec![false; mine_lines.len()];
    for op in capture_diff_slices(Algorithm::Myers, &base_lines, mine_lines) {
        if let DiffOp::Equal {
            new_index, len, ..
        } = op
        {
            for f in flags.iter_mut().skip(new_index).take(len) {
                *f = true;
            }
        }
    }
    flags
}

/// Number of parse errors the real Typst parser finds in `src`.
fn parse_error_count(src: &str) -> usize {
    typst::syntax::parse(src).errors().len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::typst_pipeline::suggestion::resolve_all_suggestions;

    fn staged(r: StagedRender) -> StagedSuggestions {
        match r {
            StagedRender::Suggestions(s) => s,
            StagedRender::Fallback { reason } => panic!("unexpected fallback: {reason}"),
        }
    }

    /// The defining invariant: accept-all yields theirs, reject-all yields mine.
    fn assert_round_trip(base: Option<&str>, mine: &str, theirs: &str) {
        let s = staged(render_incoming(base, mine, theirs, None, None));
        assert_eq!(
            resolve_all_suggestions(&s.source, true),
            theirs,
            "accept-all should equal theirs"
        );
        assert_eq!(
            resolve_all_suggestions(&s.source, false),
            mine,
            "reject-all should equal mine"
        );
    }

    #[test]
    fn identical_inputs_produce_no_suggestions() {
        let s = staged(render_incoming(Some("a\n"), "a\n", "a\n", None, None));
        assert_eq!(s.total, 0);
        assert_eq!(s.source, "a\n");
    }

    #[test]
    fn pure_insertion_round_trips_and_is_clean() {
        let base = "line one\nline three\n";
        let mine = "line one\nline three\n";
        let theirs = "line one\nline two\nline three\n";
        let s = staged(render_incoming(Some(base), mine, theirs, Some("alice"), Some("2026-05-24")));
        assert_eq!(s.total, 1);
        assert!(s.conflicts.is_empty(), "theirs-only insert is clean");
        assert_round_trip(Some(base), mine, theirs);
    }

    #[test]
    fn deletion_round_trips() {
        let base = "keep\ndrop\nkeep2\n";
        let mine = "keep\ndrop\nkeep2\n";
        let theirs = "keep\nkeep2\n";
        let s = staged(render_incoming(Some(base), mine, theirs, None, None));
        assert_eq!(s.total, 1);
        assert!(s.conflicts.is_empty());
        assert_round_trip(Some(base), mine, theirs);
    }

    #[test]
    fn theirs_only_replace_is_clean() {
        // mine == base, so a replace by theirs is a clean incoming change.
        let base = "The cat sat.\n";
        let mine = "The cat sat.\n";
        let theirs = "The cat slept.\n";
        let s = staged(render_incoming(Some(base), mine, theirs, None, None));
        assert_eq!(s.total, 1);
        assert!(s.conflicts.is_empty());
        assert_round_trip(Some(base), mine, theirs);
    }

    #[test]
    fn both_edited_same_region_is_a_conflict() {
        // base -> mine and base -> theirs both changed the same line.
        let base = "value = 1\n";
        let mine = "value = 2\n";
        let theirs = "value = 3\n";
        let s = staged(render_incoming(Some(base), mine, theirs, None, None));
        assert_eq!(s.total, 1);
        assert_eq!(s.conflicts.len(), 1, "both sides edited the same line");
        // Still round-trips: accept = theirs (3), reject = mine (2).
        assert_round_trip(Some(base), mine, theirs);
    }

    #[test]
    fn no_merge_base_treats_everything_as_clean() {
        let mine = "alpha\nbeta\n";
        let theirs = "alpha\ngamma\n";
        let s = staged(render_incoming(None, mine, theirs, None, None));
        assert!(s.conflicts.is_empty(), "no base ⇒ no conflict classification");
        assert_round_trip(None, mine, theirs);
    }

    #[test]
    fn multibyte_content_is_not_corrupted() {
        let base = "café au lait\n";
        let mine = "café au lait\n";
        let theirs = "café noir — très fort\n";
        assert_round_trip(Some(base), mine, theirs);
    }

    #[test]
    fn inline_markup_round_trips() {
        let base = "A plain line.\n";
        let mine = "A plain line.\n";
        let theirs = "A line with *bold* and _italic_.\n";
        assert_round_trip(Some(base), mine, theirs);
    }

    #[test]
    fn no_trailing_newline_round_trips() {
        let mine = "one\ntwo";
        let theirs = "one\ntwo three";
        assert_round_trip(Some(mine), mine, theirs);
    }

    #[test]
    fn unbalanced_markup_falls_back() {
        // A change that, wrapped naively, would unbalance a content bracket and
        // break the parse must fall back rather than emit broken Typst.
        let mine = "#figure[\nold caption\n]\n";
        let theirs = "#figure[\nnew caption with ] stray bracket\n]\n";
        match render_incoming(Some(mine), mine, theirs, None, None) {
            StagedRender::Fallback { .. } => {}
            StagedRender::Suggestions(s) => {
                // If it did not fall back, it must at least still be valid Typst
                // and round-trip — otherwise the test is meaningful and fails.
                assert_eq!(parse_error_count(&s.source), parse_error_count(mine));
                assert_eq!(resolve_all_suggestions(&s.source, true), theirs);
            }
        }
    }

    #[test]
    fn existing_suggestion_markup_passes_through_not_double_wrapped() {
        let base = "Original sentence.\n";
        let mine = "Original sentence.\n";
        // Their incoming line is itself a hand-authored suggestion.
        let theirs = "#suggestion(kind: \"insert\")[Original sentence, revised.]\n";
        let s = staged(render_incoming(Some(base), mine, theirs, None, None));
        assert!(
            !s.source.contains("suggestion(kind: \"insert\")[#suggestion"),
            "must not wrap a suggestion in a suggestion"
        );
    }

    #[test]
    fn change_over_existing_inline_markup_falls_back() {
        // A line carries a hand-authored inline suggestion; theirs edits the
        // text around it on the same line. Wrapping that whole line would nest
        // a suggestion inside a suggestion, so render bails to the raw diff.
        let mine = "asd #suggestion(kind: \"insert\")[Mork] the\n";
        let theirs = "asd #suggestion(kind: \"insert\")[Mork] the stuff\n";
        match render_incoming(Some(mine), mine, theirs, None, None) {
            StagedRender::Fallback { .. } => {}
            StagedRender::Suggestions(s) => {
                panic!("expected fallback for markup overlap, got {} suggestions", s.total)
            }
        }
    }

    #[test]
    fn change_away_from_existing_markup_still_renders_suggestions() {
        // The note contains a hand-authored suggestion on one line, but the
        // incoming change touches a *different* line — so it renders normally
        // (the overlap guard is narrow: only changed hunks that hold markup bail)
        // and the existing markup is preserved verbatim, exactly once.
        let mine = "intro\n#suggestion(kind: \"insert\")[note]\noutro\n";
        let theirs = "intro changed\n#suggestion(kind: \"insert\")[note]\noutro\n";
        let s = staged(render_incoming(Some(mine), mine, theirs, None, None));
        assert!(s.total >= 1, "the unrelated edit still renders as a suggestion");
        assert_eq!(
            s.source.matches("#suggestion(kind: \"insert\")[note]").count(),
            1,
            "the pre-existing markup is preserved untouched"
        );
    }
}
