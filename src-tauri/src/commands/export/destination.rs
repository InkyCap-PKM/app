//! Save and folder dialogs for export destinations, run by the backend so the
//! chosen location can be recorded in the window's
//! [`ExportGrants`](crate::storage::export_grants::ExportGrants). Every
//! export command checks its destination with [`require_export_destination`]
//! before writing.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::to_frontend_string;

/// One file-type filter in a save dialog, e.g. `{ name: "PDF", extensions: ["pdf"] }`.
#[derive(Debug, Deserialize)]
pub struct DialogFilter {
    name: String,
    extensions: Vec<String>,
}

/// Options for [`pick_export_file`] and [`pick_export_folder`], matching the
/// shape of the frontend dialog plugin's options.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDialogOptions {
    title: Option<String>,
    /// A suggested file path, or a folder to start in.
    default_path: Option<String>,
    #[serde(default)]
    filters: Vec<DialogFilter>,
}

/// Ask the user where to save an export. Returns the chosen path, or `None`
/// if they cancelled. The folder containing the chosen file becomes a place
/// this window's exports may write to.
#[tauri::command]
pub async fn pick_export_file(
    options: ExportDialogOptions,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, InkyCapError> {
    let picked = run_dialog(app, window.clone(), options, DialogKind::SaveFile).await?;
    let Some(path) = picked else {
        return Ok(None);
    };
    if let Some(parent) = path.parent() {
        state
            .session(window.label())
            .await
            .export_grants
            .grant(parent);
    }
    Ok(Some(to_frontend_string(&path)))
}

/// Ask the user for a folder to export into. Returns the chosen folder, or
/// `None` if they cancelled. The folder becomes a place this window's exports
/// may write to.
#[tauri::command]
pub async fn pick_export_folder(
    options: ExportDialogOptions,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, InkyCapError> {
    let picked = run_dialog(app, window.clone(), options, DialogKind::Folder).await?;
    let Some(path) = picked else {
        return Ok(None);
    };
    state
        .session(window.label())
        .await
        .export_grants
        .grant(&path);
    Ok(Some(to_frontend_string(&path)))
}

/// Refuse an export destination the user didn't choose in one of the dialogs
/// above. Call at the start of every command that writes an export.
pub(crate) async fn require_export_destination(
    state: &State<'_, AppState>,
    window: &tauri::WebviewWindow,
    destination: &str,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    if session.export_grants.allows(Path::new(destination)) {
        Ok(())
    } else {
        Err(InkyCapError::InvalidPath(format!(
            "export destination was not chosen in a save dialog: {destination}"
        )))
    }
}

enum DialogKind {
    SaveFile,
    Folder,
}

async fn run_dialog(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    options: ExportDialogOptions,
    kind: DialogKind,
) -> Result<Option<PathBuf>, InkyCapError> {
    let picked = tokio::task::spawn_blocking(move || {
        let mut builder = app.dialog().file().set_parent(&window);
        if let Some(title) = &options.title {
            builder = builder.set_title(title);
        }
        for filter in &options.filters {
            let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
            builder = builder.add_filter(&filter.name, &extensions);
        }
        if let Some(default) = options.default_path.as_deref().map(Path::new) {
            if default.is_dir() {
                builder = builder.set_directory(default);
            } else {
                if let Some(parent) = default.parent().filter(|p| p.is_dir()) {
                    builder = builder.set_directory(parent);
                }
                if let (DialogKind::SaveFile, Some(name)) =
                    (&kind, default.file_name().and_then(|n| n.to_str()))
                {
                    builder = builder.set_file_name(name);
                }
            }
        }
        match kind {
            DialogKind::SaveFile => builder.blocking_save_file(),
            DialogKind::Folder => builder.blocking_pick_folder(),
        }
    })
    .await
    .map_err(|e| InkyCapError::Io(std::io::Error::other(format!("dialog join error: {e}"))))?;

    picked
        .map(|fp| {
            fp.into_path()
                .map_err(|e| InkyCapError::InvalidPath(format!("invalid path from dialog: {e}")))
        })
        .transpose()
}
