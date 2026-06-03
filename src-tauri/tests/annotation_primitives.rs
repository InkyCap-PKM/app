//! Compile-validates the `#annotation` primitive in the `inkycap-notebox`
//! Typst package (`lib.typ`).
//!
//! `#annotation` renders a styled block and emits a queryable label
//! (`<inkycap-annotation>`). A syntax error in the `#let` would only surface
//! when a note that uses it is compiled, so this test runs a real note carrying
//! both a bare `#annotation[…]` and an `#annotation(…)[…]` with `by:`/`on:`
//! attribution and inline markup through the actual Typst compiler. Needs no
//! external tooling, so it always runs.

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
    // Confirms the note is well-formed end to end: it compiles and the
    // metadata query succeeds (the `#note` title is recovered). The annotation
    // label is emitted by the same proven `[#metadata(..) <label>]` pattern as
    // `#tag` / `#task`; this guards the surrounding document staying valid.
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
