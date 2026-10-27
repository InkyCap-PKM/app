//! veraPDF check of the merged-book PDF/UA-1 export.
//!
//! Builds a small merged book through the export pipeline, has Typst write it
//! as PDF/UA-1, and checks it with veraPDF against the UA-1 profile. PDF/UA
//! conformance (heading nesting, tagging, title metadata) is easy to break
//! unnoticed, and the book pipeline does UA-specific work (heading levels,
//! `#set document(title:)`, plain page numbers in the TOC).
//!
//! veraPDF runs as a Flatpak (`org.verapdf.veraPDF`) via `flatpak run`. Without
//! it (as in CI) the test prints a notice and passes.
//!
//! The Flatpak can't read `/tmp`, so the PDF is written under
//! `$HOME/.cache/inkycap-test-pdfs/` and removed afterwards.

use std::path::PathBuf;
use std::process::Command;

use inkycap_lib::collection_parser::model::{
    BibliographyMode, BookPageNumbering, BookWikilinkMode, InjectChapterHeading, TocPlacement,
};
use inkycap_lib::commands::export::ensure_document_date_for_standard;
use inkycap_lib::storage::path::canonicalize_root;
use inkycap_lib::typst_pipeline::book_wrapper::{build_book_source, BookExportOptions, BookNote};
use inkycap_lib::typst_pipeline::compiler::{PdfStandardPreset, TypstCompiler};

/// veraPDF flatpak entry point. The CLI lives at this command name even
/// though the friendly app id is `org.verapdf.veraPDF`.
const VERAPDF_FLATPAK: &str = "org.verapdf.veraPDF";

/// The veraPDF command (without arguments) if flatpak and the veraPDF app are
/// installed.
fn locate_verapdf() -> Option<Command> {
    // Is `flatpak` itself on PATH?
    let flatpak_present = Command::new("flatpak")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !flatpak_present {
        return None;
    }
    // Is the veraPDF flatpak installed?
    let installed = Command::new("flatpak")
        .args(["info", "--show-runtime", VERAPDF_FLATPAK])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !installed {
        return None;
    }
    let mut cmd = Command::new("flatpak");
    cmd.args(["run", "--command=verapdf", VERAPDF_FLATPAK]);
    Some(cmd)
}

#[test]
fn merged_book_pdf_ua1_export_is_compliant() {
    let Some(mut verapdf) = locate_verapdf() else {
        eprintln!(
            "skipping verapdf check: flatpak or {} not installed",
            VERAPDF_FLATPAK
        );
        return;
    };

    // A two-chapter book whose chapters start at different heading levels, to
    // exercise heading normalization: PDF/UA-1 rejects skipped heading levels.
    let dir = tempfile::tempdir().expect("tempdir");
    let notebox_root = canonicalize_root(dir.path()).expect("canonicalize tempdir");
    inkycap_lib::notebox_package::scaffold(&notebox_root);

    let chapter_a_path = notebox_root.join("alpha.typ");
    let chapter_b_path = notebox_root.join("beta.typ");
    std::fs::write(
        &chapter_a_path,
        "#import \"/.inkycap/notebox.typ\": *\n\
         #note(title: \"Alpha\")\n\
         \n\
         = Alpha\n\
         \n\
         Some intro text for chapter alpha.\n\
         \n\
         == A subhead\n\
         \n\
         Body of the subhead.\n",
    )
    .expect("write alpha");
    std::fs::write(
        &chapter_b_path,
        "#import \"/.inkycap/notebox.typ\": *\n\
         #note(title: \"Beta\")\n\
         \n\
         === Skipping straight to h3 on purpose\n\
         \n\
         This exercises gap compression in the heading normalizer.\n",
    )
    .expect("write beta");

    let chapters = vec![
        BookNote {
            stem: "alpha".to_string(),
            abs_path: chapter_a_path.clone(),
            content: std::fs::read_to_string(&chapter_a_path).unwrap(),
            title: Some("Alpha".to_string()),
        },
        BookNote {
            stem: "beta".to_string(),
            abs_path: chapter_b_path.clone(),
            content: std::fs::read_to_string(&chapter_b_path).unwrap(),
            title: Some("Beta".to_string()),
        },
    ];

    let options = BookExportOptions {
        title: Some("UA-1 Smoke Test Book".to_string()),
        subtitle: None,
        author: Some("Inkycap Tests".to_string()),
        date: Some("2026-01-01".to_string()),
        abstract_text: None,
        toc_depth: 2,
        inject_chapter_heading: InjectChapterHeading::Fallback,
        wikilink_mode: BookWikilinkMode::Internal,
        include_title_page: true,
        include_outline: true,
        page_numbering: BookPageNumbering::RomanThenArabic,
        toc_placement: TocPlacement::Beginning,
        bibliography_mode: BibliographyMode::Unified,
        contributors: vec![],
        include_credit_statement: false,
    };

    let source = build_book_source(
        &chapters, &options, None, None, None, None, None, // bibliography_style
        true, // normalize_headings — the load-bearing PDF/UA-1 setting
        None, None,
    );

    // As in the real export: book wrapper, then document date, then compile.
    // UA-1 needs both the title (from the wrapper) and a fixed date
    // (`ensure_document_date_for_standard`).
    let source = ensure_document_date_for_standard(source, PdfStandardPreset::PdfUa1);

    let book_path = notebox_root.join("__book.typ");
    std::fs::write(&book_path, &source).expect("write merged source");

    let mut compiler = TypstCompiler::new(notebox_root.clone());
    compiler.ensure_system_fonts();
    let pdf_bytes = compiler
        .compile_pdf(&book_path, source, PdfStandardPreset::PdfUa1)
        .expect("compile pdf/ua-1");

    // Somewhere the veraPDF Flatpak can read (`$HOME`, not `/tmp`).
    let cache_dir = home_cache_dir();
    std::fs::create_dir_all(&cache_dir).expect("create cache dir");
    let pdf_path = cache_dir.join("merged-book-ua1-smoke.pdf");
    std::fs::write(&pdf_path, &pdf_bytes).expect("write pdf");

    // Defer cleanup until end-of-test.
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _cleanup = Cleanup(pdf_path.clone());

    // Run veraPDF: `--format text` keeps the output simple to scan.
    let output = verapdf
        .args(["--format", "text", "-f", "ua1"])
        .arg(&pdf_path)
        .output()
        .expect("invoke verapdf");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    // veraPDF's text output says `PASS` / `FAIL` per file. Anything but a clean
    // pass, including parse errors or a non-zero exit, is reported in full.
    let passed = stdout.contains("PASS") && !stdout.contains("FAIL");
    assert!(
        output.status.success() && passed,
        "veraPDF UA-1 validation did not pass.\n\
         exit: {:?}\n\
         stdout:\n{}\n\
         stderr:\n{}",
        output.status,
        stdout,
        stderr,
    );
}

fn home_cache_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .expect("$HOME must be set for the verapdf sandbox to reach the test PDF");
    home.join(".cache").join("inkycap-test-pdfs")
}
