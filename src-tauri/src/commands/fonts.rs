//! Font discovery commands — exposes system font families to the frontend.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use crate::errors::InkyCapError;
use crate::font_resolver::{self, SystemFontDefaults};

static SYSTEM_FONTS: OnceLock<Vec<String>> = OnceLock::new();

fn discover_system_fonts() -> Vec<String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();

    let families: BTreeSet<String> = db
        .faces()
        .filter_map(|face| {
            face.families
                .first()
                .map(|(name, _)| name.clone())
        })
        .collect();

    families.into_iter().collect()
}

/// Return a sorted, deduplicated list of font family names available on
/// the system. The result is cached for the lifetime of the process
/// (system fonts don't change at runtime).
#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<String>, InkyCapError> {
    let fonts = SYSTEM_FONTS.get_or_init(discover_system_fonts);
    Ok(fonts.clone())
}

/// Return the OS's default font families per generic role (sans/serif/mono).
/// Resolved via fontconfig on Linux, hardcoded on macOS/Windows. Used by
/// the frontend font picker to display labels like "System (Cantarell)".
#[tauri::command]
pub async fn system_font_defaults() -> Result<SystemFontDefaults, InkyCapError> {
    Ok(font_resolver::system_defaults().clone())
}
