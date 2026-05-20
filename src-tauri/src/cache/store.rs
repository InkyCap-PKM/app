//! [`MetadataCache`] — the public API for reading and writing the persistent
//! metadata cache. All paths are stored relative to the notebox root, and all
//! operations are scoped to a single notebox by `(notebox_id, path)`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

use super::schema;
use crate::errors::{InkyCapError, Result};
use crate::models::note::PropertyValue;

/// One file's worth of cached metadata. Mirrors the columns of the `files`
/// table plus the joined `file_tags` and `file_links` rows.
#[derive(Debug, Clone)]
pub struct CachedFile {
    /// Path relative to the notebox root.
    pub path: PathBuf,
    /// File mtime in unix seconds. Combined with `size` to detect staleness.
    pub mtime: i64,
    pub size: u64,
    pub properties: HashMap<String, PropertyValue>,
    pub title: Option<String>,
    pub tags: Vec<String>,
    /// Wikilink targets in their original (unresolved) form.
    pub links: Vec<String>,
    /// Inline `#task` / `#due` markers from the note body.
    pub agenda_markers: Vec<crate::models::note::AgendaMarker>,
    /// Full file content, cached so subsequent notebox opens can skip disk reads
    /// for unchanged files. `None` for legacy cache entries created before
    /// content caching was added.
    pub content: Option<String>,
}

/// SQLite-backed metadata cache. Thread-safe via an internal mutex; the cache
/// is not on a hot path during normal operation, so a single connection is
/// sufficient and avoids the complexity of a connection pool.
pub struct MetadataCache {
    conn: Mutex<Connection>,
}

impl MetadataCache {
    /// Open (or create) the cache database at `db_path`. The parent directory
    /// is created if it doesn't exist. On any failure (including a corrupt
    /// database), the file is deleted and recreated — the cache must never
    /// block app launch.
    pub fn open(db_path: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = match Connection::open(db_path).and_then(|c| {
            schema::init(&c)?;
            Ok(c)
        }) {
            Ok(c) => c,
            Err(err) => {
                // Corrupt or incompatible — wipe and try once more. If this
                // also fails, the error propagates and the caller falls back
                // to a cacheless rebuild.
                log::warn!(
                    "Metadata cache at {} unusable ({err}); recreating",
                    db_path.display()
                );
                let _ = std::fs::remove_file(db_path);
                let c = Connection::open(db_path)?;
                schema::init(&c)?;
                c
            }
        };

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Look up the notebox row for `notebox_root`, inserting one if it doesn't
    /// exist, and bumping `last_opened_at` to "now". Returns the notebox id.
    fn get_or_create_notebox_id(conn: &Connection, notebox_root: &Path) -> Result<i64> {
        let key = notebox_root.to_string_lossy().to_string();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        // Try update first; if no row exists, insert. This avoids racing
        // SELECT-then-INSERT logic — both branches end with `last_opened_at`
        // refreshed to `now`.
        let updated = conn.execute(
            "UPDATE noteboxes SET last_opened_at = ?1 WHERE root_path = ?2",
            params![now, key],
        )?;
        if updated == 0 {
            conn.execute(
                "INSERT INTO noteboxes (root_path, last_opened_at) VALUES (?1, ?2)",
                params![key, now],
            )?;
        }

        let id: i64 = conn.query_row(
            "SELECT id FROM noteboxes WHERE root_path = ?1",
            params![key],
            |row| row.get(0),
        )?;
        Ok(id)
    }

    /// Load every cached file for the given notebox, keyed by relative path.
    /// Returns an empty map if the notebox has no cached entries yet (e.g.
    /// first run on this notebox).
    pub fn load_notebox(&self, notebox_root: &Path) -> Result<HashMap<PathBuf, CachedFile>> {
        let conn = self.conn.lock().map_err(|_| {
            InkyCapError::Cache("metadata cache mutex poisoned".to_string())
        })?;

        let notebox_id = Self::get_or_create_notebox_id(&conn, notebox_root)?;

        let mut files: HashMap<PathBuf, CachedFile> = HashMap::new();

        // Pull all `files` rows for this notebox.
        {
            let mut stmt = conn.prepare(
                "SELECT path, mtime, size, properties_json, title, content, agenda_json \
                 FROM files WHERE notebox_id = ?1",
            )?;
            let rows = stmt.query_map(params![notebox_id], |row| {
                let path: String = row.get(0)?;
                let mtime: i64 = row.get(1)?;
                let size: i64 = row.get(2)?;
                let properties_json: String = row.get(3)?;
                let title: Option<String> = row.get(4)?;
                let content: Option<String> = row.get(5)?;
                let agenda_json: String = row.get(6)?;
                Ok((path, mtime, size, properties_json, title, content, agenda_json))
            })?;

            for row in rows {
                let (path, mtime, size, properties_json, title, content, agenda_json) = row?;
                let properties: HashMap<String, PropertyValue> =
                    serde_json::from_str(&properties_json).map_err(|e| {
                        InkyCapError::Cache(format!(
                            "corrupt properties_json for {path}: {e}"
                        ))
                    })?;
                // A corrupt agenda blob degrades to "no markers" rather than
                // failing the whole cache read — the markers are rebuilt on
                // the next compile of that file anyway.
                let agenda_markers = serde_json::from_str(&agenda_json).unwrap_or_default();
                files.insert(
                    PathBuf::from(&path),
                    CachedFile {
                        path: PathBuf::from(&path),
                        mtime,
                        size: size.max(0) as u64,
                        properties,
                        title,
                        tags: Vec::new(),
                        links: Vec::new(),
                        agenda_markers,
                        content,
                    },
                );
            }
        }

        // Tags.
        {
            let mut stmt = conn.prepare(
                "SELECT path, tag FROM file_tags WHERE notebox_id = ?1",
            )?;
            let rows = stmt.query_map(params![notebox_id], |row| {
                let path: String = row.get(0)?;
                let tag: String = row.get(1)?;
                Ok((path, tag))
            })?;
            for row in rows {
                let (path, tag) = row?;
                if let Some(file) = files.get_mut(&PathBuf::from(&path)) {
                    file.tags.push(tag);
                }
            }
        }

        // Links — preserve order via the `ordinal` column.
        {
            let mut stmt = conn.prepare(
                "SELECT source_path, target_text FROM file_links \
                 WHERE notebox_id = ?1 ORDER BY source_path, ordinal",
            )?;
            let rows = stmt.query_map(params![notebox_id], |row| {
                let path: String = row.get(0)?;
                let target: String = row.get(1)?;
                Ok((path, target))
            })?;
            for row in rows {
                let (path, target) = row?;
                if let Some(file) = files.get_mut(&PathBuf::from(&path)) {
                    file.links.push(target);
                }
            }
        }

        Ok(files)
    }

    /// Insert or replace a batch of files in a single transaction. Tags and
    /// links for each file are wiped and rewritten so callers don't need to
    /// diff them — the cascading FK on `(notebox_id, path)` handles cleanup.
    pub fn upsert_many(&self, notebox_root: &Path, files: &[CachedFile]) -> Result<()> {
        if files.is_empty() {
            return Ok(());
        }

        let mut conn = self.conn.lock().map_err(|_| {
            InkyCapError::Cache("metadata cache mutex poisoned".to_string())
        })?;
        let notebox_id = Self::get_or_create_notebox_id(&conn, notebox_root)?;

        let tx = conn.transaction()?;
        {
            let mut upsert_file = tx.prepare(
                "INSERT INTO files (notebox_id, path, mtime, size, properties_json, title, content, agenda_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
                 ON CONFLICT(notebox_id, path) DO UPDATE SET \
                    mtime = excluded.mtime, \
                    size = excluded.size, \
                    properties_json = excluded.properties_json, \
                    title = excluded.title, \
                    content = excluded.content, \
                    agenda_json = excluded.agenda_json",
            )?;
            let mut delete_tags = tx.prepare(
                "DELETE FROM file_tags WHERE notebox_id = ?1 AND path = ?2",
            )?;
            let mut insert_tag = tx.prepare(
                "INSERT OR IGNORE INTO file_tags (notebox_id, path, tag) VALUES (?1, ?2, ?3)",
            )?;
            let mut delete_links = tx.prepare(
                "DELETE FROM file_links WHERE notebox_id = ?1 AND source_path = ?2",
            )?;
            let mut insert_link = tx.prepare(
                "INSERT INTO file_links (notebox_id, source_path, target_text, ordinal) \
                 VALUES (?1, ?2, ?3, ?4)",
            )?;

            for file in files {
                let path_str = file.path.to_string_lossy().to_string();
                let properties_json = serde_json::to_string(&file.properties)?;
                let agenda_json = serde_json::to_string(&file.agenda_markers)?;

                upsert_file.execute(params![
                    notebox_id,
                    &path_str,
                    file.mtime,
                    file.size as i64,
                    properties_json,
                    file.title,
                    file.content,
                    agenda_json,
                ])?;

                delete_tags.execute(params![notebox_id, &path_str])?;
                for tag in &file.tags {
                    insert_tag.execute(params![notebox_id, &path_str, tag])?;
                }

                delete_links.execute(params![notebox_id, &path_str])?;
                for (ordinal, link) in file.links.iter().enumerate() {
                    insert_link.execute(params![
                        notebox_id,
                        &path_str,
                        link,
                        ordinal as i64,
                    ])?;
                }
            }
        }
        tx.commit()?;

        Ok(())
    }

    /// Upsert a single file. Convenience wrapper around [`Self::upsert_many`]
    /// for the file watcher write-through path.
    pub fn upsert_file(&self, notebox_root: &Path, file: &CachedFile) -> Result<()> {
        self.upsert_many(notebox_root, std::slice::from_ref(file))
    }

    /// Delete a single file's row (and its tags/links via FK cascade) from
    /// the cache. Used by the file watcher on `FileDeleted`.
    pub fn delete_file(&self, notebox_root: &Path, path: &Path) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| {
            InkyCapError::Cache("metadata cache mutex poisoned".to_string())
        })?;
        let notebox_id = Self::get_or_create_notebox_id(&conn, notebox_root)?;
        let path_str = path.to_string_lossy().to_string();
        conn.execute(
            "DELETE FROM files WHERE notebox_id = ?1 AND path = ?2",
            params![notebox_id, path_str],
        )?;
        Ok(())
    }

    /// Remove cache entries for files that no longer exist on disk. Called
    /// after a full scan so the cache stays in sync with the filesystem.
    pub fn prune(
        &self,
        notebox_root: &Path,
        existing: &HashSet<PathBuf>,
    ) -> Result<usize> {
        self.prune_collecting(notebox_root, existing).map(|(n, _)| n)
    }

    /// Like [`prune`] but also returns the relative paths that were deleted,
    /// so callers can clean up other indexes (e.g. persisted search engine).
    pub fn prune_collecting(
        &self,
        notebox_root: &Path,
        existing: &HashSet<PathBuf>,
    ) -> Result<(usize, Vec<PathBuf>)> {
        let conn = self.conn.lock().map_err(|_| {
            InkyCapError::Cache("metadata cache mutex poisoned".to_string())
        })?;
        let notebox_id = Self::get_or_create_notebox_id(&conn, notebox_root)?;

        let mut stmt = conn.prepare(
            "SELECT path FROM files WHERE notebox_id = ?1",
        )?;
        let cached_paths: Vec<String> = stmt
            .query_map(params![notebox_id], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);

        let mut deleted = 0usize;
        let mut pruned_paths = Vec::new();
        for path in cached_paths {
            let pb = PathBuf::from(&path);
            if !existing.contains(&pb) {
                conn.execute(
                    "DELETE FROM files WHERE notebox_id = ?1 AND path = ?2",
                    params![notebox_id, path],
                )?;
                deleted += 1;
                pruned_paths.push(pb);
            }
        }
        Ok((deleted, pruned_paths))
    }
}

/// Check whether a cached entry is still valid for a file with the given
/// filesystem `(mtime, size)`. Both must match — mtime alone can collide
/// (e.g. files saved within the same second) and size alone misses
/// content-changing edits that don't change length.
pub fn is_fresh(cached: &CachedFile, mtime: i64, size: u64) -> bool {
    cached.mtime == mtime && cached.size == size
}
