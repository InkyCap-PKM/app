//! Rewrites the `#note(...)` call in `.typ` source using `typst::syntax`: the
//! document is parsed as the compiler would, and edits work on the nodes' byte
//! ranges. So:
//!
//! - multi-byte text is untouched (ranges land on character boundaries);
//! - the source of arguments not being changed is kept exactly
//!   (`datetime(...)`, nested arrays, escaped strings);
//! - everything outside the `#note(...)` call is kept byte for byte.
//!
//! Public API:
//! - [`update_note_property`]: set or add a property
//! - [`remove_note_property`]: remove a property, and the call when it becomes
//!   empty
//! - [`note_call_span`]: byte range of the `#note(...)` call, including `#`
//! - [`extract_note_properties`]: (key, raw value source) pairs
//! - [`serialize_to_typst`]: a [`PropertyValue`] as Typst source
//! - [`typst_value_to_plain_text`]: raw Typst value as plain text, best effort

use std::ops::Range;

use typst::syntax::{ast, parse, parse_code, LinkedNode, SyntaxKind};

use crate::models::note::PropertyValue;

// ---------------------------------------------------------------------------
// AST navigation
// ---------------------------------------------------------------------------

/// The first `FuncCall` whose callee is `note`, depth-first. Uses `LinkedNode`
/// for absolute byte ranges.
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

/// Extend a call's range to include the `#`: in markup, `#note(...)` is a
/// `Hash` token followed by a `FuncCall` covering `note(...)`.
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

/// `(key, raw_value_source)` for each named argument of the `#note(...)` call;
/// positional and spread arguments are skipped. `raw_value_source` is the exact
/// source text of the value.
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

/// Every named argument of a call: keys from the typed AST, value ranges from
/// the LinkedNode tree (each alone lacks one of the two).
fn collect_named_args<'a>(call_link: &LinkedNode<'a>, _content: &str) -> Vec<CollectedNamed> {
    let mut out = Vec::new();
    let Some(args_link) = call_link.children().find(|c| c.kind() == SyntaxKind::Args) else {
        return out;
    };

    for child in args_link.children() {
        if child.kind() != SyntaxKind::Named {
            continue;
        }
        let Some(named_ast) = child.cast::<ast::Named>() else {
            continue;
        };
        let key = named_ast.name().as_str().to_string();
        // `Named` is `Ident Colon Expr`, possibly with whitespace, so the last
        // non-trivia child is the value.
        let value_range = child
            .children()
            .filter(|c| !is_trivia(c.kind()))
            .filter(|c| c.kind() != SyntaxKind::Ident && c.kind() != SyntaxKind::Colon)
            .last()
            .map(|c| c.range());
        let Some(value_range) = value_range else {
            continue;
        };
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

/// Set one property in `#note(...)`: replace its value, or append it. Without a
/// call, one is added after the notebox import (or at the top without an
/// import). Other arguments keep their exact source.
pub fn update_note_property(content: &str, key: &str, value: &PropertyValue) -> String {
    set_note_property_raw(content, key, &serialize_to_typst(value))
}

/// Add `link-ref("<name>")` to the list in property `key`, keeping existing
/// entries' source. A missing property becomes a one-item list; a single value
/// becomes the first item. `None` if the list already links to `name` (ignoring
/// case).
pub fn append_link_ref(content: &str, key: &str, name: &str) -> Option<String> {
    let existing = extract_note_properties(content)
        .into_iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v);
    let mut items: Vec<String> = match existing.as_deref().map(str::trim) {
        None | Some("none") | Some("()") | Some("") => Vec::new(),
        Some(raw) => array_items(raw).unwrap_or_else(|| vec![raw.to_string()]),
    };
    let wanted = name.trim().to_lowercase();
    if items
        .iter()
        .any(|item| link_ref_target(item).is_some_and(|t| t.trim().to_lowercase() == wanted))
    {
        return None;
    }
    items.push(format!(
        "link-ref(\"{}\")",
        escape_typst_string(name.trim())
    ));
    // A one-item array needs its trailing comma, or Typst reads parentheses.
    let raw = if items.len() == 1 {
        format!("({},)", items[0])
    } else {
        format!("({})", items.join(", "))
    };
    Some(set_note_property_raw(content, key, &raw))
}

/// The source of each item in an array literal, or `None` when `raw` is not
/// an array.
fn array_items(raw: &str) -> Option<Vec<String>> {
    let root = parse_code(raw);
    let root = LinkedNode::new(&root);
    let array = root.children().find(|c| c.kind() == SyntaxKind::Array)?;
    Some(
        array
            .children()
            .filter(|c| {
                !matches!(
                    c.kind(),
                    SyntaxKind::LeftParen
                        | SyntaxKind::RightParen
                        | SyntaxKind::Comma
                        | SyntaxKind::Space
                        | SyntaxKind::LineComment
                        | SyntaxKind::BlockComment
                )
            })
            .map(|c| raw[c.range()].to_string())
            .collect(),
    )
}

/// The note name in a `link-ref("…")` expression.
fn link_ref_target(raw: &str) -> Option<String> {
    let root = parse_code(raw);
    let root = LinkedNode::new(&root);
    let call = root.children().find(|c| c.kind() == SyntaxKind::FuncCall)?;
    match call.cast::<ast::FuncCall>()?.callee() {
        ast::Expr::Ident(ident) if ident.as_str() == "link-ref" => {
            crate::typst_pipeline::query::first_string_positional_arg(&call)
        }
        _ => None,
    }
}

/// Like [`update_note_property`], with the value as raw Typst source (e.g.
/// `("a", "b")`, `datetime(year: 2026, month: 4, day: 29)`). Used by scaffold
/// insertion, which has values as source from another `#note(...)`.
pub fn set_note_property_raw(content: &str, key: &str, raw_value: &str) -> String {
    let serialized = raw_value.to_string();
    let root = parse(content);
    let link = LinkedNode::new(&root);

    let Some(call_link) = find_note_call_node(&link) else {
        // No `#note(...)` yet — synthesize a minimal one and place it.
        let new_call = format_note_call(&[(key.to_string(), serialized)]);
        return insert_note_call(content, &new_call);
    };

    let existing = collect_named_args(&call_link, content);

    // Keep each existing key with its raw value, replacing the target key or
    // appending it. Positional and spread arguments aren't valid in
    // `#note(...)` and are dropped.
    let mut pieces: Vec<String> = Vec::new();
    let mut updated = false;
    for named in &existing {
        if named.key == key {
            pieces.push(format!("{}: {}", key, &serialized));
            updated = true;
        } else {
            pieces.push(format!(
                "{}: {}",
                named.key,
                &content[named.value_range.clone()]
            ));
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

/// Reorder `#note(...)`'s named arguments to match `order`; keys not in `order`
/// keep their relative order at the end. Unchanged when there is no call or
/// nothing moves. Values keep their exact source.
pub fn reorder_note_properties(content: &str, order: &[String]) -> String {
    let root = parse(content);
    let link = LinkedNode::new(&root);
    let Some(call_link) = find_note_call_node(&link) else {
        return content.to_string();
    };
    let existing = collect_named_args(&call_link, content);
    if existing.is_empty() {
        return content.to_string();
    }

    let mut by_key: std::collections::HashMap<&str, &CollectedNamed> =
        std::collections::HashMap::with_capacity(existing.len());
    for n in &existing {
        by_key.insert(n.key.as_str(), n);
    }

    let mut placed: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut pieces: Vec<String> = Vec::with_capacity(existing.len());

    for key in order {
        if let Some(n) = by_key.get(key.as_str()) {
            if placed.insert(n.key.as_str()) {
                pieces.push(format!("{}: {}", n.key, &content[n.value_range.clone()]));
            }
        }
    }
    // Append any keys not mentioned in `order`, preserving original order.
    for n in &existing {
        if !placed.contains(n.key.as_str()) {
            pieces.push(format!("{}: {}", n.key, &content[n.value_range.clone()]));
        }
    }

    let new_call = render_pieces(&pieces);
    let span = span_with_hash_prefix(content, call_link.range());
    let mut out = String::with_capacity(content.len() + new_call.len());
    out.push_str(&content[..span.start]);
    out.push_str(&new_call);
    out.push_str(&content[span.end..]);
    out
}

/// Remove a property from `#note(...)`. If it was the last, remove the whole
/// call and one trailing blank line. Unchanged when the call or key is missing.
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
        // Remove the call and one trailing newline (two if a blank line
        // follows), so no gap is left.
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
            // `[[Target]]` (the property editor's wikilink shorthand) becomes
            // `link-ref(...)`, so it counts as a link.
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

/// Render the argument fragments as a `#note(...)` call: one line for a single
/// argument, otherwise one per line with a two-space indent and trailing comma.
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

/// Add a `#note(...)` call after the notebox import line, or at the top if
/// there is none.
fn insert_note_call(content: &str, call: &str) -> String {
    for (i, line) in content.lines().enumerate() {
        if crate::notebox_package::is_notebox_import_line(line) {
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

/// A raw Typst value (e.g. `"draft"`, `("a", "b")`, `link-ref("Target")`) as
/// plain text for the cache and metadata. Other forms come back as their
/// trimmed source.
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

    const SAMPLE: &str = r#"#import "/.inkycap/notebox.typ": *
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
        let updated =
            update_note_property(SAMPLE, "status", &PropertyValue::String("published".into()));
        assert!(updated.contains("status: \"published\""));
        assert!(updated.contains("title: \"Reading notes on Heidegger\""));
        assert!(updated.contains("= Introduction"));
    }

    #[test]
    fn add_new_property() {
        let updated = update_note_property(SAMPLE, "chapter", &PropertyValue::Number(3.0));
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
        let content = "#import \"/.inkycap/notebox.typ\": *\n#note(title: \"Hello\")\n\n= Body\n";
        let updated = remove_note_property(content, "title");
        assert!(!updated.contains("#note"));
        assert!(updated.contains("= Body"));
    }

    #[test]
    fn materialize_note_call() {
        let content = "#import \"/.inkycap/notebox.typ\": *\n\n= Body\n";
        let updated = update_note_property(content, "title", &PropertyValue::String("New".into()));
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
        let updated =
            update_note_property(SAMPLE, "title", &PropertyValue::String("New Title".into()));
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

    /// Multi-byte text in values round-trips intact.
    #[test]
    fn roundtrip_preserves_unicode() {
        let src = r#"#import "/.inkycap/notebox.typ": *
#note(
  title: "L'« Être » et le temps — α/β/γ",
  description: "中文 العربية русский",
)

= Тело
"#;
        let updated = update_note_property(src, "status", &PropertyValue::String("draft".into()));
        assert!(updated.contains("L'« Être » et le temps — α/β/γ"));
        assert!(updated.contains("中文 العربية русский"));
        assert!(updated.contains("= Тело"));
        assert!(updated.contains("status: \"draft\""));
    }

    #[test]
    fn reorder_basic() {
        let updated = reorder_note_properties(
            SAMPLE,
            &[
                "status".to_string(),
                "title".to_string(),
                "tags".to_string(),
                "date".to_string(),
            ],
        );
        let i_status = updated.find("status:").unwrap();
        let i_title = updated.find("title:").unwrap();
        let i_tags = updated.find("tags:").unwrap();
        let i_date = updated.find("date:").unwrap();
        assert!(i_status < i_title);
        assert!(i_title < i_tags);
        assert!(i_tags < i_date);
        // Body content untouched.
        assert!(updated.contains("= Introduction"));
        // Complex values still preserved exactly.
        assert!(updated.contains("datetime(year: 2026, month: 4, day: 29)"));
        assert!(updated.contains("(\"philosophy\", \"phenomenology\")"));
    }

    #[test]
    fn reorder_appends_unmentioned_keys() {
        // `order` only mentions a subset; missing keys should land at the
        // end in their original relative order.
        let updated = reorder_note_properties(SAMPLE, &["status".to_string()]);
        let i_status = updated.find("status:").unwrap();
        let i_title = updated.find("title:").unwrap();
        let i_date = updated.find("date:").unwrap();
        let i_tags = updated.find("tags:").unwrap();
        assert!(i_status < i_title);
        assert!(i_title < i_date);
        assert!(i_date < i_tags);
    }

    #[test]
    fn reorder_no_note_call_is_noop() {
        let content = "#import \"lib.typ\": *\n= Heading\n";
        let updated = reorder_note_properties(content, &["title".to_string()]);
        assert_eq!(updated, content);
    }

    /// Comments inside the call's arg list must not corrupt the parse —
    /// the AST hands us byte ranges that ignore the comments.
    #[test]
    fn tolerates_inline_comments() {
        let src = "#import \"/.inkycap/notebox.typ\": *\n\
            #note(\n  title: \"X\", // inline comment\n  status: \"draft\",\n)\n\n= H\n";
        let updated = update_note_property(src, "status", &PropertyValue::String("done".into()));
        assert!(updated.contains("status: \"done\""));
        assert!(updated.contains("title: \"X\""));
    }

    #[test]
    fn append_link_ref_creates_list() {
        let src = "#note(\n  title: \"Draft\",\n)\n\nBody.";
        let out = append_link_ref(src, "derived-from", "Sleep").unwrap();
        let props = extract_note_properties(&out);
        assert!(props.contains(&(
            "derived-from".to_string(),
            "(link-ref(\"Sleep\"),)".to_string()
        )));
        assert!(props.contains(&("title".to_string(), "\"Draft\"".to_string())));
        assert!(out.ends_with("\n\nBody."));
    }

    #[test]
    fn append_link_ref_keeps_entries_and_skips_repeats() {
        let src = "#note(derived-from: (link-ref(\"A\"), link-ref(\"Café\")))\nBody";
        let out = append_link_ref(src, "derived-from", "B").unwrap();
        let props = extract_note_properties(&out);
        assert_eq!(
            props.iter().find(|(k, _)| k == "derived-from").unwrap().1,
            "(link-ref(\"A\"), link-ref(\"Café\"), link-ref(\"B\"))"
        );
        assert!(append_link_ref(&out, "derived-from", "café").is_none());
    }

    #[test]
    fn append_link_ref_wraps_a_single_value() {
        let src = "#note(derived-from: link-ref(\"A\"))";
        let out = append_link_ref(src, "derived-from", "B").unwrap();
        assert!(out.contains("(link-ref(\"A\"), link-ref(\"B\"))"));
    }
}
