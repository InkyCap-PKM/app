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
        content: Some(content.to_string()),
    }
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
    let folder = abs_path
        .parent()
        .map(|p| {
            p.strip_prefix(notebox_root)
                .unwrap_or(p)
                .display()
                .to_string()
        })
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
        .map(|p| crate::storage::to_frontend_string(p))
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
        let (mut note, content) = parse_note_from_disk(storage, path).await?;
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
                    // Reject cache entries that look like a previous compile
                    // failure: zero properties parsed from a file that visibly
                    // has a `#note(...)` call. These come from older builds
                    // where a body-only error (e.g. unresolved citation)
                    // tanked the whole compile and stored an empty result.
                    // The body-stripped fallback in `compile_and_query` will
                    // succeed on the re-parse path below.
                    let non_file_props = cached.properties.keys().any(|k| !k.starts_with("file."));
                    let cached_empty = !non_file_props && cached.tags.is_empty();
                    let looks_like_note = content.contains("#note(");
                    // Same idea but specifically for wikilinks: a cached
                    // `links = []` for a file that visibly contains a
                    // `#wikilink("…")` (or the `[[…]]` shortcut) means the
                    // earlier parse missed them. Without this the right-
                    // panel Links pane silently shows "No outbound links"
                    // even after the user adds wikilinks, because the
                    // cache lookup short-circuits the reparse path. Cheap
                    // substring check — false positives just trigger an
                    // unnecessary reparse, which is harmless.
                    let cached_no_links = cached.links.is_empty();
                    let content_has_wikilinks =
                        content.contains("#wikilink(") || content.contains("[[");
                    if (cached_empty && looks_like_note)
                        || (cached_no_links && content_has_wikilinks)
                    {
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
            let (mut note, content) = parse_note_from_disk(storage, path).await?;

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
