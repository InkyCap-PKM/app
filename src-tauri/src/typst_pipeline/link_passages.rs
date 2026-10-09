//! The passage of note text around a wikilink, found with Typst's own parser.
//!
//! A *passage* is the unit of writing a link sits in: the paragraph that holds
//! it, or the list item, or (when the link is inside a heading) the heading
//! plus the paragraph after it. For more context, each passage also carries
//! the unit of writing just before and just after it, when there is one.
//!
//! The Links pane shows inbound passages, and Compose mode copies them into a
//! new note, so each passage carries both its Typst source (for copying) and a
//! plain-text rendering (for display) in which the links are marked for
//! highlighting. A passage also carries a *snippet*: a few sentences around
//! the link, which the Links pane shows until the user asks for more context.
//!
//! Paragraph boundaries come from the syntax tree (`Parbreak`, `Heading`,
//! list items), not from scanning lines, so a `= ` inside a code block or a
//! blank line inside a string never splits a passage.

use std::ops::Range;

use icu_segmenter::options::SentenceBreakInvariantOptions;
use icu_segmenter::SentenceSegmenter;

use crate::link_index::link_note_name;
use crate::text_offsets::byte_to_utf16;
use crate::typst_pipeline::plaintext::{
    extract_marked_text, extract_plain_text, MarkNode, MarkedText,
};
use crate::typst_pipeline::query::first_string_positional_arg;
use crate::typst_pipeline::source_structure::{headings, SourceHeading};
use crate::typst_pipeline::syntax::{ast, parse, LinkedNode, SyntaxKind};

/// Longest plain-text rendering kept for display, in characters. The Typst
/// source is never shortened, so copying a passage always copies all of it.
const MAX_DISPLAY_CHARS: usize = 1500;

/// Most characters a snippet keeps on each side of the link, counted in plain
/// text so markup never uses up the allowance. A sentence next to the one
/// holding the link is included only when it fits whole.
const SNIPPET_CONTEXT_CHARS: usize = 100;

/// Plain prose for display, with the stretches to highlight.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DisplayText {
    pub text: String,
    /// `(start, end)` ranges of `text` to highlight, in UTF-16 code units so
    /// the webview can slice its strings with them directly.
    pub marks: Vec<(usize, usize)>,
}

/// One stretch of note text, in two forms.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PassageText {
    /// The Typst source of the stretch, trimmed of surrounding blank space.
    pub source: String,
    /// Plain prose for display, shortened to [`MAX_DISPLAY_CHARS`] with an
    /// ellipsis when longer. Links to the target note are marked.
    #[serde(flatten)]
    pub display: DisplayText,
}

/// The text around one link.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LinkPassage {
    /// Plain text of the heading the passage sits under, if any.
    pub heading: Option<String>,
    /// The paragraph, list item, or heading-plus-paragraph holding the link.
    pub paragraph: PassageText,
    /// The sentence holding the link with up to one sentence either side,
    /// taken from the link's own line: a list item's sub-items are left out.
    pub snippet: DisplayText,
    /// The unit of writing just before the paragraph, for context. `None` at
    /// the start of the body or of the block holding the link.
    pub before: Option<PassageText>,
    /// The unit of writing just after the paragraph, for context.
    pub after: Option<PassageText>,
}

/// Every passage in `source` that links to the note whose wikilink stem is
/// `target_stem`, in document order. Several links to the same note inside
/// one paragraph give one passage.
///
/// Links made through `link-ref(...)` property values have no passage, so a
/// note that links only from its properties yields an empty list.
pub fn inbound_passages(source: &str, target_stem: &str) -> Vec<LinkPassage> {
    let all_headings = headings(source);
    let target = target_stem.to_lowercase();
    let is_link = |n: &LinkedNode<'_>| is_wikilink_to(n, &target);
    inbound_spans(source, target_stem)
        .into_iter()
        .filter_map(|span| span_passage(source, &all_headings, span, &is_link))
        .collect()
}

/// The first unit of writing in `source`'s body, standing in for a note that
/// is linked *to* rather than linking: its opening paragraph or list item, or
/// its first heading plus the paragraph after it. `None` for an empty body.
/// Carries no `before` (nothing comes before it) but does carry `after`.
pub fn lead_passage(source: &str) -> Option<LinkPassage> {
    span_passage(source, &headings(source), lead_span(source)?, &|_| false)
}

/// Where a passage and the units of writing around it sit in the source, as
/// byte ranges.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PassageSpan {
    pub unit: Range<usize>,
    /// The part of `unit` the snippet is taken from: a list item without
    /// its sub-items, otherwise the whole unit.
    pub own: Range<usize>,
    pub before: Option<Range<usize>>,
    pub after: Option<Range<usize>>,
}

impl PassageSpan {
    /// The passage together with its neighbours.
    pub fn with_context(&self) -> Range<usize> {
        let start = self.before.as_ref().map_or(self.unit.start, |r| r.start);
        let end = self.after.as_ref().map_or(self.unit.end, |r| r.end);
        start..end
    }
}

/// The spans behind [`inbound_passages`], in document order, one per unit
/// of writing that links to `target_stem`.
pub(crate) fn inbound_spans(source: &str, target_stem: &str) -> Vec<PassageSpan> {
    let root = parse(source);
    let body_start = body_start(source);
    let target = target_stem.to_lowercase();
    let mut calls = Vec::new();
    collect_wikilinks(&LinkedNode::new(&root), &mut calls);

    let mut out: Vec<PassageSpan> = Vec::new();
    for call in calls {
        if !is_wikilink_to(&call, &target) {
            continue;
        }
        let (unit, own, markup) = unit_around(&call);
        let Some(unit) = clip(unit, body_start) else {
            continue;
        };
        let own = clip(own, body_start).unwrap_or_else(|| unit.clone());
        if out.iter().any(|s| s.unit == unit) {
            continue;
        }
        let (before, after) = match &markup {
            Some(m) => neighbours(m, &unit, body_start),
            None => (None, None),
        };
        out.push(PassageSpan {
            unit,
            own,
            before,
            after,
        });
    }
    out
}

/// The span behind [`lead_passage`].
pub(crate) fn lead_span(source: &str) -> Option<PassageSpan> {
    let root = parse(source);
    let body_start = body_start(source);
    let markup = LinkedNode::new(&root);
    let first = markup.children().find(|c| {
        c.range().end > body_start && !matches!(c.kind(), SyntaxKind::Space | SyntaxKind::Parbreak)
    })?;
    let (unit, own) = match first.kind() {
        k if is_item(k) => (first.range(), item_own_range(&first)),
        SyntaxKind::Heading => {
            let unit = heading_and_next(&first);
            (unit.clone(), unit)
        }
        _ => {
            let unit = paragraph_run(&markup, &first);
            (unit.clone(), unit)
        }
    };
    let unit = clip(unit, body_start)?;
    let own = clip(own, body_start).unwrap_or_else(|| unit.clone());
    let (_, after) = neighbours(&markup, &unit, body_start);
    Some(PassageSpan {
        unit,
        own,
        before: None,
        after,
    })
}

/// The passage a span marks out, or `None` when its unit is blank. The text
/// of nodes `is_link` accepts is marked for highlighting.
fn span_passage(
    source: &str,
    all_headings: &[SourceHeading],
    span: PassageSpan,
    is_link: MarkNode<'_>,
) -> Option<LinkPassage> {
    let paragraph = passage_text(source, span.unit.clone(), is_link)?;
    let own = source
        .get(span.own)
        .map(|own| snippet(&extract_marked_text(own, is_link)))
        .filter(|s| !s.text.trim().is_empty());
    Some(LinkPassage {
        heading: heading_above(all_headings, span.unit.start).map(heading_plain_text),
        snippet: own.map_or_else(|| paragraph.display.clone(), |s| display_text(&s)),
        paragraph,
        before: span.before.and_then(|r| passage_text(source, r, is_link)),
        after: span.after.and_then(|r| passage_text(source, r, is_link)),
    })
}

/// True when `node` is a `wikilink(...)` call to the note named `target`,
/// which must be lowercase. Ignores case and any `::heading` suffix.
fn is_wikilink_to(node: &LinkedNode<'_>, target: &str) -> bool {
    let is_wikilink = node.cast::<ast::FuncCall>().is_some_and(
        |call| matches!(call.callee(), ast::Expr::Ident(i) if i.as_str() == "wikilink"),
    );
    is_wikilink
        && first_string_positional_arg(node)
            .as_deref()
            .and_then(link_note_name)
            .is_some_and(|name| name.to_lowercase() == target)
}

/// The lowercase note names `source`'s wikilinks point at, in document order
/// and without repeats.
pub fn wikilink_names(source: &str) -> Vec<String> {
    let root = parse(source);
    let mut calls = Vec::new();
    collect_wikilinks(&LinkedNode::new(&root), &mut calls);
    let mut out: Vec<String> = Vec::new();
    for call in calls {
        let Some(target) = first_string_positional_arg(&call) else {
            continue;
        };
        if let Some(name) = link_note_name(&target).map(str::to_lowercase) {
            if !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out
}

/// Byte offset where the note's body starts, after the `#import` lines and
/// the `#note(...)` call.
pub(crate) fn body_start(source: &str) -> usize {
    // `strip_note_preamble` returns a tail slice of `source`, so the length
    // difference is a byte offset on a character boundary.
    source.len() - crate::notebox_package::strip_note_preamble(source).len()
}

/// Every `wikilink(...)` call in the tree, in document order.
fn collect_wikilinks<'a>(node: &LinkedNode<'a>, out: &mut Vec<LinkedNode<'a>>) {
    if node.kind() == SyntaxKind::FuncCall {
        if let Some(call) = node.cast::<ast::FuncCall>() {
            if let ast::Expr::Ident(ident) = call.callee() {
                if ident.as_str() == "wikilink" {
                    out.push(node.clone());
                }
            }
        }
    }
    for child in node.children() {
        collect_wikilinks(&child, out);
    }
}

/// Kinds that stand on their own as a unit of writing.
fn is_item(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::ListItem | SyntaxKind::EnumItem | SyntaxKind::TermItem
    )
}

/// Kinds that end a paragraph when they appear in a run of markup.
fn breaks_paragraph(kind: SyntaxKind) -> bool {
    kind == SyntaxKind::Parbreak || kind == SyntaxKind::Heading || is_item(kind)
}

/// The unit of writing holding `node`: climb to the nearest list item,
/// heading, or run of markup and take the paragraph there. Also returns the
/// unit's own text (see [`PassageSpan::own`]) and the markup the unit is a
/// part of, where its neighbours are.
fn unit_around<'a>(node: &LinkedNode<'a>) -> (Range<usize>, Range<usize>, Option<LinkedNode<'a>>) {
    let mut child = node.clone();
    while let Some(parent) = child.parent().cloned() {
        match parent.kind() {
            k if is_item(k) => {
                return (
                    parent.range(),
                    item_own_range(&parent),
                    parent.parent().cloned(),
                )
            }
            SyntaxKind::Heading => {
                let unit = heading_and_next(&parent);
                return (unit.clone(), unit, parent.parent().cloned());
            }
            // Markup that is the body of a list item or heading belongs to
            // that item; keep climbing so the arms above take it.
            SyntaxKind::Markup
                if !parent
                    .parent_kind()
                    .is_some_and(|k| is_item(k) || k == SyntaxKind::Heading) =>
            {
                let unit = paragraph_run(&parent, &child);
                return (unit.clone(), unit, Some(parent));
            }
            _ => child = parent,
        }
    }
    (node.range(), node.range(), None)
}

/// A list item without the items nested under it.
fn item_own_range(item: &LinkedNode<'_>) -> Range<usize> {
    let Some(body) = item.children().find(|c| c.kind() == SyntaxKind::Markup) else {
        return item.range();
    };
    let end = body
        .children()
        .take_while(|c| !is_item(c.kind()))
        .filter(|c| !matches!(c.kind(), SyntaxKind::Space | SyntaxKind::Parbreak))
        .last()
        .map_or(body.range().start, |c| c.range().end);
    item.range().start..end
}

/// Every unit of writing directly inside `markup`, in order: each list item
/// and heading on its own, and each run of other content between them and
/// paragraph breaks.
fn units_of(markup: &LinkedNode<'_>) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut run: Option<Range<usize>> = None;
    for child in markup.children() {
        let kind = child.kind();
        if breaks_paragraph(kind) {
            out.extend(run.take());
            if kind != SyntaxKind::Parbreak {
                out.push(child.range());
            }
        } else if kind == SyntaxKind::Space && run.is_none() {
            continue;
        } else {
            let r = child.range();
            run = Some(run.map_or(r.clone(), |prev| prev.start..r.end));
        }
    }
    out.extend(run);
    out
}

/// The units just before and just after `unit` inside `markup`, leaving out
/// anything before the body.
fn neighbours(
    markup: &LinkedNode<'_>,
    unit: &Range<usize>,
    body_start: usize,
) -> (Option<Range<usize>>, Option<Range<usize>>) {
    let units: Vec<Range<usize>> = units_of(markup)
        .into_iter()
        .filter_map(|r| clip(r, body_start))
        .collect();
    let first = units.iter().position(|r| r.end > unit.start);
    let last = units.iter().rposition(|r| r.start < unit.end);
    let before = first
        .and_then(|i| i.checked_sub(1))
        .map(|i| units[i].clone());
    let after = last.and_then(|i| units.get(i + 1)).cloned();
    (before, after)
}

/// The stretch of `markup`'s children around `child`, bounded by paragraph
/// breaks, headings, and list items.
fn paragraph_run(markup: &LinkedNode<'_>, child: &LinkedNode<'_>) -> Range<usize> {
    let siblings: Vec<LinkedNode<'_>> = markup.children().collect();
    let idx = child.index().min(siblings.len().saturating_sub(1));
    let mut first = idx;
    while first > 0 && !breaks_paragraph(siblings[first - 1].kind()) {
        first -= 1;
    }
    let mut last = idx;
    while last + 1 < siblings.len() && !breaks_paragraph(siblings[last + 1].kind()) {
        last += 1;
    }
    siblings[first].range().start..siblings[last].range().end
}

/// A heading plus the unit right after it: the next paragraph or list item.
/// Just the heading when another heading or nothing follows.
fn heading_and_next(heading: &LinkedNode<'_>) -> Range<usize> {
    let start = heading.range().start;
    let Some(markup) = heading.parent() else {
        return heading.range();
    };
    let next = markup
        .children()
        .skip(heading.index() + 1)
        .find(|c| !matches!(c.kind(), SyntaxKind::Space | SyntaxKind::Parbreak));
    match next {
        Some(n) if n.kind() == SyntaxKind::Heading => heading.range(),
        Some(n) if is_item(n.kind()) => start..n.range().end,
        Some(n) => start..paragraph_run(markup, &n).end,
        None => heading.range(),
    }
}

/// `range` with anything before the body cut off, or `None` if nothing is
/// left. Keeps the `#note(...)` call out of a passage when the first
/// paragraph follows it without a blank line.
fn clip(range: Range<usize>, body_start: usize) -> Option<Range<usize>> {
    let start = range.start.max(body_start);
    (start < range.end).then_some(start..range.end)
}

/// The last heading starting at or before `offset`.
fn heading_above(all: &[SourceHeading], offset: usize) -> Option<&SourceHeading> {
    all.iter().take_while(|h| h.range.start <= offset).last()
}

/// Both forms of `source[range]`, or `None` when the stretch is blank.
fn passage_text(source: &str, range: Range<usize>, is_link: MarkNode<'_>) -> Option<PassageText> {
    // Node and heading ranges come from the parser, so they fall on
    // character boundaries.
    let raw = source.get(range)?.trim();
    if raw.is_empty() {
        return None;
    }
    Some(PassageText {
        source: raw.to_string(),
        display: display_text(&shorten(
            &extract_marked_text(raw, is_link),
            MAX_DISPLAY_CHARS,
        )),
    })
}

/// `text` ready to send to the webview, with its marks in UTF-16 units.
fn display_text(text: &MarkedText) -> DisplayText {
    DisplayText {
        marks: text
            .marks
            .iter()
            .map(|r| {
                (
                    byte_to_utf16(&text.text, r.start),
                    byte_to_utf16(&text.text, r.end),
                )
            })
            .collect(),
        text: text.text.clone(),
    }
}

fn heading_plain_text(h: &SourceHeading) -> String {
    extract_plain_text(&h.text)
}

/// `text` cut to `max` characters with an ellipsis when longer.
fn shorten(text: &MarkedText, max: usize) -> MarkedText {
    match text.text.char_indices().nth(max) {
        Some((cut, _)) => excerpt(text, 0..cut),
        None => text.clone(),
    }
}

/// The short preview of a link's own text: the sentence holding the first
/// mark, with the sentence before and after when each fits whole within
/// [`SNIPPET_CONTEXT_CHARS`] of the mark, and the holding sentence itself cut
/// at a word to that allowance when it runs longer. Without a mark the
/// preview is taken from the start of the text.
fn snippet(text: &MarkedText) -> MarkedText {
    let s = &text.text;
    let anchor = text.marks.first().cloned().unwrap_or(0..0);
    let bounds: Vec<usize> = SentenceSegmenter::new(SentenceBreakInvariantOptions::default())
        .segment_str(s)
        .collect();
    let sentences: Vec<Range<usize>> = bounds.windows(2).map(|w| w[0]..w[1]).collect();
    let Some(first) = sentences.iter().position(|r| r.end > anchor.start) else {
        return text.clone();
    };
    let last = sentences
        .iter()
        .rposition(|r| r.start < anchor.end)
        .map_or(first, |i| i.max(first));

    let mut start = sentences[first].start;
    let mut end = sentences[last].end;
    if let Some(prev) = first.checked_sub(1).map(|i| &sentences[i]) {
        if s[prev.start..anchor.start].chars().count() <= SNIPPET_CONTEXT_CHARS {
            start = prev.start;
        }
    }
    if let Some(next) = sentences.get(last + 1) {
        if s[anchor.end..next.end].chars().count() <= SNIPPET_CONTEXT_CHARS {
            end = next.end;
        }
    }

    // Cut a long sentence holding the link to the allowance, at a word.
    let floor = s[..anchor.start]
        .char_indices()
        .rev()
        .nth(SNIPPET_CONTEXT_CHARS - 1)
        .map_or(0, |(i, _)| i);
    if start < floor {
        start = s[floor..anchor.start]
            .find(char::is_whitespace)
            .map_or(floor, |i| floor + i);
    }
    let ceiling = s[anchor.end..]
        .char_indices()
        .nth(SNIPPET_CONTEXT_CHARS)
        .map_or(s.len(), |(i, _)| anchor.end + i);
    if end > ceiling {
        end = s[anchor.end..ceiling]
            .rfind(char::is_whitespace)
            .map_or(ceiling, |i| anchor.end + i);
    }
    excerpt(text, start..end)
}

/// `text[range]` trimmed of blank space, with an ellipsis on each side where
/// text was left out and the marks moved to match. `range` must fall on
/// character boundaries.
fn excerpt(text: &MarkedText, range: Range<usize>) -> MarkedText {
    let s = &text.text;
    let inner = &s[range.clone()];
    let start = range.start + (inner.len() - inner.trim_start().len());
    let end = range.start + inner.trim_end().len();
    if start >= end {
        return MarkedText::default();
    }
    let lead = if s[..start].trim().is_empty() {
        ""
    } else {
        "\u{2026}"
    };
    let tail = if s[end..].trim().is_empty() {
        ""
    } else {
        "\u{2026}"
    };
    let shift = lead.len();
    let marks = text
        .marks
        .iter()
        .filter_map(|m| {
            let (a, b) = (m.start.max(start), m.end.min(end));
            (a < b).then(|| a - start + shift..b - start + shift)
        })
        .collect();
    MarkedText {
        text: format!("{lead}{}{tail}", &s[start..end]),
        marks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PREAMBLE: &str = "#import \"/.inkycap/packages/inkycap-notebox/0.1.0/lib.typ\": *\n#note(\n  title: \"Source\",\n  tags: (\"a\",),\n)\n";

    fn note(body: &str) -> String {
        format!("{PREAMBLE}\n{body}")
    }

    fn paragraphs(src: &str, target: &str) -> Vec<String> {
        inbound_passages(src, target)
            .into_iter()
            .map(|p| p.paragraph.source)
            .collect()
    }

    #[test]
    fn paragraph_holding_the_link() {
        let src = note(
            "First paragraph.\n\nSecond mentions #wikilink(\"Target\") here\nand wraps a line.\n\nThird.",
        );
        assert_eq!(
            paragraphs(&src, "Target"),
            vec!["Second mentions #wikilink(\"Target\") here\nand wraps a line."]
        );
    }

    #[test]
    fn target_matching_ignores_case_and_heading_suffix() {
        let src = note("See #wikilink(\"target::intro\").");
        assert_eq!(paragraphs(&src, "Target").len(), 1);
        assert!(paragraphs(&src, "Other").is_empty());
    }

    #[test]
    fn two_links_in_one_paragraph_give_one_passage() {
        let src =
            note("A #wikilink(\"T\") and #wikilink(\"T\", label: \"x\").\n\nB #wikilink(\"T\").");
        assert_eq!(
            paragraphs(&src, "T"),
            vec![
                "A #wikilink(\"T\") and #wikilink(\"T\", label: \"x\").",
                "B #wikilink(\"T\").",
            ]
        );
    }

    #[test]
    fn link_in_heading_takes_the_next_paragraph() {
        let src = note("= About #wikilink(\"T\")\nBody text.\n\nLater.");
        let p = &inbound_passages(&src, "T")[0];
        assert_eq!(p.paragraph.source, "= About #wikilink(\"T\")\nBody text.");
        assert_eq!(p.heading.as_deref(), Some("About T"));
    }

    #[test]
    fn link_in_list_item_takes_the_item() {
        let src = note("Intro line\n- one\n- two #wikilink(\"T\")\n- three");
        assert_eq!(paragraphs(&src, "T"), vec!["- two #wikilink(\"T\")"]);
    }

    #[test]
    fn link_inside_content_block_takes_the_inner_paragraph() {
        let src = note("#callout(\"note\")[\n  Inner one.\n\n  Inner #wikilink(\"T\") two.\n]");
        assert_eq!(paragraphs(&src, "T"), vec!["Inner #wikilink(\"T\") two."]);
    }

    #[test]
    fn first_paragraph_after_note_call_excludes_preamble() {
        let src = format!("{PREAMBLE}Straight after #wikilink(\"T\").");
        assert_eq!(
            paragraphs(&src, "T"),
            vec!["Straight after #wikilink(\"T\")."]
        );
    }

    #[test]
    fn lead_passage_is_the_first_body_paragraph() {
        let src = note("Opening — with an em dash\nover two lines.\n\nSecond.");
        let p = lead_passage(&src).unwrap();
        assert_eq!(
            p.paragraph.source,
            "Opening — with an em dash\nover two lines."
        );
        assert_eq!(p.before, None);
        assert_eq!(p.after.unwrap().source, "Second.");
    }

    #[test]
    fn lead_passage_takes_a_leading_heading_with_its_paragraph() {
        let src = note("= Überblick\nErster Absatz.\n\nZweiter.");
        let p = lead_passage(&src).unwrap();
        assert_eq!(p.paragraph.source, "= Überblick\nErster Absatz.");
        assert_eq!(p.heading.as_deref(), Some("Überblick"));
    }

    #[test]
    fn lead_passage_starts_after_the_note_call() {
        let src = format!("{PREAMBLE}- first item\n- second");
        assert_eq!(lead_passage(&src).unwrap().paragraph.source, "- first item");
    }

    #[test]
    fn lead_passage_of_an_empty_body_is_none() {
        assert_eq!(lead_passage(PREAMBLE), None);
    }

    #[test]
    fn property_only_link_has_no_passage() {
        let src = "#import \"/x/lib.typ\": *\n#note(derived-from: (link-ref(\"T\"),))\n\nBody.";
        assert!(inbound_passages(src, "T").is_empty());
    }

    #[test]
    fn multibyte_text_survives() {
        let src = note("Café — «citation» 東京 #wikilink(\"T\") — fin.\n\nNext.");
        let p = &inbound_passages(&src, "T")[0];
        assert_eq!(
            p.paragraph.source,
            "Café — «citation» 東京 #wikilink(\"T\") — fin."
        );
        assert!(p.paragraph.display.text.contains("東京"));
    }

    #[test]
    fn display_text_is_shortened_but_source_is_not() {
        let long = "word ".repeat(600);
        let src = note(&format!("{long}#wikilink(\"T\")"));
        let p = &inbound_passages(&src, "T")[0];
        assert!(p.paragraph.display.text.ends_with('\u{2026}'));
        assert!(p.paragraph.display.text.chars().count() <= MAX_DISPLAY_CHARS + 1);
        assert!(p.paragraph.source.ends_with("#wikilink(\"T\")"));
    }

    #[test]
    fn wikilink_names_listed_once_each() {
        let src = note("#wikilink(\"A\") #wikilink(\"b::x\") #wikilink(\"a\")");
        assert_eq!(wikilink_names(&src), vec!["a", "b"]);
    }

    fn context(src: &str) -> (Option<String>, Option<String>) {
        let p = &inbound_passages(src, "T")[0];
        (
            p.before.as_ref().map(|b| b.source.clone()),
            p.after.as_ref().map(|a| a.source.clone()),
        )
    }

    #[test]
    fn context_is_the_paragraph_before_and_after() {
        let src = note("One.\n\nTwo #wikilink(\"T\").\n\nThree.\n\nFour.");
        assert_eq!(context(&src), (Some("One.".into()), Some("Three.".into())));
    }

    #[test]
    fn context_stops_at_the_body_edges() {
        let src = note("Only #wikilink(\"T\").");
        assert_eq!(context(&src), (None, None));
    }

    #[test]
    fn context_around_a_list_item_is_its_neighbour_items() {
        let src = note("- a\n- b #wikilink(\"T\")\n- c");
        assert_eq!(context(&src), (Some("- a".into()), Some("- c".into())));
    }

    #[test]
    fn context_around_heading_passage_skips_the_paragraph_it_took() {
        let src = note("Lead.\n\n= About #wikilink(\"T\")\nBody.\n\nAfter.");
        assert_eq!(context(&src), (Some("Lead.".into()), Some("After.".into())));
    }

    fn marked(d: &DisplayText) -> Vec<String> {
        let units: Vec<u16> = d.text.encode_utf16().collect();
        d.marks
            .iter()
            .map(|&(a, b)| String::from_utf16(&units[a..b]).unwrap())
            .collect()
    }

    #[test]
    fn links_to_the_target_are_marked() {
        let src = note("Café — «see» #wikilink(\"T\", label: \"this\") and #wikilink(\"U\").");
        let p = &inbound_passages(&src, "T")[0];
        assert_eq!(marked(&p.paragraph.display), vec!["this"]);
        assert_eq!(marked(&p.snippet), vec!["this"]);
    }

    #[test]
    fn snippet_leaves_out_sub_items() {
        let src = note("- Sent the #wikilink(\"T\") report\n  - a sub-item\n  - another\n- next");
        let p = &inbound_passages(&src, "T")[0];
        assert_eq!(p.snippet.text, "Sent the T report");
        assert!(p.paragraph.display.text.contains("a sub-item"));
    }

    #[test]
    fn snippet_of_a_link_in_a_sub_item_is_that_item() {
        let src = note("- parent\n  - child #wikilink(\"T\")\n  - sibling");
        assert_eq!(inbound_passages(&src, "T")[0].snippet.text, "child T");
    }

    #[test]
    fn snippet_takes_a_sentence_either_side() {
        let src = note("One. Two. Three #wikilink(\"T\") here. Four. Five.");
        let p = &inbound_passages(&src, "T")[0];
        assert_eq!(p.snippet.text, "\u{2026}Two. Three T here. Four.\u{2026}");
        assert_eq!(marked(&p.snippet), vec!["T"]);
    }

    #[test]
    fn snippet_skips_a_neighbour_sentence_that_does_not_fit() {
        let long = "word ".repeat(40);
        let src = note(&format!("{long}end. Short #wikilink(\"T\") one."));
        assert_eq!(
            inbound_passages(&src, "T")[0].snippet.text,
            "\u{2026}Short T one."
        );
    }

    #[test]
    fn snippet_cuts_a_long_sentence_at_words() {
        let before = "alpha ".repeat(40);
        let after = " omega".repeat(40);
        let src = note(&format!("{before}#wikilink(\"T\"){after}."));
        let snip = inbound_passages(&src, "T")[0].snippet.clone();
        assert!(snip.text.starts_with("\u{2026}alpha "), "{}", snip.text);
        assert!(snip.text.ends_with(" omega\u{2026}"), "{}", snip.text);
        let chars = snip.text.chars().count();
        assert!(chars <= 2 * SNIPPET_CONTEXT_CHARS + 3, "{chars}");
        assert_eq!(marked(&snip), vec!["T"]);
    }

    #[test]
    fn markup_does_not_count_toward_the_snippet() {
        let src = note("Lead *strong* #emph[words] here. Then #wikilink(\"T\").");
        assert_eq!(
            inbound_passages(&src, "T")[0].snippet.text,
            "Lead strong words here. Then T."
        );
    }

    #[test]
    fn lead_passage_snippet_starts_at_the_top() {
        let src = note("First. Second. Third.\n\nMore.");
        let p = lead_passage(&src).unwrap();
        assert_eq!(p.snippet.text, "First. Second.\u{2026}");
        assert!(p.snippet.marks.is_empty());
    }
}
