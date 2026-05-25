//! Scratch-file lifecycle for read-only version views (`.inkycap/history/`).
//!
//! Viewing a past version of a note (Phase 6) opens it as an ordinary editor
//! tab, and tabs are path-backed — so the version's content is written to a
//! disposable scratch file under `.inkycap/history/<short-hash>/<note-path>`
//! and that path is opened. The hash segment keeps each version distinct and
//! makes the path *stable* per (note, version): re-viewing the same version
//! reuses the same file (and so the same tab) instead of piling up copies.
//!
//! The folder is gitignored (scratch never enters the repo) and lives under
//! `.inkycap/`, which the file watcher already ignores — so writing a view
//! raises no file-tree churn. It is cleared on notebox open: a view is a
//! transient lens on history, never a durable store.

use std::path::{Path, PathBuf};

use crate::errors::Result;

/// The version-view scratch directory for a notebox.
pub fn history_dir(notebox_root: &Path) -> PathBuf {
    notebox_root.join(".inkycap").join("history")
}

/// Absolute path a note's version-view occupies, namespaced by the version's
/// short hash so distinct versions never collide and the same version reuses
/// its file.
pub fn view_path(notebox_root: &Path, short_hash: &str, note_rel: &Path) -> PathBuf {
    history_dir(notebox_root).join(short_hash).join(note_rel)
}

/// Write a version's content to its scratch view, creating parent dirs.
/// Returns the scratch file's absolute path (to open as a tab).
pub fn write_view(
    notebox_root: &Path,
    short_hash: &str,
    note_rel: &Path,
    content: &str,
) -> Result<PathBuf> {
    let path = view_path(notebox_root, short_hash, note_rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, content)?;
    Ok(path)
}

/// Remove the whole version-view scratch folder. Idempotent — a missing folder
/// is success. Called on notebox open so views never accumulate across sessions.
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
    fn view_path_namespaces_by_hash_and_mirrors_note_path() {
        let root = Path::new("/nb");
        assert_eq!(
            view_path(root, "a1b2c3d", Path::new("research/methods.typ")),
            Path::new("/nb/.inkycap/history/a1b2c3d/research/methods.typ")
        );
    }

    #[test]
    fn write_then_clear_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let p = write_view(root, "abc1234", Path::new("a/note.typ"), "= old\n").unwrap();
        assert!(p.exists());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "= old\n");
        clear(root).unwrap();
        assert!(!history_dir(root).exists());
        clear(root).unwrap(); // idempotent
    }
}
