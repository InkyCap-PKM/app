//! Checks that the `#annotation` function in the `inkycap-notebox` package
//! (`lib.typ`) compiles.
//!
//! `#annotation` draws a styled block and emits a queryable label
//! (`<inkycap-annotation>`). An error in its `#let` would only show when a note
//! using it compiles, so this compiles a note with a bare `#annotation[…]` and
//! an `#annotation(…)[…]` with `by:`/`on:` and inline markup. Needs no external
//! tools, so it always runs.

use inkycap_lib::storage::path::canonicalize_root;
use inkycap_lib::typst_pipeline::compiler::{PdfStandardPreset, TypstCompiler};

const NOTE: &str = "#import \"/.inkycap/notebox.typ\": *\n\
#note(title: \"Annotation host\")\n\
\n\
= Draft\n\
\n\
Some prose under review.\n\
\n\
#annotation[This needs a *citation* — see _Smith 2024_.]\n\
\n\
#annotation(by: \"alice\", on: \"2026-05-22\")[Tighten the intro.]\n";

#[test]
fn annotation_primitives_compile_to_pdf() {
    let dir = tempfile::tempdir().expect("tempdir");
    let notebox_root = canonicalize_root(dir.path()).expect("canonicalize tempdir");
    inkycap_lib::notebox_package::scaffold(&notebox_root);

    let note_path = notebox_root.join("annotation-host.typ");
    std::fs::write(&note_path, NOTE).expect("write note");

    let mut compiler = TypstCompiler::new(notebox_root.clone());
    compiler.ensure_system_fonts();
    let pdf = compiler
        .compile_pdf(&note_path, NOTE.to_string(), PdfStandardPreset::Standard)
        .expect("annotation primitives compile to PDF");
    assert!(!pdf.is_empty(), "non-empty PDF produced");
}

#[test]
fn annotation_host_round_trips_through_query() {
    // The note compiles and the metadata query works (the `#note` title is
    // found). The label uses the same `[#metadata(..) <label>]` pattern as
    // `#tag` / `#task`; this checks the document around it stays valid.
    let dir = tempfile::tempdir().expect("tempdir");
    let notebox_root = canonicalize_root(dir.path()).expect("canonicalize tempdir");
    inkycap_lib::notebox_package::scaffold(&notebox_root);

    let note_path = notebox_root.join("annotation-host.typ");
    std::fs::write(&note_path, NOTE).expect("write note");

    let mut compiler = TypstCompiler::new(notebox_root.clone());
    compiler.ensure_system_fonts();
    let result = inkycap_lib::typst_pipeline::query::compile_and_query(
        &mut compiler,
        &note_path,
        NOTE.to_string(),
    );
    assert_eq!(
        result.properties.get("title").and_then(|v| match v {
            inkycap_lib::models::note::PropertyValue::String(s) => Some(s.as_str()),
            _ => None,
        }),
        Some("Annotation host"),
    );
}
