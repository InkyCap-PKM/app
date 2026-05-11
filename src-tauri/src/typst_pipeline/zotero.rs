//! Read-only access to a Zotero SQLite database for citation data.
//!
//! Opens the database with `SQLITE_OPEN_READ_ONLY` — no writes are ever
//! performed. The Zotero application may lock its database while running;
//! SQLite in WAL mode allows concurrent readers, so this should work even
//! when Zotero is open.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

use super::bibliography::BibEntry;

/// Open a Zotero database in read-only immutable mode. The `immutable=1` URI
/// parameter tells SQLite to skip all locking, so reads succeed even while
/// Zotero holds an exclusive lock on the database. The trade-off is that we
/// may see slightly stale data if Zotero has uncommitted WAL transactions,
/// which is acceptable for bibliography lookups.
fn open_zotero_readonly(db_path: &Path) -> Result<Connection, String> {
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
pub fn auto_detect_path() -> Option<PathBuf> {
    let candidates = if cfg!(target_os = "windows") {
        vec![
            dirs::data_dir().map(|d| d.join("Zotero").join("Zotero").join("zotero.sqlite")),
        ]
    } else if cfg!(target_os = "macos") {
        vec![
            dirs::home_dir().map(|d| d.join("Zotero").join("zotero.sqlite")),
        ]
    } else {
        vec![
            dirs::home_dir().map(|d| d.join("Zotero").join("zotero.sqlite")),
            dirs::home_dir().map(|d| d.join("snap").join("zotero-snap").join("common").join("Zotero").join("zotero.sqlite")),
        ]
    };

    for candidate in candidates.into_iter().flatten() {
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// Read all library items from a Zotero SQLite database.
pub fn read_entries(db_path: &Path) -> Result<Vec<BibEntry>, String> {
    let conn = open_zotero_readonly(db_path)?;

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

    // Check if the citationKey field exists (Better BibTeX plugin)
    let has_citation_key = conn
        .prepare("SELECT 1 FROM fields WHERE fieldName = 'citationKey' LIMIT 1")
        .and_then(|mut s| s.exists([]))
        .unwrap_or(false);

    // Also check for the extra field which Better BibTeX uses
    let mut extra_cite_key_stmt = if has_citation_key {
        None
    } else {
        conn.prepare(
            "SELECT idv.value FROM itemData id
             JOIN fields f ON id.fieldID = f.fieldID
             JOIN itemDataValues idv ON id.valueID = idv.valueID
             WHERE id.itemID = ? AND f.fieldName = 'extra'",
        )
        .ok()
    };

    let items: Vec<(i64, String, String)> = item_stmt
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
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
        let mut citation_key = None;

        // Read item data fields
        if let Ok(rows) = data_stmt.query_map([item_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            for row in rows.flatten() {
                match row.0.as_str() {
                    "title" => title = row.1,
                    "date" => date = Some(extract_year(&row.1)),
                    "citationKey" => citation_key = Some(row.1),
                    _ => {}
                }
            }
        }

        // If no citationKey field, try extracting from the "extra" field
        // (Better BibTeX stores "Citation Key: xyz" there)
        if citation_key.is_none() {
            if let Some(ref mut stmt) = extra_cite_key_stmt {
                if let Ok(extra) = stmt.query_row([item_id], |row| row.get::<_, String>(0)) {
                    for line in extra.lines() {
                        if let Some(key) = line.strip_prefix("Citation Key: ") {
                            citation_key = Some(key.trim().to_string());
                            break;
                        }
                    }
                }
            }
        }

        // Fall back to Zotero's internal key
        let key = citation_key.unwrap_or_else(|| zotero_key.clone());

        // Read creators
        let mut authors = Vec::new();
        if let Ok(rows) = creator_stmt.query_map([item_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        }) {
            for (first, last, role) in rows.flatten() {
                if role == "author" || role == "editor" {
                    if first.is_empty() {
                        authors.push(last);
                    } else {
                        authors.push(format!("{last}, {first}"));
                    }
                }
            }
        }

        entries.push(BibEntry {
            key,
            title,
            authors,
            year: date,
            entry_type: type_name,
            zotero_item_key: Some(zotero_key),
            has_notes: items_with_notes.contains(&item_id),
        });
    }

    // Dedup by citation key. Better BibTeX assigns keys per-library, so an
    // item present in both "My Library" and a group library appears twice
    // here with identical keys but distinct `zotero_item_key`s. Keep the
    // first occurrence (ORDER BY itemID puts older entries first, which
    // typically means the canonical/personal copy).
    let mut seen = std::collections::HashSet::new();
    entries.retain(|e| seen.insert(e.key.clone()));

    Ok(entries)
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
    let conn = open_zotero_readonly(db_path)?;

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
