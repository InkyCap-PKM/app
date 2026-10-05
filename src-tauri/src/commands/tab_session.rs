// IPC commands for the "Open previous tabs" startup behaviour: read back the
// tabs this machine last had open in the current notebox (or hold them back
// after a reopen that never finished), record them as they change, and forget
// them when the user turns the behaviour off.
//
// The record itself lives in [`crate::tab_sessions`] — per-machine, outside the
// notebox, never travelling with it.

use tauri::State;

use crate::errors::Result;
use crate::state::AppState;
use crate::tab_sessions::{self, NoteboxTabSession, TabRestore};

/// Canonical root of the notebox open in the calling window. Every command here
/// is notebox-scoped, so a window with nothing open is an error rather than a
/// silent no-op.
async fn canonical_root(
    state: &State<'_, AppState>,
    window: &tauri::WebviewWindow,
) -> Result<std::path::PathBuf> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    Ok(storage.canonical_root().to_path_buf())
}

/// The tabs this machine last had open in the current notebox, and whether to
/// reopen them or hold them back (the last reopen never finished, or InkyCap
/// was started with `--no-restore`). A reopen is marked in progress until the
/// frontend clears it with [`set_tab_restore_pending`]. Paths are absolute, and
/// notes that have since been deleted are dropped.
#[tauri::command]
pub async fn start_tab_restore(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<TabRestore> {
    let root = canonical_root(&state, &window).await?;
    tab_sessions::start_restore(&root, tab_sessions::launched_with_no_restore())
}

/// Mark or clear "reopen in progress" for the notebox at `notebox_path`. Takes
/// the notebox explicitly rather than the window's, because the frontend clears
/// the mark some seconds after the reopen, by which time the window may have
/// switched to another notebox.
#[tauri::command]
pub async fn set_tab_restore_pending(notebox_path: String, pending: bool) -> Result<()> {
    let root = crate::storage::canonicalize_root(std::path::Path::new(&notebox_path))?;
    tab_sessions::set_restore_pending(&root, pending)
}

/// Record the current notebox's open tabs, replacing the previous record.
/// Called by the frontend only while the "previous tabs" startup behaviour is
/// selected.
#[tauri::command]
pub async fn save_notebox_tab_session(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    session: NoteboxTabSession,
) -> Result<()> {
    let root = canonical_root(&state, &window).await?;
    tab_sessions::save(&root, &session)
}

/// Forget the recorded tabs of every notebox. Called when the user turns the
/// "previous tabs" startup behaviour off; needs no notebox to be open.
#[tauri::command]
pub async fn clear_all_notebox_tab_sessions() -> Result<()> {
    tab_sessions::clear_all()
}
