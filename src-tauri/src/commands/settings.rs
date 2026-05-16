// IPC commands for reading and writing user settings.

use tauri::State;

use crate::errors::Result;
use crate::scaffolds;
use crate::settings::UserSettings;
use crate::state::AppState;

/// Return the current user settings.
#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<UserSettings> {
    let settings = state.settings.read().await;
    Ok(settings.clone())
}

/// Merge partial updates into the current settings and persist.
/// Accepts a full UserSettings object — the frontend sends the complete
/// updated settings after modifying whichever fields changed.
#[tauri::command]
pub async fn update_settings(
    state: State<'_, AppState>,
    settings: UserSettings,
) -> Result<()> {
    crate::settings::save_settings(&settings)?;

    // Propagate citation settings to the Typst compiler so changes take
    // effect without reopening the notebox.
    if let Some(compiler) = state.typst_compiler.lock().await.as_mut() {
        let style = settings.citations.custom_csl_path.clone()
            .or_else(|| settings.citations.citation_style.as_deref()
                .filter(|s| *s != "custom")
                .map(String::from));
        compiler.set_bibliography_style(style);
    }

    // When the citation source is Zotero, export entries to
    // .inkycap/zotero-export.bib so the file exists on disk for
    // preview compiles and explicit #bibliography() calls.
    if let Some(notebox_root) = state.notebox_root.read().await.as_ref() {
        crate::state::configure_bibliography(notebox_root, &settings.citations);
    }

    *state.settings.write().await = settings;
    Ok(())
}

/// Generate a Zettelkasten ID using the user's configured pattern.
#[tauri::command]
pub async fn generate_zid(state: State<'_, AppState>) -> Result<String> {
    let settings = state.settings.read().await;
    let pattern = &settings.files.zid_pattern;
    Ok(scaffolds::generate_zid(pattern))
}
