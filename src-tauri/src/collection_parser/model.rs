use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Style overrides for a collection, applied as `#set` rules when its notes
/// compile. `None` inherits the app defaults or Typst's.
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
    /// Style rules for the fields that are set, or "" if none are. Page
    /// geometry is a direct `#set page(...)`, since `set page` inside a show
    /// rule has no effect on the document's layout; text, paragraph and heading
    /// settings go through `#show: apply-collection-style.with(...)` (lib.typ).
    pub fn to_typst_show_call(&self) -> String {
        use crate::typst_pipeline::style_injection::{ensure_length_unit, sanitize_typst_string};

        let mut lines: Vec<String> = Vec::new();

        // Page geometry: direct #set rule
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
                args.push(format!("numbering: {}", format_numbering(numbering)));
            }
            if !args.is_empty() {
                lines.push(format!("#set page({})", args.join(", ")));
            }
        }

        // Text/par/heading: delegate to lib.typ via #show:
        let mut show_args: Vec<String> = Vec::new();

        if let Some(ref text) = self.text {
            let mut entries = Vec::new();
            if let Some(ref font) = text.font {
                entries.push(format!("font: \"{}\"", sanitize_typst_string(font)));
            }
            if let Some(ref size) = text.size {
                entries.push(format!("size: {}", ensure_length_unit(size, "pt")));
            }
            if let Some(ref lang) = text.lang {
                entries.push(format!("lang: \"{}\"", sanitize_typst_string(lang)));
            }
            if let Some(ref region) = text.region {
                entries.push(format!("region: \"{}\"", sanitize_typst_string(region)));
            }
            if !entries.is_empty() {
                show_args.push(format!("text-args: ({})", entries.join(", ")));
            }
        }

        if let Some(ref par) = self.paragraph {
            let mut entries = Vec::new();
            if let Some(ref leading) = par.leading {
                entries.push(format!("leading: {}", ensure_length_unit(leading, "em")));
            }
            if let Some(ref spacing) = par.spacing {
                entries.push(format!("spacing: {}", ensure_length_unit(spacing, "em")));
            }
            if let Some(ref indent) = par.first_line_indent {
                entries.push(format!(
                    "first-line-indent: {}",
                    ensure_length_unit(indent, "em")
                ));
            }
            if let Some(justify) = par.justify {
                entries.push(format!("justify: {}", justify));
            }
            if !entries.is_empty() {
                show_args.push(format!("par-args: ({})", entries.join(", ")));
            }
        }

        if let Some(ref heading) = self.heading {
            if let Some(ref numbering) = heading.numbering {
                show_args.push(format!(
                    "heading-args: (numbering: {})",
                    format_numbering(numbering)
                ));
            }
        }

        if !show_args.is_empty() {
            lines.push(format!(
                "#show: apply-collection-style.with({})",
                show_args.join(", ")
            ));
        }

        lines.join("\n")
    }
}

/// A numbering pattern for a Typst `numbering:` argument. `none` becomes the
/// `none` keyword (no numbering, the "None" preset); anything else is a quoted
/// pattern.
fn format_numbering(value: &str) -> String {
    use crate::typst_pipeline::style_injection::sanitize_typst_string;
    if value.trim() == "none" {
        "none".to_string()
    } else {
        format!("\"{}\"", sanitize_typst_string(value))
    }
}

/// Page-numbering scheme for the merged book export.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "style", rename_all = "snake_case")]
#[derive(Default)]
pub enum BookPageNumbering {
    /// Arabic numerals from the very first page.
    Arabic,
    /// Front matter unnumbered; chapters start at 1.
    ArabicFromChapters,
    /// Front matter in lowercase roman (i, ii, iii…); chapters restart at 1.
    #[default]
    RomanThenArabic,
    /// No numbers before `start_page` (an absolute page number), then 1, 2, 3….
    ArabicFromPage { start_page: u32 },
}

/// How a chapter's top-level heading is sourced when merging.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum InjectChapterHeading {
    /// Always inject `= <title>` from the note's `title` property,
    /// regardless of any `=` heading already in the file.
    Always,
    /// Inject only when the note doesn't already start with a `=` heading.
    #[default]
    Fallback,
    /// Never inject. The note must own its top-level heading.
    Never,
}

/// How wikilinks resolve when included in a merged book.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum BookWikilinkMode {
    /// Link to chapter labels when the target is in the book; other targets
    /// become plain text.
    #[default]
    Internal,
    /// Behave like single-note compilation: link to `<name>.typ`.
    External,
    /// Strip linking entirely; render only the visible text.
    Plain,
}

/// Where the book's table of contents goes, anchored by note stem. A stem not
/// in the export falls back to `Beginning`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[derive(Default)]
pub enum TocPlacement {
    /// Front matter, before the first chapter (the conventional default).
    /// Only this placement participates in front-matter page numbering.
    #[default]
    Beginning,
    /// After the final chapter, before the consolidated bibliography.
    End,
    /// Immediately after the chapter with this stem.
    AfterChapter { stem: String },
}

/// Where the book's bibliography comes from. Typst 0.15 allows several
/// `#bibliography()` per document, each scoped with a `target` selector, which
/// `PerChapter` and `InPlace` rely on.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum BibliographyMode {
    /// Remove per-note `#bibliography(...)` calls and add one bibliography at
    /// the back from the collection's bibliography file. The default.
    #[default]
    Unified,
    /// Remove per-note `#bibliography(...)` calls and add one at the end of
    /// each chapter, covering only that chapter's citations and numbered
    /// separately. From the collection's bibliography file.
    PerChapter,
    /// Keep each note's own `#bibliography(...)` and add none. The author
    /// decides placement, possibly several per note, for custom layouts.
    InPlace,
}

/// Saved "Export as book" settings in the `.collection` file. All optional; the
/// dialog supplies defaults, so a collection without `book:` can still be
/// exported.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BookExportConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// Byline and CRediT roster. When non-empty it takes over from `author`,
    /// which remains for the simple single-author case.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub contributors: Vec<Contributor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(default, rename = "abstract", skip_serializing_if = "Option::is_none")]
    pub abstract_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub toc_depth: Option<u8>,
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
    /// Where the table of contents sits relative to the chapters. Defaults to
    /// `Beginning` when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub toc_placement: Option<TocPlacement>,
    /// Where the bibliography comes from (see [`BibliographyMode`]). `Unified`
    /// when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bibliography_mode: Option<BibliographyMode>,
    /// `Some(false)` leaves out the CRediT statement even when contributors
    /// have roles; the byline still shows. `true` when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_credit_statement: Option<bool>,
    /// Where older files kept the "links to files" choice. Only read, so
    /// [`parse_collection_file`] can move it to [`CollectionExportConfig`].
    #[serde(default, skip_serializing)]
    pub linked_files: Option<crate::models::export::LinkedFilesOptions>,
}

/// The kinds of output the collection's Export tab can make.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum CollectionExportFormat {
    /// One PDF per note.
    PdfFiles,
    /// All the notes merged into one PDF, set up by the `book:` settings.
    Book,
    /// One HTML page per note.
    Site,
    /// One Markdown file per note.
    Markdown,
    /// The table's rows and columns as CSV or TSV. The default, as the
    /// first choice in the Export tab.
    #[default]
    Table,
}

/// The saved choices of a collection's Export tab, shared by every format
/// that uses them. Every field is optional; unset means the format's default.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(default)]
pub struct CollectionExportConfig {
    /// The format last chosen in the Export tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<CollectionExportFormat>,
    /// PDF standard for the PDF files and book formats.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdf_standard: Option<crate::typst_pipeline::compiler::PdfStandardPreset>,
    /// What happens to suggested changes and annotations. Not used by the
    /// website, which never shows review markup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_mode: Option<crate::typst_pipeline::review_markup::ReviewMarkupMode>,
    /// What the export does with links to notebox files, and whether it
    /// copies them and the images beside the export.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_files: Option<crate::models::export::LinkedFilesOptions>,
    /// Comma or tab for the table format.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_delimiter: Option<crate::models::export::TableDelimiter>,
}

/// One contributor, for the book byline and CRediT statement. Bibliographic
/// role and CRediT roles are independent: someone can be an `author` and hold
/// Conceptualization.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(default)]
pub struct Contributor {
    /// Display name. Free to change; identity rides on `handle`, not this.
    pub name: String,
    /// CSL/Hayagriva bibliographic role: "author", "editor", "translator",
    /// etc. `None` means a plain author. Controls byline / citation form.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub biblio_role: Option<String>,
    /// Canonical CRediT role IDs (e.g.
    /// "https://credit.niso.org/contributor-roles/conceptualization/").
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub credit_roles: Vec<String>,
}

/// A parsed `.collection` file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionFile {
    #[serde(default)]
    pub icon: Option<String>,
    /// The user's own plain-text note about the collection. Shown only in the
    /// collection's settings; never exported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub typst_template: Option<String>,
    #[serde(default)]
    pub bibliography_style: Option<String>,
    #[serde(default)]
    pub bibliography_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<CollectionStyle>,
    /// Raw Typst added at export after the generated style rules and any
    /// template, so it overrides both: custom `#show` rules, running headers
    /// and other styling Style Overrides doesn't offer. Written by the user and
    /// emitted as is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_typst: Option<String>,
    /// "Export as book" settings; `None` until configured (the dialog supplies
    /// defaults).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book: Option<BookExportConfig>,
    /// The Export tab's saved choices. None until the user changes one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export: Option<CollectionExportConfig>,
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
    /// Quick filters from the column headers, keyed by property. Each is a
    /// `FilterGroup` ANDed with `base.filters` and the view's `filters`. Kept
    /// apart from `filters` so they save and clear on their own.
    #[serde(
        rename = "columnFilters",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub column_filters: Option<HashMap<String, FilterGroup>>,
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

/// A boolean group of filters. Each combinator lists members, each an
/// expression string (e.g. `collection.contains("paper")`) or a nested group,
/// so a collection can express `(A or B) and C` (see `evaluate_filter_group`).
///
/// Combinators are ANDed: all `and` members pass, at least one `or` member
/// passes, and no `not` member passes. A missing or empty combinator passes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterGroup {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub and: Option<Vec<serde_yaml::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub or: Option<Vec<serde_yaml::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not: Option<Vec<serde_yaml::Value>>,
}

/// Parse a `.collection` file. An older file's "links to files" choice under
/// `book:` moves to `export:` (unless already set there), so the next save
/// writes it there.
pub fn parse_collection_file(content: &str) -> Result<CollectionFile, serde_yaml::Error> {
    let mut base: CollectionFile = serde_yaml::from_str(content)?;
    if let Some(old) = base.book.as_mut().and_then(|b| b.linked_files.take()) {
        let export = base.export.get_or_insert_with(Default::default);
        export.linked_files.get_or_insert(old);
    }
    Ok(base)
}

/// Serialize a `CollectionFile` back to YAML content for writing to disk.
pub fn serialize_collection_file(base: &CollectionFile) -> Result<String, serde_yaml::Error> {
    serde_yaml::to_string(base)
}

/// Leaf expressions wrapped in a nested `{ or: [...] }` group, built as a
/// mapping directly so it can't fail.
fn or_group_value(exprs: Vec<String>) -> serde_yaml::Value {
    let mut map = serde_yaml::Mapping::new();
    map.insert(
        serde_yaml::Value::String("or".to_string()),
        serde_yaml::Value::Sequence(exprs.into_iter().map(serde_yaml::Value::String).collect()),
    );
    serde_yaml::Value::Mapping(map)
}

/// The default collection file for `name`. Its filter is `All[ file.name !=
/// this.file.name, Any[ collection.contains("<name>") ] ]`: the outer AND
/// excludes the collection file itself and is where narrowing rules go; the
/// inner OR holds membership, so notes with `#note(collection: ("name"))` are
/// included and alternatives (a folder, another tag) can be added without all
/// having to match.
pub fn default_collection_file_for(name: &str) -> CollectionFile {
    let collection_filter = format!(r#"collection.contains("{}")"#, name);
    CollectionFile {
        icon: None,
        description: None,
        typst_template: None,
        bibliography_style: None,
        bibliography_file: None,
        style: None,
        custom_typst: None,
        book: None,
        export: None,
        filters: Some(FilterGroup {
            and: Some(vec![
                serde_yaml::Value::String("file.name != this.file.name".to_string()),
                or_group_value(vec![collection_filter]),
            ]),
            or: None,
            not: None,
        }),
        formulas: None,
        summaries: None,
        views: vec![ViewDef {
            view_type: "table".to_string(),
            name: "Table".to_string(),
            filters: None,
            column_filters: None,
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
        description: None,
        typst_template: None,
        bibliography_style: None,
        bibliography_file: None,
        style: None,
        custom_typst: None,
        book: None,
        export: None,
        filters: None,
        formulas: None,
        summaries: None,
        views: vec![ViewDef {
            view_type: "table".to_string(),
            name: "Table".to_string(),
            filters: None,
            column_filters: None,
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
        // Default is now All[ file-exclusion, Any[ collection.contains ] ]:
        // two top-level AND members, the second a nested OR group.
        assert_eq!(and.len(), 2);
        assert_eq!(
            and[0],
            serde_yaml::Value::String("file.name != this.file.name".to_string())
        );

        // Membership is a nested OR group, so alternatives don't all have to
        // match.
        let nested = and[1].as_mapping().expect("second member is a group");
        let or_members = nested
            .get(serde_yaml::Value::String("or".to_string()))
            .and_then(|v| v.as_sequence())
            .expect("nested group has an `or` list");
        assert_eq!(
            or_members[0],
            serde_yaml::Value::String(r#"collection.contains("my-paper")"#.to_string())
        );

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
views:
  - type: table
    name: "Table"
"#;
        let base = parse_collection_file(yaml).unwrap();
        assert_eq!(base.icon.as_deref(), Some("lucide:book"));
        assert_eq!(
            base.typst_template.as_deref(),
            Some("@preview/charged-ieee:0.1.0")
        );
        assert_eq!(base.bibliography_style.as_deref(), Some("ieee"));
    }

    #[test]
    fn old_book_linked_files_moves_to_export() {
        use crate::models::export::{FileLinkMode, LinkedFilesOptions};
        let yaml = r#"
book:
  title: "My Book"
  linked_files:
    links: copies
    copy_images: true
views: []
"#;
        let base = parse_collection_file(yaml).unwrap();
        let moved = LinkedFilesOptions {
            links: FileLinkMode::Copies,
            copy_images: true,
        };
        assert_eq!(
            base.export.as_ref().and_then(|e| e.linked_files),
            Some(moved)
        );
        assert!(base.book.as_ref().unwrap().linked_files.is_none());

        // The next save writes it under `export:` only.
        let saved = serialize_collection_file(&base).unwrap();
        let reparsed: serde_yaml::Value = serde_yaml::from_str(&saved).unwrap();
        assert!(reparsed["book"].get("linked_files").is_none());
        assert_eq!(
            reparsed["export"]["linked_files"]["links"].as_str(),
            Some("copies")
        );
        assert_eq!(reparsed["book"]["title"].as_str(), Some("My Book"));
    }

    #[test]
    fn export_linked_files_wins_over_old_book_value() {
        use crate::models::export::FileLinkMode;
        let yaml = r#"
book:
  linked_files:
    links: copies
export:
  linked_files:
    links: file-name
views: []
"#;
        let base = parse_collection_file(yaml).unwrap();
        let links = base.export.unwrap().linked_files.unwrap().links;
        assert_eq!(links, FileLinkMode::FileName);
    }

    #[test]
    fn export_settings_round_trip() {
        use crate::models::export::TableDelimiter;
        use crate::typst_pipeline::compiler::PdfStandardPreset;
        use crate::typst_pipeline::review_markup::ReviewMarkupMode;
        let yaml = r#"
export:
  format: book
  pdf_standard: pdf-a4
  review_mode: accept
  table_delimiter: tab
views: []
"#;
        let base = parse_collection_file(yaml).unwrap();
        let reparsed = parse_collection_file(&serialize_collection_file(&base).unwrap()).unwrap();
        let export = reparsed.export.unwrap();
        assert_eq!(export.format, Some(CollectionExportFormat::Book));
        assert_eq!(export.pdf_standard, Some(PdfStandardPreset::PdfA4));
        assert_eq!(export.review_mode, Some(ReviewMarkupMode::Accept));
        assert_eq!(export.table_delimiter, Some(TableDelimiter::Tab));
        assert!(export.linked_files.is_none());
    }

    #[test]
    fn description_round_trips_and_is_omitted_when_unset() {
        let yaml =
            "description: \"Drafts for the spring issue.\\nAsk Sam about the order.\"\nviews: []\n";
        let base = parse_collection_file(yaml).unwrap();
        let text = "Drafts for the spring issue.\nAsk Sam about the order.";
        assert_eq!(base.description.as_deref(), Some(text));
        let reparsed = parse_collection_file(&serialize_collection_file(&base).unwrap()).unwrap();
        assert_eq!(reparsed.description.as_deref(), Some(text));

        let saved = serialize_collection_file(&default_collection_file()).unwrap();
        assert!(!saved.contains("description"));
    }
}
