//! Export-time resolution of the collaboration *review layer* — inline
//! `#suggestion(...)` tracked changes plus the `#annotation(...)` and
//! `#review-decision(...)` block notes.
//!
//! Two host-side jobs, both AST-based (Typst-first — `typst::syntax` is the
//! same parser the compiler uses, so byte ranges land on char boundaries and
//! multi-byte UTF-8 passes through verbatim, per CLAUDE.md):
//!
//! 1. [`prepare_review_markup`] applies the user's chosen export policy to a
//!    note's source before it is compiled or converted:
//!    - **Accept** — take every suggested change (insertions kept, deletions
//!      removed, replacements take the new text) and drop the review-only block
//!      notes, yielding a clean published copy.
//!    - **Reject** — the inverse: discard suggested changes, keep the original
//!      text, and still drop the block notes.
//!    - **Keep** — leave all review markup intact so the export renders the
//!      tracked-change marks (the default; nothing is silently altered).
//!
//! 2. [`flatten_review_to_native`] rewrites any review calls that survive into
//!    plain Typst (`strike` / `underline` / `quote`). Exporters that cannot load
//!    the `inkycap-notebox` package — i.e. the Pandoc path, whose own Typst
//!    reader has no access to our package definitions — call this so the
//!    surviving "keep" marks compile instead of erroring on an undefined
//!    `suggestion` / `annotation` / `review-decision` identifier.

use std::ops::Range;

use typst::syntax::{ast, parse, LinkedNode, SyntaxKind};

use crate::typst_pipeline::suggestion::{count_suggestions, resolve_all_suggestions};

/// Block-level review functions from `inkycap-notebox` that carry reviewer
/// commentary rather than document content. Stripped for accept/reject; left
/// intact for keep (the compiler renders them).
const BLOCK_REVIEW_CALLS: &[&str] = &["annotation", "review-decision"];

/// How the export should treat the collaboration review layer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReviewMarkupMode {
    /// Take every suggested change; drop block notes. A clean published copy.
    Accept,
    /// Discard suggested changes (keep originals); drop block notes.
    Reject,
    /// Leave all review markup so tracked-change marks render. Default.
    Keep,
}

impl ReviewMarkupMode {
    /// Parse the frontend's string tag. Unknown / absent values fall back to
    /// [`ReviewMarkupMode::Keep`] so an export never silently rewrites content.
    pub fn from_opt(s: Option<&str>) -> Self {
        match s {
            Some("accept") => ReviewMarkupMode::Accept,
            Some("reject") => ReviewMarkupMode::Reject,
            _ => ReviewMarkupMode::Keep,
        }
    }
}

/// Apply the chosen review-markup policy to a note's source. Pure source
/// transform: the result is still valid Typst that compiles against the
/// `inkycap-notebox` package (the `Keep` path is unchanged source).
pub fn prepare_review_markup(source: &str, mode: ReviewMarkupMode) -> String {
    match mode {
        ReviewMarkupMode::Keep => source.to_string(),
        ReviewMarkupMode::Accept => strip_block_review(&resolve_all_suggestions(source, true)),
        ReviewMarkupMode::Reject => strip_block_review(&resolve_all_suggestions(source, false)),
    }
}

/// Number of review-layer constructs in the source (suggestions + block
/// notes). Lets the export dialog show its review-markup control only when a
/// note actually carries tracked changes.
pub fn count_review_markup(source: &str) -> usize {
    count_suggestions(source) + collect_block_review(source).len()
}

// ---------------------------------------------------------------------------
// Block-review AST handling (annotation / review-decision)
// ---------------------------------------------------------------------------

/// Remove every block-review call from the source. Used by accept/reject — the
/// notes are reviewer commentary, not document content, so a resolved copy
/// drops them. When a call is the only thing on its line, the trailing newline
/// is consumed too so no blank line is left behind.
fn strip_block_review(source: &str) -> String {
    let spans = collect_block_review(source);
    if spans.is_empty() {
        return source.to_string();
    }
    let bytes = source.as_bytes();
    let mut out = source.to_string();
    let mut sorted = spans;
    sorted.sort_by(|a, b| b.start.cmp(&a.start));
    for span in &sorted {
        let mut range = span.clone();
        // Standalone-on-its-line: line starts at the call and a newline follows.
        let at_line_start = range.start == 0 || bytes[range.start - 1] == b'\n';
        if at_line_start && bytes.get(range.end) == Some(&b'\n') {
            range.end += 1;
        }
        out.replace_range(range, "");
    }
    out
}

/// Collect the hash-extended span of every `#annotation(...)` /
/// `#review-decision(...)` call in the source, in document order.
fn collect_block_review(source: &str) -> Vec<Range<usize>> {
    fn walk(node: &LinkedNode, source: &str, out: &mut Vec<Range<usize>>) {
        if node.kind() == SyntaxKind::FuncCall {
            if let Some(call) = node.cast::<ast::FuncCall>() {
                if let ast::Expr::Ident(ident) = call.callee() {
                    if BLOCK_REVIEW_CALLS.contains(&ident.as_str()) {
                        let r = node.range();
                        let start = if r.start > 0 && source.as_bytes()[r.start - 1] == b'#' {
                            r.start - 1
                        } else {
                            r.start
                        };
                        out.push(start..r.end);
                    }
                }
            }
        }
        for child in node.children() {
            walk(&child, source, out);
        }
    }

    let root = parse(source);
    let link = LinkedNode::new(&root);
    let mut out = Vec::new();
    walk(&link, source, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keep_is_passthrough() {
        let src = "a #suggestion(kind: \"insert\")[x] b #annotation[note] c";
        assert_eq!(prepare_review_markup(src, ReviewMarkupMode::Keep), src);
    }

    #[test]
    fn accept_resolves_suggestions_and_drops_block_notes() {
        let src = "Good #suggestion(kind: \"delete\")[Good] girl";
        assert_eq!(
            prepare_review_markup(src, ReviewMarkupMode::Accept),
            "Good  girl"
        );
    }

    #[test]
    fn reject_keeps_original_text() {
        let src = "It is #suggestion(kind: \"replace\", old: [bad])[good] now";
        assert_eq!(
            prepare_review_markup(src, ReviewMarkupMode::Reject),
            "It is bad now"
        );
    }

    #[test]
    fn accept_strips_standalone_annotation_line_without_blank() {
        let src = "para one\n#annotation[needs a citation]\npara two\n";
        assert_eq!(
            prepare_review_markup(src, ReviewMarkupMode::Accept),
            "para one\npara two\n"
        );
    }

    #[test]
    fn accept_strips_review_decision() {
        let src = "before\n#review-decision(\"Title\", \"accepted\", note: \"looks good\")\nafter\n";
        assert_eq!(
            prepare_review_markup(src, ReviewMarkupMode::Accept),
            "before\nafter\n"
        );
    }

    #[test]
    fn count_covers_all_review_kinds() {
        let src = "#suggestion(kind: \"insert\")[a] #annotation[b] \
                   #review-decision(\"t\", \"accepted\")";
        assert_eq!(count_review_markup(src), 3);
        assert_eq!(count_review_markup("plain text"), 0);
    }

    #[test]
    fn multibyte_annotation_body_survives_strip() {
        let src = "keep #annotation[naïve — résumé β] this";
        assert_eq!(
            prepare_review_markup(src, ReviewMarkupMode::Accept),
            "keep  this"
        );
    }
}
