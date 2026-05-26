//! Persisted backup runtime state — separate from settings.json because
//! these values change every time a backup runs, and conflating churn
//! with preferences makes settings.json prone to write-conflicts when
//! the user is editing settings while a backup completes.
//!
//! Lives at `$CONFIG_DIR/inkycap/backup_state.json`. Schema is forward-
//! tolerant via `#[serde(default)]` so older installs upgrade silently.
//!
//! State is **per-notebox**: backups run against one notebox at a time, so
//! the "Last backup" line in Settings, the scheduler's next-due calculation,
//! and the only-on-change guard must each read the record for the notebox
//! they act on — never a different notebox's. The on-disk file is therefore
//! a map keyed by the notebox's frontend-canonical root path; `load`/`save`
//! take the notebox root and read/upsert that notebox's entry.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

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
    /// backup" line and used by the per-file restore browser as a
    /// default starting point.
    pub last_archive_path: Option<String>,
    /// Human-readable summary of the most recent run — either
    /// `"Success"` or the error message from the failed attempt. The UI
    /// renders this verbatim; it isn't intended for programmatic
    /// consumption.
    pub last_status: Option<String>,
}

/// On-disk shape: per-notebox records keyed by `notebox_key`. A `BTreeMap`
/// keeps the file stable-ordered (readable diffs, deterministic output).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct BackupStateFile {
    noteboxes: BTreeMap<String, BackupState>,
}

fn state_path() -> PathBuf {
    crate::app_paths::config_dir().join("backup_state.json")
}

/// Stable per-notebox key. Uses the frontend-canonical (verbatim-prefix
/// stripped, forward-slash) form so it matches the same notebox root no
/// matter which code path derived the `Path` — the same normalization the
/// rest of the app keys notebox-scoped data on.
pub fn notebox_key(notebox_root: &Path) -> String {
    crate::storage::path::to_frontend_string(notebox_root)
}

fn load_file() -> BackupStateFile {
    let path = state_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return BackupStateFile::default(),
    };
    // A pre-per-notebox file (flat `BackupState`) won't match this shape and
    // deserializes to an empty map — the affected notebox's first backup
    // simply re-records its state. No migration needed (no shipped users).
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_file(file: &BackupStateFile) -> Result<()> {
    let path = state_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(file)?;
    std::fs::write(&path, json)?;
    Ok(())
}

/// Read the backup record for one notebox. Returns the default ("never
/// ran") record when this notebox has no entry yet.
pub fn load(notebox_root: &Path) -> BackupState {
    let key = notebox_key(notebox_root);
    load_file().noteboxes.get(&key).cloned().unwrap_or_default()
}

/// Upsert the backup record for one notebox, leaving every other notebox's
/// record untouched.
pub fn save(notebox_root: &Path, state: &BackupState) -> Result<()> {
    let key = notebox_key(notebox_root);
    let mut file = load_file();
    file.noteboxes.insert(key, state.clone());
    save_file(&file)
}
