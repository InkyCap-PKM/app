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

/// The bibliography style in effect: the notebox's custom CSL path if set,
/// otherwise the user's named style, unless that is "custom" without a path (no
/// style).
fn resolve_bibliography_style(
    global: &crate::settings::CitationSettings,
    notebox: &crate::notebox_settings::NoteboxCitationSettings,
) -> Option<String> {
    notebox.custom_csl_path.clone().or_else(|| {
        global
            .citation_style
            .as_deref()
            .filter(|s| *s != "custom")
            .map(String::from)
    })
}

/// Return the current user-global settings.
#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<UserSettings> {
    let settings = state.settings.read().await;
    Ok(settings.clone())
}

/// Save the user settings. The frontend sends the whole updated UserSettings
/// object.
#[tauri::command]
pub async fn update_settings(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    settings: UserSettings,
) -> Result<()> {
    let session = state.session(window.label()).await;
    crate::settings::save_settings(&settings)?;

    // Pass a citation style change to the compiler so it applies without
    // reopening the notebox. The notebox's `custom_csl_path` still wins if set.
    {
        let notebox = session.notebox_settings.read().await;
        if let Some(compiler) = session.typst_compiler.lock().await.as_mut() {
            let style = resolve_bibliography_style(&settings.citations, &notebox.citations);
            compiler.set_bibliography_style(style);
        }
    }

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

/// Save the notebox settings and apply their effects (compiler style, Zotero
/// export). An error if no notebox is open.
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

    // Re-resolve the compiler style — the user may have set or cleared a
    // notebox-level custom CSL override.
    {
        let global = state.settings.read().await;
        if let Some(compiler) = session.typst_compiler.lock().await.as_mut() {
            let style = resolve_bibliography_style(&global.citations, &settings.citations);
            compiler.set_bibliography_style(style);
        }
    }

    // For a Zotero citation source (or a changed bib path), refresh the
    // notebox's exported bibliography so file watching and `#bibliography()`
    // calls find it.
    {
        let global = state.settings.read().await;
        crate::state::configure_bibliography(&notebox_root, &global.citations, &settings.citations);
    }

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
