use tauri::State;

use crate::errors::InkyCapError;
use crate::recovery::Snapshot;
use crate::state::AppState;

/// Create a snapshot for a file (called automatically on save when content changes).
#[tauri::command]
pub async fn create_snapshot(
    file_path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<bool, InkyCapError> {
    let mgr = state.snapshot_manager.read().await;
    mgr.create_snapshot(&file_path, &content)
}

/// List all snapshots for a file, newest first.
#[tauri::command]
pub async fn list_snapshots(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<Snapshot>, InkyCapError> {
    let mgr = state.snapshot_manager.read().await;
    let mut snapshots = mgr.list_snapshots(&file_path)?;
    snapshots.reverse(); // newest first for UI
    Ok(snapshots)
}

/// Get the full content of a specific snapshot.
#[tauri::command]
pub async fn restore_snapshot(
    file_path: String,
    hash: String,
    state: State<'_, AppState>,
) -> Result<String, InkyCapError> {
    let mgr = state.snapshot_manager.read().await;
    mgr.restore_snapshot(&file_path, &hash)
}

/// Get a preview of a snapshot (first N chars, preamble stripped).
#[tauri::command]
pub async fn preview_snapshot(
    file_path: String,
    hash: String,
    max_chars: Option<usize>,
    state: State<'_, AppState>,
) -> Result<String, InkyCapError> {
    let mgr = state.snapshot_manager.read().await;
    mgr.preview_snapshot(&file_path, &hash, max_chars.unwrap_or(300))
}
