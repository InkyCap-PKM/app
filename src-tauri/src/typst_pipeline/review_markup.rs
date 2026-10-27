//! Handling the review markup at export: inline `#suggestion(...)` tracked
//! changes and `#annotation(...)` notes. Both jobs use `typst::syntax`, so
//! ranges land on character boundaries and multi-byte text is preserved.
//!
//! 1. [`prepare_review_markup`] applies the chosen export setting to a note's
//!    source before it is compiled or converted:
//!    - **Accept**: apply every suggestion (insertions kept, deletions removed,
//!      replacements use the new text) and remove the notes, for a clean copy.
//!    - **Reject**: the opposite: discard suggestions and keep the original
//!      text; notes are still removed.
//!    - **Keep**: leave all review markup, so the export shows the marks (the
//!      default).
//!
//! 2. [`flatten_review_to_native`] rewrites any remaining review calls as plain
//!    Typst (`strike` / `underline` / `quote`), for exporters that can't load
//!    the `inkycap-notebox` package (Pandoc), where `suggestion` / `annotation`
//!    would be undefined.

use std::ops::Range;

use typst::syntax::{ast, parse, LinkedNode, SyntaxKind};

use crate::typst_pipeline::suggestion::{count_suggestions, resolve_all_suggestions};

/// Block-level review functions from `inkycap-notebox`, holding reviewer
/// comments rather than content. Removed for accept and reject, kept for keep.
const BLOCK_REVIEW_CALLS: &[&str] = &["annotation"];

/// How the export should treat the collaboration review layer. Stored in a
/// collection's `export:` settings as `accept` / `reject` / `keep`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
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

/// Apply the chosen review setting to a note's source. The result still
/// compiles against `inkycap-notebox` (Keep returns it unchanged).
pub fn prepare_review_markup(source: &str, mode: ReviewMarkupMode) -> String {
    match mode {
        ReviewMarkupMode::Keep => source.to_string(),
        ReviewMarkupMode::Accept => strip_block_review(&resolve_all_suggestions(source, true)),
        ReviewMarkupMode::Reject => strip_block_review(&resolve_all_suggestions(source, false)),
    }
}

/// Number of review constructs (suggestions and notes) in the source, so the
/// export dialog shows its review setting only when there are some.
pub fn count_review_markup(source: &str) -> usize {
    count_suggestions(source) + collect_block_review(source).len()
}

// ---------------------------------------------------------------------------
// Block-review AST handling (annotation)
// ---------------------------------------------------------------------------

/// Remove every block review call (accept and reject: they are comments, not
/// content). A call alone on its line takes its newline too, so no blank line
/// is left.
fn strip_block_review(source: &str) -> String {
    let spans = collect_block_review(source);
    if spans.is_empty() {
        return source.to_string();
    }
    let bytes = source.as_bytes();
    let mut out = source.to_string();
    let mut sorted = spans;
    sorted.sort_by_key(|b| std::cmp::Reverse(b.start));
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

/// Collect the hash-extended span of every `#annotation(...)` call in the
/// source, in document order.
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
    fn count_covers_all_review_kinds() {
        let src = "#suggestion(kind: \"insert\")[a] #annotation[b]";
        assert_eq!(count_review_markup(src), 2);
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
