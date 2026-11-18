//! Turns `#task("…")` calls whose string holds Typst markup into the markup
//! form, `#task[…]`.
//!
//! Markdown import used to write a task's text as a string with its links,
//! wikilinks and tags inside it as source (`#task("Read #link(\"…\")")`). A
//! string body shows that source as literal text, and its wikilinks and tags
//! aren't indexed. As a markup body (`#task[Read #link("…")]`) they render and
//! are indexed.
//!
//! Only a string that clearly holds markup is converted: its text must parse as
//! Typst markup without errors and contain at least one embedded call. A string
//! with no calls is plain text and stays as it is. One that holds an `@`
//! reference or a `<label>` is left too, and counted as skipped: that is most
//! likely a bare email address, which as markup would stop the note compiling.
//!
//! Per CLAUDE.md's Typst-first principle, calls are found and the text checked
//! with `typst::syntax`.

use std::ops::Range;

use typst::syntax::{ast, parse, LinkedNode, SyntaxKind, SyntaxNode};

/// The result of converting one note's task bodies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskBodyConversion {
    /// The note's source with the tasks converted.
    pub source: String,
    /// Tasks converted to a markup body.
    pub converted: usize,
    /// Tasks whose string holds markup but was left as it is (see the module
    /// docs).
    pub skipped: usize,
}

/// Convert the `#task("…")` calls in `source` whose string holds markup to
/// `#task[…]`, keeping their other arguments byte for byte.
pub fn convert_markup_task_bodies(source: &str) -> TaskBodyConversion {
    let root = parse(source);
    let mut edits: Vec<(Range<usize>, String)> = Vec::new();
    let mut skipped = 0;
    collect_edits(&LinkedNode::new(&root), &mut edits, &mut skipped);

    let converted = edits.len();
    let mut out = source.to_string();
    // Back to front, so earlier ranges stay valid.
    for (range, text) in edits.into_iter().rev() {
        out.replace_range(range, &text);
    }
    TaskBodyConversion {
        source: out,
        converted,
        skipped,
    }
}

fn collect_edits(
    node: &LinkedNode<'_>,
    edits: &mut Vec<(Range<usize>, String)>,
    skipped: &mut usize,
) {
    if node.kind() == SyntaxKind::FuncCall {
        if let Some(call) = node.cast::<ast::FuncCall>() {
            if matches!(call.callee(), ast::Expr::Ident(id) if id.as_str() == "task") {
                match converted_call(node) {
                    Some(Conversion::Markup(text)) => edits.push((node.range(), text)),
                    Some(Conversion::Skipped) => *skipped += 1,
                    None => {}
                }
                return;
            }
        }
    }
    for child in node.children() {
        collect_edits(&child, edits, skipped);
    }
}

enum Conversion {
    /// The call rewritten with a markup body.
    Markup(String),
    /// The string holds markup that can't safely be used as it is.
    Skipped,
}

/// A `task` call rewritten with its string as a markup body, `Skipped`, or
/// `None` when its body isn't a string holding markup.
fn converted_call(call: &LinkedNode<'_>) -> Option<Conversion> {
    let args = call.children().find(|c| c.kind() == SyntaxKind::Args)?;
    if args
        .children()
        .any(|c| c.kind() == SyntaxKind::ContentBlock)
    {
        return None;
    }
    let first = args.children().find(|c| !is_trivia(c.kind()))?;
    let body = first.cast::<ast::Str>()?.get();

    match classify(&body) {
        Body::Plain => return None,
        Body::Unsafe => return Some(Conversion::Skipped),
        Body::Markup => {}
    }

    // The argument list without the body string and the separator after it.
    let mut inner = String::new();
    let mut after_body = false;
    for child in args.children() {
        match child.kind() {
            SyntaxKind::LeftParen | SyntaxKind::RightParen => continue,
            _ if child.range() == first.range() => {
                after_body = true;
                continue;
            }
            SyntaxKind::Comma | SyntaxKind::Space if after_body => continue,
            _ => {
                after_body = false;
                inner.push_str(&child.get().full_text());
            }
        }
    }
    let callee = call.children().next()?.get().full_text();
    let args_text = if inner.trim().is_empty() {
        String::new()
    } else {
        format!("({inner})")
    };
    Some(Conversion::Markup(format!("{callee}{args_text}[{body}]")))
}

fn is_trivia(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::LeftParen
            | SyntaxKind::Space
            | SyntaxKind::LineComment
            | SyntaxKind::BlockComment
    )
}

enum Body {
    /// No embedded calls: plain text, fine as a string.
    Plain,
    /// Parses as markup with at least one embedded call.
    Markup,
    /// Doesn't parse as markup, or holds a reference or label.
    Unsafe,
}

fn classify(text: &str) -> Body {
    let root = parse(text);
    if !root.errors_and_warnings().0.is_empty() {
        return if has_kind(&root, SyntaxKind::Hash) {
            Body::Unsafe
        } else {
            Body::Plain
        };
    }
    if !has_kind(&root, SyntaxKind::Hash) {
        return Body::Plain;
    }
    if has_kind(&root, SyntaxKind::Ref) || has_kind(&root, SyntaxKind::Label) {
        return Body::Unsafe;
    }
    Body::Markup
}

fn has_kind(node: &SyntaxNode, kind: SyntaxKind) -> bool {
    node.kind() == kind || node.children().any(|c| has_kind(c, kind))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn convert(source: &str) -> TaskBodyConversion {
        convert_markup_task_bodies(source)
    }

    #[test]
    fn converts_a_string_holding_markup() {
        let out = convert(
            r#"#task("Look into the books on the Journal of Sonic Studies#link(\"https://example.test/558982\"), some may be good for #wikilink(\"Communication Studies\")  #tag(\"rwlgd\")")"#,
        );
        assert_eq!(
            out.source,
            r#"#task[Look into the books on the Journal of Sonic Studies#link("https://example.test/558982"), some may be good for #wikilink("Communication Studies")  #tag("rwlgd")]"#
        );
        assert_eq!((out.converted, out.skipped), (1, 0));
    }

    #[test]
    fn keeps_the_other_arguments() {
        let out = convert(
            "#task(\"Call #wikilink(\\\"Athena Otlet\\\")\", done: true, due: \"2026-06-23\") after",
        );
        assert_eq!(
            out.source,
            "#task(done: true, due: \"2026-06-23\")[Call #wikilink(\"Athena Otlet\")] after"
        );
    }

    #[test]
    fn leaves_plain_strings_alone() {
        let source = "#task(\"Buy milk\")\n#task(\"Price is $5 *maybe\", done: true)\n";
        let out = convert(source);
        assert_eq!(out.source, source);
        assert_eq!((out.converted, out.skipped), (0, 0));
    }

    #[test]
    fn skips_markup_holding_a_reference_or_a_parse_error() {
        let source = "#task(\"Mail athena@inkycap.org about #link(\\\"x\\\")\")\n\
                      #task(\"Fix #link(\\\"x\\\") ]\")\n";
        let out = convert(source);
        assert_eq!(out.source, source);
        assert_eq!((out.converted, out.skipped), (0, 2));
    }

    #[test]
    fn converts_tasks_inside_other_markup_and_keeps_utf8() {
        let out = convert("#callout(\"note\")[Rédiger — #task(\"Lire #emph[ceci]\")]");
        assert_eq!(
            out.source,
            "#callout(\"note\")[Rédiger — #task[Lire #emph[ceci]]]"
        );
    }

    #[test]
    fn leaves_markup_tasks_alone() {
        let source = "#task(done: true)[Read #link(\"x\")[it]]";
        assert_eq!(convert(source).source, source);
    }
}
