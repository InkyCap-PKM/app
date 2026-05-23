//! Compile-validates the `#review` / `#review-decision` collaboration
//! primitives in the `inkycap-notebox` Typst package (`lib.typ`).
//!
//! Both render a styled annotation block and emit a queryable label
//! (`<inkycap-review>` / `<inkycap-review-decision>`). A syntax error in either
//! `#let` would only surface when a note that uses them is compiled, so this
//! test runs a real note carrying both — a bare `#review[…]`, a `#review(…)[…]`
//! with `by:`/`on:` attribution and inline markup, and the three
//! `#review-decision(…)` action kinds (accepted / rejected / commented, the
//! last two with/without a note arg) — through the actual Typst compiler.
//! Exercises every branch of `_decision-color` / `_decision-label`. Needs no
//! external tooling, so it always runs.

use inkycap_lib::storage::path::canonicalize_root;
use inkycap_lib::typst_pipeline::compiler::{PdfStandardPreset, TypstCompiler};

const NOTE: &str = "#import \"/.inkycap/notebox.typ\": *\n\
#note(title: \"Review host\")\n\
\n\
= Draft\n\
\n\
Some prose under review.\n\
\n\
#review[This needs a *citation* — see _Smith 2024_.]\n\
\n\
#review(by: \"alice\", on: \"2026-05-22\")[Tighten the intro.]\n\
\n\
#review-decision(\"New Section\", \"accepted\", by: \"alice\", on: \"2026-05-22\")\n\
\n\
#review-decision(\"Old Intro\", \"rejected\", note: \"Superseded by the new draft.\", by: \"alice\", on: \"2026-05-22\")\n\
\n\
#review-decision(\"Methodology\", \"commented\", note: \"Worth expanding later.\", by: \"bob\")\n";

#[test]
fn review_primitives_compile_to_pdf() {
    let dir = tempfile::tempdir().expect("tempdir");
    let notebox_root = canonicalize_root(dir.path()).expect("canonicalize tempdir");
    inkycap_lib::notebox_package::scaffold(&notebox_root);

    let note_path = notebox_root.join("review-host.typ");
    std::fs::write(&note_path, NOTE).expect("write note");

    let mut compiler = TypstCompiler::new(notebox_root.clone());
    compiler.ensure_system_fonts();
    let pdf = compiler
        .compile_pdf(&note_path, NOTE.to_string(), PdfStandardPreset::Standard)
        .expect("review primitives compile to PDF");
    assert!(!pdf.is_empty(), "non-empty PDF produced");
}

#[test]
fn review_host_round_trips_through_query() {
    // Confirms the note is well-formed end to end: it compiles and the
    // metadata query succeeds (the `#note` title is recovered). The review
    // labels are emitted by the same proven `[#metadata(..) <label>]` pattern
    // as `#tag` / `#task`; this guards the surrounding document staying valid.
    let dir = tempfile::tempdir().expect("tempdir");
    let notebox_root = canonicalize_root(dir.path()).expect("canonicalize tempdir");
    inkycap_lib::notebox_package::scaffold(&notebox_root);

    let note_path = notebox_root.join("review-host.typ");
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
        Some("Review host"),
    );
}
