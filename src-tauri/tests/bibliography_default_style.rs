//! Checks that a note's own `#bibliography(...)` without `style:` is formatted
//! in the default style InkyCap adds with `#set bibliography(style: ...)`
//! (`typst_pipeline::bibliography::with_default_style`), and that a style the
//! note names itself still wins. Preview and every export add the default this
//! way, so this is what keeps a note's PDF in the same style as its preview.
//! Compiles with Typst's HTML compiler; needs no external tools.

use inkycap_lib::storage::path::canonicalize_root;
use inkycap_lib::typst_pipeline::bibliography::with_default_style;
use inkycap_lib::typst_pipeline::compiler::TypstCompiler;

const BIB: &str = "@book{otlet1934,\n  author = {Otlet, Paul},\n  title = {Traité de documentation},\n  year = {1934},\n}\n";

fn compile(note: &str) -> String {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = canonicalize_root(dir.path()).expect("canonicalize tempdir");
    inkycap_lib::notebox_package::scaffold(&root);
    std::fs::write(root.join("refs.bib"), BIB).expect("write bib");
    let note_path = root.join("note.typ");
    std::fs::write(&note_path, note).expect("write note");
    let mut compiler = TypstCompiler::new(root.clone());
    compiler.ensure_system_fonts();
    let result = compiler
        .compile_html(&note_path, note.to_string())
        .expect("note compiles to HTML");
    assert!(result.ok, "compile failed: {:?}", result.diagnostics);
    result.html
}

fn note(bibliography: &str) -> String {
    format!("#import \"/.inkycap/notebox.typ\": *\nAs shown @otlet1934[p. 64].\n\n{bibliography}\n")
}

#[test]
fn own_bibliography_uses_the_default_style() {
    let src = note("#bibliography(\"/refs.bib\", title: [References])");
    let html = compile(&with_default_style(&src, "chicago-author-date"));
    assert!(
        html.contains("Otlet 1934, p. 64"),
        "not author-date:\n{html}"
    );
    assert!(html.contains("References"), "title missing:\n{html}");
}

#[test]
fn own_bibliography_without_the_rule_falls_back_to_ieee() {
    // What exports did before: Typst's own default.
    let html = compile(&note("#bibliography(\"/refs.bib\")"));
    assert!(html.contains("[1, p. 64]"), "expected IEEE:\n{html}");
}

#[test]
fn a_style_the_note_names_wins_over_the_default() {
    let src = note("#bibliography(\"/refs.bib\", style: \"ieee\")");
    let html = compile(&with_default_style(&src, "chicago-author-date"));
    assert!(
        html.contains("[1, p. 64]"),
        "expected the note's IEEE:\n{html}"
    );
}
