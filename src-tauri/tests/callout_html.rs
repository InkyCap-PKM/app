//! Compile-validates the HTML-target branch of the `#callout(...)` and
//! `#annotation(...)` primitives in the `inkycap-notebox` Typst package
//! (`lib.typ`).
//!
//! Typst's `typst-html` backend drops the paged `block(fill:/stroke:/…)` box
//! styling these used to rely on, so they now branch on `target() == "html"`
//! and emit a semantic `<div class="inkycap-callout …">` (with the resolved
//! kind colour as a CSS custom property) for the reading-view / export
//! stylesheet to paint. A syntax error in that branch only surfaces when a note
//! using it is compiled to HTML, so this runs a real note through the actual
//! Typst HTML compiler. Needs no external tooling, so it always runs.

use inkycap_lib::storage::path::canonicalize_root;
use inkycap_lib::typst_pipeline::compiler::TypstCompiler;

const NOTE: &str = "#import \"/.inkycap/notebox.typ\": *\n\
#note(title: \"Callout host\")\n\
\n\
= Draft\n\
\n\
#callout(\"note\", title: \"Heads up\")[Body with *bold* and _italic_ text.]\n\
\n\
#callout(\"warning\")[Careful now.]\n\
\n\
#annotation(by: \"alice\", on: \"2026-05-23\")[A reviewer remark.]\n";

#[test]
fn callout_and_annotation_emit_semantic_html() {
    let dir = tempfile::tempdir().expect("tempdir");
    let notebox_root = canonicalize_root(dir.path()).expect("canonicalize tempdir");
    inkycap_lib::notebox_package::scaffold(&notebox_root);

    let note_path = notebox_root.join("callout-host.typ");
    std::fs::write(&note_path, NOTE).expect("write note");

    let mut compiler = TypstCompiler::new(notebox_root.clone());
    compiler.ensure_system_fonts();
    let result = compiler
        .compile_html(&note_path, NOTE.to_string())
        .expect("callout/annotation note compiles to HTML");

    assert!(
        result.ok,
        "HTML compile reported failure: {:?}",
        result.diagnostics
    );
    let html = &result.html;

    // Callout renders as a semantic div carrying kind + the body/title parts.
    assert!(
        html.contains("inkycap-callout--note"),
        "note callout class missing:\n{html}"
    );
    assert!(
        html.contains("inkycap-callout--warning"),
        "warning callout class missing:\n{html}"
    );
    assert!(
        html.contains("inkycap-callout__title"),
        "callout title element missing:\n{html}"
    );
    assert!(
        html.contains("inkycap-callout__body"),
        "callout body element missing:\n{html}"
    );
    // The custom property carrying the resolved colour must be emitted.
    assert!(
        html.contains("--inkycap-callout-color:"),
        "callout colour custom property missing:\n{html}"
    );
    // Inner markup still renders inside the HTML body (it is real Typst content).
    assert!(
        html.contains("Careful now."),
        "callout body text missing:\n{html}"
    );

    // Annotation gets the same treatment.
    assert!(
        html.contains("inkycap-annotation"),
        "annotation class missing:\n{html}"
    );
    assert!(
        html.contains("inkycap-annotation__title"),
        "annotation title element missing:\n{html}"
    );
    assert!(
        html.contains("A reviewer remark."),
        "annotation body text missing:\n{html}"
    );
}
