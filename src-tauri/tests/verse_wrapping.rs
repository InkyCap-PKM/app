//! Verse lines must wrap at the right margin.
//!
//! `#verse(...)` preserves idiosyncratic spacing by mapping ASCII spaces to
//! non-breaking spaces. Doing that to *every* space (the original
//! implementation) also removes every legal break opportunity, so a verse line
//! longer than the measure ran straight off the right edge of the page in the
//! SVG preview and in exported PDFs. `_verse-preserve-spaces` in
//! `inkycap-notebox/lib.typ` keeps one ordinary space per interior run so the
//! line can still break between words.
//!
//! This pins both halves of that invariant: long lines wrap inside the page,
//! and the preserved indentation / run-spacing survives.
//!
//! Bundled fonts only (no `ensure_system_fonts()`) so the geometry is the same
//! on every machine — same rationale as `tests/fidelity.rs`.

use std::collections::BTreeSet;

use inkycap_lib::storage::path::canonicalize_root;
use inkycap_lib::typst_pipeline::compiler::TypstCompiler;
use typst::layout::{Abs, Frame, FrameItem, Point};

/// A shaped text run, positioned in absolute page coordinates.
struct Run {
    x: Abs,
    y: Abs,
    width: Abs,
    text: String,
}

/// Flatten a frame tree into absolutely-positioned text runs.
///
/// Only the translation part of a group transform is applied: verse content is
/// laid out by `align`/`block`/`grid`, none of which scale or rotate. A future
/// fixture that does would need the full affine here.
fn collect_runs(frame: &Frame, origin: Point, out: &mut Vec<Run>) {
    for (pos, item) in frame.items() {
        let at = origin + *pos;
        match item {
            FrameItem::Text(t) => out.push(Run {
                x: at.x,
                y: at.y,
                width: t.width(),
                text: t.text.to_string(),
            }),
            FrameItem::Group(g) => {
                let shifted = Point::new(at.x + g.transform.tx, at.y + g.transform.ty);
                collect_runs(&g.frame, shifted, out);
            }
            _ => {}
        }
    }
}

/// A line long enough that, unwrapped, it runs well past the right edge of an
/// A4 page — the shape of the original bug.
const LONG_LINE: &str = "The quick brown fox jumps over the lazy dog and keeps running \
far past the right margin of this page without ever once pausing for breath or \
punctuation of any kind whatsoever";

/// Indentation and interior run-spacing that must survive layout verbatim.
const SPACED_LINE: &str = "    indented    and    spaced";

fn compile_verse(body: &str) -> (Abs, Vec<Run>) {
    let dir = tempfile::tempdir().expect("tempdir");
    let notebox_root = canonicalize_root(dir.path()).expect("canonicalize tempdir");
    inkycap_lib::notebox_package::scaffold(&notebox_root);

    let source = format!(
        "{}\n#verse(\"{}\")\n",
        inkycap_lib::notebox_package::import_line(),
        body
    );

    let note_path = notebox_root.join("note.typ");
    std::fs::write(&note_path, &source).expect("write note");

    let mut compiler = TypstCompiler::new(notebox_root.clone());
    let doc = compiler
        .compile_document(&note_path, source)
        .expect("verse fixture compiles");

    let page = doc.pages().first().expect("at least one page");
    let mut runs = Vec::new();
    collect_runs(&page.frame, Point::zero(), &mut runs);
    (page.frame.width(), runs)
}

#[test]
fn long_verse_line_wraps_inside_the_page() {
    let (page_width, runs) = compile_verse(&format!("{LONG_LINE}\n{SPACED_LINE}"));
    assert!(!runs.is_empty(), "verse produced no text runs");

    // Every glyph run ends inside the page. Unwrapped, the long line reaches
    // roughly twice the page width.
    let widest = runs
        .iter()
        .max_by_key(|r| (r.x + r.width).to_raw().to_bits())
        .expect("a run");
    assert!(
        widest.x + widest.width <= page_width,
        "verse text overflows the page: right edge {:.1}pt > page width {:.1}pt (run {:?})",
        (widest.x + widest.width).to_pt(),
        page_width.to_pt(),
        widest.text,
    );

    // …because the long line broke across several lines, not because it was
    // silently truncated. Two source lines, so >2 baselines means it wrapped.
    let baselines: BTreeSet<i64> = runs.iter().map(|r| r.y.to_pt().round() as i64).collect();
    assert!(
        baselines.len() > 2,
        "long verse line did not wrap: {} baseline(s) for 2 source lines",
        baselines.len()
    );
}

#[test]
fn verse_preserves_indentation_and_run_spacing() {
    let (_, runs) = compile_verse(SPACED_LINE);
    let text: String = runs.iter().map(|r| r.text.as_str()).collect();

    // 4 leading + two interior runs of 4 (each keeping 3 non-breaking spaces
    // plus one ordinary, breakable one) = 10 non-breaking spaces.
    let nbsp = text.matches('\u{00A0}').count();
    assert_eq!(
        nbsp, 10,
        "verse spacing not preserved: {nbsp} non-breaking spaces in {text:?}"
    );
}
