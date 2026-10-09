//! Typst-AST-driven plain-prose extraction for the external-tool bridge and
//! for link previews, which can also mark where chosen nodes ended up.
//!
//! Grammar checkers, style linters, and LLM helpers want a writer's *prose*,
//! not raw Typst source. Piping the source verbatim sends a note's
//! `#import "/.inkycap/…": *` preamble, its `#note(title: …, tags: …)`
//! metadata block, `#wikilink(…)` / `#tag(…)` markup, math, and code through
//! to the tool — noise that wastes the tool's budget (and, for network tools,
//! leaks structural metadata) without improving the check.
//!
//! Per CLAUDE.md's Typst-first principle, we do not strip markup with regex.
//! We parse the source with `typst::syntax::parse` — the same parser the
//! compiler uses — and walk the AST emitting the text leaves while pruning the
//! structural nodes. Markup wrappers (`Strong`, `Emph`, headings, list items,
//! content-bracket function calls) fall away naturally because their delimiters
//! (`*`, `_`, `=`, `-`) are their own non-`Text` tokens. This mirrors the
//! search indexer in [`crate::search::text_projection`], but produces a single
//! contiguous prose string (with paragraph breaks preserved) rather than the
//! offset-tagged token stream the search engine needs.

use std::ops::Range;

use typst::syntax::{ast, parse, LinkedNode, SyntaxKind};

/// Decides which nodes' text [`extract_marked_text`] marks.
pub type MarkNode<'f> = &'f dyn Fn(&LinkedNode<'_>) -> bool;

/// Placeholders written around a marked node's text during the walk and
/// removed afterwards. Private-use characters never show up in prose, and
/// any that do are dropped from text leaves so they can't be misread.
const MARK_OPEN: char = '\u{E000}';
const MARK_CLOSE: char = '\u{E001}';

/// Plain prose with some stretches marked, such as the links to one note.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MarkedText {
    pub text: String,
    /// Byte ranges into `text`, in order and not overlapping.
    pub marks: Vec<Range<usize>>,
}

/// Extract plain prose from a note's Typst source (or a selected fragment).
///
/// Drops the leading `#import` and the `#note(...)` properties block, unwraps
/// inline markup to its text, keeps headings and list items as their words,
/// pulls the user-visible label out of `#wikilink` / `#tag` / `#link-ref` and
/// the body prose out of content-bracket calls (`#callout[…]`, `#quote[…]`,
/// `#suggestion[…]`, custom wrappers), and skips math, code, raw spans,
/// labels, references, and comments entirely. Whitespace is normalized: source
/// line wraps collapse to single spaces, blank lines collapse to a single
/// paragraph break.
pub fn extract_plain_text(source: &str) -> String {
    extract_marked_text(source, &|_| false).text
}

/// [`extract_plain_text`], also noting where the text of each node that
/// `is_marked` accepts ended up, so a display can highlight it.
pub fn extract_marked_text(source: &str, is_marked: MarkNode<'_>) -> MarkedText {
    let root = parse(source);
    let mut out = String::new();
    walk(&LinkedNode::new(&root), &mut out, is_marked);
    take_marks(&normalize(&out))
}

/// Recursive descent over the AST, bracketing a marked node's text with the
/// mark placeholders.
fn walk(node: &LinkedNode<'_>, out: &mut String, mark: MarkNode<'_>) {
    if mark(node) {
        out.push(MARK_OPEN);
        walk_node(node, out, mark);
        out.push(MARK_CLOSE);
    } else {
        walk_node(node, out, mark);
    }
}

/// Default behaviour is "descend into every child"; the arms below either
/// emit a text leaf, emit normalized whitespace, prune a non-prose subtree,
/// or dispatch a function call.
fn walk_node(node: &LinkedNode<'_>, out: &mut String, mark: MarkNode<'_>) {
    match node.kind() {
        // Structural / non-prose subtrees — never descend.
        SyntaxKind::Label
        | SyntaxKind::Ref
        | SyntaxKind::LineComment
        | SyntaxKind::BlockComment
        | SyntaxKind::ModuleImport
        | SyntaxKind::ModuleInclude
        | SyntaxKind::Equation
        | SyntaxKind::Math
        | SyntaxKind::Code
        | SyntaxKind::CodeBlock
        // Code spans / fenced blocks: identifiers, not prose — checking them
        // produces noise (a grammar tool flags every snake_case token).
        | SyntaxKind::Raw => return,

        // Text leaves and whitespace. Source line wraps (`Space` carrying a
        // single newline) become spaces — Typst treats them as inline space —
        // while `Parbreak` (a blank line) becomes a real paragraph break, so
        // the tool sees the same paragraph structure the reader does.
        SyntaxKind::Text => {
            let text = node.leaf_text().as_str();
            if text.contains([MARK_OPEN, MARK_CLOSE]) {
                out.extend(text.chars().filter(|c| !matches!(*c, MARK_OPEN | MARK_CLOSE)));
            } else {
                out.push_str(text);
            }
            return;
        }
        SyntaxKind::Space => {
            out.push(' ');
            return;
        }
        SyntaxKind::Parbreak => {
            out.push_str("\n\n");
            return;
        }
        SyntaxKind::Linebreak => {
            out.push('\n');
            return;
        }
        SyntaxKind::SmartQuote => {
            out.push_str(node.leaf_text());
            return;
        }
        SyntaxKind::Escape => {
            // `\#`, `\*`, `\_`, … — emit the escaped character, not the
            // backslash, so the tool sees the literal the reader sees.
            let text = node.leaf_text().as_str();
            out.push_str(text.strip_prefix('\\').unwrap_or(text));
            return;
        }

        // Headings and list/enum/term items are block-level: bracket them with
        // breaks so a heading never fuses onto the paragraph that follows and
        // each item lands on its own line.
        SyntaxKind::Heading => {
            ensure_paragraph_break(out);
            for child in node.children() {
                walk(&child, out, mark);
            }
            out.push_str("\n\n");
            return;
        }
        SyntaxKind::ListItem | SyntaxKind::EnumItem | SyntaxKind::TermItem => {
            // Newline *before* each item only; the inter-item `Space` node plus
            // the next item's guard supply the separation. Appending a newline
            // here too would fuse with that `Space` into a blank line.
            ensure_newline(out);
            for child in node.children() {
                walk(&child, out, mark);
            }
            return;
        }

        SyntaxKind::FuncCall => {
            handle_func_call(node, out, mark);
            return;
        }

        _ => {}
    }

    for child in node.children() {
        walk(&child, out, mark);
    }
}

/// Function-call dispatch. The InkyCap primitives whose user-visible text is a
/// string *argument* are special-cased; everything else falls back to
/// "descend into `ContentBlock` arguments only", so content-bracket wrappers
/// yield their inner prose without enumerating every function.
fn handle_func_call(node: &LinkedNode<'_>, out: &mut String, mark: MarkNode<'_>) {
    let Some(call) = node.cast::<ast::FuncCall>() else {
        return;
    };
    let callee = match call.callee() {
        ast::Expr::Ident(ident) => Some(ident.as_str().to_string()),
        _ => None, // `module.fn(…)` — treat as unknown, descend content blocks
    };

    match callee.as_deref() {
        // Metadata / runtime / media calls carry no prose to check.
        Some("note") | Some("metadata") | Some("bibliography") | Some("set-notebox")
        | Some("image") | Some("embed") | Some("video") | Some("audio") => {}

        // `#tag("name")` — the tag word is prose-adjacent; keep it.
        Some("tag") => {
            if let Some(name) = first_positional_string(node) {
                out.push_str(&name);
                out.push(' ');
            }
        }

        // `#wikilink("Target", label: "shown")` — emit what the reader sees:
        // the label if present, otherwise the target name.
        Some("wikilink") => {
            if let Some(text) =
                named_string_arg(node, "label").or_else(|| first_positional_string(node))
            {
                out.push_str(&text);
            }
        }

        // `#link-ref("Target")` — the target name is the visible text.
        Some("link-ref") => {
            if let Some(name) = first_positional_string(node) {
                out.push_str(&name);
            }
        }

        // `#link("https://…")[display]` — the URL is not prose; the display
        // body (if any) lives in a ContentBlock. Same for annotation/suggestion
        // bodies and every other content-bracket wrapper.
        _ => descend_into_content_blocks(node, out, mark),
    }
}

/// Walk only the `ContentBlock` (`[…]`) arguments of a call, skipping its
/// code-mode arguments — the default for unknown / content-bracket functions.
fn descend_into_content_blocks(node: &LinkedNode<'_>, out: &mut String, mark: MarkNode<'_>) {
    let Some(args) = node.children().find(|c| c.kind() == SyntaxKind::Args) else {
        return;
    };
    for child in args.children() {
        if child.kind() == SyntaxKind::ContentBlock {
            walk(&child, out, mark);
        }
    }
}

/// The decoded value of the first positional string argument, or `None` if the
/// first argument isn't a string literal.
fn first_positional_string(call_node: &LinkedNode<'_>) -> Option<String> {
    let args = call_node
        .children()
        .find(|c| c.kind() == SyntaxKind::Args)?;
    for child in args.children() {
        match child.kind() {
            SyntaxKind::LeftParen
            | SyntaxKind::Comma
            | SyntaxKind::Space
            | SyntaxKind::LineComment
            | SyntaxKind::BlockComment => continue,
            SyntaxKind::Str => return child.cast::<ast::Str>().map(|s| s.get().to_string()),
            _ => return None,
        }
    }
    None
}

/// The decoded value of a named string argument `name: "…"`, if present.
pub(crate) fn named_string_arg(call_node: &LinkedNode<'_>, name: &str) -> Option<String> {
    let args = call_node
        .children()
        .find(|c| c.kind() == SyntaxKind::Args)?;
    for child in args.children() {
        if child.kind() != SyntaxKind::Named {
            continue;
        }
        let Some(named) = child.cast::<ast::Named>() else {
            continue;
        };
        if named.name().as_str() != name {
            continue;
        }
        if let ast::Expr::Str(s) = named.expr() {
            return Some(s.get().to_string());
        }
    }
    None
}

/// Push a paragraph break unless the buffer already ends with one (or is empty).
fn ensure_paragraph_break(out: &mut String) {
    if !out.is_empty() && !out.ends_with("\n\n") {
        if out.ends_with('\n') {
            out.push('\n');
        } else {
            out.push_str("\n\n");
        }
    }
}

/// Push a newline unless the buffer already ends with one (or is empty).
fn ensure_newline(out: &mut String) {
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
}

/// Collapse the walk's raw output to clean prose: horizontal whitespace runs
/// per line become a single space, and runs of blank lines become a single
/// paragraph break. Leading/trailing blank lines are trimmed.
fn normalize(raw: &str) -> String {
    // `split_whitespace` collapses each line's internal whitespace runs; a
    // blank line is kept at most once in a row to bound paragraph gaps.
    let mut lines: Vec<String> = Vec::new();
    let mut prev_blank = false;
    for line in raw.lines() {
        let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        let blank = collapsed.is_empty();
        if blank && prev_blank {
            continue;
        }
        prev_blank = blank;
        lines.push(collapsed);
    }
    // Trim leading/trailing blank lines.
    let start = lines
        .iter()
        .position(|l| !l.is_empty())
        .unwrap_or(lines.len());
    let end = lines
        .iter()
        .rposition(|l| !l.is_empty())
        .map_or(start, |i| i + 1);
    lines[start..end].join("\n")
}

/// Remove the mark placeholders from `raw`, recording the stretches they
/// enclosed. Marks left empty (a marked node with no text) are dropped.
fn take_marks(raw: &str) -> MarkedText {
    let mut text = String::with_capacity(raw.len());
    let mut marks = Vec::new();
    let mut depth = 0usize;
    let mut start = 0;
    for c in raw.chars() {
        match c {
            MARK_OPEN => {
                if depth == 0 {
                    start = text.len();
                }
                depth += 1;
            }
            MARK_CLOSE => {
                depth = depth.saturating_sub(1);
                if depth == 0 && text.len() > start {
                    marks.push(start..text.len());
                }
            }
            _ => text.push(c),
        }
    }
    MarkedText { text, marks }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_import_and_note_block() {
        let src = "#import \"/.inkycap/packages/inkycap-notebox/0.1.0/lib.typ\": *\n\
                   #note(title: \"My note\", tags: (\"a\", \"b\"))\n\n\
                   The actual prose.";
        assert_eq!(extract_plain_text(src), "The actual prose.");
    }

    #[test]
    fn unwraps_inline_markup_and_headings() {
        let src = "= A heading\n\nSome *bold* and _italic_ prose.";
        assert_eq!(
            extract_plain_text(src),
            "A heading\n\nSome bold and italic prose."
        );
    }

    #[test]
    fn keeps_wikilink_and_tag_text() {
        let src = "See #wikilink(\"Other Note\") and a #tag(\"topic\") here.";
        assert_eq!(extract_plain_text(src), "See Other Note and a topic here.");
    }

    #[test]
    fn prefers_wikilink_label() {
        let src = "Read #wikilink(\"Target\", label: \"the sequel\") now.";
        assert_eq!(extract_plain_text(src), "Read the sequel now.");
    }

    #[test]
    fn skips_math_and_code() {
        let src = "Before $x^2 + 1$ after. #let y = 3 End.";
        // Math and the `#let` binding drop out; surrounding prose remains.
        let out = extract_plain_text(src);
        assert!(out.contains("Before"), "got: {out:?}");
        assert!(out.contains("after"), "got: {out:?}");
        assert!(!out.contains("x^2"), "got: {out:?}");
        assert!(!out.contains("let y"), "got: {out:?}");
    }

    #[test]
    fn keeps_content_bracket_body() {
        let src = "#callout(kind: \"note\")[Remember *this* point.]";
        assert_eq!(extract_plain_text(src), "Remember this point.");
    }

    #[test]
    fn keeps_list_items_as_lines() {
        let src = "- first item\n- second item";
        assert_eq!(extract_plain_text(src), "first item\nsecond item");
    }

    #[test]
    fn multibyte_prose_survives() {
        // UTF-8 correctness: em-dash, smart quotes, accents must pass through.
        let src = "Café — naïve “quotes” résumé.";
        assert_eq!(extract_plain_text(src), "Café — naïve “quotes” résumé.");
    }

    #[test]
    fn marks_the_chosen_nodes_text() {
        let src = "Café *see* #wikilink(\"Target\") — and #wikilink(\"Other\").";
        let is_target = |n: &LinkedNode<'_>| {
            n.kind() == SyntaxKind::FuncCall
                && first_positional_string(n).as_deref() == Some("Target")
        };
        let m = extract_marked_text(src, &is_target);
        assert_eq!(m.text, "Café see Target — and Other.");
        assert_eq!(m.marks.len(), 1);
        assert_eq!(&m.text[m.marks[0].clone()], "Target");
    }

    #[test]
    fn placeholder_characters_in_prose_are_not_marks() {
        let m = extract_marked_text("a \u{E000}b\u{E001} c", &|_| false);
        assert_eq!(m.text, "a b c");
        assert!(m.marks.is_empty());
    }
}
