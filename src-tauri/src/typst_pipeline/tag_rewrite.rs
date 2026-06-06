//! Rewriter for InkyCap tag references in a note's body source.
//!
//! A tag carried by a note can appear in three textual forms:
//!   1. `#tag("name")` — the canonical inkycap-notebox call (body).
//!   2. `tags: ("name", ...)` — the `tags:` argument of the top-of-file
//!      `#note(...)` call. That one is rewritten by the caller through
//!      [`crate::typst_pipeline::note_rewriter`], which already owns
//!      whitespace-preserving `#note(...)` property edits.
//!   3. `#name` — the bare hashtag shorthand a user may hand-write.
//!
//! This module handles the body forms (1) and (3); renaming maps
//! `old` → `new`. (Tags can be renamed globally but not deleted globally —
//! see `commands::properties`.)
//!
//! Per CLAUDE.md's Typst-first principle, the `#tag(...)` form is matched
//! through `typst::syntax` — the same parser the compiler uses — so we
//! operate on real call nodes and preserve multi-byte UTF-8 verbatim. The
//! bare-`#name` shorthand has no call node to anchor on (`#name` is a
//! Typst variable reference, not a call), so it stays a bounded regex.

use std::ops::Range;

use regex::Regex;
use typst::syntax::{ast, parse, LinkedNode, SyntaxKind};

/// Rewrite a note body's tag references from `old` to `new` (bare tag
/// names, no leading `#`).
///
/// Covers `#tag("old")` calls and the bare `#old` shorthand. The `tags:`
/// property inside `#note(...)` is the caller's responsibility (see the
/// module docs).
pub fn rewrite_tag_references(content: &str, old: &str, new: &str) -> String {
    let after_calls = rewrite_tag_calls(content, old, new);
    rewrite_inline_shorthand(&after_calls, old, new)
}

/// Rewrite `#tag("old")` calls via the Typst AST, replacing only the
/// string-literal argument.
fn rewrite_tag_calls(content: &str, old: &str, new: &str) -> String {
    let root = parse(content);
    let link = LinkedNode::new(&root);

    let mut edits: Vec<(Range<usize>, String)> = Vec::new();
    collect_tag_call_edits(&link, old, new, &mut edits);

    if edits.is_empty() {
        return content.to_string();
    }

    // Apply edits from the back so earlier byte offsets stay valid.
    edits.sort_by(|a, b| b.0.start.cmp(&a.0.start));
    let mut out = content.to_string();
    for (range, replacement) in edits {
        out.replace_range(range, &replacement);
    }
    out
}

/// Recursively walk the AST collecting `(range, replacement)` edits for
/// `#tag("old")` calls.
fn collect_tag_call_edits(
    node: &LinkedNode<'_>,
    old: &str,
    new: &str,
    edits: &mut Vec<(Range<usize>, String)>,
) {
    if node.kind() == SyntaxKind::FuncCall {
        if let Some(call) = node.cast::<ast::FuncCall>() {
            if let ast::Expr::Ident(ident) = call.callee() {
                if ident.as_str() == "tag" {
                    if let Some((str_range, value)) = first_string_arg(node) {
                        if value == old {
                            edits.push((str_range, format!("\"{}\"", escape_typst_string(new))));
                        }
                    }
                }
            }
        }
    }

    for child in node.children() {
        collect_tag_call_edits(&child, old, new, edits);
    }
}

/// The first positional argument of a FuncCall, as `(byte range, value)`,
/// when it's a string literal. Skips trivia, parens, and commas; bails on a
/// non-string first positional or a leading named/spread argument.
fn first_string_arg(call_node: &LinkedNode<'_>) -> Option<(Range<usize>, String)> {
    let args_node = call_node
        .children()
        .find(|c| c.kind() == SyntaxKind::Args)?;
    for child in args_node.children() {
        match child.kind() {
            SyntaxKind::LeftParen
            | SyntaxKind::RightParen
            | SyntaxKind::Comma
            | SyntaxKind::Space
            | SyntaxKind::Parbreak
            | SyntaxKind::LineComment
            | SyntaxKind::BlockComment => continue,
            SyntaxKind::Str => {
                let s = child.cast::<ast::Str>()?;
                return Some((child.range(), s.get().to_string()));
            }
            // First positional slot isn't a string literal (variable, named
            // arg, etc.) — nothing we can match on.
            _ => return None,
        }
    }
    None
}

/// Rewrite the bare `#old` shorthand. Bounded so `#old` changes but
/// `#older` does not.
fn rewrite_inline_shorthand(body: &str, old: &str, new: &str) -> String {
    let pattern = format!(r"(^|[\s\(\[,])#{}(?P<end>[^\w/-]|$)", regex::escape(old));
    let re = Regex::new(&pattern).unwrap();
    re.replace_all(body, |caps: &regex::Captures| {
        format!("{}#{}{}", &caps[1], new, &caps["end"])
    })
    .into_owned()
}

fn escape_typst_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renames_canonical_tag_call() {
        let body = "Intro #tag(\"physics\") and more.";
        let out = rewrite_tag_references(body, "physics", "science");
        assert_eq!(out, "Intro #tag(\"science\") and more.");
    }

    #[test]
    fn rename_leaves_other_tag_calls_alone() {
        let body = "#tag(\"physics\") #tag(\"history\")";
        let out = rewrite_tag_references(body, "physics", "science");
        assert_eq!(out, "#tag(\"science\") #tag(\"history\")");
    }

    #[test]
    fn renames_bare_shorthand_exact_match_only() {
        let body = "Here is #foo and #foobar.";
        let out = rewrite_tag_references(body, "foo", "bar");
        assert!(out.contains("#bar"));
        assert!(out.contains("#foobar"));
    }

    #[test]
    fn rewrites_both_forms_in_one_pass() {
        let body = "#tag(\"foo\") then bare #foo here.";
        let out = rewrite_tag_references(body, "foo", "baz");
        assert_eq!(out, "#tag(\"baz\") then bare #baz here.");
    }

    #[test]
    fn no_op_when_tag_absent() {
        let body = "#tag(\"history\") and #other.";
        let out = rewrite_tag_references(body, "physics", "science");
        assert_eq!(out, body);
    }

    #[test]
    fn preserves_multibyte_content_around_edit() {
        let body = "Café — #tag(\"physics\") — déjà vu";
        let out = rewrite_tag_references(body, "physics", "science");
        assert_eq!(out, "Café — #tag(\"science\") — déjà vu");
    }
}
