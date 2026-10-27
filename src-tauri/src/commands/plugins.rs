//! Finding declarative plugins.
//!
//! A declarative plugin is one JSON manifest adding data, not code, to
//! InkyCap's registries: extra `/` palette commands or snippets, and saved
//! query views as sidebar panes. The frontend defines the format and registers
//! them; this command only returns the manifest files for it to check and
//! apply.
//!
//! Manifests are read from two places (the user's first, then the notebox's, so
//! a notebox can include its own):
//!
//!   * `$CONFIG_DIR/inkycap/plugins/*.json`
//!   * `<notebox>/.inkycap/plugins/*.json`
//!
//! See `documentation/developer/extending/declarative-plugins.md`.

use serde::Serialize;
use std::path::Path;
use tauri::State;

use crate::errors::Result;
use crate::state::AppState;

/// One discovered manifest file: its (frontend-canonical) path and raw JSON.
#[derive(Debug, Clone, Serialize)]
pub struct PluginManifestFile {
    pub path: String,
    pub contents: String,
}

/// Read every `*.json` directly in `dir` (not subfolders) into `out`. A missing
/// folder or unreadable file is skipped; the folder is optional, and one bad
/// file shouldn't stop the rest.
fn read_manifest_dir(dir: &Path, out: &mut Vec<PluginManifestFile>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match std::fs::read_to_string(&path) {
            Ok(contents) => out.push(PluginManifestFile {
                path: crate::storage::to_frontend_string(&path),
                contents,
            }),
            Err(err) => log::warn!("plugin manifest: failed to read {}: {err}", path.display()),
        }
    }
}

/// Discover declarative-plugin manifests. Returns raw files for the frontend to
/// validate and register; the backend deliberately does not interpret them.
#[tauri::command]
pub async fn read_plugin_manifests(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<PluginManifestFile>> {
    let session = state.session(window.label()).await;
    let mut out = Vec::new();
    read_manifest_dir(&crate::app_paths::config_dir().join("plugins"), &mut out);
    if let Some(root) = session.notebox_root.read().await.as_ref() {
        read_manifest_dir(&root.join(".inkycap").join("plugins"), &mut out);
    }
    Ok(out)
}
