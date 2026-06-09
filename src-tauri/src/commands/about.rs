//! App "about"/legal commands: surfacing the bundled third-party licence
//! notices to the frontend (Settings → Sources → "Full third-party notices").
//!
//! The notices files are produced by `scripts/gen-third-party-licenses.mjs`,
//! live in `src-tauri/licenses/`, and ship via `bundle.resources` in
//! `tauri.conf.json`. The frontend never reads files directly — it asks for a
//! notices file by a fixed `kind`, which is validated against an allowlist so
//! the parameter can never become an arbitrary path.

use tauri::Manager;

use crate::errors::InkyCapError;

/// Whether this installation can install updates in place.
///
/// Returns `"auto"` on Windows/macOS and on Linux when running as an AppImage
/// (the `APPIMAGE` env var is set by the AppImage runtime). Returns `"manual"`
/// for other Linux installs (`.deb`/`.rpm`/Flatpak/Snap) — those are owned by a
/// package manager, so the UI links to the releases page instead of attempting
/// a self-replacing install.
#[tauri::command]
pub fn update_install_kind() -> String {
    if cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_none() {
        "manual".to_string()
    } else {
        "auto".to_string()
    }
}

/// Return the running app's version string (e.g. `26.6.1`).
///
/// Sourced from the version Tauri was built with (`tauri.conf.json` →
/// `Cargo.toml`), kept in lockstep across manifests by `scripts/version.mjs`.
/// The version is `YY.MM.RELEASE`; the frontend formats/interprets it
/// (Settings → Overview): the last (RELEASE) component is even for user-facing
/// releases and odd for development builds.
#[tauri::command]
pub fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Map a frontend `kind` to its bundled filename. The allowlist is the trust
/// boundary: `kind` is never interpolated into a path beyond these constants.
fn notices_filename(kind: &str) -> Result<&'static str, InkyCapError> {
    match kind {
        "rust" => Ok("THIRD-PARTY-rust.txt"),
        "js" => Ok("THIRD-PARTY-js.txt"),
        other => Err(InkyCapError::InvalidPath(format!(
            "Unknown third-party notices kind: {other}"
        ))),
    }
}

/// Read a bundled third-party licence notices file and return its text.
///
/// In a packaged build the file lives in the app's resource directory; in
/// `tauri dev` resources aren't staged next to the debug binary, so we fall
/// back to the crate's source tree (`CARGO_MANIFEST_DIR`). Either way the file
/// is read-only and chosen from a fixed allowlist.
#[tauri::command]
pub async fn read_third_party_notices(
    kind: String,
    app: tauri::AppHandle,
) -> Result<String, InkyCapError> {
    let rel = format!("licenses/{}", notices_filename(&kind)?);

    // Packaged build: resolve against the bundled resource directory.
    if let Ok(path) = app
        .path()
        .resolve(&rel, tauri::path::BaseDirectory::Resource)
    {
        if path.is_file() {
            return Ok(std::fs::read_to_string(&path)?);
        }
    }

    // Dev fallback: read straight from the source tree.
    let dev_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(&rel);
    if dev_path.is_file() {
        return Ok(std::fs::read_to_string(&dev_path)?);
    }

    Err(InkyCapError::InvalidPath(format!(
        "Third-party notices file not found: {rel}"
    )))
}
