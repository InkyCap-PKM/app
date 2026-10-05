//! The passage of note text around a wikilink, found with Typst's own parser.
//!
//! A *passage* is the unit of writing a link sits in: the paragraph that holds
//! it, or the list item, or (when the link is inside a heading) the heading
//! plus the paragraph after it. For more context, each passage also carries
//! the unit of writing just before and just after it, when there is one.
//!
//! The Links pane shows inbound passages, and Compose mode copies them into a
//! new note, so each passage carries both its Typst source (for copying) and a
//! plain-text rendering (for display).
//!
//! Paragraph boundaries come from the syntax tree (`Parbreak`, `Heading`,
//! list items), not from scanning lines, so a `= ` inside a code block or a
//! blank line inside a string never splits a passage.

use std::ops::Range;

use crate::link_index::link_note_name;
use crate::typst_pipeline::plaintext::extract_plain_text;
use crate::typst_pipeline::query::first_string_positional_arg;
use crate::typst_pipeline::source_structure::{headings, SourceHeading};
use crate::typst_pipeline::syntax::{ast, parse, LinkedNode, SyntaxKind};

/// Longest plain-text rendering kept for display, in characters. The Typst
/// source is never shortened, so copying a passage always copies all of it.
const MAX_DISPLAY_CHARS: usize = 1500;

/// One stretch of note text, in two forms.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PassageText {
    /// The Typst source of the stretch, trimmed of surrounding blank space.
    pub source: String,
    /// Plain prose for display, shortened to [`MAX_DISPLAY_CHARS`] with an
    /// ellipsis when longer.
    pub text: String,
}

/// The text around one link.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LinkPassage {
    /// Plain text of the heading the passage sits under, if any.
    pub heading: Option<String>,
    /// The paragraph, list item, or heading-plus-paragraph holding the link.
    pub paragraph: PassageText,
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
    let root = parse(source);
    let body_start = body_start(source);
    let target = target_stem.to_lowercase();
    let mut calls = Vec::new();
    collect_wikilinks(&LinkedNode::new(&root), &mut calls);

    let all_headings = headings(source);
    let mut seen: Vec<Range<usize>> = Vec::new();
    let mut out = Vec::new();
    for call in calls {
        let matches = first_string_positional_arg(&call)
            .as_deref()
            .and_then(link_note_name)
            .is_some_and(|name| name.to_lowercase() == target);
        if !matches {
            continue;
        }
        let (unit, markup) = unit_around(&call);
        let Some(unit) = clip(unit, body_start) else {
            continue;
        };
        if seen.contains(&unit) {
            continue;
        }
        seen.push(unit.clone());
        let (before, after) = match &markup {
            Some(m) => neighbours(m, &unit, body_start),
            None => (None, None),
        };
        let Some(paragraph) = passage_text(source, unit.clone()) else {
            continue;
        };
        out.push(LinkPassage {
            heading: heading_above(&all_headings, unit.start).map(heading_plain_text),
            paragraph,
            before: before.and_then(|r| passage_text(source, r)),
            after: after.and_then(|r| passage_text(source, r)),
        });
    }
    out
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
fn body_start(source: &str) -> usize {
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
/// markup the unit is a part of, where its neighbours are.
fn unit_around<'a>(node: &LinkedNode<'a>) -> (Range<usize>, Option<LinkedNode<'a>>) {
    let mut child = node.clone();
    while let Some(parent) = child.parent().cloned() {
        match parent.kind() {
            k if is_item(k) => return (parent.range(), parent.parent().cloned()),
            SyntaxKind::Heading => return (heading_and_next(&parent), parent.parent().cloned()),
            // Markup that is the body of a list item or heading belongs to
            // that item; keep climbing so the arms above take it.
            SyntaxKind::Markup
                if !parent
                    .parent_kind()
                    .is_some_and(|k| is_item(k) || k == SyntaxKind::Heading) =>
            {
                return (paragraph_run(&parent, &child), Some(parent));
            }
            _ => child = parent,
        }
    }
    (node.range(), None)
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
fn passage_text(source: &str, range: Range<usize>) -> Option<PassageText> {
    // Node and heading ranges come from the parser, so they fall on
    // character boundaries.
    let raw = source.get(range)?.trim();
    if raw.is_empty() {
        return None;
    }
    Some(PassageText {
        source: raw.to_string(),
        text: shorten(&extract_plain_text(raw), MAX_DISPLAY_CHARS),
    })
}

fn heading_plain_text(h: &SourceHeading) -> String {
    extract_plain_text(&h.text)
}

/// `text` cut to `max` characters with an ellipsis when longer.
fn shorten(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((cut, _)) => format!("{}\u{2026}", text[..cut].trim_end()),
        None => text.to_string(),
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
        assert!(p.paragraph.text.contains("東京"));
    }

    #[test]
    fn display_text_is_shortened_but_source_is_not() {
        let long = "word ".repeat(600);
        let src = note(&format!("{long}#wikilink(\"T\")"));
        let p = &inbound_passages(&src, "T")[0];
        assert!(p.paragraph.text.ends_with('\u{2026}'));
        assert!(p.paragraph.text.chars().count() <= MAX_DISPLAY_CHARS + 1);
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
}
