//! Source-level rewriter for `#note(...)` calls in `.typ` files.
//!
//! Operates on raw text — no Typst compilation needed. Supports:
//! - Finding the `#note(...)` call (typically near file top, after import)
//! - Updating a single named argument
//! - Adding a new named argument
//! - Removing a named argument
//! - Materializing a new `#note(...)` when none exists
//! - Dematerializing (removing) when all properties are gone

use crate::models::note::PropertyValue;

/// Byte range of the `#note(...)` call in the source, including the leading `#`.
#[derive(Debug, Clone, Copy)]
struct NoteCallSpan {
    start: usize,
    end: usize,
}

/// Find the `#note(` call and its matching `)`. Returns the byte range
/// of the full `#note(...)` expression. Only finds top-level calls (not
/// inside other function calls or code blocks).
fn find_note_call(content: &str) -> Option<NoteCallSpan> {
    let needle = "#note(";
    let start = content.find(needle)?;

    // Walk forward from the opening `(` to find the balanced `)`.
    let paren_start = start + needle.len() - 1; // index of '('
    let end = find_matching_paren(content, paren_start)?;

    Some(NoteCallSpan {
        start,
        end: end + 1, // include the closing ')'
    })
}

/// Starting from an opening `(` at `pos`, find its matching `)`.
/// Respects nested parens, brackets, braces, and string literals.
fn find_matching_paren(content: &str, pos: usize) -> Option<usize> {
    let bytes = content.as_bytes();
    if bytes.get(pos).copied() != Some(b'(') {
        return None;
    }

    let mut depth: usize = 1;
    let mut i = pos + 1;
    while i < bytes.len() && depth > 0 {
        match bytes[i] {
            b'"' => {
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\\' {
                        i += 2;
                        continue;
                    }
                    if bytes[i] == b'"' {
                        break;
                    }
                    i += 1;
                }
            }
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            b'[' => {
                // Content blocks — find matching ]
                let mut bdepth: usize = 1;
                i += 1;
                while i < bytes.len() && bdepth > 0 {
                    match bytes[i] {
                        b'[' => bdepth += 1,
                        b']' => bdepth -= 1,
                        b'"' => {
                            i += 1;
                            while i < bytes.len() {
                                if bytes[i] == b'\\' {
                                    i += 2;
                                    continue;
                                }
                                if bytes[i] == b'"' {
                                    break;
                                }
                                i += 1;
                            }
                        }
                        _ => {}
                    }
                    i += 1;
                }
                continue; // i already advanced past ]
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Parse the arguments inside the `#note(...)` call into (key, raw_value)
/// pairs. `inner` is the text between the outer parens (exclusive).
/// Each entry preserves the exact source text of the value (for round-trip).
fn parse_note_args(inner: &str) -> Vec<(String, String)> {
    let mut args: Vec<(String, String)> = Vec::new();
    let bytes = inner.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        // Skip whitespace and commas
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b',') {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }

        // Parse key: look for `identifier:`
        let key_start = i;
        while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'-') {
            i += 1;
        }
        // Skip whitespace before colon
        let mut colon_i = i;
        while colon_i < bytes.len() && bytes[colon_i].is_ascii_whitespace() {
            colon_i += 1;
        }
        if colon_i >= bytes.len() || bytes[colon_i] != b':' {
            break; // not a named arg — bail
        }
        let key = inner[key_start..i].to_string();
        i = colon_i + 1; // skip the colon

        // Skip whitespace after colon
        while i < bytes.len() && bytes[i] == b' ' {
            i += 1;
        }

        // Parse value — consume until we hit a comma at depth 0 or end
        let value_start = i;
        let value_end = find_value_end(bytes, i);
        let raw_value = inner[value_start..value_end].trim_end().to_string();
        args.push((key, raw_value));
        i = value_end;
    }
    args
}

/// Find the end of a value expression starting at `start`.
/// Stops at a top-level comma or end of input.
fn find_value_end(bytes: &[u8], start: usize) -> usize {
    let mut i = start;
    let mut paren_depth: usize = 0;

    while i < bytes.len() {
        match bytes[i] {
            b',' if paren_depth == 0 => return i,
            b'"' => {
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\\' {
                        i += 2;
                        continue;
                    }
                    if bytes[i] == b'"' {
                        break;
                    }
                    i += 1;
                }
            }
            b'(' => paren_depth += 1,
            b')' => {
                if paren_depth == 0 {
                    return i;
                }
                paren_depth -= 1;
            }
            b'[' => {
                let mut bdepth: usize = 1;
                i += 1;
                while i < bytes.len() && bdepth > 0 {
                    match bytes[i] {
                        b'[' => bdepth += 1,
                        b']' => bdepth -= 1,
                        _ => {}
                    }
                    i += 1;
                }
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    i
}

/// Serialize a `PropertyValue` to Typst source syntax.
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
            // Check for wikilink syntax [[target]] → link-ref("target")
            if let Some(target) = s.strip_prefix("[[").and_then(|s| s.strip_suffix("]]")) {
                return format!("link-ref(\"{}\")", escape_typst_string(target));
            }
            format!("\"{}\"", escape_typst_string(s))
        }
        PropertyValue::List(items) => {
            let inner: Vec<String> = items.iter().map(serialize_to_typst).collect();
            if items.len() == 1 {
                // Typst requires a trailing comma for single-element arrays;
                // without it, ("value") is parsed as parenthesized grouping.
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

/// Update a single property in a `#note(...)` call. If no `#note(...)` exists,
/// materializes one after the import line. Returns the updated file content.
pub fn update_note_property(content: &str, key: &str, value: &PropertyValue) -> String {
    if let Some(span) = find_note_call(content) {
        let call_text = &content[span.start..span.end];
        let paren_open = call_text.find('(').unwrap();
        let inner = &call_text[paren_open + 1..call_text.len() - 1];
        let mut args = parse_note_args(inner);

        let serialized = serialize_to_typst(value);
        let mut found = false;
        for (k, v) in &mut args {
            if k == key {
                *v = serialized.clone();
                found = true;
                break;
            }
        }
        if !found {
            args.push((key.to_string(), serialized));
        }

        let new_call = rebuild_note_call(&args);
        format!("{}{}{}", &content[..span.start], new_call, &content[span.end..])
    } else {
        // Materialize a new #note(...) call
        let serialized = serialize_to_typst(value);
        let new_call = rebuild_note_call(&[(key.to_string(), serialized)]);
        insert_note_call(content, &new_call)
    }
}

/// Remove a single property from a `#note(...)` call. If it was the last
/// property, removes the entire call. Returns the updated file content.
pub fn remove_note_property(content: &str, key: &str) -> String {
    let Some(span) = find_note_call(content) else {
        return content.to_string();
    };

    let call_text = &content[span.start..span.end];
    let paren_open = call_text.find('(').unwrap();
    let inner = &call_text[paren_open + 1..call_text.len() - 1];
    let args = parse_note_args(inner);

    let filtered: Vec<(String, String)> = args
        .into_iter()
        .filter(|(k, _)| k != key)
        .collect();

    if filtered.is_empty() {
        // Remove the entire #note(...) call and its trailing newline(s)
        let mut end = span.end;
        let bytes = content.as_bytes();
        // Consume trailing newline
        if end < bytes.len() && bytes[end] == b'\n' {
            end += 1;
        }
        // Consume one more blank line if present
        if end < bytes.len() && bytes[end] == b'\n' {
            end += 1;
        }
        format!("{}{}", &content[..span.start], &content[end..])
    } else {
        let new_call = rebuild_note_call(&filtered);
        format!("{}{}{}", &content[..span.start], new_call, &content[span.end..])
    }
}

/// Rebuild the `#note(...)` call text from a list of (key, value) pairs.
fn rebuild_note_call(args: &[(String, String)]) -> String {
    if args.is_empty() {
        return "#note()".to_string();
    }
    if args.len() == 1 {
        return format!("#note({}: {})", args[0].0, args[0].1);
    }
    let mut lines: Vec<String> = Vec::with_capacity(args.len());
    for (key, value) in args {
        lines.push(format!("  {}: {},", key, value));
    }
    format!("#note(\n{}\n)", lines.join("\n"))
}

/// Insert a `#note(...)` call into content that doesn't have one.
/// Places it after the import line, or at the top if no import.
fn insert_note_call(content: &str, call: &str) -> String {
    let import_prefix = "#import \"/.inkycap/packages/inkycap-vault/";

    for (i, line) in content.lines().enumerate() {
        if line.starts_with(import_prefix) {
            // Insert after this line
            let line_end = content
                .match_indices('\n')
                .nth(i)
                .map(|(pos, _)| pos + 1)
                .unwrap_or(content.len());
            return format!("{}{}\n{}", &content[..line_end], call, &content[line_end..]);
        }
    }

    // No import line — insert at the very top
    format!("{}\n{}", call, content)
}

/// Return the byte range `start..end` of the `#note(...)` call, or `None`.
pub fn note_call_span(content: &str) -> Option<std::ops::Range<usize>> {
    find_note_call(content).map(|s| s.start..s.end)
}

/// Extract raw key-value pairs from the `#note(...)` call in source text.
/// Returns an empty vec if no `#note(...)` is present. Values are raw Typst
/// source fragments (e.g. `"draft"`, `("a", "b")`).
pub fn extract_note_properties(content: &str) -> Vec<(String, String)> {
    let Some(span) = find_note_call(content) else {
        return Vec::new();
    };
    let call_text = &content[span.start..span.end];
    let paren_open = call_text.find('(').unwrap();
    let inner = &call_text[paren_open + 1..call_text.len() - 1];
    parse_note_args(inner)
}

/// Convert a raw Typst value fragment to a plain-text string suitable for
/// metadata embedding. Strips quotes, flattens arrays to comma-separated,
/// and passes through other values as-is.
pub fn typst_value_to_plain_text(raw: &str) -> String {
    let trimmed = raw.trim();

    // Quoted string: "value" → value
    if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        return trimmed[1..trimmed.len() - 1]
            .replace("\\\"", "\"")
            .replace("\\\\", "\\");
    }

    // Array: ("a", "b") → a, b
    if trimmed.starts_with('(') && trimmed.ends_with(')') {
        let inner = &trimmed[1..trimmed.len() - 1];
        let items: Vec<String> = inner
            .split(',')
            .map(|s| typst_value_to_plain_text(s.trim()))
            .filter(|s| !s.is_empty())
            .collect();
        return items.join(", ");
    }

    // link-ref("Target") → Target
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
    fn find_note_call_basic() {
        let span = find_note_call(SAMPLE).unwrap();
        let text = &SAMPLE[span.start..span.end];
        assert!(text.starts_with("#note("));
        assert!(text.ends_with(')'));
        assert!(text.contains("title:"));
    }

    #[test]
    fn find_note_call_missing() {
        let content = "#import \"lib.typ\": *\n= Heading\n";
        assert!(find_note_call(content).is_none());
    }

    #[test]
    fn parse_args() {
        let inner = r#"
  title: "Hello",
  date: datetime(year: 2026, month: 4, day: 29),
  tags: ("a", "b"),
  status: "draft",
"#;
        let args = parse_note_args(inner);
        assert_eq!(args.len(), 4);
        assert_eq!(args[0].0, "title");
        assert_eq!(args[0].1, r#""Hello""#);
        assert_eq!(args[1].0, "date");
        assert!(args[1].1.starts_with("datetime("));
        assert_eq!(args[2].0, "tags");
        assert_eq!(args[2].1, r#"("a", "b")"#);
        assert_eq!(args[3].0, "status");
        assert_eq!(args[3].1, r#""draft""#);
    }

    #[test]
    fn update_existing_property() {
        let updated = update_note_property(SAMPLE, "status", &PropertyValue::String("published".into()));
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
        let content = "#import \"/.inkycap/packages/inkycap-vault/0.1.0/lib.typ\": *\n#note(title: \"Hello\")\n\n= Body\n";
        let updated = remove_note_property(&content, "title");
        assert!(!updated.contains("#note"));
        assert!(updated.contains("= Body"));
    }

    #[test]
    fn materialize_note_call() {
        let content = "#import \"/.inkycap/packages/inkycap-vault/0.1.0/lib.typ\": *\n\n= Body\n";
        let updated = update_note_property(content, "title", &PropertyValue::String("New".into()));
        assert!(updated.contains("#note(title: \"New\")"));
        assert!(updated.contains("= Body"));
        // Should be after the import line
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
        // Updating one key should not disturb datetime or other complex values
        let updated = update_note_property(SAMPLE, "title", &PropertyValue::String("New Title".into()));
        assert!(updated.contains("datetime(year: 2026, month: 4, day: 29)"));
        assert!(updated.contains("(\"philosophy\", \"phenomenology\")"));
    }

    #[test]
    fn handles_string_with_quotes() {
        let updated = update_note_property(SAMPLE, "title", &PropertyValue::String("He said \"hello\"".into()));
        assert!(updated.contains(r#"title: "He said \"hello\"""#));
    }
}
