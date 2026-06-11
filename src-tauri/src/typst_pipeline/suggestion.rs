//! Rust ↔ Typst glue for the inline `#suggestion(...)` tracked-change
//! primitive (the "suggesting mode" of the collaboration layer).
//!
//! Two jobs, both Typst-first (`typst::syntax` parses the source — the same
//! parser the compiler uses — so byte ranges land on char boundaries and
//! multi-byte UTF-8 passes through verbatim, per CLAUDE.md):
//!
//! 1. [`suggestion_call`] builds a `#suggestion(...)` call string. Used by the
//!    markdown-import CriticMarkup mapping and any other host-side emitter; the
//!    visual editor wraps a selection itself (like `#highlight[…]`).
//! 2. [`resolve_suggestion_at`] / [`resolve_all_suggestions`] *accept* or
//!    *reject* a suggestion as a source transform — they **unwrap** the
//!    `#suggestion(...)` call to clean Typst so a published document never
//!    carries suggestion marks. This is the same AST-edit discipline as
//!    `note_rewriter` and `path_rebase`.
//!
//! Resolution semantics (accept = take the proposed change):
//! | kind    | accept            | reject            |
//! |---------|-------------------|-------------------|
//! | insert  | keep new text     | remove new text   |
//! | delete  | remove old text   | keep old text     |
//! | replace | new text          | old text          |

use std::ops::Range;

use typst::syntax::{ast, parse, LinkedNode, SyntaxKind};

use crate::typst_pipeline::book_wrapper::typst_escape;

/// The kind of change a `#suggestion(...)` proposes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SuggestionKind {
    Insert,
    Delete,
    Replace,
}

impl SuggestionKind {
    /// The lowercase string used as the Typst `kind` argument (must match the
    /// `lib.typ` `suggestion` assert + `_suggestion-*` switch).
    pub fn as_typ(self) -> &'static str {
        match self {
            SuggestionKind::Insert => "insert",
            SuggestionKind::Delete => "delete",
            SuggestionKind::Replace => "replace",
        }
    }

    fn from_typ(s: &str) -> Option<Self> {
        match s {
            "insert" => Some(SuggestionKind::Insert),
            "delete" => Some(SuggestionKind::Delete),
            "replace" => Some(SuggestionKind::Replace),
            _ => None,
        }
    }
}

/// Build a `#suggestion(...)[body]` call.
///
/// - `body` is the inserted (insert/replace) or deleted (delete) text, placed
///   verbatim in the content bracket — the caller supplies valid inline markup
///   (a selection or plain text), exactly as `#highlight[…]` is emitted.
/// - `old` is the replaced text for `Replace` (ignored otherwise); also placed
///   verbatim as a content argument.
/// - `by` / `on` attribute the author; omitted when empty.
pub fn suggestion_call(
    kind: SuggestionKind,
    body: &str,
    old: Option<&str>,
    by: Option<&str>,
    on: Option<&str>,
) -> String {
    let mut named = format!("kind: \"{}\"", kind.as_typ());
    if kind == SuggestionKind::Replace {
        named.push_str(&format!(", old: [{}]", old.unwrap_or("")));
    }
    if let Some(by) = by.filter(|s| !s.is_empty()) {
        named.push_str(&format!(", by: \"{}\"", typst_escape(by)));
    }
    if let Some(on) = on.filter(|s| !s.is_empty()) {
        named.push_str(&format!(", on: \"{}\"", typst_escape(on)));
    }
    format!("#suggestion({named})[{body}]")
}

/// A parsed `#suggestion(...)` call: its kind and the byte ranges (in the
/// source) needed to resolve it. `full_span` includes the leading `#`.
struct ParsedSuggestion {
    kind: SuggestionKind,
    full_span: Range<usize>,
    /// Inner content of the trailing `[body]` (brackets excluded).
    body_inner: Range<usize>,
    /// Inner content of the `old: [..]` argument, for `Replace`.
    old_inner: Option<Range<usize>>,
    /// The `by:` attribution (who proposed the change), if present.
    by: Option<String>,
}

/// Compute the replacement text for accepting/rejecting a suggestion.
fn resolution_text(p: &ParsedSuggestion, source: &str, accept: bool) -> String {
    let body = || source[p.body_inner.clone()].to_string();
    let old = || {
        p.old_inner
            .clone()
            .map(|r| source[r].to_string())
            .unwrap_or_default()
    };
    match (p.kind, accept) {
        (SuggestionKind::Insert, true) => body(),
        (SuggestionKind::Insert, false) => String::new(),
        (SuggestionKind::Delete, true) => String::new(),
        (SuggestionKind::Delete, false) => body(),
        (SuggestionKind::Replace, true) => body(),
        (SuggestionKind::Replace, false) => old(),
    }
}

/// Accept (or reject) the `#suggestion(...)` call whose span contains `offset`
/// — the byte offset of (or anywhere within) the call, as the visual editor
/// knows it. Returns the rewritten source, unwrapping the call to clean Typst.
/// Unchanged when no suggestion call contains `offset`.
pub fn resolve_suggestion_at(source: &str, offset: usize, accept: bool) -> String {
    let root = parse(source);
    let link = LinkedNode::new(&root);
    let mut calls: Vec<ParsedSuggestion> = Vec::new();
    collect_suggestions(&link, source, &mut calls);
    // The call whose hash-extended span contains the offset; innermost
    // (smallest span) wins if suggestions ever nest. `full_span.start` is the
    // `#`, so an offset there matches.
    let Some(parsed) = calls
        .into_iter()
        .filter(|p| p.full_span.contains(&offset))
        .min_by_key(|p| p.full_span.end - p.full_span.start)
    else {
        return source.to_string();
    };
    let replacement = resolution_text(&parsed, source, accept);
    let mut out = String::with_capacity(source.len());
    out.push_str(&source[..parsed.full_span.start]);
    out.push_str(&replacement);
    out.push_str(&source[parsed.full_span.end..]);
    out
}

/// Accept (or reject) **every** `#suggestion(...)` call in the source — the
/// "accept all / reject all" path. Edits are applied back-to-front so earlier
/// offsets stay valid.
pub fn resolve_all_suggestions(source: &str, accept: bool) -> String {
    let root = parse(source);
    let link = LinkedNode::new(&root);
    let mut calls: Vec<ParsedSuggestion> = Vec::new();
    collect_suggestions(&link, source, &mut calls);
    if calls.is_empty() {
        return source.to_string();
    }
    calls.sort_by_key(|b| std::cmp::Reverse(b.full_span.start));
    let mut out = source.to_string();
    for p in &calls {
        let replacement = resolution_text(p, source, accept);
        out.replace_range(p.full_span.clone(), &replacement);
    }
    out
}

/// Count the `#suggestion(...)` calls in the source (for UI badges / tests).
pub fn count_suggestions(source: &str) -> usize {
    let root = parse(source);
    let link = LinkedNode::new(&root);
    let mut calls = Vec::new();
    collect_suggestions(&link, source, &mut calls);
    calls.len()
}

/// Count the `#suggestion(...)` calls **not** attributed to `me` — the changes
/// awaiting *this* user's decision. A suggestion the local user authored is
/// theirs to send, not to resolve, so it is excluded once its `by:` matches.
/// Suggestions with no `by:` (unknown author, e.g. legacy) count as
/// awaiting-decision. With an empty `me`, no attribution is possible, so all
/// suggestions count (matches [`count_suggestions`]).
pub fn count_suggestions_by_others(source: &str, me: &str) -> usize {
    let me = me.trim();
    let root = parse(source);
    let link = LinkedNode::new(&root);
    let mut calls = Vec::new();
    collect_suggestions(&link, source, &mut calls);
    if me.is_empty() {
        return calls.len();
    }
    calls
        .iter()
        .filter(|p| p.by.as_deref().map(str::trim) != Some(me))
        .count()
}

// ---------------------------------------------------------------------------
// AST navigation
// ---------------------------------------------------------------------------

fn is_suggestion_call(node: &LinkedNode) -> bool {
    node.kind() == SyntaxKind::FuncCall
        && node
            .cast::<ast::FuncCall>()
            .map(|c| matches!(c.callee(), ast::Expr::Ident(i) if i.as_str() == "suggestion"))
            .unwrap_or(false)
}

/// Collect every `#suggestion(...)` call in document order.
fn collect_suggestions(node: &LinkedNode, source: &str, out: &mut Vec<ParsedSuggestion>) {
    if is_suggestion_call(node) {
        if let Some(p) = parse_suggestion(node, source) {
            out.push(p);
        }
    }
    for child in node.children() {
        collect_suggestions(&child, source, out);
    }
}

/// Extend a FuncCall range to include the leading markup `#`.
fn span_with_hash_prefix(source: &str, range: Range<usize>) -> Range<usize> {
    let bytes = source.as_bytes();
    if range.start > 0 && bytes[range.start - 1] == b'#' {
        (range.start - 1)..range.end
    } else {
        range
    }
}

/// Pull the kind + content ranges out of a `#suggestion(...)` FuncCall node.
fn parse_suggestion(call: &LinkedNode, source: &str) -> Option<ParsedSuggestion> {
    let args = call.children().find(|c| c.kind() == SyntaxKind::Args)?;

    let mut kind = SuggestionKind::Insert; // default mirrors lib.typ
    let mut old_inner: Option<Range<usize>> = None;
    let mut body_inner: Option<Range<usize>> = None;
    let mut by: Option<String> = None;

    for child in args.children() {
        match child.kind() {
            // The trailing `[body]` is a direct ContentBlock child of Args.
            SyntaxKind::ContentBlock => {
                body_inner = Some(inner_of_brackets(&child));
            }
            SyntaxKind::Named => {
                let Some(named) = child.cast::<ast::Named>() else {
                    continue;
                };
                match named.name().as_str() {
                    "kind" => {
                        if let ast::Expr::Str(s) = named.expr() {
                            if let Some(k) = SuggestionKind::from_typ(&s.get()) {
                                kind = k;
                            }
                        }
                    }
                    "by" => {
                        if let ast::Expr::Str(s) = named.expr() {
                            by = Some(s.get().to_string());
                        }
                    }
                    "old" => {
                        // The value is a ContentBlock nested under the Named node.
                        if let Some(cb) = child
                            .children()
                            .find(|c| c.kind() == SyntaxKind::ContentBlock)
                        {
                            old_inner = Some(inner_of_brackets(&cb));
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    Some(ParsedSuggestion {
        kind,
        full_span: span_with_hash_prefix(source, call.range()),
        body_inner: body_inner?,
        old_inner,
        by,
    })
}

/// Inner byte range of a `[...]` ContentBlock (brackets stripped). `[` and `]`
/// are single-byte ASCII, so this stays on char boundaries.
fn inner_of_brackets(content_block: &LinkedNode) -> Range<usize> {
    let r = content_block.range();
    (r.start + 1)..(r.end - 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_insert_call() {
        let c = suggestion_call(
            SuggestionKind::Insert,
            "new text",
            None,
            Some("alice"),
            Some("2026-05-23"),
        );
        assert_eq!(
            c,
            "#suggestion(kind: \"insert\", by: \"alice\", on: \"2026-05-23\")[new text]"
        );
    }

    #[test]
    fn build_delete_call_omits_empty_attribution() {
        let c = suggestion_call(SuggestionKind::Delete, "stale", None, None, None);
        assert_eq!(c, "#suggestion(kind: \"delete\")[stale]");
    }

    #[test]
    fn build_replace_call_carries_old() {
        let c = suggestion_call(
            SuggestionKind::Replace,
            "new",
            Some("old"),
            Some("bob"),
            None,
        );
        assert_eq!(
            c,
            "#suggestion(kind: \"replace\", old: [old], by: \"bob\")[new]"
        );
    }

    #[test]
    fn count_by_others_excludes_my_own_suggestions() {
        let src = "A #suggestion(kind: \"insert\", by: \"Athena Otlet\")[mine] \
                   B #suggestion(kind: \"insert\", by: \"Phydeau Koft\")[theirs] \
                   C #suggestion(kind: \"delete\")[unknown]";
        assert_eq!(count_suggestions(src), 3);
        // Mine is excluded; theirs + the unattributed one remain.
        assert_eq!(count_suggestions_by_others(src, "Athena Otlet"), 2);
        // Trailing/leading space in the identity is tolerated.
        assert_eq!(count_suggestions_by_others(src, "  Athena Otlet  "), 2);
        // No local identity → can't attribute, so all count.
        assert_eq!(count_suggestions_by_others(src, ""), 3);
    }

    #[test]
    fn accept_insert_keeps_text_reject_removes() {
        let src = "Before #suggestion(kind: \"insert\")[added] after.";
        let off = src.find("#suggestion").unwrap();
        assert_eq!(resolve_suggestion_at(src, off, true), "Before added after.");
        assert_eq!(resolve_suggestion_at(src, off, false), "Before  after.");
    }

    #[test]
    fn accept_delete_removes_reject_keeps() {
        let src = "Keep #suggestion(kind: \"delete\")[gone] here.";
        let off = src.find("#suggestion").unwrap();
        assert_eq!(resolve_suggestion_at(src, off, true), "Keep  here.");
        assert_eq!(resolve_suggestion_at(src, off, false), "Keep gone here.");
    }

    #[test]
    fn accept_replace_takes_new_reject_takes_old() {
        let src = "It is #suggestion(kind: \"replace\", old: [bad])[good] now.";
        let off = src.find("#suggestion").unwrap();
        assert_eq!(resolve_suggestion_at(src, off, true), "It is good now.");
        assert_eq!(resolve_suggestion_at(src, off, false), "It is bad now.");
    }

    #[test]
    fn offset_inside_the_call_resolves_it() {
        let src = "x #suggestion(kind: \"insert\")[y] z";
        // An offset in the middle of the call (not just its start) still finds it.
        let mid = src.find("[y]").unwrap();
        assert_eq!(resolve_suggestion_at(src, mid, true), "x y z");
    }

    #[test]
    fn unknown_offset_is_noop() {
        let src = "no suggestion here";
        assert_eq!(resolve_suggestion_at(src, 3, true), src);
    }

    #[test]
    fn resolve_all_accepts_every_kind() {
        let src = "A #suggestion(kind: \"insert\")[ins] B #suggestion(kind: \"delete\")[del] C \
                   #suggestion(kind: \"replace\", old: [o])[n] D";
        assert_eq!(resolve_all_suggestions(src, true), "A ins B  C n D");
        assert_eq!(resolve_all_suggestions(src, false), "A  B del C o D");
    }

    #[test]
    fn count_matches() {
        let src = "#suggestion(kind: \"insert\")[a] #suggestion(kind: \"delete\")[b]";
        assert_eq!(count_suggestions(src), 2);
        assert_eq!(count_suggestions("plain"), 0);
    }

    #[test]
    fn body_with_inline_markup_round_trips() {
        // Body content is markup, not a string — emphasis must survive accept.
        let src = "see #suggestion(kind: \"insert\")[a _key_ point] here";
        let off = src.find("#suggestion").unwrap();
        assert_eq!(
            resolve_suggestion_at(src, off, true),
            "see a _key_ point here"
        );
    }

    #[test]
    fn multibyte_body_is_not_corrupted() {
        let src = "x #suggestion(kind: \"replace\", old: [naïve — α])[résumé β] y";
        let off = src.find("#suggestion").unwrap();
        assert_eq!(resolve_suggestion_at(src, off, true), "x résumé β y");
        assert_eq!(resolve_suggestion_at(src, off, false), "x naïve — α y");
    }
}
