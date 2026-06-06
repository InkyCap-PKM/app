//! Compile-validates that aligned images survive the HTML target.
//!
//! `typst-html` (0.14) has no show rule for `align()`, so `#align(center)[#image
//! (...)]` is dropped entirely from HTML output — a centred or right-aligned
//! image silently disappears in the reading view and HTML export, while a bare
//! (left) image renders fine (typst inlines it as a base64 `data:` URI). The fix
//! is `html-align` in `inkycap-notebox/lib.typ`, installed as a document-wide
//! `#show align: html-align` by `inject_html_align_shim` on every HTML compile
//! path. This runs a real note through the actual injection + Typst HTML
//! compiler so a regression (the rule failing to install, or `html-align`
//! breaking) surfaces here.

use inkycap_lib::storage::path::canonicalize_root;
use inkycap_lib::typst_pipeline::compiler::TypstCompiler;
use inkycap_lib::typst_pipeline::style_injection::inject_html_align_shim;

const NOTE: &str = "#import \"/.inkycap/notebox.typ\": *\n\
#note(title: \"Img host\")\n\
\n\
= Draft\n\
\n\
Left: #image(\"/Assets/x.png\")\n\
\n\
Center: #align(center)[#image(\"/Assets/x.png\")]\n\
\n\
Right: #align(right)[#image(\"/Assets/x.png\")]\n\
\n\
TwoD: #align(center + horizon)[#image(\"/Assets/x.png\")]\n";

// Minimal valid 1x1 PNG.
const PNG: [u8; 67] = [
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];

#[test]
fn aligned_images_survive_html_target() {
    let dir = tempfile::tempdir().expect("tempdir");
    let notebox_root = canonicalize_root(dir.path()).expect("canonicalize tempdir");
    inkycap_lib::notebox_package::scaffold(&notebox_root);
    std::fs::create_dir_all(notebox_root.join("Assets")).unwrap();
    std::fs::write(notebox_root.join("Assets/x.png"), PNG).unwrap();

    let note_path = notebox_root.join("img-host.typ");
    std::fs::write(&note_path, NOTE).expect("write note");

    // Apply the same align shim the HTML compile commands inject.
    let source = inject_html_align_shim(NOTE);

    let mut compiler = TypstCompiler::new(notebox_root.clone());
    compiler.ensure_system_fonts();
    let result = compiler
        .compile_html(&note_path, source)
        .expect("note compiles to HTML");

    assert!(
        result.ok,
        "HTML compile reported failure: {:?}",
        result.diagnostics
    );
    let html = &result.html;

    // Bare image: typst inlines it as a base64 data URI (no alignment wrapper).
    assert!(
        html.contains("<img src=\"data:image/png;base64,"),
        "bare image missing from HTML:\n{html}"
    );
    // Centred and right images are re-emitted as text-aligned divs wrapping the
    // (still base64-inlined) image, rather than being dropped.
    assert!(
        html.contains("<div style=\"text-align: center\"><img src=\"data:image/png;base64,"),
        "centred image not re-emitted as aligned div:\n{html}"
    );
    assert!(
        html.contains("<div style=\"text-align: right\"><img src=\"data:image/png;base64,"),
        "right image not re-emitted as aligned div:\n{html}"
    );
    // A 2-D alignment keeps only its horizontal component (vertical has no
    // text-align analogue), so `center + horizon` still maps to `center`.
    assert_eq!(
        html.matches("text-align: center").count(),
        2,
        "expected centre + 2-D-centre to both map to text-align: center:\n{html}"
    );
}
