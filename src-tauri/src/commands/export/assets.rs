use std::path::PathBuf;

use tauri::State;

use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::traits::NoteboxStorage;

// ── Self-contained .typ export ──────────────────────────────────

/// Export a note as a self-contained `.typ` file with the `inkycap-notebox`
/// package inlined and referenced images copied alongside. The output
/// directory will contain the `.typ` plus any assets it references.
#[tauri::command]
pub async fn export_self_contained_typ(
    path: String,
    output_path: String,
    review_mode: Option<String>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    crate::commands::export::destination::require_export_destination(&state, &window, &output_path)
        .await?;
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path_buf = PathBuf::from(&path);
    let content = storage.read_file(&path_buf).await?;
    let content = super::helpers::apply_review_mode(&content, review_mode.as_deref());
    let output = PathBuf::from(&output_path);
    let output_dir = output
        .parent()
        .ok_or_else(|| InkyCapError::ExportFailed("Invalid output path".into()))?;

    // Relative paths become root-absolute (`/notes/fig.png`), and each image
    // is copied to the same place under the output folder. Compiling the
    // exported file takes its own folder as the root, so they resolve there.
    let note_dir = crate::commands::file_ops::notebox_relative_path(&path_buf, &storage)
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_default();
    let rewritten = crate::typst_pipeline::path_rebase::rebase_relative_paths(&content, &note_dir);
    for rel in crate::typst_pipeline::path_rebase::referenced_image_paths(&rewritten, &note_dir) {
        // Resolving through the storage keeps every copy inside the notebox.
        let Ok(source) = storage.resolve_path(std::path::Path::new(&rel)) else {
            continue;
        };
        if !source.is_file() {
            continue;
        }
        let dest = output_dir.join(&rel);
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                InkyCapError::ExportFailed(format!("Failed to create asset dir: {e}"))
            })?;
        }
        tokio::fs::copy(&source, &dest)
            .await
            .map_err(|e| InkyCapError::ExportFailed(format!("Failed to copy asset {rel}: {e}")))?;
    }

    let inlined = inline_package(&rewritten);
    tokio::fs::write(&output, inlined.as_bytes())
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write .typ file: {e}")))
}

/// Inline the `inkycap-notebox` package into a note's source.
pub(super) fn inline_package(source: &str) -> String {
    let lib_source = std::str::from_utf8(crate::notebox_package::LIB_TYP_BYTES)
        .unwrap_or("// inkycap-notebox package could not be inlined");

    let mut result = String::with_capacity(source.len() + lib_source.len() + 200);

    let mut found_import = false;
    for line in source.lines() {
        if !found_import && crate::notebox_package::is_notebox_import_line(line) {
            found_import = true;
            result.push_str("// ── inkycap-notebox package (inlined for portability) ──\n");
            result.push_str(lib_source);
            result.push_str("\n// ── end inkycap-notebox ──\n");
        } else {
            result.push_str(line);
            result.push('\n');
        }
    }

    if !found_import {
        let mut prefixed = String::with_capacity(result.len() + lib_source.len() + 200);
        prefixed.push_str("// ── inkycap-notebox package (inlined for portability) ──\n");
        prefixed.push_str(lib_source);
        prefixed.push_str("\n// ── end inkycap-notebox ──\n\n");
        prefixed.push_str(&result);
        return prefixed;
    }

    result
}
