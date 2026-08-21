//! Where a note's headings and fenced raw blocks are, according to Typst's
//! own parser.
//!
//! Every line-oriented caller in the backend used to answer these questions
//! with a regex over `content.lines()`, and each got the same thing wrong: a
//! line reading `= Not a headliner` is a heading only where Typst says it is,
//! and inside a ``` fence Typst says it is raw text (issue #21). The damage
//! ranged from cosmetic to destructive — a false entry in heading
//! autocomplete, a spurious PDF/UA accessibility warning, and, in merged book
//! export, `normalize_heading_levels` *rewriting* the `=` markers of a code
//! sample the author never meant as a heading.
//!
//! Per CLAUDE.md's Typst-first principle the fix is not a better regex but
//! [`typst::syntax::parse`] — the parser the compiler runs — reached through
//! [`crate::typst_pipeline::syntax`]. It already knows where markup stops and
//! raw text starts, and it keeps knowing as Typst evolves.
//!
//! The frontend answers the same question for the editor's outline and heading
//! fold in `src/editor/typst-decorations/heading-scan.ts`, against the same
//! parser compiled to WebAssembly.

use std::collections::HashSet;
use std::ops::Range;

use crate::typst_pipeline::syntax::{ast, parse, LinkedNode, SyntaxKind};

/// One heading, as the parser sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceHeading {
    /// Nesting depth — the number of `=` markers, saturating at `u8::MAX`.
    /// Not clamped to 6: Typst doesn't cap heading depth, so callers that
    /// need a ceiling (a UI indent, say) impose their own.
    pub level: u8,
    /// The heading's source text with the markers stripped, trimmed. Still
    /// Typst markup — `= Hello *world*` yields `Hello *world*`.
    pub text: String,
    /// The `<label>` that follows the heading on the same line, without its
    /// angle brackets.
    pub label: Option<String>,
    /// 1-based line the heading starts on.
    pub line: usize,
    /// Byte range of the heading itself: the markers through the end of its
    /// content, stopping before any trailing whitespace and `<label>`.
    pub range: Range<usize>,
}

/// Every heading in `source`, in document order.
pub fn headings(source: &str) -> Vec<SourceHeading> {
    let root = parse(source);
    let mut out = Vec::new();
    collect_headings(&LinkedNode::new(&root), source, &mut out);
    let mut lines = LineCounter::new(source);
    for heading in &mut out {
        heading.line = lines.line_at(heading.range.start);
    }
    out
}

/// 1-based line numbers covered by a fenced raw block (```` ``` ````), from
/// its opening delimiter's line through its closing delimiter's line.
///
/// Inline raw spans (`` `like this` ``) are deliberately absent: they share a
/// line with ordinary prose, so a caller that skipped the whole line would
/// skip the prose too.
///
/// A fence the author hasn't closed yet is included as well. Typst reports it
/// as one error region running to the end of the file, and for the rewriters
/// that consume this — Markdown export, the `.typ` audit — leaving that region
/// alone is the whole point: it is half-written code, not markup to translate.
pub fn raw_block_lines(source: &str) -> HashSet<usize> {
    let root = parse(source);
    let mut ranges = Vec::new();
    collect_raw_blocks(&LinkedNode::new(&root), source, &mut ranges);

    let mut out = HashSet::new();
    let mut lines = LineCounter::new(source);
    for range in ranges {
        let first = lines.line_at(range.start);
        // Measure to the last byte *inside* the block: an unterminated fence
        // runs to the end of the file, and counting its final line break would
        // claim the empty line past it.
        let last = lines.line_at(range.end.saturating_sub(1).max(range.start));
        out.extend(first..=last);
    }
    out
}

fn collect_headings(node: &LinkedNode<'_>, source: &str, out: &mut Vec<SourceHeading>) {
    if node.kind() == SyntaxKind::Heading {
        if let Some(heading) = build_heading(node, source) {
            out.push(heading);
        }
        // A heading's own children hold its inline markup, never another
        // heading worth reporting on its own.
        return;
    }
    for child in node.children() {
        collect_headings(&child, source, out);
    }
}

fn build_heading(node: &LinkedNode<'_>, source: &str) -> Option<SourceHeading> {
    let range = node.range();
    let raw = source.get(range.clone())?;
    // The markers are ASCII `=`, so trimming them by byte position lands on a
    // char boundary even when the title itself is not ASCII.
    let markers = raw.bytes().take_while(|&b| b == b'=').count();
    if markers == 0 {
        return None;
    }
    let level = node
        .cast::<ast::Heading>()
        .map(|h| h.depth().get())
        .unwrap_or(markers)
        .min(u8::MAX as usize) as u8;

    Some(SourceHeading {
        level,
        text: raw[markers..].trim().to_string(),
        label: trailing_label(node, source),
        line: 0, // filled in by `headings`, which walks the line breaks once
        range,
    })
}

/// The `<label>` attached to this heading, if one follows it on the same line.
///
/// Typst parses the label as the heading's *sibling*, not its child, so a
/// label two lines further down would also turn up here — hence the same-line
/// check.
fn trailing_label(node: &LinkedNode<'_>, source: &str) -> Option<String> {
    let next = node.next_sibling()?;
    if next.kind() != SyntaxKind::Label {
        return None;
    }
    let between = source.get(node.range().end..next.range().start)?;
    if between.contains('\n') {
        return None;
    }
    let text = source.get(next.range())?;
    Some(
        text.trim_start_matches('<')
            .trim_end_matches('>')
            .to_string(),
    )
}

fn collect_raw_blocks(node: &LinkedNode<'_>, source: &str, out: &mut Vec<Range<usize>>) {
    match node.kind() {
        SyntaxKind::Raw => {
            if node.cast::<ast::Raw>().is_some_and(|raw| raw.block()) {
                out.push(node.range());
            }
            return;
        }
        // An unterminated fence never becomes a `Raw` node — the parser gives
        // up and marks the rest of the file as one error. Recognize it by the
        // backticks it opens with.
        SyntaxKind::Error => {
            let range = node.range();
            if source
                .get(range.clone())
                .is_some_and(|text| text.trim_start().starts_with("```"))
            {
                out.push(range);
            }
            return;
        }
        _ => {}
    }
    for child in node.children() {
        collect_raw_blocks(&child, source, out);
    }
}

/// Turns byte offsets into 1-based line numbers for a forward-moving sequence
/// of lookups, counting each line break exactly once.
struct LineCounter<'a> {
    source: &'a str,
    scanned: usize,
    line: usize,
}

impl<'a> LineCounter<'a> {
    fn new(source: &'a str) -> Self {
        Self {
            source,
            scanned: 0,
            line: 1,
        }
    }

    /// Line containing `byte`. Offsets must arrive in non-decreasing order —
    /// AST walks produce them that way.
    fn line_at(&mut self, byte: usize) -> usize {
        let byte = byte.min(self.source.len());
        if byte < self.scanned {
            debug_assert!(false, "LineCounter went backwards");
            return self.line;
        }
        self.line += self.source[self.scanned..byte].matches('\n').count();
        self.scanned = byte;
        self.line
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reproduction from issue #21: a fence nested in a list, holding a
    /// line that looks exactly like a top-level heading.
    const ISSUE_21: &str = "= Headline\n\
                            - Bullet point A\n\
                            \x20 - B\n\
                            \x20   - B.1\n\
                            \x20   - ```\n\
                            = Not a headliner\n\
                            baz\n\
                            ```\n\
                            \x20 - C\n";

    fn summarize(source: &str) -> Vec<(u8, String, usize)> {
        headings(source)
            .into_iter()
            .map(|h| (h.level, h.text, h.line))
            .collect()
    }

    #[test]
    fn finds_headings_with_level_text_and_line() {
        assert_eq!(
            summarize("= One\n\ntext\n\n== Two\n"),
            vec![(1, "One".into(), 1), (2, "Two".into(), 5)]
        );
    }

    #[test]
    fn ignores_heading_syntax_inside_a_fence() {
        assert_eq!(summarize(ISSUE_21), vec![(1, "Headline".into(), 1)]);
    }

    #[test]
    fn ignores_heading_syntax_in_inline_raw_comments_math_and_strings() {
        for source in [
            "Write `= Heading` to open a section.\n",
            "/*\n= Commented out\n*/\n",
            "// = Also not one\n",
            "$ a\n= b\nc $\n",
            "#let s = \"\n= Not a heading\n\"\n",
        ] {
            assert_eq!(summarize(source), vec![], "{source:?}");
        }
    }

    #[test]
    fn keeps_markup_in_the_heading_text() {
        assert_eq!(
            summarize("= Hello *world*\n"),
            vec![(1, "Hello *world*".into(), 1)]
        );
    }

    #[test]
    fn reads_a_trailing_label_but_not_one_on_the_next_line() {
        let with_label = headings("= Intro <intro>\n");
        assert_eq!(with_label[0].label.as_deref(), Some("intro"));
        assert_eq!(with_label[0].text, "Intro");

        let separate = headings("= Intro\n\n<elsewhere>\n");
        assert_eq!(separate[0].label, None);
    }

    #[test]
    fn range_covers_the_markers_and_content_only() {
        let source = "intro\n\n== Section <sec>\n";
        let heading = &headings(source)[0];
        assert_eq!(&source[heading.range.clone()], "== Section");
        assert_eq!(heading.line, 3);
    }

    #[test]
    fn finds_an_indented_heading_and_uncapped_depth() {
        assert_eq!(
            summarize("- item\n\n  = Indented\n"),
            vec![(1, "Indented".into(), 3)]
        );
        assert_eq!(summarize("======= Seven\n"), vec![(7, "Seven".into(), 1)]);
    }

    #[test]
    fn counts_lines_for_multibyte_content() {
        // Byte offsets and line numbers diverge the moment a title isn't
        // ASCII; the counter works in bytes and must still land on line 3.
        let source = "= Überschrift — mit Bindestrich\n\n== 日本語の見出し\n";
        assert_eq!(
            summarize(source),
            vec![
                (1, "Überschrift — mit Bindestrich".into(), 1),
                (2, "日本語の見出し".into(), 3),
            ]
        );
    }

    #[test]
    fn empty_source_has_no_headings() {
        assert_eq!(summarize(""), vec![]);
        assert_eq!(summarize("just prose\n"), vec![]);
    }

    #[test]
    fn raw_block_lines_cover_a_fence_including_its_delimiters() {
        let source = "= H\n```typ\n= Nope\n```\nafter\n";
        let mut lines: Vec<usize> = raw_block_lines(source).into_iter().collect();
        lines.sort_unstable();
        assert_eq!(lines, vec![2, 3, 4]);
    }

    #[test]
    fn raw_block_lines_find_a_fence_indented_inside_a_list() {
        // The shape a line-based `starts_with("```")` check misses, because
        // the line begins with the list marker.
        let mut lines: Vec<usize> = raw_block_lines(ISSUE_21).into_iter().collect();
        lines.sort_unstable();
        assert_eq!(lines, vec![5, 6, 7, 8]);
    }

    #[test]
    fn raw_block_lines_ignore_inline_spans() {
        assert!(raw_block_lines("a `= x` b\n").is_empty());
        assert!(raw_block_lines("no code here\n").is_empty());
    }

    #[test]
    fn raw_block_lines_cover_an_unterminated_fence_to_the_end() {
        let source = "= H\n```\n= Nope\nstill raw\n";
        let mut lines: Vec<usize> = raw_block_lines(source).into_iter().collect();
        lines.sort_unstable();
        assert_eq!(lines, vec![2, 3, 4]);
        assert_eq!(summarize(source), vec![(1, "H".into(), 1)]);
    }
}
