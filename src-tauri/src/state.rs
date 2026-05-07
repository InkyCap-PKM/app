use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use notify::RecommendedWatcher;
use tokio::sync::{Mutex, RwLock};

use crate::bookmarks::{self, Bookmark};
use crate::cache::MetadataCache;
use crate::link_index::LinkIndex;
use crate::property_types::PropertyTypeRegistry;
use crate::recovery::SnapshotManager;
use crate::scanner::property_index::PropertyIndex;
use crate::search::engine::{PersistedSearchIndex, SearchEngine};
use crate::settings::{CitationSettings, UserSettings};
use crate::storage::local::LocalVaultStorage;
use crate::storage::traits::VaultStorage;
use crate::typst_pipeline::TypstCompiler;

/// Summary stats produced by [`AppState::build_indexes`], used to populate
/// the `vault:index-ready` event payload sent to the frontend.
#[derive(Debug, Clone, serde::Serialize)]
pub struct IndexStats {
    pub file_count: usize,
    pub collection_count: usize,
    pub property_keys: Vec<String>,
}

/// Global application state, managed by Tauri.
///
/// **Lock ordering invariant.** Several fields below are `RwLock`s and any
/// code path that holds more than one of them at the same time MUST acquire
/// them in this order to prevent deadlocks:
///
/// 1. `link_index`
/// 2. `property_index`
/// 3. `search_engine`
/// 4. `metadata_cache`
///
/// Non-nested single-lock acquisitions (acquire, use, release, then acquire
/// the next) are always safe. The one helper that nests two locks is
/// [`AppState::reindex_note`], which holds `link_index` (write) while
/// briefly acquiring `property_index` (read) to snapshot the note path set.
/// If you add a helper that nests differently, either follow the order
/// above or split it into sequential single-lock steps.
pub struct AppState {
    pub vault_root: RwLock<Option<PathBuf>>,
    pub storage: RwLock<Option<Arc<LocalVaultStorage>>>,
    pub property_index: RwLock<PropertyIndex>,
    pub link_index: RwLock<LinkIndex>,
    pub collection_files: RwLock<Vec<PathBuf>>,
    /// File watcher handle — kept alive as long as a vault is open.
    pub watcher: RwLock<Option<RecommendedWatcher>>,
    /// User-configurable settings, persisted to disk.
    pub settings: RwLock<UserSettings>,
    /// Full-text search engine with inverted index.
    pub search_engine: RwLock<SearchEngine>,
    /// User bookmarks (notes, searches, headings, collections).
    pub bookmarks: RwLock<Vec<Bookmark>>,
    /// File recovery snapshot manager.
    pub snapshot_manager: RwLock<SnapshotManager>,
    /// Persistent metadata cache (SQLite). Optional because cache open is
    /// best-effort — a missing or corrupt cache should never block app launch.
    pub metadata_cache: RwLock<Option<Arc<MetadataCache>>>,
    /// Global property type registry, persisted per-vault.
    pub property_types: RwLock<PropertyTypeRegistry>,
    /// Typst compile pipeline, instantiated on vault open. The Mutex (rather
    /// than RwLock) is intentional: every compile mutates the underlying
    /// World's source/main caches, so all access is single-writer.
    pub typst_compiler: Mutex<Option<TypstCompiler>>,
    /// Unix timestamp of the last search index save. Used to debounce
    /// persistence — the index is only written to disk if at least
    /// `SEARCH_SAVE_INTERVAL_SECS` have elapsed since the last save.
    last_search_save: AtomicI64,
}

impl AppState {
    pub fn new() -> Self {
        let settings = crate::settings::load_settings();
        // Open the persistent metadata cache. We can't use the Tauri AppHandle
        // here (this is called inside the builder), so we resolve the data
        // directory via `dirs` — same approach the rest of the codebase uses
        // for config / bookmarks. A cache failure is logged and the app
        // continues with no cache (slow path).
        let metadata_cache = Self::open_metadata_cache();
        Self {
            vault_root: RwLock::new(None),
            storage: RwLock::new(None),
            property_index: RwLock::new(PropertyIndex::new()),
            link_index: RwLock::new(LinkIndex::new()),
            collection_files: RwLock::new(Vec::new()),
            watcher: RwLock::new(None),
            settings: RwLock::new(settings),
            search_engine: RwLock::new(SearchEngine::new()),
            bookmarks: RwLock::new(bookmarks::load_bookmarks().unwrap_or_default()),
            snapshot_manager: RwLock::new(SnapshotManager::new()),
            metadata_cache: RwLock::new(metadata_cache),
            property_types: RwLock::new(PropertyTypeRegistry::new()),
            typst_compiler: Mutex::new(None),
            last_search_save: AtomicI64::new(0),
        }
    }

    /// Resolve the cache database path under the user's data directory and
    /// open it. Errors are logged and surfaced as `None` so callers fall back
    /// to the cacheless cold path.
    fn open_metadata_cache() -> Option<Arc<MetadataCache>> {
        let data_dir = dirs::data_dir()?.join("inkycap");
        let db_path = data_dir.join("metadata-cache.sqlite");
        match MetadataCache::open(&db_path) {
            Ok(cache) => Some(Arc::new(cache)),
            Err(err) => {
                eprintln!(
                    "metadata cache: failed to open at {}: {err}",
                    db_path.display()
                );
                None
            }
        }
    }

    /// Fast vault open: sets `vault_root`, `storage`, lists collection files, clears
    /// the indexes, and returns the rough `.typ` file count from a directory
    /// walk. The expensive metadata parse / link resolution / search index
    /// build happens later in [`AppState::build_indexes`], typically spawned
    /// as a background task by the `open_vault` Tauri command.
    ///
    /// Returns the number of note files discovered, so the caller can
    /// populate `VaultInfo.file_count` immediately.
    pub async fn open_vault_fast(&self, path: PathBuf) -> crate::errors::Result<usize> {
        let storage = Arc::new(LocalVaultStorage::new(path.clone())?);
        // Canonicalize the root so that every in-memory path we store uses
        // the same prefix that the storage layer validates against. This
        // prevents subtle mismatches when the user-supplied path contains a
        // symlink or trailing separators.
        let canonical_path = storage.canonical_root().to_path_buf();

        // Cheap directory walks — no file reads, no parsing.
        let note_files = storage.list_files(&canonical_path, "*.typ").await?;
        let collection_files = storage.list_files(&canonical_path, "*.collection").await?;
        let note_count = note_files.len();

        // Reset stale state from any previously open vault before swapping in
        // the new vault root. Empty indexes are fine — UI features that depend
        // on them should show a loading state until `vault:index-ready` fires.
        *self.property_index.write().await = PropertyIndex::new();
        *self.link_index.write().await = LinkIndex::new();
        *self.search_engine.write().await = SearchEngine::new();

        *self.collection_files.write().await = collection_files;
        *self.property_types.write().await = PropertyTypeRegistry::load(&canonical_path);

        // Scaffold the inkycap-vault package into .inkycap/packages/ so
        // notes can `#import` it. Must happen before the compiler is
        // constructed so that package files are on disk for any compile.
        crate::vault_package::scaffold(&canonical_path);

        // Pre-warm the Typst compiler at vault-open time so the first
        // reading-mode render doesn't pay the ~340ms font-discovery cost
        // measured in the Phase 0 bench. Construction is synchronous; future
        // work that adds system fonts may want to spawn this off-thread.
        let mut compiler = TypstCompiler::new(canonical_path.clone());
        {
            let settings = self.settings.read().await;
            let style = settings.citations.custom_csl_path.clone()
                .or_else(|| settings.citations.citation_style.as_deref()
                    .filter(|s| *s != "custom")
                    .map(String::from));
            compiler.set_bibliography_style(style);
        }
        *self.typst_compiler.lock().await = Some(compiler);
        *self.vault_root.write().await = Some(canonical_path);
        *self.storage.write().await = Some(storage);

        Ok(note_count)
    }

    /// Build the property index, link index, and full-text search index for
    /// the currently open vault. Intended to run as a background task after
    /// [`AppState::open_vault_fast`]; the indexes are computed locally and
    /// then swapped into `AppState` with brief write locks so that read-side
    /// IPC commands aren't blocked for the entire build.
    pub async fn build_indexes(&self) -> crate::errors::Result<IndexStats> {
        let (storage, vault_root) = {
            let storage = self
                .storage
                .read()
                .await
                .clone()
                .ok_or(crate::errors::InkyCapError::VaultNotOpen)?;
            let vault_root = self
                .vault_root
                .read()
                .await
                .clone()
                .ok_or(crate::errors::InkyCapError::VaultNotOpen)?;
            (storage, vault_root)
        };

        let cache = self.metadata_cache.read().await.clone();

        // Acquire the compiler for the duration of the scan so that
        // `typst query` metadata extraction can run. The compiler
        // mutex is the only exclusive lock here — other state locks
        // (property_index, link_index, etc.) are acquired only briefly
        // at the end for the swap.
        let mut compiler_guard = self.typst_compiler.lock().await;
        let compiler = compiler_guard
            .as_mut()
            .ok_or(crate::errors::InkyCapError::VaultNotOpen)?;

        let (scan, cache_stats) = if let Some(cache) = cache.as_ref() {
            let (scan, stats) = crate::scanner::walker::scan_vault_cached(
                storage.as_ref(),
                &vault_root,
                cache.as_ref(),
                compiler,
            )
            .await?;
            eprintln!(
                "metadata cache: {} files, {} hits, {} misses, {} pruned",
                stats.total_files, stats.cache_hits, stats.cache_misses, stats.pruned
            );
            (scan, Some(stats))
        } else {
            let s = crate::scanner::walker::scan_vault(
                storage.as_ref(),
                &vault_root,
                compiler,
            )
            .await?;
            (s, None)
        };

        // Release the compiler before the index-swap section, which
        // acquires other locks. No nesting hazard.
        drop(compiler_guard);
        let crate::scanner::walker::ScanResult {
            notes,
            collection_files,
            link_index,
            contents,
            file_mtimes,
        } = scan;

        let property_index = PropertyIndex::build(notes);

        // Try to load the persisted search index and incrementally update it
        // rather than rebuilding from scratch.
        let index_path = search_index_path(&vault_root);
        let search_engine = if let Some(persisted) = PersistedSearchIndex::load_from_file(&index_path) {
            let mut engine = persisted.engine;
            let saved_at = persisted.saved_at;

            // Remove docs for files that were pruned (deleted since last scan).
            if let Some(ref stats) = cache_stats {
                for path in &stats.pruned_paths {
                    engine.remove_doc(path);
                }
            }

            // Determine which files need search updates: files whose mtime is
            // newer than the persisted snapshot, or files not yet in the engine.
            let current_paths: HashSet<&Path> = contents.iter().map(|(p, _)| p.as_path()).collect();
            let stale_engine_paths: Vec<PathBuf> = engine
                .indexed_paths()
                .into_iter()
                .filter(|p| !current_paths.contains(*p))
                .map(|p| p.to_path_buf())
                .collect();
            for path in &stale_engine_paths {
                engine.remove_doc(path);
            }

            let mut updated = 0usize;
            for (path, content) in &contents {
                let mtime = file_mtimes.get(path).copied().unwrap_or(0);
                let needs_update = mtime > saved_at || !engine.contains_path(path);
                if needs_update {
                    let (tags, title, keys, values) = extract_search_meta(&property_index, path);
                    engine.update_doc(path, content, tags, title, keys, values);
                    updated += 1;
                }
            }

            eprintln!(
                "search index: loaded persisted, {} updated, {} pruned",
                updated, stale_engine_paths.len() + cache_stats.as_ref().map_or(0, |s| s.pruned_paths.len())
            );
            engine
        } else {
            // No persisted index — build from scratch.
            let search_files: Vec<(
                PathBuf,
                String,
                Vec<String>,
                Option<String>,
                Vec<String>,
                std::collections::HashMap<String, Vec<String>>,
            )> = contents
                .into_iter()
                .map(|(path, content)| {
                    let (tags, title, keys, values) = extract_search_meta(&property_index, &path);
                    (path, content, tags, title, keys, values)
                })
                .collect();
            eprintln!("search index: built from scratch ({} files)", search_files.len());
            SearchEngine::build(search_files)
        };
        // Save the search engine for next launch.
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let persisted = PersistedSearchIndex {
            engine: search_engine,
            saved_at: now,
        };
        persisted.save_to_file(&index_path);
        let search_engine = persisted.engine;

        let stats = IndexStats {
            file_count: property_index.note_count(),
            collection_count: collection_files.len(),
            property_keys: property_index.property_keys.iter().cloned().collect(),
        };

        *self.property_index.write().await = property_index;
        *self.link_index.write().await = link_index;
        *self.collection_files.write().await = collection_files;
        *self.search_engine.write().await = search_engine;

        Ok(stats)
    }

    /// Write a freshly re-parsed note through to the persistent metadata
    /// cache. Called from the in-app mutation paths (file_ops, files,
    /// creation_rules) so that warm starts after lots of editing don't have
    /// to re-parse those files. Errors are logged and swallowed — cache
    /// write-through is a performance optimization, not a correctness
    /// requirement.
    pub async fn cache_upsert_note(
        &self,
        abs_path: &std::path::Path,
        note: &crate::models::note::NoteMetadata,
        content: &str,
    ) {
        let cache = match self.metadata_cache.read().await.clone() {
            Some(c) => c,
            None => return,
        };
        let vault_root = match self.vault_root.read().await.clone() {
            Some(r) => r,
            None => return,
        };
        let relpath = abs_path
            .strip_prefix(&vault_root)
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|_| abs_path.to_path_buf());

        let stat = match crate::scanner::walker::stat_file(abs_path).await {
            Ok(s) => s,
            Err(err) => {
                eprintln!(
                    "metadata cache: stat failed for {}: {err}",
                    abs_path.display()
                );
                return;
            }
        };

        let cached =
            crate::scanner::walker::note_to_cached_file(note, relpath, stat.mtime, stat.size, content);
        if let Err(err) = cache.upsert_file(&vault_root, &cached) {
            eprintln!("metadata cache: upsert_file failed: {err}");
        }
    }

    /// Remove a note's entry from the persistent metadata cache. Called from
    /// the in-app deletion paths so a deleted file doesn't linger in the
    /// cache and reappear on next launch.
    pub async fn cache_remove_note(&self, abs_path: &std::path::Path) {
        let cache = match self.metadata_cache.read().await.clone() {
            Some(c) => c,
            None => return,
        };
        let vault_root = match self.vault_root.read().await.clone() {
            Some(r) => r,
            None => return,
        };
        let relpath = abs_path
            .strip_prefix(&vault_root)
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|_| abs_path.to_path_buf());
        if let Err(err) = cache.delete_file(&vault_root, &relpath) {
            eprintln!("metadata cache: delete_file failed: {err}");
        }
    }

    pub async fn get_storage(&self) -> crate::errors::Result<Arc<LocalVaultStorage>> {
        self.storage
            .read()
            .await
            .clone()
            .ok_or(crate::errors::InkyCapError::VaultNotOpen)
    }

    /// Re-index a single note across **every** in-memory index (link, search,
    /// property) and write through to the persistent metadata cache.
    ///
    /// This is the single authoritative write-through path. Any mutation of a
    /// note — creation, content save, property update, rename — must funnel
    /// through here so the indices and cache stay coherent. Previously this
    /// logic was duplicated in `commands::files` and `commands::file_ops`, and
    /// the two copies drifted: the `files` copy forgot to touch the search
    /// engine, so saves made via the editor never updated full-text search
    /// until the next vault re-open.
    ///
    /// Lock ordering (to avoid deadlocks with the watcher-side path):
    ///   0. typst_compiler (acquired first, released before index locks)
    ///   1. link_index (write)
    ///   2. property_index (read, then dropped)
    ///   3. search_engine (write)
    ///   4. metadata cache (via `cache_upsert_note`, acquires its own guard)
    ///   5. property_index (write, last — consumes the parsed note)
    pub async fn reindex_note(&self, path: &std::path::Path, content: &str) {
        let vault_root = self.vault_root.read().await;
        let Some(root) = vault_root.as_ref() else {
            return;
        };
        let root = root.clone();
        drop(vault_root);

        // Acquire the compiler for typst query, then release it before
        // taking any index locks (no nesting).
        let mut note = {
            let mut compiler_guard = self.typst_compiler.lock().await;
            crate::scanner::walker::parse_note(
                path,
                content,
                &root,
                compiler_guard.as_mut(),
            )
        };

        // parse_note does not populate file.* properties (those come from
        // the filesystem). Carry forward the existing file.* entries so
        // filters like `file.ext == "typ"` keep working after reindex.
        {
            let prop_index = self.property_index.read().await;
            if let Some(old) = prop_index.notes.get(&path.to_path_buf()) {
                for (k, v) in &old.properties {
                    if k.starts_with("file.") {
                        note.properties.entry(k.clone()).or_insert_with(|| v.clone());
                    }
                }
            }
        }

        // 1. Link index: forget the old links, record the new ones, resolve.
        let mut link_index = self.link_index.write().await;
        link_index.remove_note(&path.to_path_buf());
        for link_target in &note.links {
            link_index.add_link(path.to_path_buf(), link_target.clone());
        }
        let all_paths: Vec<std::path::PathBuf> = {
            let prop_index = self.property_index.read().await;
            prop_index.notes.keys().cloned().collect()
        };
        link_index.resolve_note_links(&path.to_path_buf(), &all_paths);
        drop(link_index);

        // 2. Search engine.
        let tags = note.tags.clone();
        let title = note.properties.get("title").and_then(|v| {
            if let crate::models::note::PropertyValue::String(s) = v {
                Some(s.clone())
            } else {
                None
            }
        });
        let property_keys: Vec<String> = note
            .properties
            .keys()
            .filter(|k| !k.starts_with("file."))
            .cloned()
            .collect();
        let property_values =
            crate::search::engine::flatten_property_values(&note.properties);
        {
            let mut engine = self.search_engine.write().await;
            engine.update_doc(path, content, tags, title, property_keys, property_values);
        }

        // 3. Persistent cache write-through (best-effort).
        self.cache_upsert_note(path, &note, content).await;

        // 4. Property index — last, because it consumes `note`.
        let mut prop_index = self.property_index.write().await;
        prop_index.update_note(note);
        drop(prop_index);

        // 5. Debounced search index persistence.
        self.maybe_save_search_index().await;
    }

    /// Remove a note from every index AND from the persistent metadata cache.
    /// Companion to [`reindex_note`].
    pub async fn remove_from_indices(&self, path: &std::path::Path) {
        let path_buf = path.to_path_buf();

        {
            let mut link_index = self.link_index.write().await;
            link_index.remove_note(&path_buf);
        }
        {
            let mut prop_index = self.property_index.write().await;
            prop_index.remove_note(&path_buf);
        }
        {
            let mut engine = self.search_engine.write().await;
            engine.remove_doc(path);
        }
        self.cache_remove_note(path).await;
        self.maybe_save_search_index().await;
    }

    /// Save the search index to disk if at least 60 seconds have elapsed
    /// since the last save. Called after mutations to keep the persisted
    /// snapshot reasonably fresh without hammering the disk on every edit.
    async fn maybe_save_search_index(&self) {
        const SEARCH_SAVE_INTERVAL_SECS: i64 = 60;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let last = self.last_search_save.load(Ordering::Relaxed);
        if now - last < SEARCH_SAVE_INTERVAL_SECS {
            return;
        }

        let vault_root = match self.vault_root.read().await.clone() {
            Some(r) => r,
            None => return,
        };

        let engine = self.search_engine.read().await;
        let index_path = search_index_path(&vault_root);
        PersistedSearchIndex::save_borrowed(&engine, now, &index_path);
        self.last_search_save.store(now, Ordering::Relaxed);
    }
}

/// Resolve the on-disk path for the persisted search index. Keyed by a
/// hash of the vault root so multiple vaults don't collide.
fn search_index_path(vault_root: &Path) -> PathBuf {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(vault_root.to_string_lossy().as_bytes());
    let short = &hex::encode(&hash)[..16];
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("inkycap")
        .join(format!("search-index-{short}.bin"))
}

/// Tiny hex encoder (avoids pulling in the `hex` crate).
mod hex {
    pub fn encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}

/// Extract search metadata (tags, title, property keys, property values)
/// for a single note from the property index.
fn extract_search_meta(
    property_index: &PropertyIndex,
    path: &Path,
) -> (
    Vec<String>,
    Option<String>,
    Vec<String>,
    std::collections::HashMap<String, Vec<String>>,
) {
    property_index
        .notes
        .get(path)
        .map(|note| {
            let title = note.properties.get("title").and_then(|v| {
                if let crate::models::note::PropertyValue::String(s) = v {
                    Some(s.clone())
                } else {
                    None
                }
            });
            let keys: Vec<String> = note
                .properties
                .keys()
                .filter(|k| !k.starts_with("file."))
                .cloned()
                .collect();
            let values =
                crate::search::engine::flatten_property_values(&note.properties);
            (note.tags.clone(), title, keys, values)
        })
        .unwrap_or_else(|| {
            (
                Vec::new(),
                None,
                Vec::new(),
                std::collections::HashMap::new(),
            )
        })
}

/// Resolve the bibliography override path based on citation settings.
/// When the source is "zotero", reads entries from the Zotero database and
/// exports them to `.inkycap/zotero-export.bib` so the Typst compiler can
/// resolve `@key` citations. Returns the vault-relative path to use as the
/// bibliography override.
pub fn configure_bibliography(
    vault_root: &Path,
    citations: &CitationSettings,
) -> Option<String> {
    match citations.source.as_str() {
        "zotero" => {
            let db = citations
                .zotero_database_path
                .as_ref()
                .map(PathBuf::from)
                .or_else(|| crate::typst_pipeline::zotero::auto_detect_path());
            let Some(db_path) = db else { return None };
            match crate::typst_pipeline::zotero::read_entries(&db_path) {
                Ok(entries) => {
                    match crate::typst_pipeline::bibliography::write_zotero_export(vault_root, &entries) {
                        Ok(rel_path) => Some(rel_path),
                        Err(e) => {
                            eprintln!("Failed to write Zotero export: {e}");
                            None
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Failed to read Zotero entries: {e}");
                    None
                }
            }
        }
        _ => citations.bibliography_path.clone(),
    }
}
