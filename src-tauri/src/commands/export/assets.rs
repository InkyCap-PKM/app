use std::path::PathBuf;

use tauri::State;

use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::traits::NoteboxStorage;

use super::helpers::extract_image_paths;

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
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path_buf = PathBuf::from(&path);
    let content = storage.read_file(&path_buf).await?;
    let content = super::helpers::apply_review_mode(&content, review_mode.as_deref());
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root
        .as_ref()
        .ok_or(InkyCapError::NoteboxNotOpen)?
        .clone();
    drop(notebox_root);

    let output = PathBuf::from(&output_path);
    let output_dir = output
        .parent()
        .ok_or_else(|| InkyCapError::ExportFailed("Invalid output path".into()))?;

    let image_paths = extract_image_paths(&content);
    let mut rewritten = content.clone();
    for img_path in &image_paths {
        let abs_img = if let Some(stripped) = img_path.strip_prefix('/') {
            root.join(stripped)
        } else {
            path_buf.parent().unwrap_or(&root).join(img_path)
        };
        if abs_img.exists() {
            let rel = img_path.strip_prefix('/').unwrap_or(img_path.as_str());
            let dest = output_dir.join(rel);
            if let Some(parent) = dest.parent() {
                tokio::fs::create_dir_all(parent).await.map_err(|e| {
                    InkyCapError::ExportFailed(format!("Failed to create asset dir: {e}"))
                })?;
            }
            tokio::fs::copy(&abs_img, &dest).await.map_err(|e| {
                InkyCapError::ExportFailed(format!(
                    "Failed to copy asset {}: {e}",
                    abs_img.display()
                ))
            })?;
            if img_path.starts_with('/') {
                rewritten = rewritten.replace(
                    &format!("#image(\"{img_path}\")"),
                    &format!("#image(\"{rel}\")"),
                );
            }
        }
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

// ── Figure extraction ───────────────────────────────────────────

/// Export figures from a note to a target directory.
#[tauri::command]
pub async fn export_figures(
    path: String,
    output_dir: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path_buf = PathBuf::from(&path);
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?;

    let content = storage.read_file(&path_buf).await?;
    let image_paths = extract_image_paths(&content);

    let output_dir = PathBuf::from(&output_dir);
    tokio::fs::create_dir_all(&output_dir)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to create output dir: {}", e)))?;

    let mut exported = Vec::new();
    for img_path in &image_paths {
        let abs_img = if let Some(stripped) = img_path.strip_prefix('/') {
            root.join(stripped)
        } else {
            path_buf.parent().unwrap_or(root).join(img_path)
        };

        if abs_img.exists() {
            let file_name = abs_img
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "unknown".to_string());
            let dest = output_dir.join(&file_name);
            tokio::fs::copy(&abs_img, &dest).await.map_err(|e| {
                InkyCapError::ExportFailed(format!("Failed to copy {}: {}", file_name, e))
            })?;
            exported.push(file_name);
        }
    }

    Ok(exported)
}
