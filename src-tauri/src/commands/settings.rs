// IPC commands for reading and writing settings.
//
// Settings come in two flavors: user-global (`UserSettings`, persisted at
// `$CONFIG_DIR/inkycap/settings.json`) and per-notebox (`NoteboxSettings`,
// persisted at `<notebox>/.inkycap/settings.json`). Each has its own pair
// of read/write commands so the frontend can route a field-update to the
// right backing store.

use tauri::State;

use crate::errors::{InkyCapError, Result};
use crate::notebox_settings::NoteboxSettings;
use crate::scaffolds;
use crate::settings::UserSettings;
use crate::state::AppState;

/// Resolve the effective bibliography style by overlaying the per-notebox
/// custom CSL path on top of the user-global named style. The notebox's
/// override (if any) wins; otherwise the user-global style is used, unless
/// it's the sentinel value "custom" without a path (no style set).
fn resolve_bibliography_style(
    global: &crate::settings::CitationSettings,
    notebox: &crate::notebox_settings::NoteboxCitationSettings,
) -> Option<String> {
    notebox
        .custom_csl_path
        .clone()
        .or_else(|| {
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

/// Merge partial updates into the user-global settings and persist.
/// Accepts a full UserSettings object — the frontend sends the complete
/// updated settings after modifying whichever fields changed.
#[tauri::command]
pub async fn update_settings(
    state: State<'_, AppState>,
    settings: UserSettings,
) -> Result<()> {
    crate::settings::save_settings(&settings)?;

    // Propagate the citation-style change to the Typst compiler so a global
    // style swap takes effect without reopening the notebox. The current
    // notebox's `custom_csl_path` still wins if set.
    {
        let notebox = state.notebox_settings.read().await;
        if let Some(compiler) = state.typst_compiler.lock().await.as_mut() {
            let style = resolve_bibliography_style(&settings.citations, &notebox.citations);
            compiler.set_bibliography_style(style);
        }
    }

    *state.settings.write().await = settings;
    Ok(())
}

/// Return the current notebox's settings. Returns defaults if no notebox
/// is open — the frontend should not act on those values until a notebox
/// is loaded.
#[tauri::command]
pub async fn get_notebox_settings(state: State<'_, AppState>) -> Result<NoteboxSettings> {
    let settings = state.notebox_settings.read().await;
    Ok(settings.clone())
}

/// Persist the per-notebox settings and reapply downstream effects
/// (compiler style, Zotero export). Errors out if no notebox is open —
/// there's no destination to write to.
#[tauri::command]
pub async fn update_notebox_settings(
    state: State<'_, AppState>,
    settings: NoteboxSettings,
) -> Result<()> {
    let notebox_root = state
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
        if let Some(compiler) = state.typst_compiler.lock().await.as_mut() {
            let style = resolve_bibliography_style(&global.citations, &settings.citations);
            compiler.set_bibliography_style(style);
        }
    }

    // When the citation source is Zotero (or the bib path changed), refresh
    // the notebox-local export/bibliography pointer so file-watching and
    // explicit #bibliography() calls resolve.
    {
        let global = state.settings.read().await;
        crate::state::configure_bibliography(&notebox_root, &global.citations, &settings.citations);
    }

    *state.notebox_settings.write().await = settings;
    Ok(())
}

/// Generate a Zettelkasten ID using the user's configured pattern.
#[tauri::command]
pub async fn generate_zid(state: State<'_, AppState>) -> Result<String> {
    let settings = state.settings.read().await;
    let pattern = &settings.files.zid_pattern;
    Ok(scaffolds::generate_zid(pattern))
}
