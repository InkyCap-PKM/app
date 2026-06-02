//! Cleanup for the legacy version-view scratch folder (`.inkycap/history/`).
//!
//! Earlier builds opened a past version of a note by writing it to a disposable
//! scratch file here and opening that as a tab. Version viewing is now a
//! read-only inline diff (see [`crate::commands::git::git_note_version_text`]
//! and the frontend `VersionDiffView`), so nothing is written here anymore —
//! but [`clear`] still runs on notebox open to sweep any scratch files left by
//! an older build. The folder is gitignored and watcher-ignored.

use std::path::{Path, PathBuf};

use crate::errors::Result;

/// The (legacy) version-view scratch directory for a notebox.
pub fn history_dir(notebox_root: &Path) -> PathBuf {
    notebox_root.join(".inkycap").join("history")
}

/// Remove the whole version-view scratch folder. Idempotent — a missing folder
/// is success. Called on notebox open so any legacy scratch files don't linger.
pub fn clear(notebox_root: &Path) -> Result<()> {
    match std::fs::remove_dir_all(history_dir(notebox_root)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_removes_the_folder_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(history_dir(root).join("abc1234")).unwrap();
        std::fs::write(history_dir(root).join("abc1234/note.typ"), "x").unwrap();
        assert!(history_dir(root).exists());
        clear(root).unwrap();
        assert!(!history_dir(root).exists());
        clear(root).unwrap(); // idempotent
    }
}
