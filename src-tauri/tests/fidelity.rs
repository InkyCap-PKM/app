//! Typst output snapshot tests.
//!
//! A checked-in set of representative `.typ` notes is compiled through the real
//! pipeline, and each output (HTML, SVG, `typst query` metadata) is snapshotted
//! with `insta`, so a Typst upgrade that changes rendered output shows up as a
//! diff. After an upgrade run `cargo insta test --review` and accept the
//! expected changes. See `documentation/developer/typst-upgrade.md`.
//!
//! ## Determinism
//!
//! Snapshots must be the same on every machine, so `ensure_system_fonts()` is
//! not called: only the fonts bundled in `typst-assets` are used.
//!
//! Each fixture gets a fresh temporary notebox with the `inkycap-notebox`
//! package and a shared `refs.bib`, so citations resolve.

use std::collections::BTreeMap;
use std::path::Path;

use inkycap_lib::models::note::{AgendaMarker, PropertyValue};
use inkycap_lib::models::recurrence::Recurrence;
use inkycap_lib::storage::path::canonicalize_root;
use inkycap_lib::typst_pipeline::compiler::TypstCompiler;
use inkycap_lib::typst_pipeline::query::{compile_and_query, QueryResult};

/// Minimal bibliography written into every fixture notebox so the
/// citation/bibliography fixture resolves `@lovelace1843` / `@turing1950`.
const REFS_BIB: &str = r#"@article{lovelace1843,
  author = {Lovelace, Ada},
  title = {Notes on the Analytical Engine},
  journal = {Taylor's Scientific Memoirs},
  year = {1843},
}

@article{turing1950,
  author = {Turing, Alan},
  title = {Computing Machinery and Intelligence},
  journal = {Mind},
  year = {1950},
}
"#;

/// Snapshot-friendly copy of a [`QueryResult`]: properties sorted into a
/// `BTreeMap` (the real struct uses a `HashMap` and isn't `Serialize`), with
/// only the metadata that must stay stable.
#[derive(serde::Serialize)]
struct MetadataSnapshot {
    properties: BTreeMap<String, PropertyValue>,
    tags: Vec<String>,
    links: Vec<String>,
    heading_labels: Vec<String>,
    agenda: Vec<AgendaMarker>,
    recurrence: Option<Recurrence>,
    suggestions: usize,
}

impl From<QueryResult> for MetadataSnapshot {
    fn from(q: QueryResult) -> Self {
        MetadataSnapshot {
            properties: q.properties.into_iter().collect(),
            tags: q.tags,
            links: q.links,
            heading_labels: q.heading_labels,
            agenda: q.agenda,
            recurrence: q.recurrence,
            suggestions: q.suggestions,
        }
    }
}

/// Summary of the rendered SVG pages. The full SVG is megabytes of glyph paths
/// and changes with tiny font shifts; page count and rounded geometry catch
/// real layout changes, and the byte length flags any change at all.
#[derive(serde::Serialize)]
struct SvgDigest {
    page_count: usize,
    pages: Vec<SvgPage>,
}

#[derive(serde::Serialize)]
struct SvgPage {
    width_pt: i64,
    height_pt: i64,
    svg_len: usize,
}

fn compile_fixture(path: &Path) {
    let source = std::fs::read_to_string(path).expect("read fixture");

    let dir = tempfile::tempdir().expect("tempdir");
    let notebox_root = canonicalize_root(dir.path()).expect("canonicalize tempdir");
    inkycap_lib::notebox_package::scaffold(&notebox_root);
    std::fs::write(notebox_root.join("refs.bib"), REFS_BIB).expect("write refs.bib");

    let note_path = notebox_root.join("note.typ");
    std::fs::write(&note_path, &source).expect("write note");

    // Bundled fonts only — see the module-level determinism note.
    let mut compiler = TypstCompiler::new(notebox_root.clone());

    // SVG (paged) — assert a clean compile, then snapshot the layout digest.
    let svg = compiler
        .compile_svg(&note_path, source.clone())
        .expect("svg compile");
    assert!(
        svg.ok,
        "fixture failed to compile to SVG: {:?}",
        svg.diagnostics
    );
    let digest = SvgDigest {
        page_count: svg.frames.len(),
        pages: svg
            .frames
            .iter()
            .map(|f| SvgPage {
                width_pt: f.width_pt.round() as i64,
                height_pt: f.height_pt.round() as i64,
                svg_len: f.svg.len(),
            })
            .collect(),
    };
    insta::assert_json_snapshot!("svg", digest);

    // HTML — the readable fidelity surface; snapshot it in full.
    let html = compiler
        .compile_html(&note_path, source.clone())
        .expect("html compile");
    assert!(
        html.ok,
        "fixture failed to compile to HTML: {:?}",
        html.diagnostics
    );
    insta::assert_snapshot!("html", html.html);

    // Metadata — `#note(...)` properties, tags, links, agenda markers.
    let meta = MetadataSnapshot::from(compile_and_query(&mut compiler, &note_path, source));
    insta::assert_json_snapshot!("metadata", meta);
}

/// One snapshot set (svg / html / metadata) per `.typ` fixture, named after the
/// file, so adding a `.typ` under `fixtures/fidelity/` extends the tests.
#[test]
fn fidelity_corpus() {
    insta::glob!("fixtures/fidelity/*.typ", |path| {
        compile_fixture(path);
    });
}

/// Compile-time benchmark, run on every minor Typst upgrade (see the pin note
/// in `Cargo.toml`).
///
/// Ignored by default, since it's a measurement, not a test; a fresh compiler
/// per iteration reloads the bundled fonts each time. Run it on the new version
/// and record the results in the upgrade guide:
///
/// ```text
/// cargo test --release --test fidelity -- --ignored --nocapture pin_benchmark
/// ```
#[test]
#[ignore = "perf measurement; run explicitly on a Typst bump"]
fn pin_benchmark() {
    use std::time::Instant;

    const ITERS: u32 = 20;
    let manifest = env!("CARGO_MANIFEST_DIR");
    let mut fixtures: Vec<_> = std::fs::read_dir(format!("{manifest}/tests/fixtures/fidelity"))
        .expect("read fixtures dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "typ"))
        .collect();
    fixtures.sort();

    let dir = tempfile::tempdir().expect("tempdir");
    let notebox_root = canonicalize_root(dir.path()).expect("canonicalize tempdir");
    inkycap_lib::notebox_package::scaffold(&notebox_root);
    std::fs::write(notebox_root.join("refs.bib"), REFS_BIB).expect("write refs.bib");
    let note_path = notebox_root.join("note.typ");

    println!(
        "\npin benchmark — typst pipeline, {} fixtures × {ITERS} iters (bundled fonts only)",
        fixtures.len()
    );
    let (mut total_svg, mut total_html) = (0u128, 0u128);
    for fixture in &fixtures {
        let source = std::fs::read_to_string(fixture).expect("read fixture");
        std::fs::write(&note_path, &source).expect("write note");
        let name = fixture.file_name().unwrap().to_string_lossy().to_string();

        let mut svg_ns = 0u128;
        let mut html_ns = 0u128;
        for _ in 0..ITERS {
            let mut c = TypstCompiler::new(notebox_root.clone());
            let t = Instant::now();
            c.compile_svg(&note_path, source.clone()).expect("svg");
            svg_ns += t.elapsed().as_nanos();

            let mut c = TypstCompiler::new(notebox_root.clone());
            let t = Instant::now();
            c.compile_html(&note_path, source.clone()).expect("html");
            html_ns += t.elapsed().as_nanos();
        }
        let svg_ms = svg_ns as f64 / ITERS as f64 / 1.0e6;
        let html_ms = html_ns as f64 / ITERS as f64 / 1.0e6;
        total_svg += svg_ns;
        total_html += html_ns;
        println!("  {name:<28} svg {svg_ms:>7.2} ms   html {html_ms:>7.2} ms");
    }
    let n = (fixtures.len() as u128 * ITERS as u128).max(1);
    println!(
        "  {:<28} svg {:>7.2} ms   html {:>7.2} ms  (mean per compile)\n",
        "ALL",
        total_svg as f64 / n as f64 / 1.0e6,
        total_html as f64 / n as f64 / 1.0e6,
    );
}
