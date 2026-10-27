//! Checks that the inline `#suggestion(...)` function in the `inkycap-notebox`
//! package (`lib.typ`) compiles.
//!
//! Compiled, `#suggestion` shows the result as if accepted (insert and replace
//! show the new text, delete shows nothing), unstyled, and emits the invisible
//! `<inkycap-suggestion>` mark. An error in its `#let` or `kind` assert only
//! shows when a note using it compiles, so this compiles a note with all three
//! kinds (replace with `old:`, one with attribution). Needs no external tools,
//! so it always runs.

use inkycap_lib::storage::path::canonicalize_root;
use inkycap_lib::typst_pipeline::compiler::{PdfStandardPreset, TypstCompiler};

const NOTE: &str = "#import \"/.inkycap/notebox.typ\": *\n\
#note(title: \"Suggestion host\")\n\
\n\
= Draft\n\
\n\
The team #suggestion(kind: \"insert\", by: \"alice\", on: \"2026-05-23\", note: \"tone?\")[strongly ] recommends this.\n\
\n\
This sentence is #suggestion(kind: \"delete\")[needlessly ]concise.\n\
\n\
It is #suggestion(kind: \"replace\", old: [bad])[good] now, with _inline_ markup.\n";

#[test]
fn suggestion_kinds_compile_to_pdf() {
    let dir = tempfile::tempdir().expect("tempdir");
    let notebox_root = canonicalize_root(dir.path()).expect("canonicalize tempdir");
    inkycap_lib::notebox_package::scaffold(&notebox_root);

    let note_path = notebox_root.join("suggestion-host.typ");
    std::fs::write(&note_path, NOTE).expect("write note");

    let mut compiler = TypstCompiler::new(notebox_root.clone());
    compiler.ensure_system_fonts();
    let pdf = compiler
        .compile_pdf(&note_path, NOTE.to_string(), PdfStandardPreset::Standard)
        .expect("suggestion kinds compile to PDF");
    assert!(!pdf.is_empty(), "non-empty PDF produced");
}

#[test]
fn suggestion_host_round_trips_through_query() {
    // The note compiles and the `#note` title is recovered — confirms the
    // surrounding document (with three `#suggestion` marks) stays well-formed.
    let dir = tempfile::tempdir().expect("tempdir");
    let notebox_root = canonicalize_root(dir.path()).expect("canonicalize tempdir");
    inkycap_lib::notebox_package::scaffold(&notebox_root);

    let note_path = notebox_root.join("suggestion-host.typ");
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
        Some("Suggestion host"),
    );
}
