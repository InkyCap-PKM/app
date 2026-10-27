//! Saved backup state, kept apart from settings.json because it changes on
//! every backup, which would conflict with the user editing settings while a
//! backup finishes.
//!
//! Stored in `$CONFIG_DIR/inkycap/backup_state.json`; `#[serde(default)]` lets
//! older files load.
//!
//! State is per notebox: the "Last backup" line, the scheduler's next run and
//! the only-on-change check each use the record of the notebox they act on. The
//! file is a map keyed by the notebox's frontend-canonical root path;
//! `load`/`save` read and write that notebox's entry.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::errors::Result;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BackupState {
    /// Unix time in seconds of the last successful backup; `0` means never.
    /// Used for the next scheduled run and the only-on-change check (compared
    /// with the newest mtime in the notebox).
    pub last_success_unix: i64,
    /// The most recent archive's path, in frontend-canonical form, for the
    /// "Last backup" line and as the restore browser's starting point.
    pub last_archive_path: Option<String>,
    /// Summary of the last run, `"Success"` or the error message, shown as is
    /// in the UI.
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

/// Key for a notebox: the frontend-canonical path (no `\\?\` prefix, forward
/// slashes), so every route to the same root gives the same key.
pub fn notebox_key(notebox_root: &Path) -> String {
    crate::storage::path::to_frontend_string(notebox_root)
}

fn load_file() -> BackupStateFile {
    let path = state_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return BackupStateFile::default(),
    };
    // A file in an older, flat format doesn't parse as a map and loads as
    // empty; the next backup records state again.
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
