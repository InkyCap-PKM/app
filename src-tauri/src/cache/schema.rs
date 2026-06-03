//! SQLite schema definition and migrations for the metadata cache.
//!
//! Bumping `SCHEMA_VERSION` triggers a full cache wipe + recreate on next
//! open. Because the cache is disposable (it's rebuilt from the filesystem),
//! we don't ship migration scripts — losing the cache costs one slow startup,
//! not user data.

use rusqlite::Connection;

pub const SCHEMA_VERSION: i32 = 6;

pub const CREATE_STATEMENTS: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)",
    "CREATE TABLE IF NOT EXISTS noteboxes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_path TEXT NOT NULL UNIQUE,
        last_opened_at INTEGER NOT NULL
    )",
    // Tags and links are normalized into their own tables (rather than packed
    // into JSON columns on `files`) so a future `.collection` query evaluator can
    // compile to SQL with proper indexes — see the architecture plan.
    "CREATE TABLE IF NOT EXISTS files (
        notebox_id INTEGER NOT NULL REFERENCES noteboxes(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        properties_json TEXT NOT NULL,
        title TEXT,
        content TEXT,
        agenda_json TEXT NOT NULL DEFAULT '[]',
        unresolved_suggestions INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (notebox_id, path)
    )",
    "CREATE TABLE IF NOT EXISTS file_tags (
        notebox_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (notebox_id, path, tag),
        FOREIGN KEY (notebox_id, path) REFERENCES files(notebox_id, path) ON DELETE CASCADE
    )",
    "CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(notebox_id, tag)",
    "CREATE TABLE IF NOT EXISTS file_links (
        notebox_id INTEGER NOT NULL,
        source_path TEXT NOT NULL,
        target_text TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (notebox_id, source_path, ordinal),
        FOREIGN KEY (notebox_id, source_path) REFERENCES files(notebox_id, path) ON DELETE CASCADE
    )",
    "CREATE INDEX IF NOT EXISTS idx_file_links_target ON file_links(notebox_id, target_text)",
];

/// Initialize the schema, wiping and recreating if the stored version is older
/// than [`SCHEMA_VERSION`]. Foreign keys are enabled here so the cascading
/// deletes on `noteboxes` / `files` actually fire.
pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;

    // Create the version table first so we can check the current schema version
    // even on a fresh database.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)",
        [],
    )?;

    let current_version: Option<i32> = conn
        .query_row("SELECT version FROM schema_version LIMIT 1", [], |row| {
            row.get(0)
        })
        .ok();

    let need_wipe = match current_version {
        Some(v) if v == SCHEMA_VERSION => false,
        Some(_) => true,
        // No version row but tables may exist from before versioning was
        // added. Wipe to be safe — the cost is one slow startup.
        None => has_any_table(conn),
    };

    if need_wipe {
        wipe(conn)?;
    }

    for stmt in CREATE_STATEMENTS {
        conn.execute(stmt, [])?;
    }

    conn.execute(
        "INSERT OR REPLACE INTO schema_version (version) VALUES (?1)",
        [SCHEMA_VERSION],
    )?;

    // Verify that the schema matches expectations. If a prior wipe didn't
    // fully take effect (e.g. stale WAL journal) we surface it as an error
    // so the caller can delete the file and retry from scratch.
    verify_schema(conn)?;

    Ok(())
}

/// Check whether any of the expected tables already exist.
fn has_any_table(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('files','noteboxes')",
        [],
        |row| row.get::<_, i32>(0),
    )
    .unwrap_or(0)
        > 0
}

/// Verify that the `files` table has the expected columns. Returns an error
/// if the schema doesn't match, which triggers the delete-and-retry path
/// in [`MetadataCache::open`].
fn verify_schema(conn: &Connection) -> rusqlite::Result<()> {
    let has_content: bool = conn.prepare("SELECT content FROM files LIMIT 0").is_ok();
    if !has_content {
        return Err(rusqlite::Error::InvalidColumnName(
            "schema verification failed: files table missing content column".to_string(),
        ));
    }
    let has_agenda: bool = conn
        .prepare("SELECT agenda_json FROM files LIMIT 0")
        .is_ok();
    if !has_agenda {
        return Err(rusqlite::Error::InvalidColumnName(
            "schema verification failed: files table missing agenda_json column".to_string(),
        ));
    }
    let has_unresolved: bool = conn
        .prepare("SELECT unresolved_suggestions FROM files LIMIT 0")
        .is_ok();
    if !has_unresolved {
        return Err(rusqlite::Error::InvalidColumnName(
            "schema verification failed: files table missing unresolved_suggestions column"
                .to_string(),
        ));
    }
    Ok(())
}

/// Drop all cache tables. Used on schema mismatch.
fn wipe(conn: &Connection) -> rusqlite::Result<()> {
    // Disable FK checks during wipe to avoid ordering issues with
    // cascading constraints on some SQLite builds.
    conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
    let tables = [
        "file_links",
        "file_tags",
        "files",
        "noteboxes",
        "schema_version",
    ];
    for table in tables {
        conn.execute(&format!("DROP TABLE IF EXISTS {}", table), [])?;
    }
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    Ok(())
}
