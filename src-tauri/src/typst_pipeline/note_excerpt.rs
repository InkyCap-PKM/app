//! A shortened copy of a note's source holding only the passages around its
//! links to one other note, for the Journal Scroll's Neighbourhood view.
//!
//! The excerpt is still the note's own Typst, compiled in the note's place:
//! it keeps the preamble (`#import`, `#note(...)`) and every top-level
//! `#let`, `#set`, `#show` and `#import` in the body, so the kept text renders
//! with the definitions and styles it relies on. Each passage keeps one unit
//! of writing before and after it (see
//! [`crate::typst_pipeline::link_passages`]). Text left out is replaced by its
//! line breaks, so compile messages still point at the right lines of the
//! note, and a gap of a paragraph or more between kept parts shows as `[…]`.

use std::ops::Range;

use crate::typst_pipeline::link_passages::{body_start, inbound_spans, lead_span};
use crate::typst_pipeline::syntax::{parse, LinkedNode, SyntaxKind};

/// Marker standing in for left-out text between two kept parts.
const GAP_MARKER: &str = "\\[…\\]";

/// The excerpt of `source` around its links to the note whose wikilink stem
/// is `target_stem`, or around its opening passage when it has none (the
/// target links to it, or it links only from its properties). `None` when
/// the excerpt would leave nothing out.
pub fn excerpt_source(source: &str, target_stem: &str) -> Option<String> {
    let mut spans = inbound_spans(source, target_stem);
    if spans.is_empty() {
        spans.extend(lead_span(source));
    }
    let body_start = body_start(source);
    let mut keep: Vec<Range<usize>> = Vec::new();
    keep.push(0..body_start);
    keep.extend(spans.iter().map(|s| s.with_context()));
    keep.extend(statement_ranges(source, body_start));
    let keep = merge(keep);

    let mut gaps = Vec::new();
    let mut pos = 0;
    for r in &keep {
        if r.start > pos {
            gaps.push(pos..r.start);
        }
        pos = r.end;
    }
    if pos < source.len() {
        gaps.push(pos..source.len());
    }
    if gaps.iter().all(|g| source[g.clone()].trim().is_empty()) {
        return None;
    }

    let mut out = String::with_capacity(source.len());
    let mut pos = 0;
    for r in &keep {
        if r.start > pos {
            push_gap(&mut out, &source[pos..r.start], true);
        }
        out.push_str(&source[r.clone()]);
        pos = r.end;
    }
    if pos < source.len() {
        // The Journal Scroll's "Show more" strip marks the end instead.
        push_gap(&mut out, &source[pos..], false);
    }
    Some(out)
}

/// Write left-out text as its line breaks only. Between kept parts, the
/// text itself (inside its surrounding blank space) becomes the gap marker.
fn push_gap(out: &mut String, gap: &str, marked: bool) {
    let content = gap.trim();
    if content.is_empty() {
        out.push_str(gap);
        return;
    }
    // `trim` cuts whole whitespace characters, so these offsets fall on
    // character boundaries.
    let lead = gap.len() - gap.trim_start().len();
    let trail_start = lead + content.len();
    out.push_str(&gap[..lead]);
    if marked {
        out.push_str(GAP_MARKER);
    }
    out.push_str(&"\n".repeat(content.matches('\n').count()));
    out.push_str(&gap[trail_start..]);
}

/// Byte ranges of the top-level `#let`, `#set`, `#show` and `#import`
/// statements in the body, each including its `#`.
fn statement_ranges(source: &str, body_start: usize) -> Vec<Range<usize>> {
    let root = parse(source);
    let markup = LinkedNode::new(&root);
    let children: Vec<LinkedNode<'_>> = markup.children().collect();
    let mut out = Vec::new();
    for pair in children.windows(2) {
        let (hash, stmt) = (&pair[0], &pair[1]);
        let is_statement = matches!(
            stmt.kind(),
            SyntaxKind::LetBinding
                | SyntaxKind::SetRule
                | SyntaxKind::ShowRule
                | SyntaxKind::ModuleImport
        );
        if hash.kind() == SyntaxKind::Hash && is_statement && hash.range().start >= body_start {
            out.push(hash.range().start..stmt.range().end);
        }
    }
    out
}

/// `ranges` sorted, with overlapping and touching ones joined.
fn merge(mut ranges: Vec<Range<usize>>) -> Vec<Range<usize>> {
    ranges.sort_by_key(|r| r.start);
    let mut out: Vec<Range<usize>> = Vec::new();
    for r in ranges {
        match out.last_mut() {
            Some(last) if r.start <= last.end => last.end = last.end.max(r.end),
            _ => out.push(r),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const PREAMBLE: &str = "#import \"/.inkycap/packages/inkycap-notebox/0.1.0/lib.typ\": *\n#note(\n  title: \"Source\",\n)\n";

    fn note(body: &str) -> String {
        format!("{PREAMBLE}\n{body}")
    }

    #[test]
    fn keeps_the_passage_and_one_paragraph_either_side() {
        let src = note("One.\n\nTwo.\n\nThree #wikilink(\"T\") — dash.\n\nFour.\n\nFive.");
        let out = excerpt_source(&src, "T").unwrap();
        assert!(out.starts_with(PREAMBLE));
        assert!(!out.contains("One."));
        assert!(out.contains("Two.\n\nThree #wikilink(\"T\") — dash.\n\nFour."));
        assert!(!out.contains("Five."));
        assert!(out.contains(GAP_MARKER));
    }

    #[test]
    fn line_numbers_are_kept() {
        let src = note("One.\n\nTwo.\n\nThree #wikilink(\"T\").\n\nFour.\n\nFive.\n\nSix.");
        let out = excerpt_source(&src, "T").unwrap();
        assert_eq!(out.matches('\n').count(), src.matches('\n').count());
        let line_of = |s: &str, needle: &str| s.lines().position(|l| l.contains(needle));
        assert_eq!(line_of(&out, "Three"), line_of(&src, "Three"));
    }

    #[test]
    fn keeps_body_definitions_and_rules() {
        let src = note(
            "#let who = [Athena]\n\nSkipped one.\n\nSkipped two.\n\nSkipped three.\n\nBy #who, see #wikilink(\"T\").",
        );
        let out = excerpt_source(&src, "T").unwrap();
        assert!(out.contains("#let who = [Athena]"));
        assert!(out.contains("By #who"));
        assert!(!out.contains("Skipped one."));
    }

    #[test]
    fn note_without_a_link_keeps_its_opening() {
        let src = note("Opening.\n\nNext.\n\nLater.\n\nMuch later.");
        let out = excerpt_source(&src, "T").unwrap();
        assert!(out.contains("Opening.\n\nNext."));
        assert!(!out.contains("Later."));
    }

    #[test]
    fn short_note_needs_no_excerpt() {
        let src = note("Before.\n\nLinks #wikilink(\"T\").\n\nAfter.");
        assert_eq!(excerpt_source(&src, "T"), None);
    }
}
