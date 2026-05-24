//! Staging-folder lifecycle for incoming changes (`.inkycap/incoming/`).
//!
//! A fetch never touches the working tree. Instead, each changed note is
//! written here as a *staged copy* — my source with theirs' changes overlaid
//! as `#suggestion` markup (see [`super::suggest`]). The user opens the staged
//! copy like any tab, resolves the suggestions inline, and consolidating (Phase
//! 3) writes the resolved result back to the working path.
//!
//! Staged copies mirror each note's notebox-relative path under `incoming/`
//! (`research/methods.typ` → `.inkycap/incoming/research/methods.typ`) so the
//! mapping back to the working note is unambiguous. The folder is gitignored
//! (so staged copies never enter the repo) and lives under `.inkycap/`, which
//! the file watcher already ignores — so writing staged copies raises no
//! file-tree churn. It is cleared at the start of each fetch: it is a scratch
//! view of one review session, never a durable store.

use std::path::{Path, PathBuf};

use crate::errors::Result;

/// The staging directory for a notebox.
pub fn incoming_dir(notebox_root: &Path) -> PathBuf {
    notebox_root.join(".inkycap").join("incoming")
}

/// Absolute path a note's staged copy occupies, mirroring its relative path.
pub fn staged_path(notebox_root: &Path, note_rel: &Path) -> PathBuf {
    incoming_dir(notebox_root).join(note_rel)
}

/// Remove the whole staging folder. Idempotent — a missing folder is success,
/// since the post-condition ("no stale staged copies") already holds. Called
/// at the start of a fetch so a review session never mixes with the last one.
pub fn clear(notebox_root: &Path) -> Result<()> {
    let dir = incoming_dir(notebox_root);
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Write a staged copy for `note_rel`, creating mirrored parent dirs as needed.
/// Returns the staged copy's absolute path.
pub fn write_staged(notebox_root: &Path, note_rel: &Path, source: &str) -> Result<PathBuf> {
    let path = staged_path(notebox_root, note_rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, source)?;
    Ok(path)
}

/// Read a staged copy back (on consolidate). `None` when it does not exist.
pub fn read_staged(notebox_root: &Path, note_rel: &Path) -> Result<Option<String>> {
    let path = staged_path(notebox_root, note_rel);
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Remove one note's staged copy after it has been consolidated. Idempotent.
pub fn remove_staged(notebox_root: &Path, note_rel: &Path) -> Result<()> {
    match std::fs::remove_file(staged_path(notebox_root, note_rel)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Notebox-relative paths of every staged copy currently present, so
/// "consolidate all" can promote them in one pass. Empty when nothing is
/// staged.
pub fn list_staged(notebox_root: &Path) -> Vec<PathBuf> {
    let dir = incoming_dir(notebox_root);
    walkdir::WalkDir::new(&dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            e.path()
                .strip_prefix(&dir)
                .ok()
                .map(|rel| rel.to_path_buf())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staged_path_mirrors_relative_path() {
        let root = Path::new("/nb");
        assert_eq!(
            staged_path(root, Path::new("research/methods.typ")),
            Path::new("/nb/.inkycap/incoming/research/methods.typ")
        );
    }

    #[test]
    fn write_then_read_round_trips_through_subdirs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let rel = Path::new("a/b/note.typ");
        let path = write_staged(root, rel, "= staged\n").unwrap();
        assert!(path.exists());
        assert_eq!(read_staged(root, rel).unwrap().as_deref(), Some("= staged\n"));
    }

    #[test]
    fn list_staged_returns_relative_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_staged(root, Path::new("a/b.typ"), "x").unwrap();
        write_staged(root, Path::new("c.typ"), "y").unwrap();
        let mut listed = list_staged(root);
        listed.sort();
        assert_eq!(listed, vec![PathBuf::from("a/b.typ"), PathBuf::from("c.typ")]);
    }

    #[test]
    fn remove_staged_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_staged(root, Path::new("n.typ"), "x").unwrap();
        remove_staged(root, Path::new("n.typ")).unwrap();
        assert!(read_staged(root, Path::new("n.typ")).unwrap().is_none());
        remove_staged(root, Path::new("n.typ")).unwrap(); // again, no error
    }

    #[test]
    fn clear_is_idempotent_and_removes_copies() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // Clearing an absent folder is fine.
        clear(root).unwrap();
        write_staged(root, Path::new("n.typ"), "x").unwrap();
        assert!(incoming_dir(root).exists());
        clear(root).unwrap();
        assert!(!incoming_dir(root).exists());
        assert!(read_staged(root, Path::new("n.typ")).unwrap().is_none());
    }
}
