//! Export commands for Typst notes and collections.
//!
//! - PDF export via `typst-pdf` (single note or collection)
//! - Self-contained `.typ` export (inlines the `inkycap-notebox` package)
//! - Native HTML export via Typst's HTML backend
//! - Static site generation for collections
//! - Pandoc-based multi-format export (HTML, DOCX, ODT, LaTeX)
//! - CSV export for collection table data
//! - Figure/asset extraction

pub(crate) mod assets;
pub(crate) mod csv;
pub(crate) mod helpers;
pub(crate) mod html;
pub(crate) mod pandoc;
pub(crate) mod pdf;
pub(crate) mod site;

// ── Re-exports ──────────────────────────────────────────────────
// Preserves the public API surface: all callers continue to use
// `commands::export::function_name` unchanged.

pub use assets::{export_figures, export_self_contained_typ};
pub use csv::{export_collection_csv, export_collection_csv_to_file};
pub use helpers::{resolve_template_path, resolve_template_path_with_root};
pub use html::export_note_html;
pub use pandoc::{detect_pandoc, export_via_pandoc};
pub use pdf::{
    check_pdf_standard_requirements, ensure_document_date_for_standard,
    export_collection_batch_pdf, export_collection_book_pdf, export_collection_note_pdf,
    export_note_pdf, export_note_pdf_to_file, BookExportOverrides, BookLabelCollision,
};
pub use site::export_collection_static_site;

/// Number of collaboration review-markup constructs (`#suggestion`,
/// `#annotation`, `#review-decision`) in a note. The export dialog calls this
/// when opening so it only shows its "Review markup" control for notes that
/// actually carry tracked changes.
#[tauri::command]
pub async fn count_note_review_markup(
    path: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<usize, crate::errors::InkyCapError> {
    use crate::storage::traits::NoteboxStorage;
    let storage = state.get_storage().await?;
    let content = storage
        .read_file(&std::path::PathBuf::from(&path))
        .await?;
    Ok(crate::typst_pipeline::review_markup::count_review_markup(&content))
}

#[cfg(test)]
mod tests {
    use super::helpers::*;
    use super::assets::inline_package;
    use super::pandoc::{
        inject_docx_core_properties, inject_odt_meta_properties, mirror_img_style_size_to_attrs,
    };
    use super::pdf::{
        check_pdf_standard_requirements, ensure_document_date_for_standard,
    };
    use crate::typst_pipeline::compiler::PdfStandardPreset;

    #[test]
    fn extract_image_paths_finds_all() {
        let source = r#"
= My Note

#image("figures/fig1.png")
Some text.
#image("/assets/photo.jpg", width: 80%)
"#;
        let paths = extract_image_paths(source);
        assert_eq!(paths, vec!["figures/fig1.png", "/assets/photo.jpg"]);
    }

    #[test]
    fn inline_package_replaces_import() {
        let source = "#import \"/.inkycap/packages/inkycap-notebox/0.1.0/lib.typ\": *\n\n= Hello\n";
        let result = inline_package(source);
        assert!(result.contains("inkycap-notebox package (inlined for portability)"));
        assert!(!result.contains("#import \"/.inkycap/packages"));
        assert!(result.contains("= Hello"));
    }

    /// Notes created since the path migration use the canonical
    /// `/.inkycap/notebox.typ` import. `inline_package` must recognize that
    /// form too.
    #[test]
    fn inline_package_replaces_canonical_import() {
        let source = "#import \"/.inkycap/notebox.typ\": *\n\n= Hello\n";
        let result = inline_package(source);
        assert!(result.contains("inkycap-notebox package (inlined for portability)"));
        assert!(!result.contains("#import \"/.inkycap/notebox.typ\""));
        assert!(result.contains("= Hello"));
    }

    #[test]
    fn ensure_document_date_after_canonical_import() {
        let source = "#import \"/.inkycap/notebox.typ\": *\n#note()\n\n= Body\n".to_string();
        let result = ensure_document_date_for_standard(source, PdfStandardPreset::PdfA4);
        let import_pos = result.find("#import \"/.inkycap/notebox.typ\"").unwrap();
        let date_pos = result.find("#set document(date:").unwrap();
        assert!(
            date_pos > import_pos,
            "date injection should follow the import line, got:\n{}",
            result
        );
    }

    #[test]
    fn check_pdf_ua1_reports_missing_image_alt() {
        let source = "= Title\n#image(\"a.png\")\nSome text.\n#image(\"b.svg\", alt: \"a thing\")\n";
        let err = check_pdf_standard_requirements(source, PdfStandardPreset::PdfUa1)
            .expect_err("expected ua-1 violation");
        let msg = err.to_string();
        assert!(msg.contains("a.png"), "should name offender: {msg}");
        assert!(!msg.contains("b.svg"), "image with alt should not appear: {msg}");
        assert!(msg.contains("line 2"), "should give a line number: {msg}");
    }

    #[test]
    fn check_pdf_ua1_reports_heading_level_gaps() {
        let source = "= Top\n\nFirst body.\n\n=== Skipped a level\n\nMore.\n";
        let err = check_pdf_standard_requirements(source, PdfStandardPreset::PdfUa1)
            .expect_err("expected ua-1 violation");
        let msg = err.to_string();
        assert!(msg.contains("level 1"));
        assert!(msg.contains("level 3"));
        assert!(msg.contains("Skipped a level"));
    }

    #[test]
    fn check_pdf_ua1_aggregates_multiple_issue_kinds() {
        let source = "= H1\n#image(\"a.png\")\n=== H3 jump\n";
        let err = check_pdf_standard_requirements(source, PdfStandardPreset::PdfUa1)
            .expect_err("expected ua-1 violation");
        let msg = err.to_string();
        assert!(msg.contains("Images missing alt text"));
        assert!(msg.contains("Heading levels skip"));
    }

    #[test]
    fn check_pdf_ua1_passes_when_clean() {
        let source = "= Top\n== Sub\n#image(\"a.png\", alt: \"a thing\")\n";
        check_pdf_standard_requirements(source, PdfStandardPreset::PdfUa1).expect("clean");
    }

    #[test]
    fn check_standard_pdf_is_always_ok() {
        let source = "= h\n#image(\"x.png\")\n=== gap\n";
        check_pdf_standard_requirements(source, PdfStandardPreset::Standard).expect("standard");
    }

    #[test]
    fn inject_document_metadata_sets_title_and_author() {
        let source = concat!(
            "#import \"/.inkycap/packages/inkycap-notebox/0.1.0/lib.typ\": *\n",
            "#note(title: \"My Paper\", author: \"Jane Doe\")\n",
            "\n= Hello\n",
        );
        let result = inject_document_metadata(source);
        assert!(result.contains("#set document(title: \"My Paper\", author: \"Jane Doe\")"));
        assert!(result.contains("= Hello"));
    }

    #[test]
    fn inject_document_metadata_date_as_datetime() {
        let source = "#note(title: \"Test\", date: \"2026-04-28\")\n\n= Body\n";
        let result = inject_document_metadata(source);
        assert!(result.contains("date: datetime(year: 2026, month: 4, day: 28)"), "got: {}", result);
    }

    #[test]
    fn inject_document_metadata_multiline_note_with_mixed_types() {
        let source = concat!(
            "#import \"/.inkycap/packages/inkycap-notebox/0.1.0/lib.typ\": *\n",
            "#note(\n",
            "  tag: (\"dogtag\", \"animal\"),\n",
            "  date: \"2026-04-28\",\n",
            "  to-do: false,\n",
            "  alias: \"\",\n",
            ")\n",
            "\n= heading 1\n",
        );
        let result = inject_document_metadata(source);
        assert!(result.contains("= heading 1"));
        assert!(result.contains("datetime(year: 2026, month: 4, day: 28)"));
    }

    #[test]
    fn inject_document_metadata_handles_tags_as_keywords() {
        let source = "#note(title: \"Test\", tags: (\"physics\", \"quantum\"))\n\n= Body\n";
        let result = inject_document_metadata(source);
        assert!(result.contains("title: \"Test\""));
        assert!(result.contains("keywords: (\"physics\", \"quantum\")"));
    }

    #[test]
    fn inject_document_metadata_noop_without_note() {
        let source = "= Just a heading\n\nSome text.\n";
        let result = inject_document_metadata(source);
        assert_eq!(result, source);
    }

    #[test]
    fn inject_document_metadata_datetime_literal_passthrough() {
        let source = "#note(title: \"Test\", date: datetime(year: 2026, month: 4, day: 29))\n\n= Body\n";
        let result = inject_document_metadata(source);
        assert!(result.contains("date: datetime(year: 2026, month: 4, day: 29)"), "got: {}", result);
    }

    #[test]
    fn normalize_date_value_from_datetime() {
        assert_eq!(
            normalize_date_value("datetime(year: 2026, month: 4, day: 29)"),
            "2026-04-29"
        );
    }

    #[test]
    fn normalize_date_value_passthrough_iso() {
        assert_eq!(normalize_date_value("2026-04-29"), "2026-04-29");
    }

    #[test]
    fn normalize_metadata_maps_keys() {
        let raw = vec![
            ("title".to_string(), "Test".to_string()),
            ("tag".to_string(), "a, b".to_string()),
            ("to-do".to_string(), "false".to_string()),
            ("alias".to_string(), "alt".to_string()),
        ];
        let norm = normalize_metadata(&raw);
        let keys: Vec<&str> = norm.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.contains(&"title"));
        assert!(keys.contains(&"keywords"));
        assert!(!keys.contains(&"tag"));
        assert!(!keys.contains(&"to-do"));
        assert!(!keys.contains(&"alias"));
    }

    #[test]
    fn inject_docx_core_properties_upserts() {
        let xml = concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            r#"<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" "#,
            r#"xmlns:dc="http://purl.org/dc/elements/1.1/" "#,
            r#"xmlns:dcterms="http://purl.org/dc/terms/" "#,
            r#"xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">"#,
            r#"<dc:title>Old Title</dc:title>"#,
            r#"</cp:coreProperties>"#,
        );
        let meta = vec![
            ("title".to_string(), "New Title".to_string()),
            ("author".to_string(), "Jane Doe".to_string()),
            ("keywords".to_string(), "physics, quantum".to_string()),
        ];
        let result = inject_docx_core_properties(xml, &meta);
        assert!(result.contains("<dc:title>New Title</dc:title>"));
        assert!(result.contains("<dc:creator>Jane Doe</dc:creator>"));
        assert!(result.contains("<cp:keywords>physics, quantum</cp:keywords>"));
        assert!(!result.contains("Old Title"));
    }

    #[test]
    fn strip_docx_title_paragraphs_with_space_before_slash() {
        let xml = concat!(
            "<w:body>",
            r#"<w:p><w:pPr><w:pStyle w:val="Title" /></w:pPr>"#,
            "<w:r><w:t>Daisy Dog</w:t></w:r></w:p>",
            r#"<w:p><w:pPr><w:pStyle w:val="Date" /></w:pPr>"#,
            "<w:r><w:t>2026-04-28</w:t></w:r></w:p>",
            r#"<w:p><w:pPr><w:pStyle w:val="Heading1" /></w:pPr>"#,
            "<w:r><w:t>Section</w:t></w:r></w:p>",
            "</w:body>",
        );
        let title_styles = regex::Regex::new(
            r#"<w:pStyle w:val="(Title|Subtitle|Author|Date)"\s*/>"#,
        ).unwrap();
        let result = super::pandoc::strip_docx_title_paragraphs(xml, &title_styles);
        assert!(!result.contains("Daisy Dog"), "title should be stripped");
        assert!(!result.contains("2026-04-28"), "date should be stripped");
        assert!(result.contains("Section"), "heading should remain");
    }

    #[test]
    fn inject_docx_core_properties_real_pandoc_output() {
        let xml = concat!(
            r#"<?xml version="1.0" encoding="UTF-8"?>"#,
            r#"<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" "#,
            r#"xmlns:dc="http://purl.org/dc/elements/1.1/" "#,
            r#"xmlns:dcterms="http://purl.org/dc/terms/" "#,
            r#"xmlns:dcmitype="http://purl.org/dc/dcmitype/" "#,
            r#"xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">"#,
            r#"<dc:title>Daisy Dog</dc:title>"#,
            r#"<dc:creator></dc:creator>"#,
            r#"<cp:keywords></cp:keywords>"#,
            r#"<dcterms:created xsi:type="dcterms:W3CDTF">2026-05-02T19:37:44Z</dcterms:created>"#,
            r#"<dcterms:modified xsi:type="dcterms:W3CDTF">2026-05-02T19:37:44Z</dcterms:modified>"#,
            r#"</cp:coreProperties>"#,
        );
        let meta = vec![
            ("title".to_string(), "Daisy Dog".to_string()),
            ("keywords".to_string(), "dogtag, animal".to_string()),
            ("date".to_string(), "2026-04-28".to_string()),
        ];
        let result = inject_docx_core_properties(xml, &meta);
        assert!(result.contains("<dc:title>Daisy Dog</dc:title>"));
        assert!(result.contains("<cp:keywords>dogtag, animal</cp:keywords>"));
        assert!(result.contains("<dcterms:created xsi:type=\"dcterms:W3CDTF\">2026-04-28T00:00:00Z</dcterms:created>"));
    }

    #[test]
    fn inject_odt_meta_properties_real_pandoc_output() {
        let xml = concat!(
            r#"<?xml version="1.0" encoding="utf-8"?>"#,
            r#"<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" "#,
            r#"xmlns:dc="http://purl.org/dc/elements/1.1/" "#,
            r#"xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0">"#,
            r#"<office:meta>"#,
            r#"<meta:generator>Pandoc/3.7.0.2</meta:generator>"#,
            r#"<dc:title>Daisy Dog</dc:title>"#,
            r#"<dc:description></dc:description>"#,
            r#"<dc:subject></dc:subject>"#,
            r#"<meta:keyword></meta:keyword>"#,
            r#"<meta:initial-creator></meta:initial-creator>"#,
            r#"<dc:creator></dc:creator>"#,
            r#"<dc:date>2026-05-02T19:39:28Z</dc:date>"#,
            r#"</office:meta>"#,
            r#"</office:document-meta>"#,
        );
        let meta = vec![
            ("title".to_string(), "Daisy Dog".to_string()),
            ("keywords".to_string(), "dogtag, animal".to_string()),
            ("date".to_string(), "2026-04-28".to_string()),
        ];
        let result = inject_odt_meta_properties(xml, &meta);
        assert!(result.contains("<dc:title>Daisy Dog</dc:title>"));
        assert!(result.contains("<meta:keyword>dogtag</meta:keyword>"));
        assert!(result.contains("<meta:keyword>animal</meta:keyword>"));
        assert!(result.contains("<dc:date>2026-04-28T00:00:00</dc:date>"));
        assert!(!result.contains("<meta:keyword></meta:keyword>"));
    }

    #[test]
    fn inject_odt_meta_properties_upserts() {
        let xml = concat!(
            r#"<?xml version="1.0" encoding="UTF-8"?>"#,
            r#"<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" "#,
            r#"xmlns:dc="http://purl.org/dc/elements/1.1/" "#,
            r#"xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0">"#,
            r#"<office:meta>"#,
            r#"<dc:title>Old</dc:title>"#,
            r#"</office:meta>"#,
            r#"</office:document-meta>"#,
        );
        let meta = vec![
            ("title".to_string(), "New Title".to_string()),
            ("author".to_string(), "Jane".to_string()),
            ("keywords".to_string(), "a, b".to_string()),
            ("date".to_string(), "2026-04-29".to_string()),
        ];
        let result = inject_odt_meta_properties(xml, &meta);
        assert!(result.contains("<dc:title>New Title</dc:title>"));
        assert!(result.contains("<meta:initial-creator>Jane</meta:initial-creator>"));
        assert!(result.contains("<meta:keyword>a</meta:keyword>"));
        assert!(result.contains("<meta:keyword>b</meta:keyword>"));
        assert!(result.contains("<dc:date>2026-04-29T00:00:00</dc:date>"));
        assert!(!result.contains(">Old<"));
    }

    #[test]
    fn resolve_template_bare_name_defaults_to_local_namespace() {
        // After dropping .inkycap/templates/, bare names resolve to
        // `@local/<name>:0.1.0` so users can refer to their own packages
        // from a creation rule without typing the full spec.
        assert_eq!(resolve_template_path("ieee"), "@local/ieee:0.1.0");
    }

    #[test]
    fn resolve_template_absolute_path_passthrough() {
        assert_eq!(resolve_template_path("/my/template.typ"), "/my/template.typ");
    }

    #[test]
    fn resolve_template_package_ref_passthrough() {
        assert_eq!(
            resolve_template_path("@preview/charged-ieee:0.1.0"),
            "@preview/charged-ieee:0.1.0",
        );
    }

    #[test]
    fn inject_bibliography_when_citations_present() {
        let source = "#note()\nSome text @smith2020 and more.".to_string();
        let result = maybe_inject_bibliography(source, Some("refs.bib"), None);
        assert!(result.contains("#bibliography(\"/refs.bib\")"));
    }

    #[test]
    fn inject_bibliography_with_style() {
        let source = "#note()\n@jones2021".to_string();
        let result = maybe_inject_bibliography(source, Some("refs.bib"), Some("ieee"));
        assert!(result.contains("#bibliography(\"/refs.bib\", style: \"ieee\")"));
    }

    #[test]
    fn no_bibliography_without_citations() {
        let source = "#note()\nNo citations here.".to_string();
        let result = maybe_inject_bibliography(source.clone(), Some("refs.bib"), None);
        assert_eq!(result, source);
    }

    #[test]
    fn no_bibliography_without_bib_file() {
        let source = "#note()\n@smith2020".to_string();
        let result = maybe_inject_bibliography(source.clone(), None, None);
        assert_eq!(result, source);
    }

    #[test]
    fn no_bibliography_for_import_at_signs() {
        let source = "#import \"@preview/pkg:0.1.0\": *\nNo citations.".to_string();
        let result = maybe_inject_bibliography(source.clone(), Some("refs.bib"), None);
        assert_eq!(result, source);
    }

    #[test]
    fn img_style_width_mirrored_to_attribute() {
        // Typst HTML export sizes images via inline CSS; Pandoc needs the
        // width as an attribute or it embeds at intrinsic (huge) size.
        let html = r#"<img src="data:image/png;base64,AAAA" style="width: 25%">"#;
        let out = mirror_img_style_size_to_attrs(html);
        assert!(out.contains(r#"width="25%""#), "got: {out}");
    }

    #[test]
    fn img_existing_width_attr_not_duplicated() {
        let html = r#"<img src="x.png" width="100" style="width: 25%">"#;
        let out = mirror_img_style_size_to_attrs(html);
        assert_eq!(out.matches("width=").count(), 1, "got: {out}");
    }

    #[test]
    fn img_auto_width_skipped() {
        let html = r#"<img src="x.png" style="width: auto">"#;
        let out = mirror_img_style_size_to_attrs(html);
        assert!(!out.contains("width=\""), "auto should be skipped: {out}");
    }
}
