//! The compile API: holds a [`NoteboxWorld`] and offers `compile_svg`,
//! `compile_pdf`, HTML and query hooks.
//!
//! - One compiler per open notebox, reused so comemo memoization stays warm.
//! - Every compile is `typst::compile(&world)` with the world's main file set
//!   to the document.
//! - SVG is returned per page; the reading view stacks the pages.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use typst_html::{HtmlDocument, HtmlOptions};
use typst_layout::PagedDocument;
use typst_pdf::{PdfOptions, PdfStandard, PdfStandards};

use crate::typst_pipeline::diagnostic::TypstDiagnostic;
use crate::typst_pipeline::recovery::{self, RecoveryStyle};
use crate::typst_pipeline::world::NoteboxWorld;

/// Logs each compile's duration at `debug` level, so regressions show in dev
/// logs. Only the file name is logged, not the path.
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

/// How many compile cycles a `comemo` entry may go untouched before
/// [`comemo::evict`] drops it. The compiler lives as long as the notebox, so
/// without eviction the cache would keep artifacts from every note indexed or
/// edited. The active document touches its entries on each compile, so its fast
/// path survives. typst-cli uses 10; editing revisits recent documents, so this
/// is larger.
const COMEMO_MAX_AGE: usize = 30;

/// Evicts stale `comemo` entries when dropped. Held as `let _guard` at the top
/// of each public compile method, so eviction runs after all its work,
/// whichever way it returns.
struct EvictComemoOnDrop;

impl Drop for EvictComemoOnDrop {
    fn drop(&mut self) {
        comemo::evict(COMEMO_MAX_AGE);
    }
}

/// PDF standard presets offered to the frontend, each mapped to [`PdfStandard`]
/// flags for `typst-pdf`.
///
/// [`PdfStandardPreset::PdfA2aUa1`] combines archival and accessible conformance.
/// It uses PDF/A-2a, not PDF/A-4: PDF/UA-1 requires PDF 1.7 and PDF/A-4 requires
/// PDF 2.0, so typst-pdf rejects that pair, while PDF/A-2a's tagging matches what
/// PDF/UA-1 needs. A new preset also needs the frontend type in `ipc.ts` and the
/// options in `ExportDialog.tsx` / `CollectionExportPane.tsx`.
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
    /// PDF/A-2a + PDF/UA-1: archival and accessible in one file.
    PdfA2aUa1,
}

impl PdfStandardPreset {
    /// Whether this format allows keeping errored markup as plain text.
    /// Archival and accessible formats don't: an error can hide the structure
    /// (alt text, headings, language) they guarantee.
    pub fn allows_bypassing_errors(self) -> bool {
        matches!(self, Self::Standard)
    }

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

    /// True when the preset includes PDF/UA-1 (`PdfUa1` or `PdfA2aUa1`), so the
    /// accessibility requirements apply.
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

/// Compile output for IPC. SVG strings travel as JSON.
#[derive(Debug, Clone, Serialize)]
pub struct TypstCompileResult {
    /// True if the document compiled without errors (warnings are possible).
    /// When false, `frames` may still hold output from the recovery pass (see
    /// `recovered`).
    pub ok: bool,
    /// True when the document failed but the recovery pass produced output by
    /// dropping the errored spans. `diagnostics` still has the real errors. See
    /// [`recovery`].
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

/// A compiled PDF.
#[derive(Debug, Clone)]
pub struct PdfOutput {
    pub bytes: Vec<u8>,
    /// True when the note had errors and was compiled by keeping the errored
    /// markup as plain text (only possible when bypassing errors was asked for).
    pub bypassed: bool,
}

/// Why a PDF compile failed, with structured diagnostics where they exist.
enum PdfFailure {
    SetMain(String),
    Compile(Vec<TypstDiagnostic>),
    PdfExport(Vec<TypstDiagnostic>),
}

fn join_messages(diags: &[TypstDiagnostic]) -> String {
    diags
        .iter()
        .map(|d| d.message.as_str())
        .collect::<Vec<_>>()
        .join("; ")
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

    /// Empty the compiler's file caches once a pass over many notes is done.
    /// See [`NoteboxWorld::forget_cached_files`].
    pub fn forget_cached_files(&self) {
        self.world.forget_cached_files();
    }

    /// The World, used by package fetching
    /// ([`crate::typst_pipeline::package_fetch`]) to collect packages a compile
    /// couldn't resolve.
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

    /// Load system fonts before the first compile, always. Deciding from the
    /// font settings kept missing cases and produced `unknown font family`
    /// warnings; loading costs about 100ms once per session. `_settings` is
    /// kept for a possible opt-in lazy mode.
    pub fn ensure_system_fonts_for_settings(&mut self, _settings: &crate::settings::UserSettings) {
        if self.system_fonts_loaded() {
            return;
        }
        self.ensure_system_fonts();
    }

    /// Compile to a `PagedDocument` without rendering, for queries that only
    /// need the introspector.
    pub fn compile_document(&mut self, abs_path: &Path, source: String) -> Option<PagedDocument> {
        let _evict = EvictComemoOnDrop;
        if self.world.set_main(abs_path, source).is_err() {
            return None;
        }

        let _t = CompileTimer::start("compile_document", abs_path);
        let warned = typst::compile::<PagedDocument>(&self.world);
        _t.done();
        warned.output.ok()
    }

    /// Like [`compile_document`], but on a localized failure runs the
    /// [`recovery`] pass (dropping errored spans such as a broken `#include`)
    /// so metadata can still be read from the rest. Without this, one broken
    /// span would hide every inline `#task` / `#due` from the Agenda.
    ///
    /// Recovery rewrites the world's main source, so the original is restored
    /// before returning, as in [`compile_svg`]. `None` only when recovery can't
    /// make progress.
    ///
    /// [`compile_document`]: Self::compile_document [`compile_svg`]:
    /// Self::compile_svg [`recovery`]: crate::typst_pipeline::recovery
    pub fn compile_document_recovering(
        &mut self,
        abs_path: &Path,
        source: String,
    ) -> Option<PagedDocument> {
        let _evict = EvictComemoOnDrop;
        if self.world.set_main(abs_path, source.clone()).is_err() {
            return None;
        }
        let _t = CompileTimer::start("compile_document_recovering", abs_path);
        let warned = typst::compile::<PagedDocument>(&self.world);
        _t.done();
        match warned.output {
            Ok(document) => Some(document),
            Err(errors) => {
                let recovered = recovery::recover::<PagedDocument>(
                    &self.world,
                    abs_path,
                    &errors,
                    RecoveryStyle::Marker,
                );
                // Restore the user's original source so later queries/compiles
                // against this path see what they wrote, not the patched variant.
                let _ = self.world.set_main(abs_path, source);
                recovered
            }
        }
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

    /// Compile the note at `abs_path` to per-page SVG. The caller supplies the
    /// source, normally read through [`NoteboxStorage`], which keeps the main
    /// file inside the notebox. Imported files are still read by the `World`
    /// directly.
    ///
    /// `abs_path` must be a canonical absolute path inside the compiler's
    /// notebox root.
    ///
    /// [`NoteboxStorage`]: crate::storage::traits::NoteboxStorage
    pub fn compile_svg(
        &mut self,
        abs_path: &Path,
        source: String,
    ) -> Result<TypstCompileResult, CompileError> {
        let _evict = EvictComemoOnDrop;
        // Clone so the original source is available to restore in the world
        // after the recovery pass (which rewrites the main file in place).
        self.world
            .set_main(abs_path, source.clone())
            .map_err(|err| CompileError::SetMain(abs_path.to_path_buf(), format!("{err:?}")))?;

        // `.output` is the document or errors; `.warnings` the warnings.
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
                // Reading-view fallback: recover a renderable document by
                // dropping errored spans. The diagnostics still report the real
                // errors.
                let recovered = recovery::recover::<PagedDocument>(
                    &self.world,
                    abs_path,
                    &errors,
                    RecoveryStyle::Marker,
                );
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
        self.compile_pdf_with(abs_path, source, pdf_standard, false)
            .map(|out| out.bytes)
    }

    /// Like [`compile_pdf`](Self::compile_pdf), optionally bypassing errors:
    /// with `bypass_errors`, a failing note's errored markup is kept as plain
    /// text (see [`RecoveryStyle::LiteralText`]) and [`PdfOutput::bypassed`] is
    /// set. Errors recovery can't get past are still returned, as are all
    /// errors for formats that don't allow bypassing (see
    /// [`PdfStandardPreset::allows_bypassing_errors`]).
    pub fn compile_pdf_with(
        &mut self,
        abs_path: &Path,
        source: String,
        pdf_standard: PdfStandardPreset,
        bypass_errors: bool,
    ) -> Result<PdfOutput, CompileError> {
        self.compile_pdf_structured(abs_path, source, pdf_standard, bypass_errors)
            .map_err(|failure| match failure {
                PdfFailure::SetMain(msg) => CompileError::SetMain(abs_path.to_path_buf(), msg),
                PdfFailure::Compile(diags) => CompileError::Compile(join_messages(&diags)),
                PdfFailure::PdfExport(diags) => CompileError::PdfExport(join_messages(&diags)),
            })
    }

    /// Like [`compile_pdf_with`](Self::compile_pdf_with), but returns
    /// structured diagnostics on failure, so the book export can trace each
    /// error to its note (see `book_wrapper::describe_book_diagnostics`).
    pub fn compile_pdf_diagnostics(
        &mut self,
        abs_path: &Path,
        source: String,
        pdf_standard: PdfStandardPreset,
        bypass_errors: bool,
    ) -> Result<PdfOutput, Vec<TypstDiagnostic>> {
        self.compile_pdf_structured(abs_path, source, pdf_standard, bypass_errors)
            .map_err(|failure| match failure {
                PdfFailure::SetMain(msg) => vec![TypstDiagnostic {
                    severity: "error",
                    message: format!(
                        "failed to register main file {}: {msg}",
                        abs_path.display() // path-stringification-ok: error message
                    ),
                    primary: None,
                    trace: Vec::new(),
                    hints: Vec::new(),
                }],
                PdfFailure::Compile(diags) | PdfFailure::PdfExport(diags) => diags,
            })
    }

    /// Shared body of the PDF compile entry points.
    fn compile_pdf_structured(
        &mut self,
        abs_path: &Path,
        source: String,
        pdf_standard: PdfStandardPreset,
        bypass_errors: bool,
    ) -> Result<PdfOutput, PdfFailure> {
        let _evict = EvictComemoOnDrop;
        // Recovery rewrites the main file in place, so keep the original to
        // restore afterwards (see `compile_svg`).
        let bypass_errors = bypass_errors && pdf_standard.allows_bypassing_errors();
        let original = bypass_errors.then(|| source.clone());
        self.world
            .set_main(abs_path, source)
            .map_err(|err| PdfFailure::SetMain(format!("{err:?}")))?;

        let _t = CompileTimer::start("compile_pdf", abs_path);
        let warned = typst::compile::<PagedDocument>(&self.world);
        _t.done();

        let (document, bypassed) = match warned.output {
            Ok(document) => (document, false),
            Err(errors) => {
                let recovered = original.map(|original| {
                    let doc = recovery::recover::<PagedDocument>(
                        &self.world,
                        abs_path,
                        &errors,
                        RecoveryStyle::LiteralText,
                    );
                    let _ = self.world.set_main(abs_path, original);
                    doc
                });
                match recovered.flatten() {
                    Some(document) => (document, true),
                    None => return Err(PdfFailure::Compile(self.to_diagnostics(&errors))),
                }
            }
        };

        let options = PdfOptions {
            standards: pdf_standard.to_pdf_standards(),
            ..PdfOptions::default()
        };
        let bytes = typst_pdf::pdf(&document, &options)
            .map_err(|errs| PdfFailure::PdfExport(self.to_diagnostics(&errs)))?;
        Ok(PdfOutput { bytes, bypassed })
    }

    fn to_diagnostics(&self, errors: &[typst::diag::SourceDiagnostic]) -> Vec<TypstDiagnostic> {
        errors
            .iter()
            .map(|d| crate::typst_pipeline::diagnostic::from_source(d, &self.world))
            .collect()
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
        bypass_errors: bool,
    ) -> Result<PdfOutput, CompileError> {
        let with_template = inject_template_import(&source, template);
        let old_style = self.bibliography_style.clone();
        if let Some(style) = bib_style {
            self.bibliography_style = Some(style.to_string());
        }
        let result = self.compile_pdf_with(abs_path, with_template, pdf_standard, bypass_errors);
        self.bibliography_style = old_style;
        result
    }

    /// Compile the note at `abs_path` to HTML with Typst's HTML backend. Failed
    /// compiles are recovered with warning markers ([`RecoveryStyle::Marker`]); see
    /// [`compile_html_with`](Self::compile_html_with).
    pub fn compile_html(
        &mut self,
        abs_path: &Path,
        source: String,
    ) -> Result<TypstHtmlResult, CompileError> {
        self.compile_html_with(abs_path, source, RecoveryStyle::Marker)
    }

    /// Like [`compile_html`](Self::compile_html), choosing how a failed compile
    /// is recovered. On recovery, `ok` is false, `recovered` true and `html`
    /// the recovered page.
    pub fn compile_html_with(
        &mut self,
        abs_path: &Path,
        source: String,
        recovery_style: RecoveryStyle,
    ) -> Result<TypstHtmlResult, CompileError> {
        let _evict = EvictComemoOnDrop;
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
                // Default options (minified). The reading view and HTML exports
                // don't need readable HTML source, and using the default picks
                // up new fields.
                match typst_html::html(&document, &HtmlOptions::default()) {
                    Ok(html) => Ok(TypstHtmlResult {
                        ok: true,
                        recovered: false,
                        html,
                        diagnostics,
                    }),
                    Err(errs) => {
                        // HTML generation itself failed; not a span error, so
                        // recovery doesn't apply.
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
                let recovered = recovery::recover::<HtmlDocument>(
                    &self.world,
                    abs_path,
                    &errors,
                    recovery_style,
                )
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

    /// Temp dirs aren't always canonical (`/tmp` links to `/private/tmp` on
    /// macOS), but the pipeline expects a canonical root.
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
        // The archival-plus-accessible preset (PDF/A-2a + PDF/UA-1) must build
        // and produce a PDF. If a Typst upgrade rejects the pair, this fails here
        // rather than in a user's export. The document has a title, language and
        // date, as both standards require.
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

    /// A note that `#include`s a broken file still renders its own content: the
    /// `#include` is replaced with the error marker and the included file's
    /// error is reported.
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

    /// Bypassing keeps errored markup as text: a stray reference stays
    /// readable, a call with a bad argument appears as written, and a following
    /// `(` stays text.
    #[test]
    fn bypassing_errors_keeps_the_literal_source_text() {
        let (_dir, root) = canonical_tempdir();
        crate::notebox_package::scaffold(&root);
        let import = crate::notebox_package::import_line();
        let src = format!(
            "{import}\n\nMet on @2025-09-15(at noon).\n\n#image(\"/missing.png\", width: 50%)\n\nlast line\n"
        );
        let note_path = root.join("broken.typ");
        fs::write(&note_path, &src).expect("write note");

        let mut compiler = TypstCompiler::new(root);
        let result = compiler
            .compile_html_with(&note_path, src, RecoveryStyle::LiteralText)
            .expect("compile_html_with");

        assert!(!result.ok, "the note has errors");
        assert!(
            result.recovered,
            "bypass should produce a page: {:?}",
            result.diagnostics
        );
        assert!(
            result.html.contains("@2025-09-15(at noon)"),
            "html: {}",
            result.html
        );
        assert!(result.html.contains("#image("), "html: {}", result.html);
        assert!(
            result.html.contains("/missing.png"),
            "html: {}",
            result.html
        );
        assert!(result.html.contains("last line"), "html: {}", result.html);
        assert!(
            !result.html.contains('\u{26a0}'),
            "no warning markers in an export"
        );
    }

    /// Plain PDF may bypass errors; archival and accessible formats refuse and
    /// report the original errors instead.
    #[test]
    fn only_plain_pdf_may_bypass_errors() {
        let (_dir, root) = canonical_tempdir();
        crate::notebox_package::scaffold(&root);
        let import = crate::notebox_package::import_line();
        let src = format!(
            "{import}\n#set document(title: \"T\", date: datetime(year: 2026, month: 1, day: 1))\n\
             #set text(lang: \"en\")\n\nSee @missing-label here.\n"
        );
        let note_path = root.join("broken.typ");
        fs::write(&note_path, &src).expect("write note");

        let mut compiler = TypstCompiler::new(root);
        let plain = compiler
            .compile_pdf_with(&note_path, src.clone(), PdfStandardPreset::Standard, true)
            .expect("plain PDF bypasses the error");
        assert!(plain.bypassed);
        assert!(plain.bytes.starts_with(b"%PDF-"));

        assert!(compiler
            .compile_pdf_with(&note_path, src.clone(), PdfStandardPreset::Standard, false)
            .is_err());
        for standard in [
            PdfStandardPreset::PdfA4,
            PdfStandardPreset::PdfUa1,
            PdfStandardPreset::PdfA2aUa1,
        ] {
            assert!(
                compiler
                    .compile_pdf_with(&note_path, src.clone(), standard, true)
                    .is_err(),
                "{standard:?} must not bypass errors"
            );
        }
    }

    /// `#video` / `#audio` compile for both targets: a placeholder in paged
    /// output and `<video>` / `<audio controls>` in HTML.
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
        // The spike fixture uses the whole notebox package. It lives at the
        // repository root; skip when it isn't there.
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
        // A literal `@2025-09-15` is a reference to a missing label; recovery
        // should drop it and render the rest.
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
