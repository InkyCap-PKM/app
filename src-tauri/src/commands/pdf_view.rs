//! PDF viewing for attachment tabs. Typst draws each page: a one-line
//! document places the page with `image(path, page: n)` and goes through the
//! same SVG compile as reading mode, so no separate PDF viewer is bundled.
//! The page count comes from `hayro-syntax`, the PDF reader Typst itself uses
//! (Typst keeps its own wrapper around it private).

use std::path::{Path, PathBuf};

use tauri::State;

use crate::errors::InkyCapError;
use crate::state::{AppState, NoteboxSession};
use crate::storage::sanitize_notebox_arg;
use crate::storage::to_frontend_string;
use crate::typst_pipeline::book_wrapper::typst_escape;
use crate::typst_pipeline::{TypstCompiler, TypstFrame};

/// Where the page document sits in the notebox. It is never written to disk;
/// the compiler only needs a main-file path inside the notebox root.
const PAGE_DOCUMENT_PATH: &str = ".inkycap/pdf-page-view.typ";

/// Resolve `path` to the canonical PDF file inside the notebox and its
/// notebox-relative form (`Assets/paper.pdf`).
async fn resolve_pdf(
    session: &NoteboxSession,
    path: &str,
) -> Result<(PathBuf, String, PathBuf), InkyCapError> {
    let path_arg = sanitize_notebox_arg(path)?;
    let storage = session.get_storage().await?;
    let canonical = storage.resolve_path(&path_arg)?;
    if !canonical.is_file() {
        return Err(InkyCapError::FileNotFound(path.to_string()));
    }
    let root = storage.canonical_root().to_path_buf();
    let rel = canonical
        .strip_prefix(&root)
        .map(to_frontend_string)
        .map_err(|_| InkyCapError::InvalidPath(path.to_string()))?;
    Ok((canonical, rel, root))
}

/// The Typst document that shows page `page` (1-based) of the notebox file
/// `rel`, sized to the PDF page itself.
fn page_document_source(rel: &str, page: usize) -> String {
    format!(
        "#set page(width: auto, height: auto, margin: 0pt)\n#image(\"/{}\", page: {page})\n",
        typst_escape(rel)
    )
}

/// Number of pages in the PDF at `path` (absolute or notebox-relative).
#[tauri::command]
pub async fn get_pdf_page_count(
    path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<usize, InkyCapError> {
    let session = state.session(window.label()).await;
    let (canonical, _, _) = resolve_pdf(&session, &path).await?;
    let data = tokio::fs::read(&canonical).await?;
    tokio::task::spawn_blocking(move || count_pages(data))
        .await
        .map_err(|err| InkyCapError::Typst(err.to_string()))?
}

fn count_pages(data: Vec<u8>) -> Result<usize, InkyCapError> {
    hayro_syntax::Pdf::new(data)
        .map(|pdf| pdf.pages().len())
        .map_err(|err| InkyCapError::Typst(format!("{err:?}")))
}

/// Draw page `page` (1-based) of the PDF at `path` as SVG. Fails with the
/// first Typst error when the page can't be drawn (a damaged PDF, a page
/// number out of range).
#[tauri::command]
pub async fn render_pdf_page(
    path: String,
    page: usize,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<TypstFrame, InkyCapError> {
    let session = state.session(window.label()).await;
    let (_, rel, root) = resolve_pdf(&session, &path).await?;
    let mut guard = session.typst_compiler.lock().await;
    let compiler = guard.as_mut().ok_or(InkyCapError::NoteboxNotOpen)?;
    draw_page(compiler, &root, &rel, page)
}

/// Compile the page document for page `page` of the notebox file `rel` and
/// return the drawn page, or the first Typst error.
fn draw_page(
    compiler: &mut TypstCompiler,
    root: &Path,
    rel: &str,
    page: usize,
) -> Result<TypstFrame, InkyCapError> {
    let main = root.join(PAGE_DOCUMENT_PATH);
    let result = compiler
        .compile_svg(&main, page_document_source(rel, page.max(1)))
        .map_err(|err| InkyCapError::Typst(err.to_string()))?;
    if result.ok {
        if let Some(frame) = result.frames.into_iter().next() {
            return Ok(frame);
        }
    }
    let message = result
        .diagnostics
        .into_iter()
        .next()
        .map(|d| d.message)
        .unwrap_or_default();
    Err(InkyCapError::Typst(message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::typst_pipeline::PdfStandardPreset;

    #[test]
    fn page_document_places_one_page_at_its_own_size() {
        assert_eq!(
            page_document_source("Assets/a \"b\".pdf", 3),
            "#set page(width: auto, height: auto, margin: 0pt)\n#image(\"/Assets/a \\\"b\\\".pdf\", page: 3)\n"
        );
    }

    #[test]
    fn counts_and_draws_pages_of_a_real_pdf() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonical root");
        let mut compiler = TypstCompiler::new(root.clone());

        // A two-page PDF with differently sized pages, made by Typst itself.
        let source = "#set page(width: 200pt, height: 100pt)\nOne\n#pagebreak()\n#set page(width: 300pt, height: 150pt)\nTwo\n";
        let pdf = compiler
            .compile_pdf(
                &root.join("source.typ"),
                source.to_string(),
                PdfStandardPreset::Standard,
            )
            .expect("compile pdf");
        std::fs::create_dir_all(root.join("Assets")).expect("assets dir");
        std::fs::write(root.join("Assets/two pages.pdf"), &pdf).expect("write pdf");

        assert_eq!(count_pages(pdf).expect("count"), 2);

        let second = draw_page(&mut compiler, &root, "Assets/two pages.pdf", 2).expect("page 2");
        assert!(
            (second.width_pt - 300.0).abs() < 0.5,
            "width {}",
            second.width_pt
        );
        assert!(
            (second.height_pt - 150.0).abs() < 0.5,
            "height {}",
            second.height_pt
        );
        assert!(second.svg.starts_with("<svg"));

        assert!(draw_page(&mut compiler, &root, "Assets/two pages.pdf", 3).is_err());
    }
}
