//! Checks that a rewritten bibliography file reaches the compiler. The compiler
//! keeps each file it has read until told otherwise, so after the Zotero
//! export is rewritten (the References panel's Refresh, saving settings, an
//! export) `NoteboxSession::refresh_bibliography_file` calls
//! `TypstCompiler::invalidate_notebox_file`. Without that, the reading view and
//! exports kept showing the old entries until InkyCap restarted.

use inkycap_lib::storage::path::canonicalize_root;
use inkycap_lib::typst_pipeline::compiler::TypstCompiler;

const NOTE: &str = "#import \"/.inkycap/notebox.typ\": *\n@otlet1934\n\n#bibliography(\"/.inkycap/zotero-export.bib\")\n";

fn bib(title: &str) -> String {
    format!("@book{{otlet1934,\n  author = {{Otlet, Paul}},\n  title = {{{title}}},\n  year = {{1934}},\n}}\n")
}

#[test]
fn invalidating_the_bibliography_shows_the_rewritten_entries() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = canonicalize_root(dir.path()).expect("canonicalize tempdir");
    inkycap_lib::notebox_package::scaffold(&root);
    let bib_path = root.join(".inkycap/zotero-export.bib");
    std::fs::write(&bib_path, bib("First title")).expect("write bib");
    let note_path = root.join("note.typ");
    std::fs::write(&note_path, NOTE).expect("write note");

    let mut compiler = TypstCompiler::new(root.clone());
    compiler.ensure_system_fonts();
    let mut html = || {
        compiler
            .compile_html(&note_path, NOTE.to_string())
            .expect("note compiles")
            .html
    };
    assert!(html().contains("First title"));

    std::fs::write(&bib_path, bib("Second title")).expect("rewrite bib");
    // Until told, the compiler keeps the copy it read first.
    assert!(html().contains("First title"));
    drop(html);
    compiler.invalidate_notebox_file("/.inkycap/zotero-export.bib");
    let after = compiler
        .compile_html(&note_path, NOTE.to_string())
        .expect("note compiles")
        .html;
    assert!(
        after.contains("Second title"),
        "stale bibliography:\n{after}"
    );
}
