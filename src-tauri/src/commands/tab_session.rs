// Commands for "Open previous tabs" at startup: read the tabs this computer
// last had open in the current notebox (or hold them back after a reopen that
// didn't finish), record them as they change, and forget them when the option
// is turned off.
//
// The record is in [`crate::tab_sessions`]: per computer, outside the notebox.

use tauri::State;

use crate::errors::Result;
use crate::state::AppState;
use crate::tab_sessions::{self, NoteboxTabSession, TabRestore};

/// Canonical root of the window's notebox. These commands all need a notebox,
/// so an empty window is an error.
async fn canonical_root(
    state: &State<'_, AppState>,
    window: &tauri::WebviewWindow,
) -> Result<std::path::PathBuf> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    Ok(storage.canonical_root().to_path_buf())
}

/// The tabs this computer last had open in the current notebox, and whether to
/// reopen them or hold them back (the last reopen didn't finish, or InkyCap was
/// started with `--no-restore`). A reopen is marked in progress until the
/// frontend clears it with [`set_tab_restore_pending`]. Paths are absolute;
/// deleted notes are dropped.
#[tauri::command]
pub async fn start_tab_restore(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<TabRestore> {
    let root = canonical_root(&state, &window).await?;
    tab_sessions::start_restore(&root, tab_sessions::launched_with_no_restore())
}

/// Set or clear "reopen in progress" for `notebox_path`. Takes the notebox
/// explicitly because the frontend clears it some seconds after the reopen,
/// when the window may show another notebox.
#[tauri::command]
pub async fn set_tab_restore_pending(notebox_path: String, pending: bool) -> Result<()> {
    let root = crate::storage::canonicalize_root(std::path::Path::new(&notebox_path))?;
    tab_sessions::set_restore_pending(&root, pending)
}

/// Record the current notebox's open tabs, replacing the previous record.
/// Called only while "Open previous tabs" is selected.
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
