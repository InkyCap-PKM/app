use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Style overrides for a collection. Each field is optional — `None` means
/// "inherit from app defaults or Typst built-ins". These are injected as
/// `#set` rules at compile time for notes in this collection.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct CollectionStyle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<PageStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<TextStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paragraph: Option<ParagraphStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading: Option<HeadingStyle>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PageStyle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paper: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub numbering: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TextStyle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ParagraphStyle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leading: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spacing: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_line_indent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub justify: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct HeadingStyle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub numbering: Option<String>,
}

impl CollectionStyle {
    /// Build a sequence of direct `#set` rules for the collection's
    /// non-`None` fields. Returns an empty string when no fields are set,
    /// so the caller can skip the injection cleanly.
    ///
    /// Set rules are emitted directly (rather than via a
    /// `#show: apply-collection-style.with(...)` wrapper) because page-level
    /// rules like `set page(paper: ...)` are no-ops when applied through a
    /// show-rule's returned content — page geometry is resolved before the
    /// transformed content is laid out. See the matching note on
    /// `style_injection::build_defaults_rules` for the full rationale.
    pub fn to_typst_show_call(&self) -> String {
        use crate::typst_pipeline::style_injection::{ensure_length_unit, sanitize_typst_string};

        let mut rules: Vec<String> = Vec::new();

        if let Some(ref page) = self.page {
            let mut args = Vec::new();
            if let Some(ref paper) = page.paper {
                args.push(format!("paper: \"{}\"", sanitize_typst_string(paper)));
            }
            if let Some(ref margin) = page.margin {
                args.push(format!("margin: {}", ensure_length_unit(margin, "pt")));
            }
            if let Some(cols) = page.columns {
                args.push(format!("columns: {}", cols));
            }
            if let Some(ref numbering) = page.numbering {
                args.push(format!("numbering: \"{}\"", sanitize_typst_string(numbering)));
            }
            if !args.is_empty() {
                rules.push(format!("#set page({})", args.join(", ")));
            }
        }

        if let Some(ref text) = self.text {
            let mut args = Vec::new();
            if let Some(ref font) = text.font {
                args.push(format!("font: \"{}\"", sanitize_typst_string(font)));
            }
            if let Some(ref size) = text.size {
                args.push(format!("size: {}", ensure_length_unit(size, "pt")));
            }
            if let Some(ref lang) = text.lang {
                args.push(format!("lang: \"{}\"", sanitize_typst_string(lang)));
            }
            if let Some(ref region) = text.region {
                args.push(format!("region: \"{}\"", sanitize_typst_string(region)));
            }
            if !args.is_empty() {
                rules.push(format!("#set text({})", args.join(", ")));
            }
        }

        if let Some(ref par) = self.paragraph {
            let mut args = Vec::new();
            if let Some(ref leading) = par.leading {
                args.push(format!("leading: {}", ensure_length_unit(leading, "em")));
            }
            if let Some(ref spacing) = par.spacing {
                args.push(format!("spacing: {}", ensure_length_unit(spacing, "em")));
            }
            if let Some(ref indent) = par.first_line_indent {
                args.push(format!("first-line-indent: {}", ensure_length_unit(indent, "em")));
            }
            if let Some(justify) = par.justify {
                args.push(format!("justify: {}", justify));
            }
            if !args.is_empty() {
                rules.push(format!("#set par({})", args.join(", ")));
            }
        }

        if let Some(ref heading) = self.heading {
            if let Some(ref numbering) = heading.numbering {
                rules.push(format!(
                    "#set heading(numbering: \"{}\")",
                    sanitize_typst_string(numbering)
                ));
            }
        }

        rules.join("\n")
    }
}

/// Page-numbering scheme for the merged book export.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "style", rename_all = "snake_case")]
pub enum BookPageNumbering {
    /// Arabic numerals from the very first page.
    Arabic,
    /// Front matter unnumbered; chapters start at 1.
    ArabicFromChapters,
    /// Front matter in lowercase roman (i, ii, iii…); chapters restart at 1.
    RomanThenArabic,
    /// No numbers until the chosen page, then arabic 1, 2, 3…
    /// `start_page` is the absolute page of the document on which the first
    /// arabic numeral ("1") is rendered.
    ArabicFromPage { start_page: u32 },
}

impl Default for BookPageNumbering {
    fn default() -> Self {
        BookPageNumbering::RomanThenArabic
    }
}

/// How a chapter's top-level heading is sourced when merging.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InjectChapterHeading {
    /// Always inject `= <title>` from the note's `title` property,
    /// regardless of any `=` heading already in the file.
    Always,
    /// Inject only when the note doesn't already start with a `=` heading.
    Fallback,
    /// Never inject. The note must own its top-level heading.
    Never,
}

impl Default for InjectChapterHeading {
    fn default() -> Self {
        InjectChapterHeading::Fallback
    }
}

/// How wikilinks resolve when included in a merged book.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BookWikilinkMode {
    /// Resolve wikilinks to in-document chapter labels when the target is
    /// part of the merged book. Targets outside the book fall back to plain
    /// text.
    Internal,
    /// Behave like single-note compilation: link to `<name>.typ`.
    External,
    /// Strip linking entirely; render only the visible text.
    Plain,
}

impl Default for BookWikilinkMode {
    fn default() -> Self {
        BookWikilinkMode::Internal
    }
}

/// Persistent "Export as book" configuration stored in the `.collection` file.
/// Every field is optional; the export dialog supplies sensible defaults at
/// use time, so a freshly created collection without a `book:` block can be
/// exported without ceremony.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BookExportConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(default, rename = "abstract", skip_serializing_if = "Option::is_none")]
    pub abstract_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub toc_depth: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number_chapters: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inject_chapter_heading: Option<InjectChapterHeading>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wikilink_mode: Option<BookWikilinkMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_title_page: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_outline: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_numbering: Option<BookPageNumbering>,
}

/// A parsed `.collection` file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionFile {
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub typst_template: Option<String>,
    #[serde(default)]
    pub bibliography_style: Option<String>,
    #[serde(default)]
    pub bibliography_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<CollectionStyle>,
    /// Settings for the "Export as book" action — merged single-PDF output
    /// drawn from the collection's notes. None means the user hasn't
    /// configured book export for this collection (defaults are supplied at
    /// dialog time).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book: Option<BookExportConfig>,
    #[serde(default)]
    pub metadata: Option<HashMap<String, String>>,
    #[serde(default)]
    pub filters: Option<FilterGroup>,
    #[serde(default)]
    pub formulas: Option<HashMap<String, String>>,
    #[serde(default)]
    pub summaries: Option<HashMap<String, String>>,
    #[serde(default)]
    pub views: Vec<ViewDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewDef {
    #[serde(rename = "type", default = "default_view_type")]
    pub view_type: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub filters: Option<FilterGroup>,
    #[serde(default)]
    pub order: Option<Vec<String>>,
    #[serde(default)]
    pub sort: Option<Vec<SortRule>>,
    #[serde(rename = "columnSize", default)]
    pub column_size: Option<HashMap<String, f64>>,
    #[serde(default)]
    pub summaries: Option<HashMap<String, String>>,
}

fn default_view_type() -> String {
    "table".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SortRule {
    pub property: String,
    #[serde(default = "default_sort_direction")]
    pub direction: String,
}

fn default_sort_direction() -> String {
    "ASC".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterGroup {
    #[serde(default)]
    pub and: Option<Vec<serde_yaml::Value>>,
    #[serde(default)]
    pub or: Option<Vec<serde_yaml::Value>>,
}

/// Parse a `.collection` file from its YAML content.
pub fn parse_collection_file(content: &str) -> Result<CollectionFile, serde_yaml::Error> {
    serde_yaml::from_str(content)
}

/// Serialize a `CollectionFile` back to YAML content for writing to disk.
pub fn serialize_collection_file(base: &CollectionFile) -> Result<String, serde_yaml::Error> {
    serde_yaml::to_string(base)
}

/// Create a default CollectionFile for a named collection.
/// Includes a default filter `collection.contains("<name>")` so that notes
/// with `#note(collection: ("name"))` are automatically included.
pub fn default_collection_file_for(name: &str) -> CollectionFile {
    let collection_filter = format!(r#"collection.contains("{}")"#, name);
    CollectionFile {
        icon: None,
        typst_template: None,
        bibliography_style: None,
        bibliography_file: None,
        style: None,
        book: None,
        metadata: None,
        filters: Some(FilterGroup {
            and: Some(vec![
                serde_yaml::Value::String("file.name != this.file.name".to_string()),
                serde_yaml::Value::String(format!(r#"file.ext == "typ""#)),
                serde_yaml::Value::String(collection_filter),
            ]),
            or: None,
        }),
        formulas: None,
        summaries: None,
        views: vec![ViewDef {
            view_type: "table".to_string(),
            name: "Table".to_string(),
            filters: None,
            order: Some(vec!["file.name".to_string()]),
            sort: Some(vec![SortRule {
                property: "file.name".to_string(),
                direction: "ASC".to_string(),
            }]),
            column_size: None,
            summaries: None,
        }],
    }
}

/// Create a default empty CollectionFile with a single table view (no collection filter).
pub fn default_collection_file() -> CollectionFile {
    CollectionFile {
        icon: None,
        typst_template: None,
        bibliography_style: None,
        bibliography_file: None,
        style: None,
        book: None,
        metadata: None,
        filters: None,
        formulas: None,
        summaries: None,
        views: vec![ViewDef {
            view_type: "table".to_string(),
            name: "Table".to_string(),
            filters: None,
            order: Some(vec!["file.name".to_string()]),
            sort: Some(vec![SortRule {
                property: "file.name".to_string(),
                direction: "ASC".to_string(),
            }]),
            column_size: None,
            summaries: None,
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_basic_collection_file() {
        let yaml = r#"
filters:
  and:
    - 'file.name != this.file.name'
    - 'file.ext == "typ"'
views:
  - type: table
    name: "All Notes"
    order:
      - file.name
      - title
      - tags
    sort:
      - property: file.mtime
        direction: DESC
"#;
        let base = parse_collection_file(yaml).unwrap();
        assert!(base.filters.is_some());
        assert_eq!(base.views.len(), 1);
        assert_eq!(base.views[0].name, "All Notes");
        assert_eq!(base.views[0].view_type, "table");
        assert!(base.views[0].sort.is_some());
    }

    #[test]
    fn test_parse_multi_view_collection_file() {
        let yaml = r#"
views:
  - type: table
    name: "To Do"
    filters:
      and:
        - 'task == true'
  - type: table
    name: "Done"
    filters:
      and:
        - 'task == false'
"#;
        let base = parse_collection_file(yaml).unwrap();
        assert_eq!(base.views.len(), 2);
        assert_eq!(base.views[0].name, "To Do");
        assert_eq!(base.views[1].name, "Done");
    }

    #[test]
    fn test_round_trip_serialize() {
        let yaml = r#"
filters:
  and:
    - 'file.name != this.file.name'
views:
  - type: table
    name: "All Notes"
    order:
      - file.name
      - title
    sort:
      - property: file.name
        direction: ASC
"#;
        let base = parse_collection_file(yaml).unwrap();
        let serialized = serialize_collection_file(&base).unwrap();
        let reparsed = parse_collection_file(&serialized).unwrap();

        assert_eq!(reparsed.views.len(), 1);
        assert_eq!(reparsed.views[0].name, "All Notes");
        assert_eq!(
            reparsed.views[0].order.as_ref().unwrap(),
            &vec!["file.name".to_string(), "title".to_string()]
        );
        assert!(reparsed.filters.is_some());
    }

    #[test]
    fn test_default_collection_file() {
        let base = default_collection_file();
        assert_eq!(base.views.len(), 1);
        assert_eq!(base.views[0].name, "Table");
        assert!(base.views[0].order.is_some());
        assert!(base.filters.is_none());

        // Should serialize and parse back
        let yaml = serialize_collection_file(&base).unwrap();
        let reparsed = parse_collection_file(&yaml).unwrap();
        assert_eq!(reparsed.views.len(), 1);
    }

    #[test]
    fn test_default_collection_file_for_collection() {
        let base = default_collection_file_for("my-paper");
        assert!(base.filters.is_some());
        let filters = base.filters.clone().unwrap();
        let and = filters.and.unwrap();
        assert_eq!(and.len(), 3);
        assert_eq!(and[2], serde_yaml::Value::String(r#"collection.contains("my-paper")"#.to_string()));

        // Round-trip
        let yaml = serialize_collection_file(&base).unwrap();
        let reparsed = parse_collection_file(&yaml).unwrap();
        assert!(reparsed.filters.is_some());
    }

    #[test]
    fn test_parse_collection_file_with_new_fields() {
        let yaml = r#"
icon: "lucide:book"
typst_template: "@preview/charged-ieee:0.1.0"
bibliography_style: ieee
metadata:
  journal: "Nature"
  deadline: "2026-06-01"
views:
  - type: table
    name: "Table"
"#;
        let base = parse_collection_file(yaml).unwrap();
        assert_eq!(base.icon.as_deref(), Some("lucide:book"));
        assert_eq!(base.typst_template.as_deref(), Some("@preview/charged-ieee:0.1.0"));
        assert_eq!(base.bibliography_style.as_deref(), Some("ieee"));
        let meta = base.metadata.unwrap();
        assert_eq!(meta.get("journal").unwrap(), "Nature");
        assert_eq!(meta.get("deadline").unwrap(), "2026-06-01");
    }
}
