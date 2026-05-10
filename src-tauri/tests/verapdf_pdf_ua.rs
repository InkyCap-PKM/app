//! veraPDF integration smoke test for the merged-book PDF/UA-1 export.
//!
//! Builds a minimal merged book through the same pipeline the export
//! command uses, asks Typst to emit it as PDF/UA-1, and runs veraPDF over
//! the result to confirm the file passes the UA-1 validation profile.
//!
//! veraPDF is a heavyweight Java tool that ships locally as a Flatpak
//! (`org.verapdf.veraPDF`). We invoke it via `flatpak run` so the test
//! works on the developer machine; CI and machines without the Flatpak
//! installed are auto-skipped — the test prints a one-line notice and
//! returns success rather than blocking the build.
//!
//! The flatpak sandbox refuses to read `/tmp` by default, so the
//! generated PDF is written under `$HOME/.cache/inkycap-test-pdfs/`
//! (which the flatpak's default `~` filesystem permission allows) and
//! cleaned up at the end of the test.
//!
//! Why this test exists: PDF/UA-1 conformance is a structural property
//! of the output (heading nesting, tagged content, document title metadata)
//! that's far easier to break than to notice in a manual export. The
//! merged-book pipeline does PDF/UA-specific work (heading-level
//! normalization, `#set document(title:)` injection, plain-page-number
//! TOC entries) that we want to lock down with a real validator rather
//! than a homemade check.

use std::path::PathBuf;
use std::process::Command;

use inkycap_lib::storage::path::canonicalize_root;
use inkycap_lib::typst_pipeline::book_wrapper::{
    build_book_source, BookExportOptions, BookNote,
};
use inkycap_lib::commands::export::ensure_document_date_for_standard;
use inkycap_lib::typst_pipeline::compiler::{PdfStandardPreset, TypstCompiler};
use inkycap_lib::collection_parser::model::{
    BookPageNumbering, BookWikilinkMode, InjectChapterHeading,
};

/// veraPDF flatpak entry point. The CLI lives at this command name even
/// though the friendly app id is `org.verapdf.veraPDF`.
const VERAPDF_FLATPAK: &str = "org.verapdf.veraPDF";

/// Probe that determines whether the local machine has flatpak + the
/// veraPDF app installed. Returns the assembled command (still missing
/// arguments) when both are present.
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

    // Build a small two-chapter book through the real merged-book wrapper.
    // We exercise the heading-normalization path (chapters with mismatched
    // top-level heading depths) because that's the load-bearing piece for
    // PDF/UA-1 — the spec rejects gappy heading hierarchies.
    let dir = tempfile::tempdir().expect("tempdir");
    let vault_root =
        canonicalize_root(dir.path()).expect("canonicalize tempdir");
    inkycap_lib::vault_package::scaffold(&vault_root);

    let chapter_a_path = vault_root.join("alpha.typ");
    let chapter_b_path = vault_root.join("beta.typ");
    std::fs::write(
        &chapter_a_path,
        "#import \"/.inkycap/vault.typ\": *\n\
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
        "#import \"/.inkycap/vault.typ\": *\n\
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
        number_chapters: true,
        inject_chapter_heading: InjectChapterHeading::Fallback,
        wikilink_mode: BookWikilinkMode::Internal,
        include_title_page: true,
        include_outline: true,
        page_numbering: BookPageNumbering::RomanThenArabic,
        include_bibliography: true,
    };

    let source = build_book_source(
        &chapters,
        &options,
        None,
        None,
        None,
        None,
        true, // normalize_headings — the load-bearing PDF/UA-1 setting
        None,
        None,
    );

    // Mirror the real export pipeline: book wrapper → document-date
    // injector → compile. Either step alone is insufficient — UA-1
    // demands both a document title (set by the wrapper) and a fixed
    // date (added by `ensure_document_date_for_standard`).
    let source = ensure_document_date_for_standard(source, PdfStandardPreset::PdfUa1);

    let book_path = vault_root.join("__book.typ");
    std::fs::write(&book_path, &source).expect("write merged source");

    let mut compiler = TypstCompiler::new(vault_root.clone());
    compiler.ensure_system_fonts();
    let pdf_bytes = compiler
        .compile_pdf(&book_path, source, PdfStandardPreset::PdfUa1)
        .expect("compile pdf/ua-1");

    // Drop the PDF somewhere the verapdf flatpak sandbox can read it. The
    // default `~` permission of org.verapdf.veraPDF gives access to
    // `$HOME/...`; `/tmp` is sandboxed out.
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

    // veraPDF's text format prints `PASS` / `FAIL` per file. Anything
    // other than a clean PASS — including parse failures or non-zero
    // exit — is a regression and worth surfacing in full.
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
