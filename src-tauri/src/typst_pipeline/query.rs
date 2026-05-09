//! Metadata extraction via Typst's introspector.
//!
//! After compiling a document, we query the introspector for the three
//! InkyCap labels (`<inkycap-note>`, `<inkycap-tag>`, `<inkycap-link>`) and
//! convert the attached `metadata(...)` values into Rust types that the
//! scanner and indexes consume.

use std::collections::HashMap;
use std::path::Path;

use typst::foundations::{Dict, Label, Selector, Value};
use typst::introspection::{Introspector, MetadataElem};
use typst::layout::PagedDocument;
use typst::utils::PicoStr;

use crate::models::note::PropertyValue;
use crate::typst_pipeline::compiler::TypstCompiler;

/// Extracted metadata from a single `.typ` file.
#[derive(Debug, Clone, Default)]
pub struct QueryResult {
    /// Properties from `#note(...)`. Does NOT include `file.*` properties.
    pub properties: HashMap<String, PropertyValue>,
    /// Tag names from both `#tag(...)` calls and `note(tags: ...)`.
    pub tags: Vec<String>,
    /// Raw wikilink target strings from `#wikilink(...)` and `link-ref(...)`.
    pub links: Vec<String>,
    /// Heading labels referenced by wikilinks with `label:` parameter.
    pub heading_labels: Vec<String>,
}

/// Query a compiled document for all InkyCap metadata.
pub fn query_document(document: &PagedDocument) -> QueryResult {
    let introspector = &document.introspector;
    let mut result = QueryResult::default();

    extract_note_metadata(introspector, &mut result);
    extract_tags(introspector, &mut result);
    extract_links(introspector, &mut result);

    result
}

/// Compile a file and extract metadata in one step. Returns
/// [`QueryResult::default()`] if the file fails to compile — callers that
/// need a graceful display for broken files (e.g. the property panel)
/// rely on the scanner's persisted [`MetadataCache`], which keeps the last
/// successful query result keyed by `(mtime, size)` and short-circuits
/// this function when the file hasn't changed since it last compiled.
///
/// Earlier versions of this module ran a hand-rolled raw-source extractor
/// when compilation failed; that has been removed because the source-text
/// fallback duplicated `note_rewriter`'s parsing surface and silently
/// disagreed with Typst's own evaluation in edge cases (single-element
/// tuples, `link-ref` round-trips, escape handling). For files that have
/// truly never compiled, an empty result is the honest answer.
///
/// [`MetadataCache`]: crate::cache::MetadataCache
pub fn compile_and_query(
    compiler: &mut TypstCompiler,
    abs_path: &Path,
    source: String,
) -> QueryResult {
    match compiler.compile_document(abs_path, source) {
        Some(document) => query_document(&document),
        None => QueryResult::default(),
    }
}

// ---------------------------------------------------------------------------
// Label selectors
// ---------------------------------------------------------------------------

fn label_selector(name: &str) -> Option<Selector> {
    let pico = PicoStr::intern(name);
    Label::new(pico).map(Selector::Label)
}

// ---------------------------------------------------------------------------
// <inkycap-note> — document-level metadata dict
// ---------------------------------------------------------------------------

fn extract_note_metadata(introspector: &Introspector, result: &mut QueryResult) {
    let Some(selector) = label_selector("inkycap-note") else {
        return;
    };
    let elements = introspector.query(&selector);

    for elem in elements.iter() {
        let Some(meta) = elem.to_packed::<MetadataElem>() else {
            continue;
        };
        let Value::Dict(dict) = &meta.value else {
            continue;
        };

        for (key, value) in dict.iter() {
            let key_str = key.as_str().to_string();

            if key_str == "tags" {
                if let Value::Array(arr) = value {
                    for item in arr.iter() {
                        if let Value::Str(s) = item {
                            let tag = s.as_str().to_string();
                            if !result.tags.contains(&tag) {
                                result.tags.push(tag);
                            }
                        }
                    }
                }
                // Also store in properties so the sidebar panel can display/edit them
                result
                    .properties
                    .insert(key_str, typst_value_to_property(value));
            } else {
                result
                    .properties
                    .insert(key_str, typst_value_to_property(value));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// <inkycap-tag> — inline tags
// ---------------------------------------------------------------------------

fn extract_tags(introspector: &Introspector, result: &mut QueryResult) {
    let Some(selector) = label_selector("inkycap-tag") else {
        return;
    };
    let elements = introspector.query(&selector);

    for elem in elements.iter() {
        let Some(meta) = elem.to_packed::<MetadataElem>() else {
            continue;
        };
        let Value::Dict(dict) = &meta.value else {
            continue;
        };

        if let Some(Value::Str(name)) = dict_get(dict, "name") {
            let tag = name.as_str().to_string();
            if !result.tags.contains(&tag) {
                result.tags.push(tag);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// <inkycap-link> — wikilinks and link-refs
// ---------------------------------------------------------------------------

fn extract_links(introspector: &Introspector, result: &mut QueryResult) {
    let Some(selector) = label_selector("inkycap-link") else {
        return;
    };
    let elements = introspector.query(&selector);

    for elem in elements.iter() {
        let Some(meta) = elem.to_packed::<MetadataElem>() else {
            continue;
        };
        let Value::Dict(dict) = &meta.value else {
            continue;
        };

        if let Some(Value::Str(target)) = dict_get(dict, "target") {
            result.links.push(target.as_str().to_string());
        }
        if let Some(Value::Str(label)) = dict_get(dict, "label") {
            result.heading_labels.push(label.as_str().to_string());
        }
    }
}

// ---------------------------------------------------------------------------
// Value conversion helpers
// ---------------------------------------------------------------------------

fn dict_get<'a>(dict: &'a Dict, key: &str) -> Option<&'a Value> {
    dict.get(key).ok()
}

fn typst_value_to_property(value: &Value) -> PropertyValue {
    match value {
        Value::Bool(b) => PropertyValue::Bool(*b),
        Value::Int(n) => PropertyValue::Number(*n as f64),
        Value::Float(f) => PropertyValue::Number(*f),
        Value::Str(s) => PropertyValue::String(s.as_str().to_string()),
        Value::Array(arr) => {
            let items: Vec<PropertyValue> = arr
                .iter()
                .map(|v| typst_value_to_property(v))
                .collect();
            PropertyValue::List(items)
        }
        Value::Dict(dict) => {
            // link-ref dicts → store as string "[[target]]"
            if let Some(Value::Str(kind)) = dict_get(dict, "kind") {
                if kind.as_str() == "link-ref" {
                    if let Some(Value::Str(target)) = dict_get(dict, "target") {
                        return PropertyValue::String(format!("[[{}]]", target.as_str()));
                    }
                }
            }
            PropertyValue::String(format!("{dict:?}"))
        }
        _ => PropertyValue::String(format!("{value:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::path::canonicalize_root;
    use std::fs;
    use tempfile::tempdir;

    fn setup_vault_with_package(source: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempdir().expect("tempdir");
        let root = canonicalize_root(dir.path()).expect("canonicalize");

        // Scaffold the package into the vault
        crate::vault_package::scaffold(&root);

        let note_path = root.join("test.typ");
        let full_source = format!(
            "{}\n\n{}",
            crate::vault_package::import_line(),
            source
        );
        fs::write(&note_path, &full_source).expect("write note");

        (dir, root)
    }

    #[test]
    fn extracts_note_metadata() {
        let (_dir, root) = setup_vault_with_package(
            r#"#note(title: "Test Note", status: "draft", tags: ("research", "typst"))"#,
        );
        let note_path = root.join("test.typ");
        let source = fs::read_to_string(&note_path).unwrap();

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source);

        assert_eq!(
            result.properties.get("title"),
            Some(&PropertyValue::String("Test Note".to_string()))
        );
        assert_eq!(
            result.properties.get("status"),
            Some(&PropertyValue::List(vec![PropertyValue::String("draft".to_string())]))
        );
        assert!(result.tags.contains(&"research".to_string()));
        assert!(result.tags.contains(&"typst".to_string()));
    }

    #[test]
    fn extracts_inline_tags() {
        let (_dir, root) = setup_vault_with_package(
            "Some text with #tag(\"important\") and #tag(\"review\") inline.",
        );
        let note_path = root.join("test.typ");
        let source = fs::read_to_string(&note_path).unwrap();

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source);

        assert!(result.tags.contains(&"important".to_string()));
        assert!(result.tags.contains(&"review".to_string()));
    }

    #[test]
    fn extracts_wikilinks() {
        let (_dir, root) = setup_vault_with_package(
            r#"Link to #wikilink("Other Note") and #wikilink("Another", display: "see this")."#,
        );
        let note_path = root.join("test.typ");
        let source = fs::read_to_string(&note_path).unwrap();

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source);

        assert!(result.links.contains(&"Other Note".to_string()));
        assert!(result.links.contains(&"Another".to_string()));
    }

    #[test]
    fn extracts_link_refs_from_note_metadata() {
        let (_dir, root) = setup_vault_with_package(
            r#"#note(title: "Test", source: link-ref("Source Note"))"#,
        );
        let note_path = root.join("test.typ");
        let source = fs::read_to_string(&note_path).unwrap();

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source);

        assert!(result.links.contains(&"Source Note".to_string()));
    }

    #[test]
    fn deduplicates_tags_from_note_and_inline() {
        let (_dir, root) = setup_vault_with_package(
            "#note(tags: (\"shared\",))\n\nSome #tag(\"shared\") and #tag(\"unique\").",
        );
        let note_path = root.join("test.typ");
        let source = fs::read_to_string(&note_path).unwrap();

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source);

        let shared_count = result.tags.iter().filter(|t| t.as_str() == "shared").count();
        assert_eq!(shared_count, 1, "tag 'shared' should appear exactly once");
        assert!(result.tags.contains(&"unique".to_string()));
    }

    #[test]
    fn broken_file_without_note_returns_empty() {
        let dir = tempdir().expect("tempdir");
        let root = canonicalize_root(dir.path()).expect("canonicalize");
        crate::vault_package::scaffold(&root);

        let note_path = root.join("broken.typ");
        fs::write(&note_path, "#unknown_function(\n").expect("write");

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(
            &mut compiler,
            &note_path,
            fs::read_to_string(&note_path).unwrap(),
        );

        assert!(result.properties.is_empty());
        assert!(result.tags.is_empty());
        assert!(result.links.is_empty());
    }

    /// When a file fails to compile, the query returns an empty result —
    /// the scanner's persisted cache is the supported source of property
    /// data for broken files. Earlier we extracted properties from the
    /// raw source text on failure, but that duplicated `note_rewriter`'s
    /// parsing and silently disagreed with Typst's evaluation in edge
    /// cases.
    #[test]
    fn returns_empty_result_when_compilation_fails() {
        let dir = tempdir().expect("tempdir");
        let root = canonicalize_root(dir.path()).expect("canonicalize");
        crate::vault_package::scaffold(&root);

        // File has `#note(...)` but no import, so compilation will fail.
        let note_path = root.join("no_import.typ");
        let source = r#"#note(
  collection: ("Second Collection", "JC Collection 1"),
  tag: ("dogtag"),
)

= Hello
"#;
        fs::write(&note_path, source).expect("write");

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source.to_string());

        assert!(
            result.properties.is_empty(),
            "expected no properties when compile fails, got {:?}",
            result.properties
        );
        assert!(result.tags.is_empty());
        assert!(result.links.is_empty());
    }

    #[test]
    fn extracts_collection_property_as_list() {
        let (_dir, root) = setup_vault_with_package(
            r#"#note(title: "Paper Draft", collection: ("my-paper", "thesis-ch3"))"#,
        );
        let note_path = root.join("test.typ");
        let source = fs::read_to_string(&note_path).unwrap();

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source);

        let collection = result.properties.get("collection").expect("collection property");
        assert!(collection.contains("my-paper"));
        assert!(collection.contains("thesis-ch3"));
        assert!(!collection.contains("other"));
    }

    #[test]
    fn extracts_embed_links() {
        let (_dir, root) = setup_vault_with_package(
            r#"#embed("Embedded Note")"#,
        );
        let note_path = root.join("test.typ");
        let source = fs::read_to_string(&note_path).unwrap();

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source);

        assert!(result.links.contains(&"Embedded Note".to_string()));
    }
}
