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
//
// A tab whose file freezes or crashes the app would otherwise be reopened at
// every start, with the setting that stops it out of reach. So a reopen has to
// prove it worked: `start_restore` marks the notebox's record as "reopen in
// progress", and the frontend clears the mark once the window has stayed
// responsive for a while. A mark still set at the next start means the last
// reopen never got that far, and the tabs are held back for the user to reopen
// by hand. Starting with `--no-restore` holds them back too.

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
    /// Frontend tab type: "file", "collection", "mycelial", or "attachment".
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
    /// Set while a reopen of these tabs has not yet proved it worked (see the
    /// module comment). Kept by the backend: [`save`] ignores whatever the
    /// frontend sends here.
    pub restore_pending: bool,
}

/// Why the recorded tabs were held back instead of reopened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HeldBack {
    /// The last reopen of these tabs never finished: the app froze, crashed,
    /// or was closed within moments of starting.
    Interrupted,
    /// InkyCap was started with [`NO_RESTORE_ARG`].
    NoRestore,
}

/// What to do with the recorded tabs when a notebox opens: reopen `tabs`, or,
/// when `held_back` says why, offer them to the user instead.
#[derive(Debug, Clone, Serialize)]
pub struct TabRestore {
    pub tabs: Vec<SessionTab>,
    pub held_back: Option<HeldBack>,
}

/// Command-line option that starts InkyCap without reopening any tabs, the way
/// out when a reopened tab makes the app unusable.
pub const NO_RESTORE_ARG: &str = "--no-restore";

/// Whether this run of InkyCap was started with [`NO_RESTORE_ARG`].
pub fn launched_with_no_restore() -> bool {
    std::env::args().skip(1).any(|a| a == NO_RESTORE_ARG)
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

/// Decide whether the tabs recorded for this notebox are reopened or held back
/// (see the module comment), and mark a reopen as in progress. Paths come back
/// absolute, and tabs whose file has since been deleted are dropped. Empty when
/// nothing was recorded.
pub fn start_restore(canonical_root: &Path, no_restore: bool) -> Result<TabRestore> {
    let _guard = FILE_LOCK.lock();
    let mut store = read_store();
    let restore = decide_restore(&mut store, canonical_root, no_restore);
    write_store(&store)?;
    Ok(restore)
}

fn decide_restore(
    store: &mut TabSessionStore,
    canonical_root: &Path,
    no_restore: bool,
) -> TabRestore {
    let Some(entry) = store.noteboxes.get_mut(&key_for(canonical_root)) else {
        return TabRestore {
            tabs: Vec::new(),
            held_back: None,
        };
    };
    let held_back = if no_restore {
        Some(HeldBack::NoRestore)
    } else if entry.restore_pending {
        Some(HeldBack::Interrupted)
    } else {
        None
    };
    let tabs = expand(canonical_root, entry.clone()).tabs;
    entry.restore_pending = held_back.is_none() && !tabs.is_empty();
    TabRestore { tabs, held_back }
}

/// Mark or clear "reopen in progress" for the notebox at `canonical_root`. The
/// frontend sets it before reopening held-back tabs by hand and clears it once
/// the window has stayed responsive. Does nothing for a notebox with no record.
pub fn set_restore_pending(canonical_root: &Path, pending: bool) -> Result<()> {
    let _guard = FILE_LOCK.lock();
    let mut store = read_store();
    match store.noteboxes.get_mut(&key_for(canonical_root)) {
        Some(entry) if entry.restore_pending != pending => {
            entry.restore_pending = pending;
            write_store(&store)
        }
        _ => Ok(()),
    }
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
    let key = key_for(canonical_root);
    // Recording happens all through a reopen, so the mark must survive it.
    let restore_pending = store.noteboxes.get(&key).is_some_and(|s| s.restore_pending);
    store.noteboxes.insert(
        key,
        NoteboxTabSession {
            tabs,
            restore_pending,
        },
    );
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
                ..Default::default()
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
        let session = expand(
            &root,
            NoteboxTabSession {
                tabs: vec![graph],
                ..Default::default()
            },
        );

        assert_eq!(session.tabs.len(), 1);
    }

    /// A store holding one recorded tab, `note.typ`, for a fresh notebox.
    fn store_with_one_tab() -> (tempfile::TempDir, PathBuf, TabSessionStore) {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::storage::canonicalize_root(dir.path()).unwrap();
        std::fs::write(root.join("note.typ"), "= Hi").unwrap();
        let mut store = TabSessionStore::default();
        store.noteboxes.insert(
            key_for(&root),
            NoteboxTabSession {
                tabs: vec![tab("note.typ")],
                restore_pending: false,
            },
        );
        (dir, root, store)
    }

    fn pending(store: &TabSessionStore, root: &Path) -> bool {
        store.noteboxes[&key_for(root)].restore_pending
    }

    #[test]
    fn a_reopen_is_marked_until_it_proves_it_worked() {
        let (_dir, root, mut store) = store_with_one_tab();

        let restore = decide_restore(&mut store, &root, false);

        assert_eq!(restore.held_back, None);
        assert_eq!(restore.tabs.len(), 1);
        assert!(
            pending(&store, &root),
            "the reopen should be marked in progress"
        );
    }

    #[test]
    fn tabs_are_held_back_after_a_reopen_that_never_finished() {
        let (_dir, root, mut store) = store_with_one_tab();
        decide_restore(&mut store, &root, false);

        // The app froze, so nothing cleared the mark before the next start.
        let restore = decide_restore(&mut store, &root, false);

        assert_eq!(restore.held_back, Some(HeldBack::Interrupted));
        assert_eq!(
            restore.tabs.len(),
            1,
            "the held-back tabs are still offered"
        );
        assert!(!pending(&store, &root), "holding back clears the mark");

        // And the start after that reopens normally again.
        assert_eq!(decide_restore(&mut store, &root, false).held_back, None);
    }

    #[test]
    fn the_no_restore_option_holds_tabs_back() {
        let (_dir, root, mut store) = store_with_one_tab();

        let restore = decide_restore(&mut store, &root, true);

        assert_eq!(restore.held_back, Some(HeldBack::NoRestore));
        assert!(!pending(&store, &root));
    }

    #[test]
    fn nothing_to_reopen_marks_nothing() {
        let (_dir, root, mut store) = store_with_one_tab();
        std::fs::remove_file(root.join("note.typ")).unwrap();

        let restore = decide_restore(&mut store, &root, false);

        assert!(restore.tabs.is_empty());
        assert!(!pending(&store, &root));
    }
}
