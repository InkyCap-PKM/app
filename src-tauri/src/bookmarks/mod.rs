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
pub fn add_bookmark(bookmarks: &mut Vec<Bookmark>, kind: BookmarkKind) -> String {
    let id = format!("bm-{}", uuid_simple());
    bookmarks.push(Bookmark {
        id: id.clone(),
        kind,
    });
    id
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
