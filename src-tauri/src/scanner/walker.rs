//! Notebox scanner.
//!
//! Walks `.typ` files, extracts filesystem metadata, and (for cache misses)
//! compiles each file through the Typst pipeline to extract body-derived
//! metadata via `typst query` against the `<inkycap-note>`, `<inkycap-tag>`,
//! and `<inkycap-link>` labels emitted by the `inkycap-notebox` package.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::cache::{CachedFile, MetadataCache};
use crate::errors::Result;
use crate::link_index::LinkIndex;
use crate::models::note::{FileMetadata, NoteId, NoteMetadata, PropertyValue};
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::query::{self, QueryResult};
use crate::typst_pipeline::TypstCompiler;

/// Parse a single note from its content (for incremental re-indexing).
/// Does not populate `file.*` properties since those come from filesystem
/// metadata.
///
/// When `compiler` is provided, body-derived metadata (links, tags,
/// typed properties) is extracted via `typst query`; otherwise those
/// fields are empty.
pub fn parse_note(
    path: &Path,
    content: &str,
    _notebox_root: &Path,
    compiler: Option<&mut TypstCompiler>,
) -> NoteMetadata {
    let mut note = NoteMetadata {
        path: path.to_path_buf(),
        properties: std::collections::HashMap::new(),
        links: Vec::new(),
        tags: Vec::new(),
        agenda_markers: Vec::new(),
        unresolved_suggestions: 0,
        recurrence: None,
    };

    if let Some(compiler) = compiler {
        let qr = query::compile_and_query(compiler, path, content.to_string());
        enrich_with_query(&mut note, qr);
    }

    note
}

/// Result of a full notebox scan.
pub struct ScanResult {
    pub notes: Vec<NoteMetadata>,
    pub collection_files: Vec<PathBuf>,
    pub link_index: LinkIndex,
    /// File contents collected during the scan, so callers (e.g. the search
    /// engine) don't need to re-read every file from disk.
    pub contents: Vec<(PathBuf, String)>,
    /// Modification times from stat, keyed by absolute path. Used by the
    /// search-engine persistence layer to detect files that changed since
    /// the last persisted snapshot.
    pub file_mtimes: HashMap<PathBuf, i64>,
}

/// Parse a single note file from disk, producing the full [`NoteMetadata`]
/// (including `file.*` properties) plus the raw content.
async fn parse_note_from_disk(
    storage: &dyn NoteboxStorage,
    path: &Path,
) -> Result<(NoteMetadata, String)> {
    let content = storage.read_file(path).await?;
    let mut properties = std::collections::HashMap::new();

    // file.* properties — derived from filesystem metadata, not #note(...).
    let file_meta = storage.file_metadata(path).await?;
    insert_file_properties(&mut properties, &file_meta);

    let note = NoteMetadata {
        path: path.to_path_buf(),
        properties,
        links: Vec::new(),
        tags: Vec::new(),
        agenda_markers: Vec::new(),
        unresolved_suggestions: 0,
        recurrence: None,
    };

    Ok((note, content))
}

/// Populate the `file.*` properties on `properties` from a storage
/// [`FileMetadata`]. These are derived from the filesystem (not `#note(...)`),
/// so every indexed note needs them set — including notes reindexed in memory
/// after a write (e.g. a collaboration apply), where `parse_note` alone leaves
/// them empty and collection filters like `file.ext == "typ"` would then
/// silently exclude the note until a full rescan.
pub fn insert_file_properties(
    properties: &mut HashMap<String, PropertyValue>,
    file_meta: &FileMetadata,
) {
    properties.insert(
        "file.name".to_string(),
        PropertyValue::String(file_meta.name.clone()),
    );
    properties.insert(
        "file.folder".to_string(),
        PropertyValue::String(file_meta.folder.clone()),
    );
    properties.insert(
        "file.ext".to_string(),
        PropertyValue::String(file_meta.ext.clone()),
    );
    properties.insert(
        "file.path".to_string(),
        PropertyValue::String(file_meta.path.clone()),
    );
    if let Some(ref ctime) = file_meta.ctime {
        properties.insert(
            "file.ctime".to_string(),
            PropertyValue::String(ctime.clone()),
        );
    }
    if let Some(ref mtime) = file_meta.mtime {
        properties.insert(
            "file.mtime".to_string(),
            PropertyValue::String(mtime.clone()),
        );
    }
    properties.insert(
        "file.size".to_string(),
        PropertyValue::Number(file_meta.size as f64),
    );
}

/// Merge query results into a NoteMetadata, populating links, tags, and
/// body-derived properties from `#note(...)`.
fn enrich_with_query(note: &mut NoteMetadata, qr: QueryResult) {
    note.links = qr.links;
    note.tags = qr.tags;
    note.agenda_markers = qr.agenda;
    note.unresolved_suggestions = qr.suggestions;
    note.recurrence = qr.recurrence;
    for (key, value) in qr.properties {
        note.properties.insert(key, value);
    }
}

/// Convert a freshly parsed [`NoteMetadata`] into a [`CachedFile`] suitable
/// for upsert into the metadata cache. `mtime` and `size` come from the
/// filesystem stat performed at scan time.
pub(crate) fn note_to_cached_file(
    note: &NoteMetadata,
    relative_path: PathBuf,
    mtime: i64,
    size: u64,
    content: &str,
) -> CachedFile {
    let title = note.properties.get("title").and_then(|v| {
        if let PropertyValue::String(s) = v {
            Some(s.clone())
        } else {
            None
        }
    });

    // Strip file.* properties when persisting — they're derived from the
    // filesystem stat, not from #note(...) properties, so caching them would be both
    // redundant and wrong (the absolute path varies if the notebox moves).
    let mut persisted_props: HashMap<String, PropertyValue> = HashMap::new();
    for (k, v) in &note.properties {
        if !k.starts_with("file.") {
            persisted_props.insert(k.clone(), v.clone());
        }
    }

    CachedFile {
        path: relative_path,
        mtime,
        size,
        properties: persisted_props,
        title,
        tags: note.tags.clone(),
        links: note.links.clone(),
        agenda_markers: note.agenda_markers.clone(),
        unresolved_suggestions: note.unresolved_suggestions as u32,
        recurrence: note.recurrence.clone(),
        content: Some(content.to_string()),
    }
}

/// Whether a cache entry that is fresh by mtime and size still looks like the
/// leftover of a bad parse, and should be re-parsed rather than trusted.
///
/// Two shapes are rejected. No properties and no tags for a file that visibly
/// has a `#note(...)` call: older builds stored an empty result when a
/// body-only error (an unresolved citation, say) failed the whole compile,
/// and the body-stripped fallback in `compile_and_query` now succeeds on the
/// re-parse. And an empty link list for a file that visibly contains a
/// `#wikilink(...)` or `[[...]]`: without this the Links pane silently shows
/// "No outbound links" after the user adds wikilinks, because the cache hit
/// short-circuits the reparse. Both are cheap substring checks; a false
/// positive only costs one unnecessary reparse.
fn cache_entry_looks_stale(cached: &CachedFile, content: &str) -> bool {
    let non_file_props = cached.properties.keys().any(|k| !k.starts_with("file."));
    let cached_empty = !non_file_props && cached.tags.is_empty();
    let looks_like_note = content.contains("#note(");
    let cached_no_links = cached.links.is_empty();
    let content_has_wikilinks = content.contains("#wikilink(") || content.contains("[[");
    (cached_empty && looks_like_note) || (cached_no_links && content_has_wikilinks)
}

/// Metadata for one note straight from the cache, without the compiler: what
/// the next scan would produce for it as a cache hit. Lets the Properties
/// panel show a note while the indexes are still being built after open,
/// instead of waiting for the scan to release the compiler.
///
/// `None` when the file has no cache entry, the entry is stale (its recorded
/// mtime and size no longer match the file, or it fails
/// [`cache_entry_looks_stale`]), or the file cannot be stat'd or read. Only an
/// entry the scan itself would reuse is served, so the caller never shows
/// values the finished index will contradict.
pub async fn note_from_cache(
    storage: &dyn NoteboxStorage,
    cache: &MetadataCache,
    notebox_root: &Path,
    abs_path: &Path,
) -> Option<NoteMetadata> {
    let relpath = abs_path.strip_prefix(notebox_root).ok()?;
    let stat = stat_file(abs_path).await.ok()?;
    let cached = cache.load_file(notebox_root, relpath).ok().flatten()?;
    if !crate::cache::store::is_fresh(&cached, stat.mtime, stat.size) {
        return None;
    }
    let content = match cached.content.clone() {
        Some(content) => content,
        None => storage.read_file(abs_path).await.ok()?,
    };
    if cache_entry_looks_stale(&cached, &content) {
        return None;
    }
    Some(cached_to_note(&cached, abs_path, notebox_root, &stat))
}

/// Reconstitute a [`NoteMetadata`] from a cache hit, deriving the `file.*`
/// properties from the path strings and the filesystem stat obtained during
/// the scan.
fn cached_to_note(
    cached: &CachedFile,
    abs_path: &Path,
    notebox_root: &Path,
    stat: &FileStat,
) -> NoteMetadata {
    let mut properties = cached.properties.clone();

    let name = abs_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    // `file.folder` is exposed to collection filters and the property panel and
    // is compared against forward-slash paths from the file tree — flow it
    // through the frontend-shape helper (like `file.path` below) so Windows
    // callers don't trip on `\` separators or a `\\?\` verbatim prefix.
    let folder = abs_path
        .parent()
        .map(|p| crate::storage::to_frontend_string(p.strip_prefix(notebox_root).unwrap_or(p)))
        .unwrap_or_default();
    let ext = abs_path
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_default();
    // `file.path` is a notebox-relative path exposed to collection filters,
    // queries, and the property panel — flow it through the frontend-shape
    // helper so Windows callers don't trip on `\` separators when the same
    // value is matched against forward-slash paths from the file tree.
    let rel_path = abs_path
        .strip_prefix(notebox_root)
        .map(crate::storage::to_frontend_string)
        .unwrap_or_else(|_| crate::storage::to_frontend_string(abs_path));

    properties.insert("file.name".to_string(), PropertyValue::String(name));
    properties.insert("file.folder".to_string(), PropertyValue::String(folder));
    properties.insert("file.ext".to_string(), PropertyValue::String(ext));
    properties.insert("file.path".to_string(), PropertyValue::String(rel_path));
    properties.insert(
        "file.size".to_string(),
        PropertyValue::Number(stat.size as f64),
    );
    if let Some(ctime) = stat.ctime {
        properties.insert(
            "file.ctime".to_string(),
            PropertyValue::String(unix_secs_to_rfc3339(ctime)),
        );
    }
    properties.insert(
        "file.mtime".to_string(),
        PropertyValue::String(unix_secs_to_rfc3339(stat.mtime)),
    );

    NoteMetadata {
        path: abs_path.to_path_buf(),
        properties,
        links: cached.links.clone(),
        tags: cached.tags.clone(),
        agenda_markers: cached.agenda_markers.clone(),
        unresolved_suggestions: cached.unresolved_suggestions as usize,
        recurrence: cached.recurrence.clone(),
    }
}

fn unix_secs_to_rfc3339(secs: i64) -> String {
    use chrono::{DateTime, Utc};
    let dt = DateTime::<Utc>::from_timestamp(secs, 0)
        .unwrap_or_else(|| DateTime::<Utc>::from_timestamp(0, 0).unwrap());
    dt.to_rfc3339()
}

/// Filesystem stat results needed by the scanner and cache.
pub(crate) struct FileStat {
    pub mtime: i64,
    pub ctime: Option<i64>,
    pub size: u64,
}

/// Stat a file (no content read). Used to check cache freshness without
/// paying the cost of opening the file.
pub(crate) async fn stat_file(path: &Path) -> Result<FileStat> {
    let meta = tokio::fs::metadata(path).await?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let ctime = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);
    Ok(FileStat {
        mtime,
        ctime,
        size: meta.len(),
    })
}

/// List `.collection` files from the reserved `.inkycap/collections/`
/// directory. Returns an empty list if the directory is missing (callers
/// like the scanner must not fail just because a freshly imported notebox
/// hasn't been scaffolded yet).
async fn list_collection_files(
    storage: &dyn NoteboxStorage,
    notebox_root: &Path,
) -> Result<Vec<PathBuf>> {
    let dir = crate::notebox_package::collections_dir(notebox_root);
    if !storage.exists(&dir).await {
        return Ok(Vec::new());
    }
    storage.list_files(&dir, "*.collection").await
}

/// Scan all `.typ` files in a notebox directory. This is the no-cache cold
/// path: every file is read, compiled, and queried for metadata. Used as
/// a fallback when no cache is available.
pub async fn scan_notebox(
    storage: &dyn NoteboxStorage,
    notebox_root: &Path,
    compiler: &mut TypstCompiler,
) -> Result<ScanResult> {
    let note_files = storage.list_files(notebox_root, "*.typ").await?;
    let collection_files = list_collection_files(storage, notebox_root).await?;

    let mut notes = Vec::with_capacity(note_files.len());
    let mut contents = Vec::with_capacity(note_files.len());
    let mut file_mtimes = HashMap::with_capacity(note_files.len());
    let mut link_index = LinkIndex::new();

    for path in &note_files {
        // Log-and-skip a single unreadable/locked note (antivirus, a sync
        // tool mid-write) rather than failing the entire notebox scan — the
        // cache-aware path already skips per-file on stat failure.
        let (mut note, content) = match parse_note_from_disk(storage, path).await {
            Ok(v) => v,
            Err(err) => {
                log::warn!("scan: skipping unreadable note {}: {err}", path.display());
                continue;
            }
        };
        if let Ok(stat) = stat_file(path).await {
            file_mtimes.insert(path.clone(), stat.mtime);
        }

        // Extract body-derived metadata via typst query.
        let qr = query::compile_and_query(compiler, path, content.clone());
        enrich_with_query(&mut note, qr);

        let note_id: NoteId = path.clone();
        link_index.set_forward_links(note_id, note.links.clone());

        notes.push(note);
        contents.push((path.clone(), content));
    }

    // Resolve link targets and build backlinks
    let all_paths: Vec<PathBuf> = notes.iter().map(|n| n.path.clone()).collect();
    link_index.resolve_and_build_backlinks(&all_paths);

    Ok(ScanResult {
        notes,
        collection_files,
        link_index,
        contents,
        file_mtimes,
    })
}

/// Stats reported back from a cache-aware scan, mostly for logging and
/// future telemetry. Not user-facing.
#[derive(Debug, Default)]
pub struct CacheScanStats {
    pub total_files: usize,
    pub cache_hits: usize,
    pub cache_misses: usize,
    pub pruned: usize,
    /// Absolute paths of files that were pruned from the cache (deleted
    /// since last scan). Needed so callers can remove stale entries from
    /// the persisted search index.
    pub pruned_paths: Vec<PathBuf>,
}

/// Cache-aware notebox scan. For each file:
///
/// 1. `stat()` it (no read).
/// 2. If a cache entry exists with matching `(mtime, size)`, reuse the cached
///    metadata (which already contains query-derived links/tags/properties
///    from the previous scan). The file content is still needed for full-text
///    search.
/// 3. Otherwise, fall back to the full disk parse + `typst query`, and queue
///    the result for upsert into the cache.
///
/// After the scan, stale entries (files in the cache that no longer exist on
/// disk) are pruned, and the upsert batch is committed in a single transaction.
pub async fn scan_notebox_cached(
    storage: &dyn NoteboxStorage,
    notebox_root: &Path,
    cache: &MetadataCache,
    compiler: &mut TypstCompiler,
) -> Result<(ScanResult, CacheScanStats)> {
    let note_files = storage.list_files(notebox_root, "*.typ").await?;
    let collection_files = list_collection_files(storage, notebox_root).await?;

    let cached_by_relpath = cache.load_notebox(notebox_root)?;

    let mut notes = Vec::with_capacity(note_files.len());
    let mut contents = Vec::with_capacity(note_files.len());
    let mut file_mtimes = HashMap::with_capacity(note_files.len());
    let mut link_index = LinkIndex::new();
    let mut to_upsert: Vec<CachedFile> = Vec::new();
    let mut existing_relpaths: HashSet<PathBuf> = HashSet::new();
    let mut stats = CacheScanStats {
        total_files: note_files.len(),
        ..Default::default()
    };

    for path in &note_files {
        let relpath = path
            .strip_prefix(notebox_root)
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|_| path.clone());
        existing_relpaths.insert(relpath.clone());

        let stat = match stat_file(path).await {
            Ok(s) => s,
            Err(_) => {
                continue;
            }
        };
        file_mtimes.insert(path.clone(), stat.mtime);

        let mut used_cache = false;

        if let Some(cached) = cached_by_relpath.get(&relpath) {
            if crate::cache::store::is_fresh(cached, stat.mtime, stat.size) {
                let content_result = if let Some(ref cached_content) = cached.content {
                    Ok(cached_content.clone())
                } else {
                    storage.read_file(path).await
                };

                if let Ok(content) = content_result {
                    if cache_entry_looks_stale(cached, &content) {
                        // fall through to reparse
                    } else {
                        let note = cached_to_note(cached, path, notebox_root, &stat);
                        link_index.set_forward_links(path.clone(), note.links.clone());
                        notes.push(note);
                        contents.push((path.clone(), content));
                        stats.cache_hits += 1;
                        used_cache = true;
                    }
                }
            }
        }

        if !used_cache {
            // Log-and-skip a single unreadable note rather than aborting the
            // whole scan (the stat-failure branch above already skips per-file).
            let (mut note, content) = match parse_note_from_disk(storage, path).await {
                Ok(v) => v,
                Err(err) => {
                    log::warn!("scan: skipping unreadable note {}: {err}", path.display());
                    continue;
                }
            };

            // Extract body-derived metadata via typst query.
            let qr = query::compile_and_query(compiler, path, content.clone());
            enrich_with_query(&mut note, qr);

            link_index.set_forward_links(path.clone(), note.links.clone());
            to_upsert.push(note_to_cached_file(
                &note, relpath, stat.mtime, stat.size, &content,
            ));
            notes.push(note);
            contents.push((path.clone(), content));
            stats.cache_misses += 1;
        }
    }

    // Resolve link targets and build backlinks across the merged set.
    let all_paths: Vec<PathBuf> = notes.iter().map(|n| n.path.clone()).collect();
    link_index.resolve_and_build_backlinks(&all_paths);

    // Persist new/changed entries and prune deletions in one go.
    if let Err(err) = cache.upsert_many(notebox_root, &to_upsert) {
        log::warn!("metadata cache: upsert_many failed: {err}");
    }
    match cache.prune_collecting(notebox_root, &existing_relpaths) {
        Ok((n, pruned_relpaths)) => {
            stats.pruned = n;
            stats.pruned_paths = pruned_relpaths
                .into_iter()
                .map(|rp| notebox_root.join(rp))
                .collect();
        }
        Err(err) => log::warn!("metadata cache: prune failed: {err}"),
    }

    Ok((
        ScanResult {
            notes,
            collection_files,
            link_index,
            contents,
            file_mtimes,
        },
        stats,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::local::LocalNoteboxStorage;

    const CONTENT: &str = "#note(title: \"A\")\n#wikilink(\"B\")\n";

    /// A notebox with one note on disk and a cache entry for it that matches
    /// the file's current mtime and size.
    async fn notebox_with_cached_note(
        dir: &tempfile::TempDir,
    ) -> (LocalNoteboxStorage, MetadataCache, PathBuf, CachedFile) {
        let root = dir.path().join("notebox");
        std::fs::create_dir_all(&root).unwrap();
        let storage = LocalNoteboxStorage::new(root.clone()).unwrap();
        let root = storage.canonical_root().to_path_buf();
        let abs = root.join("note.typ");
        std::fs::write(&abs, CONTENT).unwrap();
        let stat = stat_file(&abs).await.unwrap();

        let cache = MetadataCache::open(&dir.path().join("cache.sqlite")).unwrap();
        let mut properties = HashMap::new();
        properties.insert("title".to_string(), PropertyValue::String("A".to_string()));
        let entry = CachedFile {
            path: PathBuf::from("note.typ"),
            mtime: stat.mtime,
            size: stat.size,
            properties,
            title: Some("A".to_string()),
            tags: Vec::new(),
            links: vec!["B".to_string()],
            agenda_markers: Vec::new(),
            recurrence: None,
            unresolved_suggestions: 0,
            content: Some(CONTENT.to_string()),
        };
        cache.upsert_file(&root, &entry).unwrap();
        (storage, cache, abs, entry)
    }

    /// A fresh entry is served as the scan would reconstitute it: the cached
    /// properties and links, plus the `file.*` properties from the path.
    #[tokio::test]
    async fn note_from_cache_serves_a_fresh_entry() {
        let dir = tempfile::tempdir().unwrap();
        let (storage, cache, abs, _) = notebox_with_cached_note(&dir).await;
        let root = storage.canonical_root().to_path_buf();

        let note = note_from_cache(&storage, &cache, &root, &abs)
            .await
            .expect("fresh entry is served");
        assert_eq!(note.path, abs);
        assert_eq!(
            note.properties.get("title"),
            Some(&PropertyValue::String("A".to_string()))
        );
        assert_eq!(
            note.properties.get("file.name"),
            Some(&PropertyValue::String("note.typ".to_string()))
        );
        assert_eq!(note.links, vec!["B".to_string()]);
    }

    /// Once the file on disk no longer matches the entry's recorded size, the
    /// entry is not served, so a reader never sees values the next scan will
    /// replace.
    #[tokio::test]
    async fn note_from_cache_refuses_an_entry_the_file_has_outgrown() {
        let dir = tempfile::tempdir().unwrap();
        let (storage, cache, abs, _) = notebox_with_cached_note(&dir).await;
        let root = storage.canonical_root().to_path_buf();

        std::fs::write(&abs, format!("{CONTENT}#tag(\"new\")\n")).unwrap();

        assert!(note_from_cache(&storage, &cache, &root, &abs)
            .await
            .is_none());
    }

    /// An entry the scan would re-parse anyway (no links recorded for a file
    /// that visibly has a wikilink) is not served either, and a file with no
    /// entry is a miss.
    #[tokio::test]
    async fn note_from_cache_refuses_stale_looking_and_missing_entries() {
        let dir = tempfile::tempdir().unwrap();
        let (storage, cache, abs, entry) = notebox_with_cached_note(&dir).await;
        let root = storage.canonical_root().to_path_buf();

        let mut no_links = entry.clone();
        no_links.links.clear();
        cache.upsert_file(&root, &no_links).unwrap();
        assert!(note_from_cache(&storage, &cache, &root, &abs)
            .await
            .is_none());

        let other = root.join("other.typ");
        std::fs::write(&other, CONTENT).unwrap();
        assert!(note_from_cache(&storage, &cache, &root, &other)
            .await
            .is_none());
    }
}
