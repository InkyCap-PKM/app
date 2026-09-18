//! The bundled user manuals must build as a single book PDF through the same
//! code path as the app's "Export as book" action, using the collection file
//! committed next to each manual. This catches a page that no longer
//! compiles, a label defined twice across pages, or a collection file the
//! parser rejects, before a release ships a broken manual.
//!
//! The PDF is written to the system temp folder as `inkycap-manual-<lang>.pdf`
//! so it can be inspected by hand.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use inkycap_lib::collection_parser::model::parse_collection_file;
use inkycap_lib::commands::export::ensure_document_date_for_standard;
use inkycap_lib::link_index::note_stem;
use inkycap_lib::settings::UserSettings;
use inkycap_lib::storage::path::canonicalize_root;
use inkycap_lib::typst_pipeline::bibliography::escape_invalid_citations;
use inkycap_lib::typst_pipeline::book_wrapper::{
    build_book_source, scan_label_collisions, BookExportOptions, BookNote,
};
use inkycap_lib::typst_pipeline::compiler::{PdfStandardPreset, TypstCompiler};
use inkycap_lib::typst_pipeline::note_rewriter::{
    extract_note_properties, typst_value_to_plain_text,
};
use inkycap_lib::typst_pipeline::style_injection::build_defaults_show_call_resolved;

const WORKING_DIR: &str = ".inkycap";

fn manual_root(folder: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../documentation/manual")
        .join(folder)
}

/// Copy the manual's notes and assets into `dest`, leaving out any `.inkycap/`
/// working folder so the temp notebox starts from a clean scaffold.
fn copy_manual(src: &Path, dest: &Path) {
    for entry in std::fs::read_dir(src).expect("read manual folder") {
        let entry = entry.expect("dir entry");
        let name = entry.file_name();
        if name == WORKING_DIR {
            continue;
        }
        let target = dest.join(&name);
        if entry.file_type().expect("file type").is_dir() {
            std::fs::create_dir_all(&target).expect("create dir");
            copy_manual(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).expect("copy file");
        }
    }
}

/// Every `.typ` note under `root`, as paths relative to it, in the order the
/// collection's `file.path` sort produces.
fn collect_notes(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("read dir") {
        let entry = entry.expect("dir entry");
        let path = entry.path();
        if entry.file_name() == WORKING_DIR {
            continue;
        }
        if path.is_dir() {
            collect_notes(root, &path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("typ") {
            out.push(path.strip_prefix(root).expect("relative").to_path_buf());
        }
    }
}

fn note_title(content: &str) -> Option<String> {
    extract_note_properties(content)
        .into_iter()
        .find(|(k, _)| k == "title")
        .map(|(_, v)| typst_value_to_plain_text(&v))
        .filter(|s| !s.is_empty())
}

fn build_manual(folder: &str, collection_file: &str, lang: &str) {
    let source_root = manual_root(folder);
    let collection_path = source_root
        .join(WORKING_DIR)
        .join("collections")
        .join(collection_file);
    let collection = parse_collection_file(
        &std::fs::read_to_string(&collection_path).expect("read collection file"),
    )
    .expect("collection file parses");

    let tmp = tempfile::tempdir().expect("tempdir");
    let root = canonicalize_root(tmp.path()).expect("canonical root");
    copy_manual(&source_root, &root);
    inkycap_lib::notebox_package::scaffold(&root);

    let mut rel_paths = Vec::new();
    collect_notes(&root, &root, &mut rel_paths);
    rel_paths.sort_by(|a, b| {
        inkycap_lib::sort::compare_name(&a.to_string_lossy(), &b.to_string_lossy())
    });
    assert!(rel_paths.len() > 20, "manual should hold the full note set");

    let notes: Vec<BookNote> = rel_paths
        .iter()
        .map(|rel| {
            let abs_path = root.join(rel);
            let content = std::fs::read_to_string(&abs_path).expect("read note");
            BookNote {
                stem: note_stem(&abs_path),
                title: note_title(&content),
                abs_path,
                content,
            }
        })
        .collect();

    let collisions = scan_label_collisions(&notes);
    assert!(
        collisions.is_empty(),
        "labels defined in more than one manual page: {collisions:?}"
    );

    let options = BookExportOptions::from_config(collection.book.as_ref());
    let mut style_rules = build_defaults_show_call_resolved(&UserSettings::default());
    if let Some(rules) = collection.style.as_ref().map(|s| s.to_typst_show_call()) {
        if !rules.is_empty() {
            if !style_rules.ends_with('\n') {
                style_rules.push('\n');
            }
            style_rules.push_str(&rules);
        }
    }
    let heading_numbering = collection
        .style
        .as_ref()
        .and_then(|s| s.heading.as_ref())
        .and_then(|h| h.numbering.clone());
    let source = build_book_source(
        &notes,
        &options,
        Some(&style_rules),
        collection.custom_typst.as_deref(),
        None,
        None,
        None,
        false,
        None,
        heading_numbering.as_deref(),
    );
    let source = escape_invalid_citations(&source, &HashSet::new());
    let source = ensure_document_date_for_standard(source, PdfStandardPreset::Standard);
    let source_for_inspection = source.clone();

    let book_path = root.join("manual.book.typ");
    let mut compiler = TypstCompiler::new(root.clone());
    compiler.ensure_system_fonts();
    let pdf = compiler
        .compile_pdf(&book_path, source, PdfStandardPreset::Standard)
        .unwrap_or_else(|e| panic!("{folder} book failed to compile: {e}"));
    assert!(!pdf.is_empty());

    let out = std::env::temp_dir().join(format!("inkycap-manual-{lang}.pdf"));
    std::fs::write(&out, &pdf).expect("write pdf");
    // The merged source is kept beside the PDF so a layout problem can be
    // traced to the wrapper or to a page without re-running the build.
    std::fs::write(out.with_extension("typ"), &source_for_inspection).expect("write source");
    eprintln!("wrote {}", out.display());
}

#[test]
fn english_manual_builds_as_a_book() {
    build_manual("InkyCap-Documentation", "User Manual.collection", "en");
}

#[test]
fn french_manual_builds_as_a_book() {
    let folder = "InkyCap-Documentation-fr-CA";
    let collection = "Manuel de l'utilisateur.collection";
    if !manual_root(folder)
        .join(WORKING_DIR)
        .join("collections")
        .join(collection)
        .exists()
    {
        eprintln!("skipping: no French book collection yet");
        return;
    }
    build_manual(folder, collection, "fr-CA");
}
