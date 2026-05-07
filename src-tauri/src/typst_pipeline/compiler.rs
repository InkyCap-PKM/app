//! Public-facing compile API. Holds a [`VaultWorld`] and exposes per-document
//! `compile_svg` (Phase 1), `compile_pdf` (Phase 9b), and query hooks.
//!
//! Design notes:
//! - One compiler instance per open vault. Re-used across compiles so comemo
//!   memoization stays warm.
//! - All rendering goes through `typst::compile(&world)` where the world's
//!   "main" file pointer has been swapped to the document we want.
//! - SVG is per-page, not merged. The frontend is page-aware (reading-mode
//!   shows pages stacked with separators) so we hand it the array.

use std::path::{Path, PathBuf};

use serde::Serialize;
use typst::layout::PagedDocument;
use typst_html::HtmlDocument;

use crate::typst_pipeline::diagnostic::TypstDiagnostic;
use crate::typst_pipeline::world::VaultWorld;

/// Compile output ready for IPC. SVG strings travel through Tauri as plain
/// JSON; for the 4-page bench-doc this is ~700KB total — well under the
/// payload size we care about.
#[derive(Debug, Clone, Serialize)]
pub struct TypstCompileResult {
    /// True if a `PagedDocument` was produced. Diagnostics may still contain
    /// warnings even on success; on failure, frames is empty and diagnostics
    /// will contain at least one error.
    pub ok: bool,
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
    pub html: String,
    pub diagnostics: Vec<TypstDiagnostic>,
}

pub struct TypstCompiler {
    world: VaultWorld,
    /// Citation style (e.g. "apa", "ieee", "mla"). `None` uses Typst default.
    bibliography_style: Option<String>,
}

impl TypstCompiler {
    pub fn new(vault_root: PathBuf) -> Self {
        Self {
            world: VaultWorld::new(vault_root),
            bibliography_style: None,
        }
    }

    pub fn vault_root(&self) -> &Path {
        self.world.vault_root()
    }

    /// Load system and vault-local fonts on demand. No-op if already loaded.
    pub fn ensure_system_fonts(&mut self) {
        self.world.load_system_fonts();
    }

    pub fn system_fonts_loaded(&self) -> bool {
        self.world.system_fonts_loaded()
    }

    /// Load system fonts if settings indicate a non-embedded font is configured.
    pub fn ensure_system_fonts_for_settings(&mut self, settings: &crate::settings::UserSettings) {
        if self.system_fonts_loaded() {
            return;
        }
        let needs = settings.document.text_font.as_ref().is_some_and(|f| !f.is_empty());
        if needs {
            self.ensure_system_fonts();
        }
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
    /// by the caller (typically read via [`VaultStorage`], which validates the
    /// path is inside the vault); this keeps the compiler out of the I/O path
    /// for the main file and ensures all reads go through the trait that
    /// enforces the vault sandbox. Imported files (`#import "/..."`) are still
    /// read by the underlying `World` directly — that's a separate threat
    /// surface tracked as a follow-up.
    ///
    /// `abs_path` MUST be a canonicalized absolute path inside the vault root
    /// the compiler was constructed with; the caller is responsible for that
    /// guarantee.
    ///
    /// Uses `&mut self` so we have a single-writer guarantee; the underlying
    /// World is `Sync` and could in principle be shared, but compile is hot
    /// enough at ~20ms that we don't gain anything from concurrent compiles.
    ///
    /// [`VaultStorage`]: crate::storage::traits::VaultStorage
    pub fn compile_svg(
        &mut self,
        abs_path: &Path,
        source: String,
    ) -> Result<TypstCompileResult, CompileError> {
        self.world
            .set_main(abs_path, source)
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
            Ok(document) => {
                let frames = document
                    .pages
                    .iter()
                    .map(|page| {
                        let svg = typst_svg::svg(page);
                        TypstFrame {
                            svg,
                            width_pt: page.frame.width().to_pt(),
                            height_pt: page.frame.height().to_pt(),
                        }
                    })
                    .collect();
                Ok(TypstCompileResult {
                    ok: true,
                    frames,
                    diagnostics,
                })
            }
            Err(errors) => {
                diagnostics.extend(
                    errors
                        .iter()
                        .map(|d| crate::typst_pipeline::diagnostic::from_source(d, &self.world)),
                );
                Ok(TypstCompileResult {
                    ok: false,
                    frames: Vec::new(),
                    diagnostics,
                })
            }
        }
    }

    /// Compile the note at `abs_path` to PDF bytes. Same contract as
    /// `compile_svg` regarding path requirements.
    pub fn compile_pdf(
        &mut self,
        abs_path: &Path,
        source: String,
    ) -> Result<Vec<u8>, CompileError> {
        self.world
            .set_main(abs_path, source)
            .map_err(|err| CompileError::SetMain(abs_path.to_path_buf(), format!("{err:?}")))?;

        let warned = typst::compile::<PagedDocument>(&self.world);

        match warned.output {
            Ok(document) => {
                let options = typst_pdf::PdfOptions::default();
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

    /// Compile with a template import injected. Used for collection-level
    /// export where a journal template is applied at compile time.
    pub fn compile_pdf_with_template(
        &mut self,
        abs_path: &Path,
        source: String,
        template: &str,
        bib_style: Option<&str>,
    ) -> Result<Vec<u8>, CompileError> {
        let with_template = inject_template_import(&source, template);
        let old_style = self.bibliography_style.clone();
        if let Some(style) = bib_style {
            self.bibliography_style = Some(style.to_string());
        }
        let result = self.compile_pdf(abs_path, with_template);
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
        self.world
            .set_main(abs_path, source)
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
                        html,
                        diagnostics,
                    }),
                    Err(errs) => {
                        diagnostics.extend(
                            errs.iter()
                                .map(|d| crate::typst_pipeline::diagnostic::from_source(d, &self.world))
                                .filter(|d| !is_html_development_noise(&d.message)),
                        );
                        Ok(TypstHtmlResult {
                            ok: false,
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
                Ok(TypstHtmlResult {
                    ok: false,
                    html: String::new(),
                    diagnostics,
                })
            }
        }
    }
}

/// Inject a `#import` + `#show: <template>` after the inkycap-vault import.
fn inject_template_import(source: &str, template: &str) -> String {
    let import_marker = "#import \"/.inkycap/packages/inkycap-vault/";
    if let Some(pos) = source.find(import_marker) {
        if let Some(line_end) = source[pos..].find('\n') {
            let insert_at = pos + line_end + 1;
            let import_line = format!("#import \"{}\": *\n", template);
            let mut result = String::with_capacity(source.len() + import_line.len());
            result.push_str(&source[..insert_at]);
            result.push_str(&import_line);
            result.push_str(&source[insert_at..]);
            return result;
        }
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
    /// vault root so the symlink-escape check holds — tests must do the same.
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

    #[test]
    fn compiles_phase_0_spike_fixture() {
        // The Phase 0 spike fixture exercises the full inkycap-vault package
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
