//! Checks `BibliographyMode::PerChapter` end to end.
//!
//! Typst 0.15 allows several `#bibliography()` calls per document, each limited
//! to some citations with a `target` selector. PerChapter mode adds one at the
//! end of each chapter through the package's `chapter-bibliography`.
//!
//! The unit test in `book_wrapper.rs` checks the generated source; this compiles
//! a book with the real compiler and checks that it compiles and that each
//! chapter's list holds only that chapter's citations. Needs no external tools,
//! so it always runs.

use inkycap_lib::collection_parser::model::{
    BibliographyMode, BookPageNumbering, BookWikilinkMode, InjectChapterHeading, TocPlacement,
};
use inkycap_lib::storage::path::canonicalize_root;
use inkycap_lib::typst_pipeline::book_wrapper::{build_book_source, BookExportOptions, BookNote};
use inkycap_lib::typst_pipeline::compiler::TypstCompiler;

const REFS: &str = r#"@article{alpha2001, author = {Author Alpha}, title = {Alpha Distinct Title}, journal = {J}, year = {2001}}
@article{beta2002, author = {Author Beta}, title = {Beta Distinct Title}, journal = {J}, year = {2002}}
"#;

fn chapter(root: &std::path::Path, stem: &str, body: &str) -> BookNote {
    let p = root.join(format!("{stem}.typ"));
    let content =
        format!("#import \"/.inkycap/notebox.typ\": *\n#note(title: \"{stem}\")\n\n{body}\n");
    std::fs::write(&p, &content).expect("write chapter");
    BookNote {
        stem: stem.to_string(),
        abs_path: p,
        content,
        title: Some(stem.to_string()),
    }
}

fn per_chapter_options() -> BookExportOptions {
    BookExportOptions {
        title: Some("Per-chapter bibliographies".to_string()),
        subtitle: None,
        author: None,
        contributors: vec![],
        date: None,
        abstract_text: None,
        toc_depth: 2,
        inject_chapter_heading: InjectChapterHeading::Fallback,
        wikilink_mode: BookWikilinkMode::Internal,
        include_title_page: false,
        include_outline: false,
        page_numbering: BookPageNumbering::Arabic,
        toc_placement: TocPlacement::Beginning,
        bibliography_mode: BibliographyMode::PerChapter,
        include_credit_statement: false,
    }
}

#[test]
fn per_chapter_bibliography_scopes_each_chapters_citations() {
    let dir = tempfile::tempdir().expect("tempdir");
    let notebox_root = canonicalize_root(dir.path()).expect("canonicalize tempdir");
    inkycap_lib::notebox_package::scaffold(&notebox_root);
    std::fs::write(notebox_root.join("refs.bib"), REFS).expect("write refs.bib");

    // Two chapters, each citing a different work.
    let chapters = vec![
        chapter(
            &notebox_root,
            "alpha",
            "= Alpha\n\nDiscussed in @alpha2001.",
        ),
        chapter(&notebox_root, "beta", "= Beta\n\nDiscussed in @beta2002."),
    ];

    let source = build_book_source(
        &chapters,
        &per_chapter_options(),
        None,
        None,
        None,
        Some("/refs.bib"),
        None,
        false,
        None,
        None,
    );

    let book_path = notebox_root.join("__book.typ");
    std::fs::write(&book_path, &source).expect("write merged source");

    let mut compiler = TypstCompiler::new(notebox_root.clone());
    // Bundled fonts are enough; keep the test machine-independent.
    let result = compiler
        .compile_html(&book_path, source.clone())
        .expect("compile call succeeds");
    assert!(
        result.ok,
        "PerChapter book failed to compile: {:?}",
        result.diagnostics
    );

    let html = &result.html;
    let alpha_at = html.find("Alpha Distinct Title");
    let beta_at = html.find("Beta Distinct Title");
    assert!(
        alpha_at.is_some() && beta_at.is_some(),
        "both works should appear once each across the two chapter bibliographies"
    );
    // Each distinct work appears exactly once — it is listed only under its own
    // chapter's scoped bibliography, not duplicated into the other's.
    assert_eq!(
        html.matches("Alpha Distinct Title").count(),
        1,
        "alpha work must appear in exactly one chapter bibliography"
    );
    assert_eq!(
        html.matches("Beta Distinct Title").count(),
        1,
        "beta work must appear in exactly one chapter bibliography"
    );
    // Document order: alpha's work (chapter 1) precedes beta's (chapter 2),
    // confirming each list sits with its own chapter rather than pooling.
    assert!(
        alpha_at < beta_at,
        "alpha's reference should precede beta's in reading order"
    );
}
