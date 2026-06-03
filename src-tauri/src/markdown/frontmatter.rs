// Shared YAML frontmatter parsing for markdown import.
//
// Both the import-time scan (`scan_markdown_frontmatter`, which builds the
// property-mapping grid the user confirms) and the conversion-time emit
// (`frontmatter_to_note*` in `md_to_typst`) parse frontmatter through the
// one function here, so the keys the user maps are exactly the keys that
// get written. Parsing goes through `serde_yaml` rather than a hand-rolled
// line scanner — per CLAUDE.md's Typst-first / don't-reimplement-a-parser
// principle — which means block-style lists (`tags:\n  - a\n  - b`), typed
// scalars, booleans, and numbers all parse correctly instead of being
// silently dropped.

use crate::property_types::PropertyType;

/// One frontmatter field, with its raw key and a value that remembers
/// whether YAML gave us a scalar or a sequence (and, for scalars, the
/// type `serde_yaml` decoded).
#[derive(Debug, Clone)]
pub struct ParsedField {
    /// The key exactly as authored (trimmed), e.g. `"Created"`.
    pub key: String,
    pub value: ParsedYamlValue,
}

/// A parsed frontmatter value. Lists stay lists so a multi-tag field
/// round-trips into a Typst tuple; scalars carry the type YAML implied so
/// the scan can suggest `Number`/`Checkbox`/`Date` without re-guessing.
#[derive(Debug, Clone)]
pub enum ParsedYamlValue {
    Scalar { raw: String, ty: PropertyType },
    List(Vec<String>),
}

impl ParsedYamlValue {
    /// The property type this value most naturally maps to. Lists →
    /// `List`; scalars carry their decoded type.
    pub fn inferred_type(&self) -> PropertyType {
        match self {
            ParsedYamlValue::List(_) => PropertyType::List,
            ParsedYamlValue::Scalar { ty, .. } => *ty,
        }
    }

    /// A short representative string for display in the mapping grid.
    pub fn sample(&self) -> String {
        match self {
            ParsedYamlValue::Scalar { raw, .. } => raw.clone(),
            ParsedYamlValue::List(items) => format!("[{}]", items.join(", ")),
        }
    }
}

/// Parse YAML frontmatter into an ordered list of fields. Order follows the
/// source document. Null/empty values and nested mappings are skipped (a
/// `#note(...)` argument can't be a bare mapping). A document that isn't a
/// top-level YAML mapping yields an empty list.
pub fn parse_frontmatter_fields(yaml: &str) -> Vec<ParsedField> {
    let value: serde_yaml::Value = match serde_yaml::from_str(yaml) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let serde_yaml::Value::Mapping(map) = value else {
        return Vec::new();
    };

    let mut fields = Vec::new();
    for (k, v) in map {
        let Some(key) = scalar_to_string(&k) else {
            continue;
        };
        let key = key.trim().to_string();
        if key.is_empty() {
            continue;
        }
        if let Some(parsed) = convert_value(&v) {
            fields.push(ParsedField { key, value: parsed });
        }
    }
    fields
}

/// Convert a `serde_yaml::Value` into a `ParsedYamlValue`, or `None` for
/// values that don't belong in a `#note(...)` call (null, empty, nested
/// mappings).
fn convert_value(v: &serde_yaml::Value) -> Option<ParsedYamlValue> {
    match v {
        serde_yaml::Value::Null => None,
        serde_yaml::Value::Bool(b) => Some(ParsedYamlValue::Scalar {
            raw: b.to_string(),
            ty: PropertyType::Checkbox,
        }),
        serde_yaml::Value::Number(n) => Some(ParsedYamlValue::Scalar {
            raw: n.to_string(),
            ty: PropertyType::Number,
        }),
        serde_yaml::Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return None;
            }
            let ty = if looks_like_date(trimmed) {
                PropertyType::Date
            } else {
                PropertyType::Text
            };
            Some(ParsedYamlValue::Scalar { raw: s.clone(), ty })
        }
        serde_yaml::Value::Sequence(items) => {
            let strings: Vec<String> = items.iter().filter_map(scalar_to_string).collect();
            if strings.is_empty() {
                None
            } else {
                Some(ParsedYamlValue::List(strings))
            }
        }
        // Nested mappings / tagged values have no sensible single-argument
        // representation — drop them.
        _ => None,
    }
}

/// Stringify a scalar YAML value (used for keys and list items). Mappings
/// and sequences return `None`.
fn scalar_to_string(v: &serde_yaml::Value) -> Option<String> {
    match v {
        serde_yaml::Value::String(s) => Some(s.clone()),
        serde_yaml::Value::Number(n) => Some(n.to_string()),
        serde_yaml::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// Heuristic date detection: a leading ISO `YYYY-MM-DD`. `serde_yaml` has no
/// date type, so unquoted timestamps arrive as strings — this lets the scan
/// suggest the `Date` editor for them.
fn looks_like_date(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() < 10 {
        return false;
    }
    let is_digit = |i: usize| bytes[i].is_ascii_digit();
    is_digit(0)
        && is_digit(1)
        && is_digit(2)
        && is_digit(3)
        && bytes[4] == b'-'
        && is_digit(5)
        && is_digit(6)
        && bytes[7] == b'-'
        && is_digit(8)
        && is_digit(9)
}

/// Map a common frontmatter key (case-insensitively) to the InkyCap system
/// property it should default to. Covers the Obsidian/CommonMark aliases the
/// importer has always understood (`created`→`date`, `summary`→`description`,
/// `url`→`source`, …). Returns `None` for keys with no system equivalent.
pub fn system_alias(key: &str) -> Option<&'static str> {
    match key.trim().to_lowercase().as_str() {
        "title" => Some("title"),
        "tags" | "tag" => Some("tags"),
        "aliases" | "alias" => Some("aliases"),
        "date" | "created" => Some("date"),
        "due" => Some("due"),
        "description" | "summary" => Some("description"),
        "collection" | "collections" => Some("collection"),
        "source" | "url" => Some("source"),
        "task" => Some("task"),
        "zid" => Some("zid"),
        _ => None,
    }
}

/// Coerce an arbitrary frontmatter key into a valid Typst identifier so it
/// can be used as a `#note(...)` argument name when auto-creating a property.
/// Lowercases, replaces runs of invalid characters with `-`, and ensures a
/// leading letter. Falls back to `"field"` for an otherwise-empty result.
pub fn sanitize_ident(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    let mut prev_dash = false;
    for ch in key.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if ch == '_' || ch == '-' {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            // Collapse any run of invalid characters (spaces, punctuation,
            // multi-byte symbols) into a single dash.
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() || !trimmed.chars().next().unwrap().is_ascii_alphabetic() {
        format!("field-{}", trimmed)
            .trim_end_matches('-')
            .to_string()
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_block_style_list() {
        let yaml = "tags:\n  - foo\n  - bar\ntitle: Hello";
        let fields = parse_frontmatter_fields(yaml);
        assert_eq!(fields.len(), 2);
        let tags = &fields.iter().find(|f| f.key == "tags").unwrap().value;
        match tags {
            ParsedYamlValue::List(items) => assert_eq!(items, &vec!["foo", "bar"]),
            other => panic!("expected list, got {other:?}"),
        }
    }

    #[test]
    fn parses_inline_list() {
        let fields = parse_frontmatter_fields("tags: [a, b, c]");
        match &fields[0].value {
            ParsedYamlValue::List(items) => assert_eq!(items, &vec!["a", "b", "c"]),
            other => panic!("expected list, got {other:?}"),
        }
    }

    #[test]
    fn infers_scalar_types() {
        let fields =
            parse_frontmatter_fields("count: 42\nflag: true\nwhen: 2024-01-15\nname: Widget");
        let ty = |k: &str| {
            fields
                .iter()
                .find(|f| f.key == k)
                .unwrap()
                .value
                .inferred_type()
        };
        assert_eq!(ty("count"), PropertyType::Number);
        assert_eq!(ty("flag"), PropertyType::Checkbox);
        assert_eq!(ty("when"), PropertyType::Date);
        assert_eq!(ty("name"), PropertyType::Text);
    }

    #[test]
    fn skips_empty_and_nested() {
        let fields = parse_frontmatter_fields("empty:\nnested:\n  a: 1\nkept: yes");
        // `empty` (null) and `nested` (mapping) are dropped; `kept` survives.
        assert_eq!(fields.len(), 1);
        assert_eq!(fields[0].key, "kept");
    }

    #[test]
    fn system_aliases_resolve() {
        assert_eq!(system_alias("created"), Some("date"));
        assert_eq!(system_alias("URL"), Some("source"));
        assert_eq!(system_alias("Summary"), Some("description"));
        assert_eq!(system_alias("custom"), None);
    }

    #[test]
    fn sanitizes_idents() {
        assert_eq!(sanitize_ident("My Field"), "my-field");
        assert_eq!(sanitize_ident("foo/bar:baz"), "foo-bar-baz");
        assert_eq!(sanitize_ident("123start"), "field-123start");
        assert_eq!(sanitize_ident("  spaced  "), "spaced");
    }
}
