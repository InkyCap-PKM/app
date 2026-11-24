//! Where each part of a compiled note came from in its source, so the editor
//! and a "Split with preview" pane can scroll together.
//!
//! Typst records the source span of everything it lays out; this reads those
//! spans from the compiled document. A position is a 1-based line number whose
//! fraction is how far along the line it lies (`3.5` is halfway along line 3),
//! so a long paragraph written on one line still has many positions. Only
//! content from the note itself is reported, not from imported files.

use serde::Serialize;
use typst::layout::{Abs, Frame, FrameItem, Point, Transform};
use typst::syntax::{Source, Span};
use typst_html::{HtmlAttr, HtmlDocument, HtmlElement, HtmlNode, HtmlTag};
use typst_layout::PagedDocument;

use crate::typst_pipeline::diagnostic::diag_span_range;

/// The attribute that carries an HTML block's source position. The frontend
/// reads it in `lib/preview-positions.ts`. Typst limits names known at compile
/// time to 12 characters.
const POSITION_ATTR: HtmlAttr = HtmlAttr::constant("data-src-pos");

/// Two items less than this far apart vertically count as one row.
const SAME_ROW_PT: f64 = 1.0;

/// A source position and where it appears in a paged document.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PagePosition {
    pub position: f64,
    /// 0-based page index.
    pub page: usize,
    /// Distance from the top of the page, in Typst points.
    pub y_pt: f64,
}

/// The note's line number for a position in the compiled source, which has
/// `inserted_above` extra lines near its top.
pub fn without_inserted_lines(position: f64, inserted_above: usize) -> f64 {
    (position - inserted_above as f64).max(1.0)
}

/// Positions in `document` of the content written in `source`, one per row of
/// text or image, in the order Typst placed them.
pub fn page_positions(document: &PagedDocument, source: &Source) -> Vec<PagePosition> {
    let mut out = Vec::new();
    for (page, content) in document.pages().iter().enumerate() {
        collect_frame(
            &content.frame,
            Transform::identity(),
            page,
            source,
            &mut out,
        );
    }
    out
}

fn collect_frame(
    frame: &Frame,
    transform: Transform,
    page: usize,
    source: &Source,
    out: &mut Vec<PagePosition>,
) {
    for (point, item) in frame.items() {
        let mut push = |offset_up: Abs, span: Span, offset: usize| {
            let top = Point::new(point.x, point.y - offset_up).transform(transform);
            let y_pt = top.y.to_pt();
            let same_row = out
                .last()
                .is_some_and(|p| p.page == page && (p.y_pt - y_pt).abs() < SAME_ROW_PT);
            if same_row {
                return;
            }
            if let Some(position) = position_in(source, span, offset) {
                out.push(PagePosition {
                    position,
                    page,
                    y_pt,
                });
            }
        };
        match item {
            FrameItem::Group(group) => {
                let inner = transform
                    .pre_concat(Transform::translate(point.x, point.y))
                    .pre_concat(group.transform);
                collect_frame(&group.frame, inner, page, source, out);
            }
            FrameItem::Text(text) => {
                if let Some(glyph) = text.glyphs.first() {
                    // A text item sits on its baseline; its top is about one
                    // font size higher.
                    push(text.size, glyph.span.0, usize::from(glyph.span.1));
                }
            }
            FrameItem::Image(_, _, span) => push(Abs::zero(), *span, 0),
            FrameItem::Shape(..) | FrameItem::Link(..) | FrameItem::Tag(_) => {}
        }
    }
}

/// Write the source position of each block element of `document` into its
/// `data-src-pos` attribute. `inserted_above` as in
/// [`without_inserted_lines`].
pub fn mark_html_positions(document: &mut HtmlDocument, source: &Source, inserted_above: usize) {
    mark_element(document.root_mut(), source, inserted_above);
}

/// Mark `element`'s blocks and return the position of the first content found
/// in it.
fn mark_element(element: &mut HtmlElement, source: &Source, inserted_above: usize) -> Option<f64> {
    let mut first = position_in(source, element.span, 0);
    for child in element.children.make_mut() {
        let found = match child {
            HtmlNode::Element(inner) => mark_element(inner, source, inserted_above),
            HtmlNode::Text(_, span) => position_in(source, *span, 0),
            HtmlNode::Frame(frame) => position_in(source, frame.span, 0),
            HtmlNode::Tag(_) => None,
        };
        first = first.or(found);
    }
    if let Some(position) = first {
        if is_block(element.tag) {
            let position = without_inserted_lines(position, inserted_above);
            element.attrs.push(POSITION_ATTR, format!("{position:.3}"));
        }
    }
    first
}

/// Elements that start on their own row. Inline elements share their
/// paragraph's row, so marking them would add nothing.
fn is_block(tag: HtmlTag) -> bool {
    matches!(
        &*tag.resolve(),
        "p" | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "li"
            | "dt"
            | "dd"
            | "pre"
            | "tr"
            | "figure"
            | "figcaption"
            | "blockquote"
            | "div"
            | "hr"
            | "img"
            | "video"
            | "audio"
    )
}

/// The position `offset` bytes into `span`, when it lies in `source`.
fn position_in(source: &Source, span: Span, offset: usize) -> Option<f64> {
    if span.id()? != source.id() {
        return None;
    }
    let range = diag_span_range(span.into(), source)?;
    let byte = (range.start + offset).min(range.end);
    let lines = source.lines();
    let line = lines.byte_to_line(byte)?;
    let line_range = lines.line_to_range(line)?;
    let along = if line_range.is_empty() {
        0.0
    } else {
        (byte - line_range.start) as f64 / line_range.len() as f64
    };
    Some((line + 1) as f64 + along)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::path::canonicalize_root;
    use crate::typst_pipeline::compiler::TypstCompiler;

    /// A compiler for an empty notebox, and the path of a note in it.
    fn notebox() -> (tempfile::TempDir, TypstCompiler, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = canonicalize_root(dir.path()).expect("canonicalize tempdir");
        crate::notebox_package::scaffold(&root);
        let note = root.join("note.typ");
        (dir, TypstCompiler::new(root), note)
    }

    fn html(compiler: &mut TypstCompiler, note: &std::path::Path, source: &str) -> String {
        let result = compiler
            .compile_html_with_positions(note, source.to_string(), 0)
            .expect("html compile");
        assert!(result.ok, "{:?}", result.diagnostics);
        result.html
    }

    #[test]
    fn paged_positions_follow_the_source_lines() {
        let (_dir, mut compiler, note) = notebox();
        let source = "= Title\n\nFirst é.\n\n#pagebreak()\nSecond.\n";
        let result = compiler.compile_svg(&note, source.to_string()).unwrap();
        assert!(result.ok, "{:?}", result.diagnostics);
        let rows: Vec<(usize, usize)> = result
            .positions
            .iter()
            .map(|p| (p.position as usize, p.page))
            .collect();
        assert_eq!(rows, vec![(1, 0), (3, 0), (6, 1)]);
        assert!(result.positions[0].y_pt < result.positions[1].y_pt);
    }

    #[test]
    fn a_wrapped_paragraph_has_a_position_for_each_row() {
        let (_dir, mut compiler, note) = notebox();
        let source = format!("Intro.\n\n{}\n", "words and more words ".repeat(60));
        let result = compiler.compile_svg(&note, source).unwrap();
        let in_paragraph: Vec<f64> = result
            .positions
            .iter()
            .map(|p| p.position)
            .filter(|p| *p >= 3.0)
            .collect();
        assert!(in_paragraph.len() > 5, "{in_paragraph:?}");
        assert!(in_paragraph.windows(2).all(|w| w[0] < w[1]));
        assert!(in_paragraph.iter().all(|p| *p < 4.0));
    }

    #[test]
    fn html_blocks_carry_their_line() {
        let (_dir, mut compiler, note) = notebox();
        let out = html(
            &mut compiler,
            &note,
            "= Title\n\nText with *bold*.\n\n- one\n- two\n",
        );
        assert!(out.contains("<h2 data-src-pos=\"1.000\">"), "{out}");
        assert!(out.contains("<p data-src-pos=\"3.000\">"), "{out}");
        assert!(out.contains("<li data-src-pos=\"5."), "{out}");
        assert!(out.contains("<li data-src-pos=\"6."), "{out}");
        assert!(!out.contains("<strong data-"), "{out}");
    }

    #[test]
    fn content_made_by_the_package_takes_the_position_of_its_body() {
        let (_dir, mut compiler, note) = notebox();
        let source = format!(
            "{}\n\n#callout(\"note\")[\n  Body text.\n]\n",
            crate::notebox_package::import_line()
        );
        let out = html(&mut compiler, &note, &source);
        assert!(out.contains("data-src-pos=\"4."), "{out}");
    }

    #[test]
    fn inserted_lines_are_not_counted() {
        assert_eq!(without_inserted_lines(7.25, 3), 4.25);
        assert_eq!(without_inserted_lines(2.0, 3), 1.0);
    }

    #[test]
    fn exported_html_has_no_position_attributes() {
        let (_dir, mut compiler, note) = notebox();
        let result = compiler
            .compile_html(&note, "= Title\n".to_string())
            .unwrap();
        assert!(!result.html.contains("data-src-pos"));
    }
}
