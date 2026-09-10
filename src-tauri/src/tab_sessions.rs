// Remembers which tabs were open in each notebox, so the "Open previous tabs"
// startup behaviour can put them back the way a web browser restores its tabs.
//
// This state is per-*machine* and deliberately lives **outside** every notebox,
// in `$CONFIG_DIR/inkycap/tab-sessions.json`, keyed by canonical notebox path.
// Two reasons:
//
//   - It describes how one person left one computer, not anything about the
//     notebox itself, so it must never travel through git collaboration, a
//     notebox zip, or a folder copied to another machine. (`.inkycap/local.json`
//     is gitignored but still sits inside the notebox folder, so it would
//     travel with a copy — hence the config dir instead.)
//   - Which files someone had open is private. Keeping it in the user's own
//     config dir keeps it out of anything they might share.
//
// Recorded paths are stored notebox-relative so a notebox that is moved or
// renamed still restores; they are handed to the frontend as absolute paths
// (the shape the rest of the app compares against). Nothing is recorded unless
// the user has actually chosen the "previous tabs" startup behaviour.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::errors::Result;
use crate::storage::{to_frontend_string, validate_notebox_path};

/// Most tabs we will remember for one notebox. A generous ceiling that still
/// bounds the file if someone leaves hundreds of tabs open.
const MAX_TABS: usize = 200;

/// One remembered tab. Mirrors the subset of the frontend `Tab` that is worth
/// restoring: what it shows, and how the user was viewing it. Transient tabs
/// (empty tabs, version-diff compare views) are never recorded.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SessionTab {
    /// Frontend tab type: "file", "collection", or "mycelial".
    pub kind: String,
    /// Tab label as it was shown in the tab strip.
    pub title: String,
    /// Notebox-relative on disk; absolute (frontend string form) when it
    /// crosses IPC. See [`to_relative`] / [`to_absolute`].
    pub path: String,
    /// Per-tab editor mode override: "source", "live", or "reading".
    pub editing_mode: Option<String>,
    /// Per-tab reading-view render format: "svg" or "html".
    pub reading_format: Option<String>,
    /// Per-tab reading-view zoom, where 1.0 = 100%.
    pub reading_zoom: Option<f64>,
    /// True for the tab that was in the foreground.
    pub active: bool,
}

/// The tabs one notebox was left with.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct NoteboxTabSession {
    pub tabs: Vec<SessionTab>,
}

/// The whole per-machine store: one entry per notebox, keyed by the notebox's
/// canonical path in frontend string form.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct TabSessionStore {
    noteboxes: HashMap<String, NoteboxTabSession>,
}

/// Serializes read-modify-write cycles on the shared file. Several windows can
/// each be recording their own notebox's tabs at the same time, and they all
/// write this one file.
static FILE_LOCK: Mutex<()> = Mutex::new(());

fn store_path() -> PathBuf {
    crate::app_paths::config_dir().join("tab-sessions.json")
}

fn key_for(canonical_root: &Path) -> String {
    to_frontend_string(canonical_root)
}

fn read_store() -> TabSessionStore {
    std::fs::read_to_string(store_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_store(store: &TabSessionStore) -> Result<()> {
    let path = store_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(store)?)?;
    Ok(())
}

/// Make a recorded path relative to the notebox root, so the record survives
/// the notebox being moved or renamed. A path outside the notebox, or one
/// that climbs out of it with `..`, is rejected by returning `None` so it is
/// dropped rather than persisted.
///
/// Resolution goes through [`validate_notebox_path`] rather than a bare
/// `std::fs::canonicalize`: the notebox root is held without the Windows
/// `\\?\` verbatim prefix, and only that helper resolves the tab's path to the
/// same shape, so the prefix strip below works on every platform.
fn to_relative(canonical_root: &Path, path: &str) -> Option<String> {
    if path.is_empty() {
        return Some(String::new());
    }
    validate_notebox_path(canonical_root, Path::new(path))
        .ok()?
        .strip_prefix(canonical_root)
        .ok()
        .map(to_frontend_string)
}

/// Expand a stored relative path back to the absolute, frontend-shaped path the
/// rest of the app compares against.
fn to_absolute(canonical_root: &Path, relative: &str) -> String {
    to_frontend_string(&canonical_root.join(relative))
}

/// The tabs recorded for this notebox, with paths expanded to absolute form and
/// entries whose file has since disappeared dropped. Returns an empty session
/// when nothing was recorded.
pub fn load(canonical_root: &Path) -> NoteboxTabSession {
    let stored = {
        let _guard = FILE_LOCK.lock();
        read_store()
            .noteboxes
            .remove(&key_for(canonical_root))
            .unwrap_or_default()
    };
    expand(canonical_root, stored)
}

/// Turn a stored session into one the frontend can act on: drop tabs whose file
/// has since been deleted, and expand the remaining paths to absolute form.
fn expand(canonical_root: &Path, mut session: NoteboxTabSession) -> NoteboxTabSession {
    session.tabs.retain(|tab| {
        // A mycelial (graph) tab can be notebox-wide, with no file behind it.
        tab.kind == "mycelial" || canonical_root.join(&tab.path).exists()
    });
    for tab in &mut session.tabs {
        tab.path = to_absolute(canonical_root, &tab.path);
    }
    session
}

/// Record the tabs currently open in this notebox, replacing any previous
/// record for it. Paths outside the notebox are dropped.
pub fn save(canonical_root: &Path, session: &NoteboxTabSession) -> Result<()> {
    let tabs: Vec<SessionTab> = session
        .tabs
        .iter()
        .take(MAX_TABS)
        .filter_map(|tab| {
            to_relative(canonical_root, &tab.path).map(|path| SessionTab {
                path,
                ..tab.clone()
            })
        })
        .collect();

    let _guard = FILE_LOCK.lock();
    let mut store = read_store();
    store
        .noteboxes
        .insert(key_for(canonical_root), NoteboxTabSession { tabs });
    prune_missing_noteboxes(&mut store);
    write_store(&store)
}

/// Forget every notebox's tabs — used when the user turns the startup
/// behaviour off, so no record lingers after they stop asking for it. The
/// behaviour is a user-wide setting, so the whole store goes, not just the
/// notebox that happens to be open.
pub fn clear_all() -> Result<()> {
    let _guard = FILE_LOCK.lock();
    match std::fs::remove_file(store_path()) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Drop entries for noteboxes that no longer exist on disk, the same
/// housekeeping the notebox registry does when it loads.
fn prune_missing_noteboxes(store: &mut TabSessionStore) {
    store.noteboxes.retain(|path, _| Path::new(path).is_dir());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(path: &str) -> SessionTab {
        SessionTab {
            kind: "file".to_string(),
            title: "Note".to_string(),
            path: path.to_string(),
            active: false,
            ..Default::default()
        }
    }

    #[test]
    fn absolute_paths_are_stored_relative_to_the_notebox() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::storage::canonicalize_root(dir.path()).unwrap();
        std::fs::write(root.join("note.typ"), "= Hi").unwrap();

        let abs = to_frontend_string(&root.join("note.typ"));
        let rel = to_relative(&root, &abs).unwrap();

        assert_eq!(rel, "note.typ", "path should be stored notebox-relative");
        assert_eq!(to_absolute(&root, &rel), abs);
    }

    #[test]
    fn paths_outside_the_notebox_are_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::storage::canonicalize_root(dir.path()).unwrap();
        let outside = std::fs::canonicalize(std::env::temp_dir()).unwrap();

        assert!(to_relative(&root, &to_frontend_string(&outside)).is_none());
    }

    #[test]
    fn a_relative_path_that_climbs_out_of_the_notebox_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::storage::canonicalize_root(dir.path()).unwrap();

        assert!(to_relative(&root, "../elsewhere.typ").is_none());
        assert_eq!(
            to_relative(&root, "inside.typ").as_deref(),
            Some("inside.typ")
        );
    }

    #[test]
    fn a_missing_file_is_not_restored() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::storage::canonicalize_root(dir.path()).unwrap();
        std::fs::write(root.join("kept.typ"), "= Hi").unwrap();

        let session = expand(
            &root,
            NoteboxTabSession {
                tabs: vec![tab("kept.typ"), tab("deleted.typ")],
            },
        );

        assert_eq!(session.tabs.len(), 1, "the deleted note should be dropped");
        assert_eq!(
            session.tabs[0].path,
            to_frontend_string(&root.join("kept.typ"))
        );
    }

    #[test]
    fn a_notebox_wide_graph_tab_survives_without_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::storage::canonicalize_root(dir.path()).unwrap();

        let graph = SessionTab {
            kind: "mycelial".to_string(),
            title: "Mycelial View".to_string(),
            ..Default::default()
        };
        let session = expand(&root, NoteboxTabSession { tabs: vec![graph] });

        assert_eq!(session.tabs.len(), 1);
    }
}
