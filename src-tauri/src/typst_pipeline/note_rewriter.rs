//! Source-level rewriter for `#note(...)` calls in `.typ` files.
//!
//! Backed by `typst::syntax` — we parse the document into the same AST the
//! Typst compiler uses, locate the `#note(...)` call, and operate on byte
//! ranges from the typed nodes. This means:
//!
//! - Multi-byte UTF-8 (em-dashes, smart quotes, accented characters, CJK)
//!   passes through verbatim. Byte ranges from the parser always land on
//!   character boundaries.
//! - Argument-value source is preserved exactly for fields we don't touch:
//!   `datetime(year: 2026, month: 4, day: 29)`, nested arrays, raw strings
//!   with escaped quotes, and so on.
//! - Anything outside the `#note(...)` call is preserved byte-for-byte.
//!
//! Public API:
//! - [`update_note_property`] — set or add a single property
//! - [`remove_note_property`] — remove a property; dematerialize when empty
//! - [`note_call_span`] — byte range of the `#note(...)` call, including `#`
//! - [`extract_note_properties`] — pull (key, raw value source) pairs
//! - [`serialize_to_typst`] — render a [`PropertyValue`] as Typst source
//! - [`typst_value_to_plain_text`] — best-effort raw-Typst → plain-text

use std::ops::Range;

use typst::syntax::{ast, parse, LinkedNode, SyntaxKind};

use crate::models::note::PropertyValue;

// ---------------------------------------------------------------------------
// AST navigation
// ---------------------------------------------------------------------------

/// Walk the parsed tree depth-first and return the first `FuncCall` whose
/// callee is `note`. Uses `LinkedNode` so callers get accurate byte ranges
/// (a bare `SyntaxNode` doesn't carry parent offset information).
fn find_note_call_node<'a>(node: &LinkedNode<'a>) -> Option<LinkedNode<'a>> {
    if node.kind() == SyntaxKind::FuncCall {
        if let Some(call) = node.cast::<ast::FuncCall>() {
            if let ast::Expr::Ident(ident) = call.callee() {
                if ident.as_str() == "note" {
                    return Some(node.clone());
                }
            }
        }
    }
    for child in node.children() {
        if let Some(n) = find_note_call_node(&child) {
            return Some(n);
        }
    }
    None
}

/// Extend a FuncCall's range to include the leading `#` from markup mode.
/// In Typst markup, `#note(...)` is a `Hash` token followed by a `FuncCall`
/// node — the FuncCall's own range covers `note(...)` only. Existing
/// callers and tests treat the span as starting at `#`, so we extend.
fn span_with_hash_prefix(content: &str, range: Range<usize>) -> Range<usize> {
    let bytes = content.as_bytes();
    if range.start > 0 && bytes[range.start - 1] == b'#' {
        (range.start - 1)..range.end
    } else {
        range
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Byte range `start..end` of the `#note(...)` call (including `#`), or
/// `None` if the document has no `#note(...)`.
pub fn note_call_span(content: &str) -> Option<Range<usize>> {
    let root = parse(content);
    let link = LinkedNode::new(&root);
    let node = find_note_call_node(&link)?;
    Some(span_with_hash_prefix(content, node.range()))
}

/// Extract `(key, raw_value_source)` pairs from the named arguments of the
/// `#note(...)` call. Positional and spread arguments are skipped (the
/// `#note` API only takes named args; if a malformed call mixes types, we
/// surface the named ones and ignore the rest).
///
/// `raw_value_source` is the exact substring from the source — preserves
/// `datetime(...)` calls, nested arrays, escapes, and Unicode untouched.
pub fn extract_note_properties(content: &str) -> Vec<(String, String)> {
    let root = parse(content);
    let link = LinkedNode::new(&root);
    let Some(call_link) = find_note_call_node(&link) else {
        return Vec::new();
    };
    collect_named_args(&call_link, content)
        .into_iter()
        .map(|named| (named.key, content[named.value_range].to_string()))
        .collect()
}

/// One named argument extracted from a `#note(...)` call, with byte ranges
/// resolved against the source so callers can do range-based edits.
struct CollectedNamed {
    key: String,
    /// Range of the value expression in the source (does not include the
    /// `key:` prefix or any surrounding whitespace).
    value_range: Range<usize>,
}

/// Collect every named arg under a FuncCall LinkedNode. Walks the typed
/// AST for the keys and uses the LinkedNode tree to recover byte ranges
/// for the value expressions — neither piece alone is sufficient (typed
/// AST loses absolute offsets, raw LinkedNode loses the parsed identifier
/// shape).
fn collect_named_args<'a>(
    call_link: &LinkedNode<'a>,
    _content: &str,
) -> Vec<CollectedNamed> {
    let mut out = Vec::new();
    let Some(args_link) = call_link
        .children()
        .find(|c| c.kind() == SyntaxKind::Args)
    else {
        return out;
    };

    for child in args_link.children() {
        if child.kind() != SyntaxKind::Named {
            continue;
        }
        let Some(named_ast) = child.cast::<ast::Named>() else { continue };
        let key = named_ast.name().as_str().to_string();
        // The value is the last non-trivia child of the Named node. The
        // Named structure is `Ident Colon Expr` (with whitespace nodes
        // potentially interleaved), so the trailing non-trivia child is
        // always the expression.
        let value_range = child
            .children()
            .filter(|c| !is_trivia(c.kind()))
            .filter(|c| c.kind() != SyntaxKind::Ident && c.kind() != SyntaxKind::Colon)
            .last()
            .map(|c| c.range());
        let Some(value_range) = value_range else { continue };
        out.push(CollectedNamed { key, value_range });
    }
    out
}

/// Trivia kinds — whitespace, comments, parbreaks. Filtered out when
/// hunting for an expression node.
fn is_trivia(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::Space
            | SyntaxKind::Parbreak
            | SyntaxKind::LineComment
            | SyntaxKind::BlockComment
    )
}

/// Update a single property in the `#note(...)` call. If the call exists
/// and the key is present, the value is replaced. If the call exists but
/// the key is absent, a new named argument is appended. If no call exists
/// at all, one is materialized after the vault import line (or at the top
/// of the file when no import is present).
///
/// Args other than the one being updated are preserved with their exact
/// source bytes — nested datetimes, arrays, comments embedded in
/// expressions, and Unicode all round-trip cleanly.
pub fn update_note_property(content: &str, key: &str, value: &PropertyValue) -> String {
    let serialized = serialize_to_typst(value);
    let root = parse(content);
    let link = LinkedNode::new(&root);

    let Some(call_link) = find_note_call_node(&link) else {
        // No `#note(...)` yet — synthesize a minimal one and place it.
        let new_call = format_note_call(&[(key.to_string(), serialized)]);
        return insert_note_call(content, &new_call);
    };

    let existing = collect_named_args(&call_link, content);

    // Build a new args list: keep every existing key with its raw source
    // value, replacing the target key when matched and appending it when
    // not. Other arg kinds (positional, spread) don't appear in valid
    // `#note(...)` calls; if they show up in malformed input we drop them
    // — preserving them through this code path would surface invalid
    // syntax further down the pipeline anyway.
    let mut pieces: Vec<String> = Vec::new();
    let mut updated = false;
    for named in &existing {
        if named.key == key {
            pieces.push(format!("{}: {}", key, &serialized));
            updated = true;
        } else {
            pieces.push(format!("{}: {}", named.key, &content[named.value_range.clone()]));
        }
    }
    if !updated {
        pieces.push(format!("{}: {}", key, &serialized));
    }

    let new_call = render_pieces(&pieces);
    let span = span_with_hash_prefix(content, call_link.range());
    let mut out = String::with_capacity(content.len() + new_call.len());
    out.push_str(&content[..span.start]);
    out.push_str(&new_call);
    out.push_str(&content[span.end..]);
    out
}

/// Remove a single property from the `#note(...)` call. If the removed
/// property was the last one, the entire call (and a single trailing
/// blank line) is removed. Returns `content` unchanged when the call or
/// the key is missing.
pub fn remove_note_property(content: &str, key: &str) -> String {
    let root = parse(content);
    let link = LinkedNode::new(&root);
    let Some(call_link) = find_note_call_node(&link) else {
        return content.to_string();
    };

    let existing = collect_named_args(&call_link, content);
    let pieces: Vec<String> = existing
        .iter()
        .filter(|n| n.key != key)
        .map(|n| format!("{}: {}", n.key, &content[n.value_range.clone()]))
        .collect();

    let span = span_with_hash_prefix(content, call_link.range());
    if pieces.is_empty() {
        // Remove the entire call. Also eat one trailing newline (and a
        // following blank-line-leading newline if present) so we don't
        // leave a hanging blank where the call used to live.
        let bytes = content.as_bytes();
        let mut end = span.end;
        if end < bytes.len() && bytes[end] == b'\n' {
            end += 1;
        }
        if end < bytes.len() && bytes[end] == b'\n' {
            end += 1;
        }
        let mut out = String::with_capacity(content.len());
        out.push_str(&content[..span.start]);
        out.push_str(&content[end..]);
        out
    } else {
        let new_call = render_pieces(&pieces);
        let mut out = String::with_capacity(content.len() + new_call.len());
        out.push_str(&content[..span.start]);
        out.push_str(&new_call);
        out.push_str(&content[span.end..]);
        out
    }
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/// Serialize a [`PropertyValue`] to Typst source syntax.
pub fn serialize_to_typst(value: &PropertyValue) -> String {
    match value {
        PropertyValue::Null => "none".to_string(),
        PropertyValue::Bool(b) => b.to_string(),
        PropertyValue::Number(n) => {
            if *n == (*n as i64) as f64 {
                format!("{}", *n as i64)
            } else {
                n.to_string()
            }
        }
        PropertyValue::String(s) => {
            // `[[Target]]` is the wikilink shorthand the property editor
            // uses for link-typed fields; serialize it as the equivalent
            // package call so the value participates in the link graph.
            if let Some(target) = s.strip_prefix("[[").and_then(|s| s.strip_suffix("]]")) {
                return format!("link-ref(\"{}\")", escape_typst_string(target));
            }
            format!("\"{}\"", escape_typst_string(s))
        }
        PropertyValue::List(items) => {
            let inner: Vec<String> = items.iter().map(serialize_to_typst).collect();
            if items.len() == 1 {
                // Single-element arrays need a trailing comma in Typst —
                // `(value)` parses as parenthesized grouping.
                format!("({},)", inner[0])
            } else {
                format!("({})", inner.join(", "))
            }
        }
    }
}

fn escape_typst_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Render the existing argument fragments back into a `#note(...)` call.
/// Single-arg calls stay on one line; multi-arg calls go multiline with a
/// two-space indent and trailing comma to match the project style.
fn render_pieces(pieces: &[String]) -> String {
    if pieces.is_empty() {
        return "#note()".to_string();
    }
    if pieces.len() == 1 {
        return format!("#note({})", pieces[0]);
    }
    let lines: Vec<String> = pieces.iter().map(|p| format!("  {},", p)).collect();
    format!("#note(\n{}\n)", lines.join("\n"))
}

/// Same single-vs-multiline shape, but takes (key, value) pairs — used
/// only to materialize a fresh call when none exists.
fn format_note_call(args: &[(String, String)]) -> String {
    if args.is_empty() {
        return "#note()".to_string();
    }
    if args.len() == 1 {
        return format!("#note({}: {})", args[0].0, args[0].1);
    }
    let lines: Vec<String> = args
        .iter()
        .map(|(k, v)| format!("  {}: {},", k, v))
        .collect();
    format!("#note(\n{}\n)", lines.join("\n"))
}

/// Insert a fresh `#note(...)` call into a document that doesn't have one.
/// Lands it immediately after the vault import line; falls back to the top
/// of the file if no import line is present.
fn insert_note_call(content: &str, call: &str) -> String {
    for (i, line) in content.lines().enumerate() {
        if crate::vault_package::is_vault_import_line(line) {
            let line_end = content
                .match_indices('\n')
                .nth(i)
                .map(|(pos, _)| pos + 1)
                .unwrap_or(content.len());
            return format!("{}{}\n{}", &content[..line_end], call, &content[line_end..]);
        }
    }
    format!("{}\n{}", call, content)
}

/// Convert a raw Typst value fragment (e.g. `"draft"`, `("a", "b")`,
/// `link-ref("Target")`) to a plain-text string suitable for cache and
/// metadata embedding. Best-effort — anything more exotic than strings,
/// arrays, and `link-ref(...)` passes through as the trimmed source.
pub fn typst_value_to_plain_text(raw: &str) -> String {
    let trimmed = raw.trim();

    // Quoted string: "value" → value (with escapes unwrapped).
    if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        return trimmed[1..trimmed.len() - 1]
            .replace("\\\"", "\"")
            .replace("\\\\", "\\");
    }

    // Array: ("a", "b") → "a, b".
    if trimmed.starts_with('(') && trimmed.ends_with(')') {
        let inner = &trimmed[1..trimmed.len() - 1];
        let items: Vec<String> = inner
            .split(',')
            .map(|s| typst_value_to_plain_text(s.trim()))
            .filter(|s| !s.is_empty())
            .collect();
        return items.join(", ");
    }

    // link-ref("Target") → Target.
    if let Some(rest) = trimmed.strip_prefix("link-ref(") {
        if let Some(inner) = rest.strip_suffix(')') {
            return typst_value_to_plain_text(inner);
        }
    }

    trimmed.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"#import "/.inkycap/packages/inkycap-vault/0.1.0/lib.typ": *
#note(
  title: "Reading notes on Heidegger",
  date: datetime(year: 2026, month: 4, day: 29),
  tags: ("philosophy", "phenomenology"),
  status: "draft",
)

= Introduction

Some body text here.
"#;

    #[test]
    fn note_call_span_basic() {
        let span = note_call_span(SAMPLE).unwrap();
        let text = &SAMPLE[span];
        assert!(text.starts_with("#note("));
        assert!(text.ends_with(')'));
        assert!(text.contains("title:"));
    }

    #[test]
    fn note_call_span_missing() {
        let content = "#import \"lib.typ\": *\n= Heading\n";
        assert!(note_call_span(content).is_none());
    }

    #[test]
    fn extract_args_basic() {
        let args = extract_note_properties(SAMPLE);
        assert_eq!(args.len(), 4);
        assert_eq!(args[0].0, "title");
        assert_eq!(args[0].1, r#""Reading notes on Heidegger""#);
        assert_eq!(args[1].0, "date");
        assert!(args[1].1.starts_with("datetime("));
        assert_eq!(args[2].0, "tags");
        assert_eq!(args[2].1, r#"("philosophy", "phenomenology")"#);
        assert_eq!(args[3].0, "status");
        assert_eq!(args[3].1, r#""draft""#);
    }

    #[test]
    fn update_existing_property() {
        let updated = update_note_property(
            SAMPLE,
            "status",
            &PropertyValue::String("published".into()),
        );
        assert!(updated.contains("status: \"published\""));
        assert!(updated.contains("title: \"Reading notes on Heidegger\""));
        assert!(updated.contains("= Introduction"));
    }

    #[test]
    fn add_new_property() {
        let updated =
            update_note_property(SAMPLE, "chapter", &PropertyValue::Number(3.0));
        assert!(updated.contains("chapter: 3"));
        assert!(updated.contains("title: \"Reading notes on Heidegger\""));
    }

    #[test]
    fn remove_property() {
        let updated = remove_note_property(SAMPLE, "status");
        assert!(!updated.contains("status:"));
        assert!(updated.contains("title: \"Reading notes on Heidegger\""));
        assert!(updated.contains("= Introduction"));
    }

    #[test]
    fn remove_last_property_dematerializes() {
        let content = "#import \"/.inkycap/packages/inkycap-vault/0.1.0/lib.typ\": *\n#note(title: \"Hello\")\n\n= Body\n";
        let updated = remove_note_property(content, "title");
        assert!(!updated.contains("#note"));
        assert!(updated.contains("= Body"));
    }

    #[test]
    fn materialize_note_call() {
        let content =
            "#import \"/.inkycap/packages/inkycap-vault/0.1.0/lib.typ\": *\n\n= Body\n";
        let updated = update_note_property(
            content,
            "title",
            &PropertyValue::String("New".into()),
        );
        assert!(updated.contains("#note(title: \"New\")"));
        assert!(updated.contains("= Body"));
        let note_pos = updated.find("#note").unwrap();
        let import_pos = updated.find("#import").unwrap();
        assert!(note_pos > import_pos);
    }

    #[test]
    fn serialize_list() {
        let v = PropertyValue::List(vec![
            PropertyValue::String("a".into()),
            PropertyValue::String("b".into()),
        ]);
        assert_eq!(serialize_to_typst(&v), "(\"a\", \"b\")");
    }

    #[test]
    fn serialize_single_element_list() {
        let v = PropertyValue::List(vec![PropertyValue::String("only".into())]);
        assert_eq!(serialize_to_typst(&v), "(\"only\",)");
    }

    #[test]
    fn serialize_wikilink() {
        let v = PropertyValue::String("[[Being and Time]]".into());
        assert_eq!(serialize_to_typst(&v), "link-ref(\"Being and Time\")");
    }

    #[test]
    fn roundtrip_preserves_complex_values() {
        let updated = update_note_property(
            SAMPLE,
            "title",
            &PropertyValue::String("New Title".into()),
        );
        assert!(updated.contains("datetime(year: 2026, month: 4, day: 29)"));
        assert!(updated.contains("(\"philosophy\", \"phenomenology\")"));
    }

    #[test]
    fn handles_string_with_quotes() {
        let updated = update_note_property(
            SAMPLE,
            "title",
            &PropertyValue::String("He said \"hello\"".into()),
        );
        assert!(updated.contains(r#"title: "He said \"hello\"""#));
    }

    /// Multi-byte UTF-8 in property values must round-trip without
    /// corruption — the AST byte ranges always land on char boundaries
    /// so slicing into the source is safe.
    #[test]
    fn roundtrip_preserves_unicode() {
        let src = r#"#import "/.inkycap/packages/inkycap-vault/0.1.0/lib.typ": *
#note(
  title: "L'« Être » et le temps — α/β/γ",
  description: "中文 العربية русский",
)

= Тело
"#;
        let updated =
            update_note_property(src, "status", &PropertyValue::String("draft".into()));
        assert!(updated.contains("L'« Être » et le temps — α/β/γ"));
        assert!(updated.contains("中文 العربية русский"));
        assert!(updated.contains("= Тело"));
        assert!(updated.contains("status: \"draft\""));
    }

    /// Comments inside the call's arg list must not corrupt the parse —
    /// the AST hands us byte ranges that ignore the comments.
    #[test]
    fn tolerates_inline_comments() {
        let src = "#import \"/.inkycap/packages/inkycap-vault/0.1.0/lib.typ\": *\n\
            #note(\n  title: \"X\", // inline comment\n  status: \"draft\",\n)\n\n= H\n";
        let updated =
            update_note_property(src, "status", &PropertyValue::String("done".into()));
        assert!(updated.contains("status: \"done\""));
        assert!(updated.contains("title: \"X\""));
    }
}
