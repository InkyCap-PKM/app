//! Compile-validates the contributors byline + CRediT statement rendering.
//!
//! The `contributors-byline` / `credit-statement` helpers live in the
//! `inkycap-notebox` Typst package (`lib.typ`); a syntax error there would
//! only surface at book-export time. This test runs the real merged-book
//! wrapper with a multi-role contributor roster + CRediT roles through the
//! actual Typst compiler and asserts a non-empty PDF comes back — i.e. the
//! emitted `#contributors-byline(...)` / `#credit-statement(...)` calls and
//! the package functions they hit all compile.
//!
//! Unlike the veraPDF test this needs no external tooling, so it always
//! runs.

use inkycap_lib::collection_parser::model::{
    BookPageNumbering, BookWikilinkMode, Contributor, InjectChapterHeading,
};
use inkycap_lib::storage::path::canonicalize_root;
use inkycap_lib::typst_pipeline::book_wrapper::{build_book_source, BookExportOptions, BookNote};
use inkycap_lib::typst_pipeline::compiler::{PdfStandardPreset, TypstCompiler};

fn contrib(name: &str, role: Option<&str>, credit: &[&str]) -> Contributor {
    Contributor {
        name: name.into(),
        biblio_role: role.map(|r| r.into()),
        credit_roles: credit.iter().map(|c| c.to_string()).collect(),
        is_collaborator: false,
        handle: None,
    }
}

fn write_chapter(notebox_root: &std::path::Path, stem: &str, title: &str) -> BookNote {
    let p = notebox_root.join(format!("{stem}.typ"));
    std::fs::write(
        &p,
        format!(
            "#import \"/.inkycap/notebox.typ\": *\n#note(title: \"{title}\")\n\n= {title}\n\nBody text.\n"
        ),
    )
    .expect("write chapter");
    BookNote {
        stem: stem.to_string(),
        abs_path: p.clone(),
        content: std::fs::read_to_string(&p).unwrap(),
        title: Some(title.to_string()),
    }
}

fn plain_options() -> BookExportOptions {
    BookExportOptions {
        title: Some("T".to_string()),
        subtitle: None,
        author: None,
        contributors: vec![],
        date: None,
        abstract_text: None,
        toc_depth: 2,
        number_chapters: false,
        inject_chapter_heading: InjectChapterHeading::Fallback,
        wikilink_mode: BookWikilinkMode::Internal,
        include_title_page: false,
        include_outline: false,
        page_numbering: BookPageNumbering::Arabic,
        include_bibliography: false,
        include_credit_statement: false,
    }
}

#[test]
fn merged_book_with_contributors_and_credit_compiles() {
    let dir = tempfile::tempdir().expect("tempdir");
    let notebox_root = canonicalize_root(dir.path()).expect("canonicalize tempdir");
    inkycap_lib::notebox_package::scaffold(&notebox_root);

    // Stems with spaces + parens exercise the chapter-anchor fix: these are
    // illegal in `<...>` markup-label syntax and previously derailed the
    // merged compile with "unclosed label".
    let chapters = vec![
        write_chapter(&notebox_root, "Information Technology and Libraries (ITAL)", "ITAL"),
        write_chapter(&notebox_root, "Journal of Creative Library Practice", "JCLP"),
    ];

    // A roster exercising the byline grouping (author + editor + translator)
    // and CRediT statement (resolved labels), with a name containing a quote
    // to confirm escaping survives the round-trip into Typst.
    const CONCEPT: &str = "https://credit.niso.org/contributor-roles/conceptualization/";
    const WRITING: &str = "https://credit.niso.org/contributor-roles/writing-original-draft/";
    let contributors = vec![
        contrib("Ada \"Countess\" Lovelace", Some("author"), &[CONCEPT, WRITING]),
        contrib("Bob Jones", None, &[CONCEPT]),
        contrib("Sam Lee", Some("editor"), &[]),
        contrib("Pat Roy", Some("translator"), &[]),
    ];

    let options = BookExportOptions {
        title: Some("Contributors Smoke Test".to_string()),
        subtitle: Some("A subtitle".to_string()),
        author: None,
        contributors,
        date: Some("2026-01-01".to_string()),
        abstract_text: None,
        toc_depth: 2,
        number_chapters: true,
        inject_chapter_heading: InjectChapterHeading::Fallback,
        wikilink_mode: BookWikilinkMode::Internal,
        include_title_page: true,
        include_outline: true,
        page_numbering: BookPageNumbering::RomanThenArabic,
        include_bibliography: false,
        include_credit_statement: true,
    };

    let source = build_book_source(
        &chapters, &options, None, None, None, None, false, None, None,
    );

    // The byline + CRediT calls must be present in the emitted source…
    assert!(source.contains("#contributors-byline("), "byline call emitted");
    assert!(source.contains("#credit-statement("), "credit statement call emitted");

    // …and the whole thing must actually compile through Typst (this is
    // what catches a lib.typ syntax error).
    let book_path = notebox_root.join("__book.typ");
    std::fs::write(&book_path, &source).expect("write merged source");

    let mut compiler = TypstCompiler::new(notebox_root.clone());
    compiler.ensure_system_fonts();
    let pdf = compiler
        .compile_pdf(&book_path, source, PdfStandardPreset::Standard)
        .expect("contributors book compiles to PDF");
    assert!(!pdf.is_empty(), "non-empty PDF produced");
}

#[test]
fn credit_statement_suppressed_when_disabled() {
    // include_credit_statement = false ⇒ no #credit-statement call even
    // though contributors carry CRediT roles. The byline still renders.
    const CONCEPT: &str = "https://credit.niso.org/contributor-roles/conceptualization/";
    let options = BookExportOptions {
        title: Some("No Credit".to_string()),
        subtitle: None,
        author: None,
        contributors: vec![contrib("Ada Lovelace", Some("author"), &[CONCEPT])],
        date: None,
        abstract_text: None,
        toc_depth: 2,
        number_chapters: false,
        inject_chapter_heading: InjectChapterHeading::Fallback,
        wikilink_mode: BookWikilinkMode::Plain,
        include_title_page: true,
        include_outline: false,
        page_numbering: BookPageNumbering::Arabic,
        include_bibliography: false,
        include_credit_statement: false,
    };
    let source = build_book_source(&[], &options, None, None, None, None, false, None, None);
    assert!(source.contains("#contributors-byline("), "byline still rendered");
    assert!(!source.contains("#credit-statement("), "credit statement suppressed");
    // Document author derived from the contributor roster.
    assert!(source.contains("author: \"Ada Lovelace\""), "doc author from contributors");
}

#[test]
fn single_chapter_with_spaced_paren_stem_compiles() {
    // Regression for two pre-existing book-export bugs:
    //   1. a one-chapter book emitted `chapters: ("x")` — a string, not a
    //      one-element array — tripping set-merged-context's assert;
    //   2. a stem with spaces/parens emitted `<chap-... ...>` markup-label
    //      syntax, illegal → "unclosed label".
    let dir = tempfile::tempdir().expect("tempdir");
    let notebox_root = canonicalize_root(dir.path()).expect("canonicalize tempdir");
    inkycap_lib::notebox_package::scaffold(&notebox_root);

    let chapter = write_chapter(&notebox_root, "Knowledge Organization (KO)", "KO");
    let source = build_book_source(
        &[chapter],
        &plain_options(),
        None, None, None, None, false, None, None,
    );
    assert!(source.contains("chapters: (\"Knowledge Organization (KO)\",)"), "one-element array");
    assert!(source.contains("#chapter-anchor(\"Knowledge Organization (KO)\")"), "fn-form anchor");

    let book_path = notebox_root.join("__book.typ");
    std::fs::write(&book_path, &source).expect("write merged source");
    let mut compiler = TypstCompiler::new(notebox_root.clone());
    compiler.ensure_system_fonts();
    let pdf = compiler
        .compile_pdf(&book_path, source, PdfStandardPreset::Standard)
        .expect("single-chapter spaced-stem book compiles");
    assert!(!pdf.is_empty());
}
