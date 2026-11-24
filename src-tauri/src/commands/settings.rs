// Commands for reading and writing settings. There are user settings
// (`UserSettings`, in `$CONFIG_DIR/inkycap/settings.json`) and per-notebox
// settings (`NoteboxSettings`, in `<notebox>/.inkycap/settings.json`), each
// with its own read and write commands.

use tauri::State;

use crate::errors::{InkyCapError, Result};
use crate::notebox_settings::NoteboxSettings;
use crate::scaffolds;
use crate::settings::UserSettings;
use crate::state::AppState;

/// Return the current user-global settings.
#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<UserSettings> {
    let settings = state.settings.read().await;
    Ok(settings.clone())
}

/// Save the user settings. The frontend sends the whole updated UserSettings
/// object.
#[tauri::command]
pub async fn update_settings(state: State<'_, AppState>, settings: UserSettings) -> Result<()> {
    crate::settings::save_settings(&settings)?;
    *state.settings.write().await = settings;

    // Backup settings may have changed (interval, path, …), so wake the
    // scheduler to use them now. Harmless when nothing changed.
    crate::backup::schedule::wake_now(&state);

    Ok(())
}

/// The current notebox's settings, or defaults if no notebox is open (which the
/// frontend shouldn't act on).
#[tauri::command]
pub async fn get_notebox_settings(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<NoteboxSettings> {
    let session = state.session(window.label()).await;
    let settings = session.notebox_settings.read().await;
    Ok(settings.clone())
}

/// Save the notebox settings and apply their effects (the Zotero export). An error if no notebox is open.
#[tauri::command]
pub async fn update_notebox_settings(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    settings: NoteboxSettings,
) -> Result<()> {
    let session = state.session(window.label()).await;
    let notebox_root = session
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or_else(|| InkyCapError::BadRequest("no notebox open".to_string()))?;

    crate::notebox_settings::save_settings(&notebox_root, &settings)?;

    // For a Zotero citation source (or a changed bib path), refresh the
    // notebox's exported bibliography so `#bibliography()` calls find it.
    let global = state.settings.read().await.citations.clone();
    session
        .refresh_bibliography_file(&notebox_root, &global, &settings.citations)
        .await;

    *session.notebox_settings.write().await = settings;
    Ok(())
}

/// Generate a Zettelkasten ID using the user's configured pattern.
#[tauri::command]
pub async fn generate_zid(state: State<'_, AppState>) -> Result<String> {
    let settings = state.settings.read().await;
    let pattern = &settings.files.zid_pattern;
    Ok(scaffolds::generate_zid(pattern))
}
