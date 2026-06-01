//! Declarative-plugin discovery for the Tier-1 manifest system.
//!
//! A declarative plugin is a single JSON manifest that contributes *data* — not
//! code — to InkyCap's registries: extra `/`-palette commands/snippets and
//! saved query-view sidebar panes. The host (frontend) owns the schema and the
//! registration; this command's only job is to surface the raw manifest files
//! so the frontend can validate and apply them.
//!
//! Manifests are read from two locations (user-global first, then per-notebox,
//! so a notebox can ship its own):
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

/// Read every `*.json` directly inside `dir` (non-recursive) into `out`. Missing
/// directories and unreadable files are skipped quietly — a plugins folder is
/// optional, and one bad file shouldn't sink the rest.
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
