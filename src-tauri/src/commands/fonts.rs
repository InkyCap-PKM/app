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
        .filter_map(|face| face.families.first().map(|(name, _)| name.clone()))
        .collect();

    families.into_iter().collect()
}

/// Sorted, deduplicated font family names available on the system, cached for
/// the session.
#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<String>, InkyCapError> {
    let fonts = SYSTEM_FONTS.get_or_init(discover_system_fonts);
    Ok(fonts.clone())
}

/// The OS default font families per role (sans, serif, mono): fontconfig on
/// Linux, fixed on macOS and Windows. For font picker labels like "System
/// (Cantarell)".
#[tauri::command]
pub async fn system_font_defaults() -> Result<SystemFontDefaults, InkyCapError> {
    Ok(font_resolver::system_defaults().clone())
}
