//! Persisted backup runtime state — separate from settings.json because
//! these values change every time a backup runs, and conflating churn
//! with preferences makes settings.json prone to write-conflicts when
//! the user is editing settings while a backup completes.
//!
//! Lives at `$CONFIG_DIR/inkycap/backup_state.json`. Schema is forward-
//! tolerant via `#[serde(default)]` so older installs upgrade silently.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::errors::Result;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BackupState {
    /// Unix-epoch seconds of the last successful backup completion. `0`
    /// means "never ran". Used both by the scheduler (next-due
    /// calculation) and the only-on-change guard (compared against the
    /// max-mtime of the notebox tree).
    pub last_success_unix: i64,
    /// Path of the archive produced by the most recent successful run,
    /// in frontend-canonical form. Surfaced in the settings UI's "Last
    /// backup" line and used by the per-file restore browser (later
    /// phase) as a default starting point.
    pub last_archive_path: Option<String>,
    /// Human-readable summary of the most recent run — either
    /// `"Success"` or the error message from the failed attempt. The UI
    /// renders this verbatim; it isn't intended for programmatic
    /// consumption.
    pub last_status: Option<String>,
}

fn state_path() -> PathBuf {
    crate::app_paths::config_dir().join("backup_state.json")
}

pub fn load() -> BackupState {
    let path = state_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return BackupState::default(),
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save(state: &BackupState) -> Result<()> {
    let path = state_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(state)?;
    std::fs::write(&path, json)?;
    Ok(())
}
