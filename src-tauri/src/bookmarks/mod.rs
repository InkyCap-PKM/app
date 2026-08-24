// Bookmarks: user-managed list of quick-access items.
// Persisted at $CONFIG_DIR/inkycap/bookmarks.json.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::errors::Result;

/// A single bookmark entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bookmark {
    /// Unique identifier.
    pub id: String,
    /// The bookmark type and its associated data.
    #[serde(flatten)]
    pub kind: BookmarkKind,
}

impl BookmarkKind {
    /// The stored notebox path for path-bearing kinds (`Note`, `Heading`,
    /// `Collection`), or `None` for kinds that carry no path (`Search`,
    /// `AgendaView`). Returned mutably so a rename/move can rebase it in place.
    fn path_mut(&mut self) -> Option<&mut String> {
        match self {
            BookmarkKind::Note { path, .. }
            | BookmarkKind::Heading { path, .. }
            | BookmarkKind::Collection { path, .. } => Some(path),
            BookmarkKind::Search { .. } | BookmarkKind::AgendaView { .. } => None,
        }
    }

    /// A stable identity used to keep bookmarks unique: two kinds with the
    /// same key point at the same target, so only one should ever be stored.
    /// Display-only fields (e.g. a note's `name`) are excluded — re-bookmarking
    /// the same file is the same bookmark even if the label differs. `\u{1}`
    /// separates fields so distinct values can't run together into one key.
    fn dedupe_key(&self) -> String {
        match self {
            BookmarkKind::Note { path, .. } => format!("note\u{1}{path}"),
            BookmarkKind::Collection { path, .. } => format!("collection\u{1}{path}"),
            BookmarkKind::Heading { path, heading, .. } => {
                format!("heading\u{1}{path}\u{1}{heading}")
            }
            BookmarkKind::Search { query } => format!("search\u{1}{query}"),
            BookmarkKind::AgendaView {
                name,
                notebox,
                filter,
            } => format!("agenda\u{1}{notebox}\u{1}{name}\u{1}{filter}"),
        }
    }
}

/// The different kinds of bookmarks.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum BookmarkKind {
    /// A bookmarked note file.
    Note { path: String, name: String },
    /// A saved search query.
    Search { query: String },
    /// A specific heading within a note.
    Heading {
        path: String,
        name: String,
        heading: String,
    },
    /// A bookmarked collection (.collection file).
    Collection { path: String, name: String },
    /// A saved Agenda view: a named filter snapshot, scoped to the notebox it
    /// was created in. `filter` is a JSON-serialized `AgendaFilterSnapshot`
    /// (opaque to the backend — the frontend owns its shape).
    AgendaView {
        name: String,
        notebox: String,
        filter: String,
    },
}

/// Load bookmarks from the config file. Returns empty vec if file doesn't exist.
pub fn load_bookmarks() -> Result<Vec<Bookmark>> {
    let path = bookmarks_path();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = std::fs::read_to_string(&path)?;
    let bookmarks: Vec<Bookmark> = serde_json::from_str(&data)?;
    Ok(bookmarks)
}

/// Save bookmarks to the config file.
pub fn save_bookmarks(bookmarks: &[Bookmark]) -> Result<()> {
    let path = bookmarks_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_string_pretty(bookmarks)?;
    std::fs::write(&path, data)?;
    Ok(())
}

/// Add a bookmark. Returns the new bookmark's id.
///
/// One bookmark per target: if an equivalent bookmark already exists (same
/// path for a note/collection, same query for a search, etc.), no duplicate
/// is created and the existing bookmark's id is returned. Re-bookmarking the
/// same file is a silent no-op from the user's perspective.
pub fn add_bookmark(bookmarks: &mut Vec<Bookmark>, kind: BookmarkKind) -> String {
    let key = kind.dedupe_key();
    if let Some(existing) = bookmarks.iter().find(|b| b.kind.dedupe_key() == key) {
        return existing.id.clone();
    }
    let id = format!("bm-{}", uuid_simple());
    bookmarks.push(Bookmark {
        id: id.clone(),
        kind,
    });
    id
}

/// Rebase every bookmark that points at `old` onto `new` after a file or
/// folder is renamed or moved. Handles both an exact match (the bookmarked
/// file itself was renamed) and the directory case (a bookmarked note living
/// under a folder that was renamed/moved). Paths are compared in the same
/// frontend string form bookmarks are stored in (absolute, forward slashes).
/// Returns true if any bookmark changed.
pub fn rewrite_paths_for_rename(bookmarks: &mut [Bookmark], old: &str, new: &str) -> bool {
    let mut changed = false;
    for bookmark in bookmarks.iter_mut() {
        if let Some(path) = bookmark.kind.path_mut() {
            if let Some(rebased) = rebase_path(path, old, new) {
                *path = rebased;
                changed = true;
            }
        }
    }
    changed
}

/// If `path` equals `old`, or lives under the `old/` directory prefix, return
/// it rebased onto `new`; otherwise `None`. Trailing slashes on `old`/`new`
/// are ignored so directory arguments compare cleanly.
fn rebase_path(path: &str, old: &str, new: &str) -> Option<String> {
    let old = old.trim_end_matches('/');
    let new = new.trim_end_matches('/');
    if path == old {
        return Some(new.to_string());
    }
    path.strip_prefix(&format!("{old}/"))
        .map(|rest| format!("{new}/{rest}"))
}

/// Remove a bookmark by id. Returns true if found and removed.
pub fn remove_bookmark(bookmarks: &mut Vec<Bookmark>, id: &str) -> bool {
    let len = bookmarks.len();
    bookmarks.retain(|b| b.id != id);
    bookmarks.len() < len
}

/// Reorder a bookmark from one position to another.
pub fn reorder_bookmark(bookmarks: &mut Vec<Bookmark>, from: usize, to: usize) {
    if from >= bookmarks.len() || to >= bookmarks.len() {
        return;
    }
    let item = bookmarks.remove(from);
    bookmarks.insert(to, item);
}

/// Generate a simple unique id (timestamp + random suffix).
fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{:x}{:04x}", ts, rand_u16())
}

fn rand_u16() -> u16 {
    // Simple random using system time nanoseconds
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    (nanos & 0xFFFF) as u16
}

fn bookmarks_path() -> PathBuf {
    crate::app_paths::config_dir().join("bookmarks.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(path: &str, name: &str) -> BookmarkKind {
        BookmarkKind::Note {
            path: path.to_string(),
            name: name.to_string(),
        }
    }

    #[test]
    fn re_bookmarking_same_file_is_a_silent_no_op() {
        let mut bookmarks = Vec::new();
        let first = add_bookmark(&mut bookmarks, note("/nb/a.typ", "A"));
        // Same path, even a different display name, must not create a second entry.
        let second = add_bookmark(&mut bookmarks, note("/nb/a.typ", "A renamed"));
        assert_eq!(bookmarks.len(), 1, "duplicate bookmark should not be added");
        assert_eq!(first, second, "should return the existing bookmark's id");
    }

    #[test]
    fn distinct_targets_still_add() {
        let mut bookmarks = Vec::new();
        add_bookmark(&mut bookmarks, note("/nb/a.typ", "A"));
        add_bookmark(&mut bookmarks, note("/nb/b.typ", "B"));
        add_bookmark(
            &mut bookmarks,
            BookmarkKind::Search {
                query: "todo".into(),
            },
        );
        assert_eq!(bookmarks.len(), 3);
    }

    #[test]
    fn heading_dedupe_is_per_heading() {
        let mut bookmarks = Vec::new();
        let mk = |heading: &str| BookmarkKind::Heading {
            path: "/nb/a.typ".into(),
            name: "A".into(),
            heading: heading.to_string(),
        };
        add_bookmark(&mut bookmarks, mk("Intro"));
        add_bookmark(&mut bookmarks, mk("Intro")); // duplicate
        add_bookmark(&mut bookmarks, mk("Methods")); // different heading, distinct
        assert_eq!(bookmarks.len(), 2);
    }

    #[test]
    fn rename_rebases_exact_match() {
        let mut bookmarks = vec![Bookmark {
            id: "bm-1".into(),
            kind: note("/nb/old.typ", "Old"),
        }];
        let changed = rewrite_paths_for_rename(&mut bookmarks, "/nb/old.typ", "/nb/new.typ");
        assert!(changed);
        assert_eq!(bookmarks[0].kind.path_mut().unwrap(), "/nb/new.typ");
    }

    #[test]
    fn folder_rename_rebases_children() {
        let mut bookmarks = vec![
            Bookmark {
                id: "bm-1".into(),
                kind: note("/nb/dir/child.typ", "Child"),
            },
            Bookmark {
                id: "bm-2".into(),
                kind: note("/nb/dir-sibling/other.typ", "Other"),
            },
        ];
        let changed = rewrite_paths_for_rename(&mut bookmarks, "/nb/dir", "/nb/renamed");
        assert!(changed);
        assert_eq!(
            bookmarks[0].kind.path_mut().unwrap(),
            "/nb/renamed/child.typ"
        );
        // A sibling folder sharing the prefix `dir` must not be rebased.
        assert_eq!(
            bookmarks[1].kind.path_mut().unwrap(),
            "/nb/dir-sibling/other.typ"
        );
    }

    #[test]
    fn rename_leaves_unrelated_and_pathless_bookmarks_alone() {
        let mut bookmarks = vec![
            Bookmark {
                id: "bm-1".into(),
                kind: note("/nb/keep.typ", "Keep"),
            },
            Bookmark {
                id: "bm-2".into(),
                kind: BookmarkKind::Search {
                    query: "/nb/old.typ".into(),
                },
            },
        ];
        let changed = rewrite_paths_for_rename(&mut bookmarks, "/nb/old.typ", "/nb/new.typ");
        assert!(!changed, "no bookmark points at the renamed path");
        assert_eq!(bookmarks[0].kind.path_mut().unwrap(), "/nb/keep.typ");
    }
}
