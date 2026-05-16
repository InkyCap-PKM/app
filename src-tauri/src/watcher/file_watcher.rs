use notify::event::{MetadataKind, ModifyKind, RenameMode};
use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use crate::events::{AppEvent, ChangeKind};

/// Directories to ignore when watching for changes.
const IGNORED_DIRS: &[&str] = &[".obsidian", ".inkycap", ".git", "node_modules", ".trash"];

fn should_ignore(path: &Path) -> bool {
    path.components().any(|c| {
        if let std::path::Component::Normal(name) = c {
            let name = name.to_string_lossy();
            IGNORED_DIRS.iter().any(|d| name.as_ref() == *d)
        } else {
            false
        }
    })
}

/// Editor / OS scratch-file patterns that should never bubble up as
/// notebox events. The list is intentionally narrow: anything outside it
/// is forwarded to the frontend so the file tree refreshes. Downstream
/// cache/index sync (see `sync_cache_for_*` in `commands/notebox.rs`)
/// re-filters to the file kinds those subsystems actually care about,
/// so letting an asset rename through here is free in terms of work
/// done — it just makes the tree update.
fn is_editor_scratch_file(path: &Path) -> bool {
    let name = match path.file_name().and_then(|n| n.to_str()) {
        Some(n) => n,
        None => return false,
    };

    // vim swap (.foo.swp), emacs lock (#foo# / .#foo), backup (foo~),
    // LibreOffice (.~lock.foo#), macOS metadata (.DS_Store), generic
    // dotfiles authored by other apps.
    if name == ".DS_Store" {
        return true;
    }
    if name.ends_with('~') {
        return true;
    }
    if name.starts_with(".~lock.") || (name.starts_with('#') && name.ends_with('#')) {
        return true;
    }
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("swp") | Some("swo") | Some("swn") | Some("tmp") | Some("part") | Some("crdownload")
    )
}

fn is_watchable(path: &Path) -> bool {
    !should_ignore(path) && !is_editor_scratch_file(path)
}

/// Upper bound on queued watcher events. The notify callback's `send` will
/// backpressure (block briefly) once the dispatcher falls this far behind,
/// which prevents an out-of-control burst — e.g. `rm -rf` on a huge folder,
/// or a rapid git checkout — from growing the queue without limit and eating
/// arbitrary memory. The bound is generous so that routine saves and file
/// operations never block.
const WATCHER_QUEUE_BOUND: usize = 1024;

/// Start watching a notebox directory for file changes.
/// Returns a channel receiver that emits AppEvents.
pub fn start_watching(
    notebox_root: &Path,
) -> Result<(RecommendedWatcher, mpsc::Receiver<AppEvent>), notify::Error> {
    let (tx, rx) = mpsc::sync_channel::<AppEvent>(WATCHER_QUEUE_BOUND);

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            let Ok(event) = res else { return };

            // Renames/moves come through as `ModifyKind::Name(...)`. The
            // path set depends on the backend: `Both` carries (from, to) as
            // two entries in `event.paths`, while `From`/`To` carry a
            // single path per event. Splitting renames into delete+create
            // pairs is what lets the frontend's file-tree refresh logic
            // pick them up — before this, renames were collapsed to
            // `FileChanged` and the tree stayed stale until restart.
            let send_events: Vec<AppEvent> = match event.kind {
                EventKind::Create(_) => event
                    .paths
                    .iter()
                    .filter(|p| is_watchable(p))
                    .map(|p| AppEvent::FileCreated { path: p.clone() })
                    .collect(),

                EventKind::Remove(_) => event
                    .paths
                    .iter()
                    .filter(|p| is_watchable(p))
                    .map(|p| AppEvent::FileDeleted { path: p.clone() })
                    .collect(),

                EventKind::Modify(ModifyKind::Name(mode)) => match mode {
                    RenameMode::From => event
                        .paths
                        .iter()
                        .filter(|p| is_watchable(p))
                        .map(|p| AppEvent::FileDeleted { path: p.clone() })
                        .collect(),
                    RenameMode::To => event
                        .paths
                        .iter()
                        .filter(|p| is_watchable(p))
                        .map(|p| AppEvent::FileCreated { path: p.clone() })
                        .collect(),
                    RenameMode::Both => {
                        // `Both` arrives with exactly two paths — (from, to)
                        // per notify's docs. When both sides are watchable
                        // we emit a single `FileRenamed` carrying the pair,
                        // so the index layer can rewrite wikilinks in
                        // referencing notes (a split delete+create would
                        // orphan them — there's no way to tell from two
                        // independent events that they belong together).
                        //
                        // Asymmetric cases (one side filtered out, e.g.
                        // renaming a `.typ` to `.txt`) fall back to the
                        // single-sided event so the file tree still
                        // mirrors what's on disk.
                        let mut iter = event.paths.iter();
                        let from = iter.next();
                        let to = iter.next();
                        match (from, to) {
                            (Some(f), Some(t)) if is_watchable(f) && is_watchable(t) => {
                                vec![AppEvent::FileRenamed {
                                    from: f.clone(),
                                    to: t.clone(),
                                }]
                            }
                            (Some(f), Some(t)) => {
                                let mut out: Vec<AppEvent> = Vec::with_capacity(2);
                                if is_watchable(f) {
                                    out.push(AppEvent::FileDeleted { path: f.clone() });
                                }
                                if is_watchable(t) {
                                    out.push(AppEvent::FileCreated { path: t.clone() });
                                }
                                out
                            }
                            (Some(f), None) if is_watchable(f) => {
                                vec![AppEvent::FileDeleted { path: f.clone() }]
                            }
                            _ => Vec::new(),
                        }
                    }
                    // `Any`/`Other` — backend can't tell us which side
                    // this path refers to. Treating it as a structural
                    // change is the safe default: emit both a delete and
                    // a create so the tree refreshes either way. The
                    // frontend debounces refreshes so the duplication
                    // doesn't cause extra work.
                    RenameMode::Any | RenameMode::Other => event
                        .paths
                        .iter()
                        .filter(|p| is_watchable(p))
                        .flat_map(|p| {
                            [
                                AppEvent::FileDeleted { path: p.clone() },
                                AppEvent::FileCreated { path: p.clone() },
                            ]
                        })
                        .collect(),
                },

                EventKind::Modify(ModifyKind::Data(_)) => event
                    .paths
                    .iter()
                    .filter(|p| is_watchable(p))
                    .map(|p| AppEvent::FileChanged {
                        path: p.clone(),
                        change: ChangeKind::Content,
                    })
                    .collect(),

                EventKind::Modify(ModifyKind::Metadata(meta)) => {
                    // Access-time changes are noise — the OS updates
                    // atime on every read, and we don't care. Everything
                    // else (perms, ownership, write time, xattr) is
                    // reported as a metadata change.
                    if matches!(meta, MetadataKind::AccessTime) {
                        Vec::new()
                    } else {
                        event
                            .paths
                            .iter()
                            .filter(|p| is_watchable(p))
                            .map(|p| AppEvent::FileChanged {
                                path: p.clone(),
                                change: ChangeKind::Metadata,
                            })
                            .collect()
                    }
                }

                // `Modify::Any` / `Modify::Other` — unknown modification.
                // Treat as content change so at least the file re-parses.
                EventKind::Modify(_) => event
                    .paths
                    .iter()
                    .filter(|p| is_watchable(p))
                    .map(|p| AppEvent::FileChanged {
                        path: p.clone(),
                        change: ChangeKind::Content,
                    })
                    .collect(),

                _ => Vec::new(),
            };

            for evt in send_events {
                let _ = tx.send(evt);
            }
        },
        Config::default().with_poll_interval(Duration::from_millis(500)),
    )?;

    watcher.watch(notebox_root, RecursiveMode::Recursive)?;

    Ok((watcher, rx))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn assets_are_watchable() {
        // Regression: PNG / image renames in the attachment folder must
        // reach the frontend so the file tree refreshes. The previous
        // `.typ`-only whitelist silently dropped them.
        assert!(is_watchable(&PathBuf::from("/notebox/assets/photo.png")));
        assert!(is_watchable(&PathBuf::from("/notebox/assets/scan.jpg")));
        assert!(is_watchable(&PathBuf::from("/notebox/attachments/file.pdf")));
    }

    #[test]
    fn notes_and_collections_still_watchable() {
        assert!(is_watchable(&PathBuf::from("/notebox/note.typ")));
        assert!(is_watchable(&PathBuf::from("/notebox/Daily.collection")));
    }

    #[test]
    fn ignored_dirs_still_skipped() {
        assert!(!is_watchable(&PathBuf::from("/notebox/.git/HEAD")));
        assert!(!is_watchable(&PathBuf::from("/notebox/.inkycap/notebox.typ")));
        assert!(!is_watchable(&PathBuf::from("/notebox/.obsidian/config.json")));
    }

    #[test]
    fn editor_scratch_files_filtered() {
        assert!(!is_watchable(&PathBuf::from("/notebox/.note.typ.swp")));
        assert!(!is_watchable(&PathBuf::from("/notebox/note.typ~")));
        assert!(!is_watchable(&PathBuf::from("/notebox/#note.typ#")));
        assert!(!is_watchable(&PathBuf::from("/notebox/.~lock.doc.odt#")));
        assert!(!is_watchable(&PathBuf::from("/notebox/.DS_Store")));
        assert!(!is_watchable(&PathBuf::from("/notebox/photo.png.part")));
    }
}
