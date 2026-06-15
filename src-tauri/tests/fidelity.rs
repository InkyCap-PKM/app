//! Typst-output fidelity corpus.
//!
//! The expensive, error-prone part of any Typst compiler bump is confirming
//! that *rendered output* didn't silently shift across real documents — a base-
//! line tweak in math, a list-marker change, an HTML-structure adjustment. This
//! turns that eyeball pass into a test: a checked-in corpus of representative
//! `.typ` notes is compiled through the real pipeline and every surface (HTML,
//! SVG, `typst query` metadata) is snapshotted with `insta`.
//!
//! On the next bump the workflow is `cargo insta test --review`: accepted diffs
//! become the new baseline, unexpected diffs are caught before they reach a
//! user. See `documentation/developer/typst-upgrade.md`.
//!
//! ## Determinism
//!
//! Snapshots must be machine-independent. We deliberately do **not** call
//! `ensure_system_fonts()` — only the fonts bundled in `typst-assets` are
//! available, so the same input renders identically on any developer's machine
//! and in CI. Adding system-font discovery here would make snapshots depend on
//! whatever fonts happen to be installed.
//!
//! Each fixture gets a fresh tempdir notebox scaffolded with the
//! `inkycap-notebox` package, plus a shared `refs.bib`, so citation/bibliography
//! fixtures resolve.

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

/// Deterministic, serializable projection of a [`QueryResult`]. The live struct
/// stores properties in a `HashMap` (non-deterministic iteration order) and is
/// not `Serialize`; this mirror sorts properties into a `BTreeMap` and carries
/// only the metadata surfaces that must stay stable across a bump.
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

/// Compact, layout-focused digest of the rendered SVG pages. Snapshotting the
/// full SVG (megabytes of glyph-outline path data) would be unreadable and
/// noisy under sub-pixel font shifts; the page count and rounded geometry are
/// the signals that catch a real layout regression, paired with the byte length
/// as a coarse "did the drawing change at all" tripwire.
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

/// One snapshot set (svg / html / metadata) per `.typ` fixture. `insta::glob!`
/// names snapshots after the fixture file, so adding a `.typ` under
/// `fixtures/fidelity/` extends the corpus with no code change here.
#[test]
fn fidelity_corpus() {
    insta::glob!("fixtures/fidelity/*.typ", |path| {
        compile_fixture(path);
    });
}

/// Pin benchmark — the perf check the `Cargo.toml` pin-rationale comment
/// mandates on every minor bump. (It replaces the obsolete pre-pivot
/// `spike-bench`/`bench-napi.mjs` NAPI scripts, which measured a typst.ts
/// prototype that no longer exists; the pipeline is now a pure-Rust crate.)
///
/// Ignored by default — it's a measurement, not a pass/fail gate, and a fresh
/// compiler is built per iteration so the bundled fonts reload each time. Run
/// it against the new pin and record the numbers in the upgrade runbook:
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
