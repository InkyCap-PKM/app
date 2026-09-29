//! Read-only access to a Zotero SQLite database for citation data.
//!
//! Opens the database with `SQLITE_OPEN_READ_ONLY` — no writes are ever
//! performed. The Zotero application may lock its database while running;
//! SQLite in WAL mode allows concurrent readers, so this should work even
//! when Zotero is open.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

use super::bibliography::BibEntry;

/// Open a Zotero (or Better BibTeX) database in read-only immutable mode. The
/// `immutable=1` URI parameter tells SQLite to skip all locking, so reads
/// succeed even while Zotero holds an exclusive lock on the database. The trade-off is that we
/// may see slightly stale data if Zotero has uncommitted WAL transactions,
/// which is acceptable for bibliography lookups.
fn open_sqlite_readonly(db_path: &Path) -> Result<Connection, String> {
    let uri = format!("file:{}?immutable=1", db_path.to_string_lossy());
    Connection::open_with_flags(
        &uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Failed to open Zotero database: {e}"))
}

/// Auto-detect the default Zotero database location.
///
/// On Windows the user-facing default is `%USERPROFILE%\Zotero\zotero.sqlite`
/// (the Zotero installer's standard data-directory layout). Older `dirs`
/// versions resolved `data_dir()` to `%APPDATA%\Zotero\Zotero\zotero.sqlite`
/// which Zotero itself doesn't write to, so we now check the userprofile
/// path first and fall back to the APPDATA layout for installs that diverge.
pub fn auto_detect_path() -> Option<PathBuf> {
    let candidates = if cfg!(target_os = "windows") {
        vec![
            dirs::home_dir().map(|d| d.join("Zotero").join("zotero.sqlite")),
            dirs::document_dir().map(|d| d.join("Zotero").join("zotero.sqlite")),
            dirs::data_dir().map(|d| d.join("Zotero").join("Zotero").join("zotero.sqlite")),
        ]
    } else if cfg!(target_os = "macos") {
        vec![dirs::home_dir().map(|d| d.join("Zotero").join("zotero.sqlite"))]
    } else {
        vec![
            dirs::home_dir().map(|d| d.join("Zotero").join("zotero.sqlite")),
            dirs::home_dir().map(|d| {
                d.join("snap")
                    .join("zotero-snap")
                    .join("common")
                    .join("Zotero")
                    .join("zotero.sqlite")
            }),
        ]
    };

    candidates
        .into_iter()
        .flatten()
        .find(|candidate| candidate.exists())
}

/// Single-slot, mtime+size-keyed cache of the parsed Zotero library, mirroring
/// the `.bib`/`.yml` path in `bibliography.rs`. Reading the SQLite DB is the
/// citation-injection step's cost, and it runs twice per compile on the hot
/// reading-mode render path — for a large Zotero library that's two full DB
/// scans every keystroke-debounced compile. Caching on (mtime, size) collapses
/// repeated reads to one until the user changes the library in Zotero.
struct ZoteroCacheSlot {
    path: PathBuf,
    mtime: std::time::SystemTime,
    size: u64,
    entries: Vec<BibEntry>,
}

fn zotero_cache() -> &'static std::sync::Mutex<Option<ZoteroCacheSlot>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<Option<ZoteroCacheSlot>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

/// Read all library items from a Zotero SQLite database, using the mtime+size
/// cache. Falls through to a fresh read if the DB changed or stat fails.
pub fn read_entries(db_path: &Path) -> Result<Vec<BibEntry>, String> {
    // Best-effort stat; if it fails we just skip the cache and read fresh.
    let stat = std::fs::metadata(db_path)
        .ok()
        .and_then(|m| m.modified().ok().map(|mtime| (mtime, m.len())));

    if let Some((mtime, size)) = stat {
        let guard = zotero_cache()
            .lock()
            .map_err(|e| format!("Cache poisoned: {e}"))?;
        if let Some(slot) = guard.as_ref() {
            if slot.path == db_path && slot.mtime == mtime && slot.size == size {
                return Ok(slot.entries.clone());
            }
        }
    }

    let entries = read_entries_uncached(db_path)?;

    if let Some((mtime, size)) = stat {
        if let Ok(mut guard) = zotero_cache().lock() {
            *guard = Some(ZoteroCacheSlot {
                path: db_path.to_path_buf(),
                mtime,
                size,
                entries: entries.clone(),
            });
        }
    }
    Ok(entries)
}

/// Uncached read of all library items from a Zotero SQLite database.
fn read_entries_uncached(db_path: &Path) -> Result<Vec<BibEntry>, String> {
    let conn = open_sqlite_readonly(db_path)?;

    let mut entries = Vec::new();

    // Query all non-deleted, non-attachment, non-note items
    let mut item_stmt = conn
        .prepare(
            "SELECT i.itemID, it.typeName, i.key
             FROM items i
             JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
             WHERE i.itemID NOT IN (SELECT itemID FROM deletedItems)
               AND it.typeName NOT IN ('attachment', 'note', 'annotation')
             ORDER BY i.itemID",
        )
        .map_err(|e| format!("Failed to prepare item query: {e}"))?;

    let mut data_stmt = conn
        .prepare(
            "SELECT f.fieldName, idv.value
             FROM itemData id
             JOIN fields f ON id.fieldID = f.fieldID
             JOIN itemDataValues idv ON id.valueID = idv.valueID
             WHERE id.itemID = ?",
        )
        .map_err(|e| format!("Failed to prepare data query: {e}"))?;

    let mut creator_stmt = conn
        .prepare(
            "SELECT c.firstName, c.lastName, ct.creatorType
             FROM itemCreators ic
             JOIN creators c ON ic.creatorID = c.creatorID
             JOIN creatorTypes ct ON ic.creatorTypeID = ct.creatorTypeID
             WHERE ic.itemID = ?
             ORDER BY ic.orderIndex",
        )
        .map_err(|e| format!("Failed to prepare creator query: {e}"))?;

    let legacy_keys = read_legacy_better_bibtex_keys(db_path);

    let items: Vec<(i64, String, String)> = item_stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|e| format!("Failed to query items: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    // One-shot lookup: parent IDs that have at least one non-deleted child
    // note. Folding this into a single set query (rather than per-item) keeps
    // `has_notes` O(1) per entry below — important because users with large
    // Zotero libraries can have thousands of items.
    let items_with_notes: std::collections::HashSet<i64> = {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT parentItemID FROM itemNotes
                 WHERE parentItemID IS NOT NULL
                   AND parentItemID NOT IN (SELECT itemID FROM deletedItems)
                   AND itemID NOT IN (SELECT itemID FROM deletedItems)",
            )
            .map_err(|e| format!("Failed to prepare notes-presence query: {e}"))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(|e| format!("Failed to query notes presence: {e}"))?;
        rows.filter_map(|r| r.ok()).collect()
    };

    for (item_id, type_name, zotero_key) in items {
        let mut title = String::new();
        let mut date = None;
        let mut native_key = None;
        let mut extra = None;
        let mut extra_fields = std::collections::HashMap::new();

        // Read item data fields
        if let Ok(rows) = data_stmt.query_map([item_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            for row in rows.flatten() {
                match row.0.as_str() {
                    "title" => title = row.1,
                    "date" => date = Some(extract_year(&row.1)),
                    "citationKey" => native_key = Some(row.1),
                    "extra" => extra = Some(row.1),
                    "publicationTitle" => {
                        extra_fields.insert("journal".to_string(), row.1);
                    }
                    "bookTitle" => {
                        extra_fields.insert("booktitle".to_string(), row.1);
                    }
                    "publisher" => {
                        extra_fields.insert("publisher".to_string(), row.1);
                    }
                    "place" => {
                        extra_fields.insert("address".to_string(), row.1);
                    }
                    "volume" => {
                        extra_fields.insert("volume".to_string(), row.1);
                    }
                    "issue" | "number" => {
                        extra_fields.insert("number".to_string(), row.1);
                    }
                    "pages" | "numPages" => {
                        extra_fields.insert("pages".to_string(), row.1);
                    }
                    "DOI" => {
                        extra_fields.insert("doi".to_string(), row.1);
                    }
                    "url" => {
                        extra_fields.insert("url".to_string(), row.1);
                    }
                    "ISBN" => {
                        extra_fields.insert("isbn".to_string(), row.1);
                    }
                    "ISSN" => {
                        extra_fields.insert("issn".to_string(), row.1);
                    }
                    // abstractNote skipped — not needed for bibliography rendering
                    "edition" => {
                        extra_fields.insert("edition".to_string(), row.1);
                    }
                    "series" => {
                        extra_fields.insert("series".to_string(), row.1);
                    }
                    "institution" | "university" => {
                        extra_fields.insert("institution".to_string(), row.1);
                    }
                    "conferenceName" => {
                        extra_fields.insert("booktitle".to_string(), row.1);
                    }
                    "language" => {
                        extra_fields.insert("language".to_string(), row.1);
                    }
                    _ => {}
                }
            }
        }

        let key = choose_citation_key(
            native_key.as_deref(),
            extra.as_deref(),
            legacy_keys.get(&item_id).map(String::as_str),
            &zotero_key,
        );

        // Read creators
        let mut authors = Vec::new();
        let mut editors = Vec::new();
        if let Ok(rows) = creator_stmt.query_map([item_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        }) {
            for (first, last, role) in rows.flatten() {
                let name = if first.is_empty() {
                    last
                } else {
                    format!("{last}, {first}")
                };
                match role.as_str() {
                    "author" => authors.push(name),
                    "editor" => editors.push(name),
                    _ => {}
                }
            }
        }
        if !editors.is_empty() {
            extra_fields.insert("editor".to_string(), editors.join(" and "));
        }

        entries.push(BibEntry {
            key,
            title,
            authors,
            year: date,
            entry_type: type_name,
            zotero_item_key: Some(zotero_key),
            has_notes: items_with_notes.contains(&item_id),
            extra_fields,
        });
    }

    // Dedup by citation key. An item present in both "My Library" and a group
    // library appears twice here with identical citation keys but distinct
    // `zotero_item_key`s. Keep the
    // first occurrence (ORDER BY itemID puts older entries first, which
    // typically means the canonical/personal copy).
    let mut seen = std::collections::HashSet::new();
    entries.retain(|e| seen.insert(e.key.clone()));

    Ok(entries)
}

/// Pick an item's citation key, first non-empty source wins:
///
/// 1. Zotero's native `citationKey` field. Zotero 7 has it built in, and
///    Better BibTeX writes its keys there once it has migrated.
/// 2. A `Citation Key: <key>` line in the item's Extra field, the older way
///    to pin a key (Better BibTeX and Zotero both read it).
/// 3. The key from an unmigrated Better BibTeX database, if one exists.
/// 4. Zotero's own item ID (e.g. `5VX4GJ8Q`), which every item has.
fn choose_citation_key(
    native: Option<&str>,
    extra: Option<&str>,
    legacy: Option<&str>,
    zotero_key: &str,
) -> String {
    fn non_empty(key: Option<&str>) -> Option<&str> {
        key.map(str::trim).filter(|k| !k.is_empty())
    }
    non_empty(native)
        .or_else(|| extra.and_then(pinned_key_from_extra))
        .or_else(|| non_empty(legacy))
        .unwrap_or(zotero_key)
        .to_string()
}

/// The key from a `Citation Key: <key>` line in a Zotero Extra field. The
/// label is matched without regard to case, as Zotero does.
fn pinned_key_from_extra(extra: &str) -> Option<&str> {
    const LABEL: &str = "citation key:";
    extra.lines().find_map(|line| {
        let line = line.trim_start();
        let label = line.get(..LABEL.len())?;
        if !label.eq_ignore_ascii_case(LABEL) {
            return None;
        }
        Some(line[LABEL.len()..].trim()).filter(|k| !k.is_empty())
    })
}

/// Citation keys by Zotero item ID from Better BibTeX's own database
/// (`better-bibtex.sqlite` beside `zotero.sqlite`). Current Better BibTeX
/// moves its keys into Zotero's native field and renames this file, so it only
/// exists for setups that haven't migrated. Missing or unreadable means empty.
fn read_legacy_better_bibtex_keys(zotero_db: &Path) -> std::collections::HashMap<i64, String> {
    let Some(path) = zotero_db
        .parent()
        .map(|dir| dir.join("better-bibtex.sqlite"))
        .filter(|p| p.is_file())
    else {
        return std::collections::HashMap::new();
    };
    let Ok(conn) = open_sqlite_readonly(&path) else {
        return std::collections::HashMap::new();
    };
    let read = || -> rusqlite::Result<std::collections::HashMap<i64, String>> {
        let mut stmt = conn.prepare("SELECT itemID, citationKey FROM citationkey")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    };
    read().unwrap_or_default()
}

/// Extract a 4-digit year from a Zotero date string.
/// Zotero dates can be "2020", "2020-01-15", "January 2020", etc.
fn extract_year(date_str: &str) -> String {
    // Look for a 4-digit year anywhere in the string
    for word in date_str.split(|c: char| !c.is_ascii_digit()) {
        if word.len() == 4 {
            if let Ok(y) = word.parse::<u16>() {
                if (1000..=2100).contains(&y) {
                    return word.to_string();
                }
            }
        }
    }
    date_str.to_string()
}

/// Read user notes from a Zotero database for a given citation key.
pub fn read_notes(db_path: &Path, item_key: &str) -> Result<Vec<String>, String> {
    let conn = open_sqlite_readonly(db_path)?;

    let mut stmt = conn
        .prepare(
            "SELECT n.note FROM itemNotes n
             JOIN items i ON n.parentItemID = i.itemID
             WHERE i.key = ?",
        )
        .map_err(|e| format!("Failed to prepare notes query: {e}"))?;

    let notes: Vec<String> = stmt
        .query_map([item_key], |row| row.get(0))
        .map_err(|e| format!("Failed to query notes: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(notes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_key_wins() {
        let extra = "Citation Key: pinned2020";
        let key = choose_citation_key(Some("native2020"), Some(extra), Some("old"), "ABCD1234");
        assert_eq!(key, "native2020");
    }

    #[test]
    fn empty_native_key_falls_back_to_extra() {
        let extra = "tex.note: x\nCitation Key: pinned2020";
        let key = choose_citation_key(Some(""), Some(extra), Some("old"), "ABCD1234");
        assert_eq!(key, "pinned2020");
    }

    #[test]
    fn legacy_database_before_item_id() {
        let key = choose_citation_key(None, Some("unrelated"), Some("old2019"), "ABCD1234");
        assert_eq!(key, "old2019");
    }

    #[test]
    fn item_id_is_last_resort() {
        let key = choose_citation_key(Some("  "), None, None, "5VX4GJ8Q");
        assert_eq!(key, "5VX4GJ8Q");
    }

    #[test]
    fn pinned_key_label_ignores_case_and_blank_values() {
        assert_eq!(
            pinned_key_from_extra("citation key:  smith "),
            Some("smith")
        );
        assert_eq!(pinned_key_from_extra("Citation Key:"), None);
        assert_eq!(pinned_key_from_extra("Original: Citation Key: x"), None);
    }
}
