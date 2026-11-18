//! Convert `#task("…")` strings that hold Typst markup to markup bodies,
//! `#task[…]`, across the notebox (see `typst_pipeline::task_body` for which
//! tasks qualify). The preview command is read-only, so the UI can say how many
//! tasks in how many notes will change before anything is written.

use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::task_body::{convert_markup_task_bodies, TaskBodyConversion};

/// What converting the notebox's task bodies does, or did.
#[derive(Debug, Clone, Default, Serialize)]
pub struct TaskBodyConversionSummary {
    /// Notes with at least one task converted.
    pub notes: usize,
    /// Tasks converted to a markup body.
    pub tasks: usize,
    /// Tasks whose string holds markup that was left as it is.
    pub skipped: usize,
    /// Notes that couldn't be read or written, by notebox-relative path. Always
    /// empty for a preview.
    pub errors: Vec<String>,
}

/// Count the tasks that converting would change, and the notes holding them.
/// Changes nothing.
#[tauri::command]
pub async fn preview_task_body_conversion(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<TaskBodyConversionSummary, InkyCapError> {
    run(&state, &window, false).await
}

/// Convert every qualifying `#task("…")` in the notebox to `#task[…]`, writing
/// and reindexing each changed note. A note that fails is reported in `errors`;
/// the others are still converted.
#[tauri::command]
pub async fn convert_task_bodies(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<TaskBodyConversionSummary, InkyCapError> {
    run(&state, &window, true).await
}

async fn run(
    state: &AppState,
    window: &tauri::WebviewWindow,
    write: bool,
) -> Result<TaskBodyConversionSummary, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let notes = storage.list_files(&PathBuf::from(""), "*.typ").await?;
    // `list_files` returns canonical paths, so strip the storage's canonical
    // root rather than the session's (they differ under symlinks).
    let strip_root = storage.canonical_root();

    let mut summary = TaskBodyConversionSummary::default();
    for note_abs in notes {
        let rel = note_abs
            .strip_prefix(strip_root)
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|_| note_abs.clone());
        let content = match storage.read_file(&rel).await {
            Ok(c) => c,
            Err(e) => {
                summary.errors.push(format!("read {}: {e}", rel.display()));
                continue;
            }
        };
        // Skip the parse when the note can't hold a task.
        if !content.contains("task(") {
            continue;
        }
        let TaskBodyConversion {
            source,
            converted,
            skipped,
        } = convert_markup_task_bodies(&content);
        summary.skipped += skipped;
        if converted == 0 {
            continue;
        }
        if write {
            if let Err(e) = storage.write_file(&rel, &source).await {
                summary.errors.push(format!("write {}: {e}", rel.display()));
                continue;
            }
            session.reindex_note(&rel, &source).await;
        }
        summary.notes += 1;
        summary.tasks += converted;
    }
    Ok(summary)
}
