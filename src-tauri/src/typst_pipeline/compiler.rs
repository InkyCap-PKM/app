//! Public-facing compile API. Holds a [`NoteboxWorld`] and exposes per-document
//! `compile_svg` (Phase 1), `compile_pdf` (Phase 9b), and query hooks.
//!
//! Design notes:
//! - One compiler instance per open notebox. Re-used across compiles so comemo
//!   memoization stays warm.
//! - All rendering goes through `typst::compile(&world)` where the world's
//!   "main" file pointer has been swapped to the document we want.
//! - SVG is per-page, not merged. The frontend is page-aware (reading-mode
//!   shows pages stacked with separators) so we hand it the array.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use typst_html::{HtmlDocument, HtmlOptions};
use typst_layout::PagedDocument;
use typst_pdf::{PdfOptions, PdfStandard, PdfStandards};

use crate::typst_pipeline::diagnostic::TypstDiagnostic;
use crate::typst_pipeline::recovery;
use crate::typst_pipeline::world::NoteboxWorld;

/// Lightweight timer for the `typst::compile` hot path. CLAUDE.md asks for
/// compile-time instrumentation "from the outset"; this logs the elapsed time
/// of each compile at `debug` level (off in release/normal runs, so zero cost
/// to users) so a compile-time regression surfaces in a dev log rather than
/// only when a user notices. Logs the file name only — not the full path —
/// to keep the local-first privacy stance.
struct CompileTimer {
    label: &'static str,
    file: String,
    start: std::time::Instant,
}

impl CompileTimer {
    fn start(label: &'static str, path: &Path) -> Self {
        Self {
            label,
            file: path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("?")
                .to_string(),
            start: std::time::Instant::now(),
        }
    }

    /// Emit the elapsed-time log. Call immediately after the `typst::compile`
    /// returns so the measurement brackets only the compile itself.
    fn done(self) {
        log::debug!(
            "typst {} [{}] took {:?}",
            self.label,
            self.file,
            self.start.elapsed()
        );
    }
}

/// PDF standard presets exposed to the frontend. Each variant maps to a
/// combination of [`PdfStandard`] flags passed to the `typst-pdf` crate.
///
/// typst-pdf 0.15 lifted the 0.14 restriction that only one PDF substandard
/// could be active at a time, so [`PdfStandardPreset::PdfA2aUa1`] can now request
/// archival *and* accessibility conformance in a single file. The pairing is
/// PDF/A-2a, not the standalone `PdfA4`: PDF/UA-1 is locked to PDF 1.7, while
/// PDF/A-4 requires PDF 2.0, so the two share no common PDF version and typst-pdf
/// rejects them together. PDF/A-2a is the PDF-1.7-based archival level whose
/// Level-A conformance mandates the same full document tagging PDF/UA-1 needs —
/// the natural archival+accessible combination. The standalone variants stay for
/// users who want exactly one conformance level. Adding a preset means one new
/// entry here plus the frontend type in `ipc.ts` and the select options in
/// `ExportDialog.tsx` / `CollectionTable.tsx`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PdfStandardPreset {
    /// Plain PDF 1.7 (Typst default). No archival or accessibility conformance.
    #[default]
    Standard,
    /// PDF/A-4 — long-term archival (PDF 2.0 base).
    PdfA4,
    /// PDF/UA-1 — Universal Accessibility with full tagged structure.
    PdfUa1,
    /// PDF/A-2a + PDF/UA-1 — archival *and* accessibility in one file. PDF/A-2a's
    /// Level-A tagging is the PDF-1.7 base PDF/UA-1 shares; A-4 (PDF 2.0) can't
    /// pair with UA-1.
    PdfA2aUa1,
}

impl PdfStandardPreset {
    pub fn to_pdf_standards(self) -> PdfStandards {
        match self {
            Self::Standard => PdfStandards::default(),
            Self::PdfA4 => {
                PdfStandards::new(&[PdfStandard::A_4]).expect("PDF/A-4 is a valid standard")
            }
            Self::PdfUa1 => {
                PdfStandards::new(&[PdfStandard::Ua_1]).expect("PDF/UA-1 is a valid standard")
            }
            Self::PdfA2aUa1 => PdfStandards::new(&[PdfStandard::A_2a, PdfStandard::Ua_1])
                .expect("PDF/A-2a + PDF/UA-1 is a valid combination in typst-pdf 0.15"),
        }
    }

    /// True when the preset includes PDF/UA-1 accessibility conformance, so the
    /// accessibility requirements (alt text, gap-free headings, tagged
    /// structure, heading normalization) apply. Covers both the standalone
    /// `PdfUa1` and the combined `PdfA2aUa1`.
    pub fn includes_ua1(self) -> bool {
        matches!(self, Self::PdfUa1 | Self::PdfA2aUa1)
    }

    /// Human-readable label for diagnostics and UI fallback text.
    pub fn label(self) -> &'static str {
        match self {
            Self::Standard => "PDF",
            Self::PdfA4 => "PDF/A-4",
            Self::PdfUa1 => "PDF/UA-1",
            Self::PdfA2aUa1 => "PDF/A-2a + PDF/UA-1",
        }
    }
}

/// Compile output ready for IPC. SVG strings travel through Tauri as plain
/// JSON; for the 4-page bench-doc this is ~700KB total — well under the
/// payload size we care about.
#[derive(Debug, Clone, Serialize)]
pub struct TypstCompileResult {
    /// True if a `PagedDocument` compiled cleanly (no errors). Diagnostics may
    /// still contain warnings even on success. When false, see `recovered`:
    /// `frames` may still be populated by the error-tolerant recovery pass.
    pub ok: bool,
    /// True when the document failed to compile but the recovery pass salvaged
    /// renderable output by dropping the errored span(s). `frames` is populated
    /// and `diagnostics` still carries the real errors. See [`recovery`].
    ///
    /// [`recovery`]: crate::typst_pipeline::recovery
    pub recovered: bool,
    pub frames: Vec<TypstFrame>,
    pub diagnostics: Vec<TypstDiagnostic>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TypstFrame {
    pub svg: String,
    /// Page width/height in Typst points (1/72 inch). Frontend uses these to
    /// constrain the SVG container so layout doesn't reflow on each compile.
    pub width_pt: f64,
    pub height_pt: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TypstHtmlResult {
    pub ok: bool,
    /// See [`TypstCompileResult::recovered`]: true when `html` was salvaged by
    /// the recovery pass after a failed compile.
    pub recovered: bool,
    pub html: String,
    pub diagnostics: Vec<TypstDiagnostic>,
}

pub struct TypstCompiler {
    world: NoteboxWorld,
    /// Citation style (e.g. "apa", "ieee", "mla"). `None` uses Typst default.
    bibliography_style: Option<String>,
}

impl TypstCompiler {
    pub fn new(notebox_root: PathBuf) -> Self {
        Self {
            world: NoteboxWorld::new(notebox_root),
            bibliography_style: None,
        }
    }

    pub fn notebox_root(&self) -> &Path {
        self.world.notebox_root()
    }

    /// Borrow the underlying World. Used by on-demand package resolution
    /// ([`crate::typst_pipeline::package_fetch`]) to drain the set of packages
    /// a compile pass failed to resolve, so they can be downloaded and the
    /// compile retried.
    pub fn world(&self) -> &NoteboxWorld {
        &self.world
    }

    /// Load system and notebox-local fonts on demand. No-op if already loaded.
    pub fn ensure_system_fonts(&mut self) {
        self.world.load_system_fonts();
    }

    pub fn system_fonts_loaded(&self) -> bool {
        self.world.system_fonts_loaded()
    }

    /// Load system fonts on first compile, unconditionally.
    ///
    /// This used to gate on which font settings were configured, but every
    /// gate we added eventually missed a setting (verse_font, monospace
    /// stack, future ones) — the symptom is always the same `unknown font
    /// family` warning from Typst. Loading fonts is a one-time ~100ms cost
    /// per session (subsequent calls short-circuit on `system_fonts_loaded`),
    /// so the trade is "always pay once" vs "occasionally render the wrong
    /// font and surface a warning the user has no way to act on". Pay once.
    ///
    /// The `_settings` arg is kept so call sites stay stable and so a
    /// future variant (e.g. opt-in lazy mode for users with multi-thousand
    /// font collections) can re-introduce gating without changing the API.
    pub fn ensure_system_fonts_for_settings(&mut self, _settings: &crate::settings::UserSettings) {
        if self.system_fonts_loaded() {
            return;
        }
        self.ensure_system_fonts();
    }

    /// Compile to a `PagedDocument` without rendering to SVG. Used by the
    /// query module for metadata extraction where we only need the
    /// introspector, not rendered frames.
    pub fn compile_document(&mut self, abs_path: &Path, source: String) -> Option<PagedDocument> {
        if self.world.set_main(abs_path, source).is_err() {
            return None;
        }

        let _t = CompileTimer::start("compile_document", abs_path);
        let warned = typst::compile::<PagedDocument>(&self.world);
        _t.done();
        warned.output.ok()
    }

    pub fn set_bibliography_style(&mut self, style: Option<String>) {
        self.bibliography_style = style;
    }

    /// Drop a single file from the compiler's caches. Hook for the watcher;
    /// the next compile that touches this file will re-read it from disk.
    #[allow(dead_code)]
    pub fn invalidate(&self, abs_path: &Path) {
        self.world.invalidate(abs_path);
    }

    /// Compile the note at `abs_path` to per-page SVG. The source is supplied
    /// by the caller (typically read via [`NoteboxStorage`], which validates the
    /// path is inside the notebox); this keeps the compiler out of the I/O path
    /// for the main file and ensures all reads go through the trait that
    /// enforces the notebox sandbox. Imported files (`#import "/..."`) are still
    /// read by the underlying `World` directly — that's a separate threat
    /// surface tracked as a follow-up.
    ///
    /// `abs_path` MUST be a canonicalized absolute path inside the notebox root
    /// the compiler was constructed with; the caller is responsible for that
    /// guarantee.
    ///
    /// Uses `&mut self` so we have a single-writer guarantee; the underlying
    /// World is `Sync` and could in principle be shared, but compile is hot
    /// enough at ~20ms that we don't gain anything from concurrent compiles.
    ///
    /// [`NoteboxStorage`]: crate::storage::traits::NoteboxStorage
    pub fn compile_svg(
        &mut self,
        abs_path: &Path,
        source: String,
    ) -> Result<TypstCompileResult, CompileError> {
        // Clone so the original source is available to restore in the world
        // after the recovery pass (which rewrites the main file in place).
        self.world
            .set_main(abs_path, source.clone())
            .map_err(|err| CompileError::SetMain(abs_path.to_path_buf(), format!("{err:?}")))?;

        // typst::compile returns a Warned<SourceResult<PagedDocument>>:
        //   - .output: Result<PagedDocument, EcoVec<SourceDiagnostic>>
        //   - .warnings: EcoVec<SourceDiagnostic>
        let _t = CompileTimer::start("compile_svg", abs_path);
        let warned = typst::compile::<PagedDocument>(&self.world);
        _t.done();

        let mut diagnostics: Vec<TypstDiagnostic> = warned
            .warnings
            .iter()
            .map(|d| crate::typst_pipeline::diagnostic::from_source(d, &self.world))
            .collect();

        match warned.output {
            Ok(document) => Ok(TypstCompileResult {
                ok: true,
                recovered: false,
                frames: render_frames(&document),
                diagnostics,
            }),
            Err(errors) => {
                diagnostics.extend(
                    errors
                        .iter()
                        .map(|d| crate::typst_pipeline::diagnostic::from_source(d, &self.world)),
                );
                // Error-tolerant fallback for the reading view: salvage a
                // renderable document by dropping the errored spans. The
                // diagnostics above still report the real errors verbatim.
                let recovered = recovery::recover::<PagedDocument>(&self.world, abs_path, &errors);
                // The recovery pass left the patched source in the world;
                // restore the user's original so later queries see it.
                let _ = self.world.set_main(abs_path, source);
                match recovered {
                    Some(document) => Ok(TypstCompileResult {
                        ok: false,
                        recovered: true,
                        frames: render_frames(&document),
                        diagnostics,
                    }),
                    None => Ok(TypstCompileResult {
                        ok: false,
                        recovered: false,
                        frames: Vec::new(),
                        diagnostics,
                    }),
                }
            }
        }
    }

    /// Compile the note at `abs_path` to PDF bytes. Same contract as
    /// `compile_svg` regarding path requirements.
    pub fn compile_pdf(
        &mut self,
        abs_path: &Path,
        source: String,
        pdf_standard: PdfStandardPreset,
    ) -> Result<Vec<u8>, CompileError> {
        self.world
            .set_main(abs_path, source)
            .map_err(|err| CompileError::SetMain(abs_path.to_path_buf(), format!("{err:?}")))?;

        let _t = CompileTimer::start("compile_pdf", abs_path);
        let warned = typst::compile::<PagedDocument>(&self.world);
        _t.done();

        match warned.output {
            Ok(document) => {
                let options = PdfOptions {
                    standards: pdf_standard.to_pdf_standards(),
                    ..PdfOptions::default()
                };
                typst_pdf::pdf(&document, &options).map_err(|errs| {
                    let msg = errs
                        .iter()
                        .map(|d| crate::typst_pipeline::diagnostic::from_source(d, &self.world))
                        .map(|d| d.message)
                        .collect::<Vec<_>>()
                        .join("; ");
                    CompileError::PdfExport(msg)
                })
            }
            Err(errors) => {
                let msg = errors
                    .iter()
                    .map(|d| crate::typst_pipeline::diagnostic::from_source(d, &self.world))
                    .map(|d| d.message)
                    .collect::<Vec<_>>()
                    .join("; ");
                Err(CompileError::Compile(msg))
            }
        }
    }

    /// Like [`compile_pdf`](Self::compile_pdf) but returns the structured
    /// diagnostics on failure instead of a flattened string. The book
    /// exporter uses this so it can map each error's source offset back to
    /// the originating note (see `book_wrapper::describe_book_diagnostics`) —
    /// a flattened message can't be traced to a chapter. Kept as a sibling of
    /// `compile_pdf` rather than refactoring it, so the established
    /// `CompileError` contract every other caller relies on is unchanged.
    pub fn compile_pdf_diagnostics(
        &mut self,
        abs_path: &Path,
        source: String,
        pdf_standard: PdfStandardPreset,
    ) -> Result<Vec<u8>, Vec<TypstDiagnostic>> {
        if let Err(err) = self.world.set_main(abs_path, source) {
            return Err(vec![TypstDiagnostic {
                severity: "error",
                message: format!(
                    "failed to register main file {}: {err:?}",
                    abs_path.display()
                ),
                primary: None,
                trace: Vec::new(),
                hints: Vec::new(),
            }]);
        }
        let warned = typst::compile::<PagedDocument>(&self.world);
        match warned.output {
            Ok(document) => {
                let options = PdfOptions {
                    standards: pdf_standard.to_pdf_standards(),
                    ..PdfOptions::default()
                };
                typst_pdf::pdf(&document, &options).map_err(|errs| {
                    errs.iter()
                        .map(|d| crate::typst_pipeline::diagnostic::from_source(d, &self.world))
                        .collect::<Vec<_>>()
                })
            }
            Err(errors) => Err(errors
                .iter()
                .map(|d| crate::typst_pipeline::diagnostic::from_source(d, &self.world))
                .collect::<Vec<_>>()),
        }
    }

    /// Compile with a template import injected. Used for collection-level
    /// export where a journal template is applied at compile time.
    pub fn compile_pdf_with_template(
        &mut self,
        abs_path: &Path,
        source: String,
        template: &str,
        bib_style: Option<&str>,
        pdf_standard: PdfStandardPreset,
    ) -> Result<Vec<u8>, CompileError> {
        let with_template = inject_template_import(&source, template);
        let old_style = self.bibliography_style.clone();
        if let Some(style) = bib_style {
            self.bibliography_style = Some(style.to_string());
        }
        let result = self.compile_pdf(abs_path, with_template, pdf_standard);
        self.bibliography_style = old_style;
        result
    }

    /// Compile the note at `abs_path` to HTML using Typst's native HTML backend.
    /// Produces semantic HTML suitable for a flowing reading view or export.
    pub fn compile_html(
        &mut self,
        abs_path: &Path,
        source: String,
    ) -> Result<TypstHtmlResult, CompileError> {
        // Clone so the original source can be restored after the recovery
        // pass rewrites the main file in place (see `compile_svg`).
        self.world
            .set_main(abs_path, source.clone())
            .map_err(|err| CompileError::SetMain(abs_path.to_path_buf(), format!("{err:?}")))?;

        let _t = CompileTimer::start("compile_html", abs_path);
        let warned = typst::compile::<HtmlDocument>(&self.world);
        _t.done();

        let mut diagnostics: Vec<TypstDiagnostic> = warned
            .warnings
            .iter()
            .map(|d| crate::typst_pipeline::diagnostic::from_source(d, &self.world))
            .filter(|d| !is_html_development_noise(&d.message))
            .collect();

        match warned.output {
            Ok(document) => {
                match typst_html::html(&document, &HtmlOptions::default()) {
                    Ok(html) => Ok(TypstHtmlResult {
                        ok: true,
                        recovered: false,
                        html,
                        diagnostics,
                    }),
                    Err(errs) => {
                        // The document compiled; HTML generation itself
                        // failed. Not a span-localized error, so the recovery
                        // pass doesn't apply — report it as before.
                        diagnostics.extend(
                            errs.iter()
                                .map(|d| {
                                    crate::typst_pipeline::diagnostic::from_source(d, &self.world)
                                })
                                .filter(|d| !is_html_development_noise(&d.message)),
                        );
                        Ok(TypstHtmlResult {
                            ok: false,
                            recovered: false,
                            html: String::new(),
                            diagnostics,
                        })
                    }
                }
            }
            Err(errors) => {
                diagnostics.extend(
                    errors
                        .iter()
                        .map(|d| crate::typst_pipeline::diagnostic::from_source(d, &self.world)),
                );
                // Error-tolerant fallback for the Journal Scroll: salvage
                // renderable HTML by dropping the errored spans.
                let recovered = recovery::recover::<HtmlDocument>(&self.world, abs_path, &errors)
                    .and_then(|document| typst_html::html(&document, &HtmlOptions::default()).ok());
                let _ = self.world.set_main(abs_path, source);
                match recovered {
                    Some(html) => Ok(TypstHtmlResult {
                        ok: false,
                        recovered: true,
                        html,
                        diagnostics,
                    }),
                    None => Ok(TypstHtmlResult {
                        ok: false,
                        recovered: false,
                        html: String::new(),
                        diagnostics,
                    }),
                }
            }
        }
    }
}

/// Render a compiled `PagedDocument` to per-page SVG frames for IPC.
fn render_frames(document: &PagedDocument) -> Vec<TypstFrame> {
    document
        .pages()
        .iter()
        .map(|page| TypstFrame {
            svg: typst_svg::svg(page, &typst_svg::SvgOptions::default()),
            width_pt: page.frame.width().to_pt(),
            height_pt: page.frame.height().to_pt(),
        })
        .collect()
}

/// Inject a `#import` + `#show: <template>` after the inkycap-notebox import.
fn inject_template_import(source: &str, template: &str) -> String {
    // Find the line containing the inkycap-notebox import (canonical or legacy).
    let mut cursor = 0usize;
    for line in source.split_inclusive('\n') {
        let body = line.strip_suffix('\n').unwrap_or(line);
        if crate::notebox_package::is_notebox_import_line(body) {
            let insert_at = cursor + line.len();
            let import_line = format!("#import \"{}\": *\n", template);
            let mut result = String::with_capacity(source.len() + import_line.len());
            result.push_str(&source[..insert_at]);
            result.push_str(&import_line);
            result.push_str(&source[insert_at..]);
            return result;
        }
        cursor += line.len();
    }
    // Fallback: prepend
    format!("#import \"{}\": *\n{}", template, source)
}

#[derive(Debug, thiserror::Error)]
pub enum CompileError {
    #[error("failed to register main file {0}: {1}")]
    SetMain(PathBuf, String),
    #[error("compilation failed: {0}")]
    Compile(String),
    #[error("PDF export failed: {0}")]
    PdfExport(String),
    #[error("HTML export failed: {0}")]
    HtmlExport(String),
}

fn is_html_development_noise(msg: &str) -> bool {
    msg.contains("html export is under active development")
        || msg.contains("was ignored during HTML export")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::path::canonicalize_root;
    use std::fs;
    use tempfile::tempdir;

    /// Tempdirs may not be canonical on every platform (`/tmp` is a symlink
    /// to `/private/tmp` on macOS). The compile pipeline assumes a canonical
    /// notebox root so the symlink-escape check holds — tests must do the same.
    fn canonical_tempdir() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempdir().expect("tempdir");
        let root = canonicalize_root(dir.path()).expect("canonicalize tempdir");
        (dir, root)
    }

    #[test]
    fn compiles_a_minimal_typst_note_to_svg() {
        let (_dir, root) = canonical_tempdir();
        let note_path = root.join("note.typ");
        let source = "= Hello\n\nFirst paragraph.\n".to_string();
        fs::write(&note_path, &source).expect("write note");

        let mut compiler = TypstCompiler::new(root);
        let result = compiler.compile_svg(&note_path, source).expect("compile");

        assert!(result.ok, "compile failed: {:?}", result.diagnostics);
        assert_eq!(result.frames.len(), 1, "expected single page");
        let frame = &result.frames[0];
        assert!(
            frame.svg.starts_with("<svg"),
            "svg should begin with <svg, got: {}",
            &frame.svg[..40.min(frame.svg.len())]
        );
        assert!(frame.width_pt > 0.0);
        assert!(frame.height_pt > 0.0);
    }

    #[test]
    fn combined_pdf_a2a_ua1_standard_compiles() {
        // typst-pdf 0.15 lifted the 0.14 single-substandard restriction, so the
        // archival+accessible pair must both construct without panicking (the
        // `.expect` in `to_pdf_standards`) and produce a real PDF. The pairing is
        // PDF/A-2a, not A-4: UA-1 is PDF 1.7, A-4 is PDF 2.0, and typst-pdf
        // rejects version-incompatible standards together. Regression guard: if
        // a future bump re-tightens the validation, this fails loudly here rather
        // than at a user's export. A conformant doc carries title, language, and
        // a document date (all PDF/A + PDF/UA prerequisites).
        let (_dir, root) = canonical_tempdir();
        let note_path = root.join("combined.typ");
        let source = "#set document(title: \"Combined standards\", \
            date: datetime(year: 2026, month: 6, day: 15))\n\
            #set text(lang: \"en\")\n\n= Heading\n\nAccessible, archival body text.\n"
            .to_string();
        fs::write(&note_path, &source).expect("write note");

        let mut compiler = TypstCompiler::new(root);
        let pdf = compiler
            .compile_pdf(&note_path, source, PdfStandardPreset::PdfA2aUa1)
            .expect("combined PDF/A-2a + PDF/UA-1 compiles");
        assert!(
            pdf.starts_with(b"%PDF-"),
            "expected a PDF header, got {} bytes",
            pdf.len()
        );
    }

    /// A note that `#include`s a syntactically broken file should still render
    /// its own content. Recovery can't patch another file, but it drops the
    /// failing `#include` statement (replacing it with the error marker) so the
    /// host doesn't blank out, and the included-file error is still surfaced.
    /// Regression for the silent-blank reading view when a transcluded note has
    /// a parse error (a lone `/` term-list marker, "expected colon").
    #[test]
    fn recovers_from_a_broken_include_by_dropping_it() {
        let (_dir, root) = canonical_tempdir();
        crate::notebox_package::scaffold(&root);
        let import = crate::notebox_package::import_line();

        fs::write(
            root.join("broken.typ"),
            format!("{import}\n\n#note(title: \"Broken\")\n\nsome text\n\n/\n\nmore text\n"),
        )
        .expect("write broken");

        let host_path = root.join("host.typ");
        let host_src = format!(
            "{import}\n\n#note(title: \"Host\")\n\n= Daisy\n\nbody line\n\n#include \"/broken.typ\"\n"
        );
        fs::write(&host_path, &host_src).expect("write host");

        let mut compiler = TypstCompiler::new(root);
        let result = compiler
            .compile_svg(&host_path, host_src)
            .expect("compile_svg");

        assert!(!result.ok, "compile should report the included-file error");
        assert!(result.recovered, "recovery should salvage the host page");
        assert!(
            !result.frames.is_empty(),
            "host content should still render"
        );
        assert!(
            result.diagnostics.iter().any(|d| d.severity == "error"),
            "the included-file parse error should still be surfaced: {:?}",
            result.diagnostics,
        );
    }

    /// `#video` / `#audio` compile in both targets: a placeholder in paged
    /// output (which can't play media) and a real `<video>` / `<audio
    /// controls>` element in HTML export.
    #[test]
    fn video_and_audio_render_in_both_targets() {
        let (_dir, root) = canonical_tempdir();
        crate::notebox_package::scaffold(&root);
        let import = crate::notebox_package::import_line();
        let src = format!(
            "{import}\n\n#video(\"/Assets/clip.mp4\", width: 50%)\n\n#audio(\"/Assets/song.mp3\")\n"
        );
        let note_path = root.join("media.typ");
        fs::write(&note_path, &src).expect("write note");

        let mut compiler = TypstCompiler::new(root);

        // Paged: compiles to a placeholder, no error.
        let paged = compiler
            .compile_svg(&note_path, src.clone())
            .expect("compile_svg");
        assert!(paged.ok, "paged compile failed: {:?}", paged.diagnostics);

        // HTML: emits real media elements with controls + the source path.
        let html = compiler
            .compile_html(&note_path, src)
            .expect("compile_html");
        assert!(
            html.html.contains("<video"),
            "expected <video>, got: {}",
            html.html
        );
        assert!(
            html.html.contains("<audio"),
            "expected <audio>, got: {}",
            html.html
        );
        assert!(
            html.html.contains("controls"),
            "expected controls attr: {}",
            html.html
        );
        // Double-quoted `src` is what the HTML-export asset localizer keys on.
        assert!(
            html.html.contains(r#"src="/Assets/clip.mp4""#),
            "expected double-quoted video src: {}",
            html.html
        );
        assert!(
            html.html.contains(r#"src="/Assets/song.mp3""#),
            "expected double-quoted audio src: {}",
            html.html
        );
    }

    #[test]
    fn compiles_phase_0_spike_fixture() {
        // The Phase 0 spike fixture exercises the full inkycap-notebox package
        // (note metadata, wikilinks, tags, verse). The fixture lives at the
        // repository root, two levels above src-tauri; we only run it when
        // the path resolves so this test still passes outside a checkout.
        let workspace = match std::env::var("CARGO_MANIFEST_DIR") {
            Ok(d) => std::path::PathBuf::from(d).join("..").canonicalize().ok(),
            Err(_) => None,
        };
        let Some(workspace) = workspace else {
            return;
        };
        let fixture = workspace.join("spike-fixtures/note.typ");
        if !fixture.exists() {
            eprintln!("skipping: {} not found", fixture.display());
            return;
        }
        let source = fs::read_to_string(&fixture).expect("read fixture");

        let mut compiler = TypstCompiler::new(workspace);
        let result = compiler.compile_svg(&fixture, source).expect("compile");

        assert!(result.ok, "spike fixture failed: {:#?}", result.diagnostics);
        assert!(!result.frames.is_empty());
    }

    #[test]
    fn recovers_renderable_output_around_a_localized_error() {
        // A literal `@2025-09-15` in prose is parsed as a cross-reference to a
        // label that doesn't exist — a hard error that would otherwise blank
        // the whole reading view. Recovery should drop the errored span and
        // still render the surrounding content.
        let (_dir, root) = canonical_tempdir();
        let note_path = root.join("recover.typ");
        let source =
            "= Heading\n\nApply by @2025-09-15 for the year.\n\nA later paragraph.\n".to_string();
        fs::write(&note_path, &source).expect("write note");

        let mut compiler = TypstCompiler::new(root);
        let result = compiler
            .compile_svg(&note_path, source)
            .expect("compile call ok");

        assert!(!result.ok, "compile should report failure");
        assert!(result.recovered, "recovery should salvage a render");
        assert!(!result.frames.is_empty(), "recovered frames expected");
        assert!(
            result.diagnostics.iter().any(|d| d.severity == "error"),
            "the real error must still be surfaced",
        );
    }

    #[test]
    fn surfaces_compile_errors_as_diagnostics() {
        let (_dir, root) = canonical_tempdir();
        let note_path = root.join("broken.typ");
        // Unmatched function call — Typst will reject this at parse time.
        let source = "#unknown_function(\n".to_string();
        fs::write(&note_path, &source).expect("write note");

        let mut compiler = TypstCompiler::new(root);
        let result = compiler
            .compile_svg(&note_path, source)
            .expect("compile call ok");

        assert!(!result.ok);
        assert!(result.frames.is_empty());
        assert!(!result.diagnostics.is_empty());
        assert!(result.diagnostics.iter().any(|d| d.severity == "error"));
    }
}
