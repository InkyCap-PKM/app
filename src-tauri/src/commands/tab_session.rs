// IPC commands for the "Open previous tabs" startup behaviour: read back the
// tabs this machine last had open in the current notebox, record them as they
// change, and forget them when the user turns the behaviour off.
//
// The record itself lives in [`crate::tab_sessions`] — per-machine, outside the
// notebox, never travelling with it.

use tauri::State;

use crate::errors::Result;
use crate::state::AppState;
use crate::tab_sessions::{self, NoteboxTabSession};

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

/// Tabs this machine last had open in the current notebox, with paths made
/// absolute and any note that has since been deleted dropped. Empty when
/// nothing was recorded.
#[tauri::command]
pub async fn get_notebox_tab_session(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<NoteboxTabSession> {
    let root = canonical_root(&state, &window).await?;
    Ok(tab_sessions::load(&root))
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
