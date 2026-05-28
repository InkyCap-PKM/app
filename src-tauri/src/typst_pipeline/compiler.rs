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
use typst::layout::PagedDocument;
use typst_html::HtmlDocument;
use typst_pdf::{PdfOptions, PdfStandard, PdfStandards};

use crate::typst_pipeline::diagnostic::TypstDiagnostic;
use crate::typst_pipeline::recovery;
use crate::typst_pipeline::world::NoteboxWorld;

/// PDF standard presets exposed to the frontend. Each variant maps to a
/// combination of [`PdfStandard`] flags passed to the `typst-pdf` crate.
///
/// As of typst-pdf 0.14, only one PDF substandard (validator) can be active at
/// a time — `PdfStandards::new` rejects e.g. `[A_4, Ua_1]` together. If a
/// future typst-pdf release lifts this restriction, add a combined variant
/// like `PdfA4Ua` here and pass `&[PdfStandard::A_4, PdfStandard::Ua_1]` in
/// `to_pdf_standards`. The frontend type in `ipc.ts` and the select options in
/// `ExportDialog.tsx` / `CollectionTable.tsx` would each need one new entry.
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
}

impl PdfStandardPreset {
    pub fn to_pdf_standards(self) -> PdfStandards {
        match self {
            Self::Standard => PdfStandards::default(),
            Self::PdfA4 => PdfStandards::new(&[PdfStandard::A_4])
                .expect("PDF/A-4 is a valid standard"),
            Self::PdfUa1 => PdfStandards::new(&[PdfStandard::Ua_1])
                .expect("PDF/UA-1 is a valid standard"),
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
    pub fn compile_document(
        &mut self,
        abs_path: &Path,
        source: String,
    ) -> Option<PagedDocument> {
        if self.world.set_main(abs_path, source).is_err() {
            return None;
        }

        let warned = typst::compile::<PagedDocument>(&self.world);
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
        let warned = typst::compile::<PagedDocument>(&self.world);

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

        let warned = typst::compile::<PagedDocument>(&self.world);

        match warned.output {
            Ok(document) => {
                let options = PdfOptions {
                    standards: pdf_standard.to_pdf_standards(),
                    ..PdfOptions::default()
                };
                typst_pdf::pdf(&document, &options)
                    .map_err(|errs| {
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
                message: format!("failed to register main file {}: {err:?}", abs_path.display()),
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

        let warned = typst::compile::<HtmlDocument>(&self.world);

        let mut diagnostics: Vec<TypstDiagnostic> = warned
            .warnings
            .iter()
            .map(|d| crate::typst_pipeline::diagnostic::from_source(d, &self.world))
            .filter(|d| !is_html_development_noise(&d.message))
            .collect();

        match warned.output {
            Ok(document) => {
                match typst_html::html(&document) {
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
                                .map(|d| crate::typst_pipeline::diagnostic::from_source(d, &self.world))
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
                    .and_then(|document| typst_html::html(&document).ok());
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
        .pages
        .iter()
        .map(|page| TypstFrame {
            svg: typst_svg::svg(page),
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
        assert!(frame.svg.starts_with("<svg"), "svg should begin with <svg, got: {}", &frame.svg[..40.min(frame.svg.len())]);
        assert!(frame.width_pt > 0.0);
        assert!(frame.height_pt > 0.0);
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
        assert!(!result.frames.is_empty(), "host content should still render");
        assert!(
            result.diagnostics.iter().any(|d| d.severity == "error"),
            "the included-file parse error should still be surfaced: {:?}",
            result.diagnostics,
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
        let Some(workspace) = workspace else { return; };
        let fixture = workspace.join("spike-fixtures/note.typ");
        if !fixture.exists() {
            eprintln!("skipping: {} not found", fixture.display());
            return;
        }
        let source = fs::read_to_string(&fixture).expect("read fixture");

        let mut compiler = TypstCompiler::new(workspace);
        let result = compiler.compile_svg(&fixture, source).expect("compile");

        assert!(
            result.ok,
            "spike fixture failed: {:#?}",
            result.diagnostics
        );
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
        let result = compiler.compile_svg(&note_path, source).expect("compile call ok");

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
        let result = compiler.compile_svg(&note_path, source).expect("compile call ok");

        assert!(!result.ok);
        assert!(result.frames.is_empty());
        assert!(!result.diagnostics.is_empty());
        assert!(result.diagnostics.iter().any(|d| d.severity == "error"));
    }
}
