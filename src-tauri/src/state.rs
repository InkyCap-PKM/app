use notify::RecommendedWatcher;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, Notify, RwLock};

use crate::bookmarks::{self, Bookmark};
use crate::cache::MetadataCache;
use crate::corpus_stats::{CorpusStats, PersistedCorpusStats};
use crate::link_index::LinkIndex;
use crate::notebox_settings::{NoteboxCitationSettings, NoteboxSettings};
use crate::property_types::PropertyTypeRegistry;
use crate::scanner::property_index::PropertyIndex;
use crate::search::engine::{PersistedSearchIndex, SearchEngine};
use crate::settings::{CitationSettings, UserSettings};
use crate::storage::local::LocalNoteboxStorage;
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::TypstCompiler;

/// Summary stats produced by [`NoteboxSession::build_indexes`], used to
/// populate the `notebox:index-ready` event payload sent to the frontend.
#[derive(Debug, Clone, serde::Serialize)]
pub struct IndexStats {
    pub file_count: usize,
    pub collection_count: usize,
    pub property_keys: Vec<String>,
}

/// Everything that belongs to one open notebox in one window. Each window (by
/// Tauri label: `main`, `note-docs`, `note-<ts>`) owns one, looked up with
/// [`AppState::session`], so windows can show different noteboxes.
///
/// **Lock order.** Code holding more than one of these `RwLock`s at once must
/// take them in this order:
///
/// 1. `link_index`
/// 2. `property_index`
/// 3. `search_engine`
///
/// The shared `metadata_cache` is used last, after these are released. Taking
/// one lock at a time is always safe. [`NoteboxSession::reindex_note`] is the
/// one helper that nests two: it holds `link_index` (write) while briefly
/// reading `property_index`. A new helper must follow this order or take locks
/// one at a time.
///
/// The `AppState::sessions` map lock is only taken beforehand, to clone out the
/// session `Arc`, and never held while a session lock is taken.
pub struct NoteboxSession {
    /// Tauri window label that owns this session. Used to target events
    /// (`emit_to`) at the right window's webview.
    pub owner_label: String,
    pub notebox_root: RwLock<Option<PathBuf>>,
    pub storage: RwLock<Option<Arc<LocalNoteboxStorage>>>,
    pub property_index: RwLock<PropertyIndex>,
    pub link_index: RwLock<LinkIndex>,
    pub collection_files: RwLock<Vec<PathBuf>>,
    /// File watcher handle — kept alive as long as a notebox is open.
    pub watcher: RwLock<Option<RecommendedWatcher>>,
    /// Abort handle for the notebox health monitor (see
    /// [`crate::notebox_health`]), so opening a notebox can stop the previous
    /// one.
    pub health_monitor: RwLock<Option<tokio::task::AbortHandle>>,
    /// Per-notebox settings from `<notebox>/.inkycap/settings.json`, loaded in
    /// `open_notebox_fast`. Defaults until a notebox is open.
    pub notebox_settings: RwLock<NoteboxSettings>,
    /// Full-text search engine with inverted index.
    pub search_engine: RwLock<SearchEngine>,
    /// Corpus statistics for the Mycelial View (TF-IDF + PMI).
    pub corpus_stats: RwLock<CorpusStats>,
    /// Property type registry for this notebox, persisted per-notebox.
    pub property_types: RwLock<PropertyTypeRegistry>,
    /// Typst compiler, created on notebox open. A Mutex because every compile
    /// changes the World's caches.
    pub typst_compiler: Mutex<Option<TypstCompiler>>,
    /// Persistent metadata cache (SQLite), shared by all windows and keyed by
    /// notebox root. Optional because opening it can fail.
    metadata_cache: Option<Arc<MetadataCache>>,
    /// True once [`NoteboxSession::build_indexes`] has finished, successfully
    /// or not. Cleared on open. Until then, lookups the empty indexes can't
    /// answer are served from the metadata cache rather than parsed, so they
    /// don't wait for the scan.
    index_ready: AtomicBool,
    /// Unix time of the last search index save, for debouncing (see
    /// `SEARCH_SAVE_INTERVAL_SECS`).
    last_search_save: AtomicI64,
    /// Unix timestamp of the last corpus-stats save. Same debounce as the
    /// search index — both are caches reconciled against file mtimes on open.
    last_corpus_save: AtomicI64,
    /// True when the open notebox is the bundled documentation notebox: content
    /// writes do nothing, structural changes are refused, and its own font
    /// cascade applies. Set on every `open_notebox`.
    is_documentation: AtomicBool,
    /// Folders outside the notebox the user chose in a backend save/folder
    /// dialog; export commands only write inside these.
    pub export_grants: crate::storage::export_grants::ExportGrants,
    /// Held for the whole of an index build, so builds run one at a time.
    index_build_lock: Mutex<()>,
    /// The background index build currently running, if any. A newer build,
    /// or opening another notebox in this window, cancels it.
    index_build_task: StdMutex<Option<tokio::task::AbortHandle>>,
    /// Notes changed while an index build runs; `None` when none runs. The
    /// build reads every note first and swaps its results in at the end, so a
    /// change applied in between would be overwritten. Changes are recorded
    /// here instead and replayed from disk after the build. This also keeps
    /// saves from waiting on the compiler.
    changed_during_build: StdMutex<Option<Vec<PathBuf>>>,
}

impl NoteboxSession {
    fn new(owner_label: String, metadata_cache: Option<Arc<MetadataCache>>) -> Self {
        Self {
            owner_label,
            notebox_root: RwLock::new(None),
            storage: RwLock::new(None),
            property_index: RwLock::new(PropertyIndex::new()),
            link_index: RwLock::new(LinkIndex::new()),
            collection_files: RwLock::new(Vec::new()),
            watcher: RwLock::new(None),
            health_monitor: RwLock::new(None),
            notebox_settings: RwLock::new(NoteboxSettings::default()),
            search_engine: RwLock::new(SearchEngine::new()),
            corpus_stats: RwLock::new(CorpusStats::new(None)),
            property_types: RwLock::new(PropertyTypeRegistry::new()),
            typst_compiler: Mutex::new(None),
            metadata_cache,
            index_ready: AtomicBool::new(false),
            last_search_save: AtomicI64::new(0),
            last_corpus_save: AtomicI64::new(0),
            is_documentation: AtomicBool::new(false),
            export_grants: Default::default(),
            index_build_lock: Mutex::new(()),
            index_build_task: StdMutex::new(None),
            changed_during_build: StdMutex::new(None),
        }
    }

    /// Mark whether this session serves the documentation notebox. Called by
    /// `open_notebox`.
    pub fn set_documentation(&self, value: bool) {
        self.is_documentation
            .store(value, std::sync::atomic::Ordering::Relaxed);
    }

    /// True when the open notebox is the documentation notebox. Content writes then
    /// do nothing (edits stay in the editor) and structural changes fail with
    /// [`InkyCapError::DocumentationReadOnly`].
    pub fn is_documentation(&self) -> bool {
        self.is_documentation
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Fast notebox open: set `notebox_root` and `storage`, list collections, clear the
    /// indexes and return the approximate number of `.typ` files. The slow work happens
    /// later in [`NoteboxSession::build_indexes`], usually as a background task started
    /// by `open_notebox`.
    ///
    /// `global_citations` is passed in because the compiler's citation style falls back
    /// to the global style when the notebox has none.
    pub async fn open_notebox_fast(
        &self,
        path: PathBuf,
        global_citations: &CitationSettings,
    ) -> crate::errors::Result<usize> {
        let storage = Arc::new(LocalNoteboxStorage::new(path.clone())?);
        // Use the canonical root everywhere, matching what the storage layer
        // validates (symlinks, trailing separators).
        let canonical_path = storage.canonical_root().to_path_buf();

        // Create the `.inkycap/` folders first so the collections folder exists
        // before it is listed. Idempotent.
        crate::notebox_package::scaffold(&canonical_path);

        // Cheap directory walks — no file reads, no parsing.
        let note_files = storage.list_files(&canonical_path, "*.typ").await?;
        let collections_dir = crate::notebox_package::collections_dir(&canonical_path);
        let collection_files = if storage.exists(&collections_dir).await {
            storage.list_files(&collections_dir, "*.collection").await?
        } else {
            Vec::new()
        };
        let note_count = note_files.len();

        // A build still running for the previous notebox would swap its indexes
        // in after this reset.
        self.cancel_index_build();
        *lock_ignoring_poison(&self.changed_during_build) = None;

        // Clear the previous notebox's state. Features using the indexes show a
        // loading state until `notebox:index-ready`.
        *self.property_index.write().await = PropertyIndex::new();
        *self.link_index.write().await = LinkIndex::new();
        *self.search_engine.write().await = SearchEngine::new();
        self.index_ready.store(false, Ordering::Relaxed);

        *self.collection_files.write().await = collection_files;
        *self.property_types.write().await = PropertyTypeRegistry::load(&canonical_path);

        // Load this notebox's settings.
        *self.notebox_settings.write().await =
            crate::notebox_settings::load_settings(&canonical_path);

        // (Scaffold already ran above so the notebox library is on disk
        // before the compiler is constructed.)

        // Create the Typst compiler now, so the first reading-mode render
        // doesn't pay for font discovery (about 340ms).
        let mut compiler = TypstCompiler::new(canonical_path.clone());
        {
            let notebox = self.notebox_settings.read().await;
            // The notebox's `custom_csl_path` overrides the global style;
            // "custom" with no path means no style.
            let style = notebox.citations.custom_csl_path.clone().or_else(|| {
                global_citations
                    .citation_style
                    .as_deref()
                    .filter(|s| *s != "custom")
                    .map(String::from)
            });
            compiler.set_bibliography_style(style);
        }
        *self.typst_compiler.lock().await = Some(compiler);
        *self.notebox_root.write().await = Some(canonical_path);
        *self.storage.write().await = Some(storage);

        Ok(note_count)
    }

    /// Build the property, link and search indexes for this notebox. Runs as a
    /// background task after [`NoteboxSession::open_notebox_fast`]; results are
    /// computed locally and swapped in with brief write locks, so reads aren't
    /// blocked during the build.
    ///
    /// Marks the session index-ready when done, successful or not.
    pub async fn build_indexes(&self) -> crate::errors::Result<IndexStats> {
        let _one_build_at_a_time = self.index_build_lock.lock().await;
        self.build_indexes_locked().await
    }

    /// Body of [`build_indexes`]; the caller holds `index_build_lock`.
    async fn build_indexes_locked(&self) -> crate::errors::Result<IndexStats> {
        // Start recording changed notes. A cancelled build may have left
        // entries behind; they still need replaying, so keep them.
        lock_ignoring_poison(&self.changed_during_build).get_or_insert_with(Vec::new);
        let result = self.build_indexes_inner().await;
        // Stop recording and apply the notes changed during the build, on
        // failure too, or those changes would be lost.
        let changed = lock_ignoring_poison(&self.changed_during_build)
            .take()
            .unwrap_or_default();
        self.replay_changed_notes(changed).await;
        self.index_ready.store(true, Ordering::Relaxed);
        // The build frees far more than it keeps (every note's compile, the
        // scan's copies of note text); give that memory back.
        crate::memory::return_free_memory();
        result
    }

    /// Remember `task` as this session's background index build, cancelling
    /// the one it replaces (the new build covers the same work).
    pub fn replace_index_build(&self, task: tokio::task::AbortHandle) {
        if let Some(previous) = lock_ignoring_poison(&self.index_build_task).replace(task) {
            previous.abort();
        }
    }

    /// Cancel the background index build, if one is running.
    pub fn cancel_index_build(&self) {
        if let Some(task) = lock_ignoring_poison(&self.index_build_task).take() {
            task.abort();
        }
    }

    /// Record `paths` if an index build is running. Returns `true` when
    /// recorded; the caller must then not update the indexes (see
    /// `changed_during_build`).
    fn defer_while_building<'a>(&self, paths: impl IntoIterator<Item = &'a Path>) -> bool {
        let mut changed = lock_ignoring_poison(&self.changed_during_build);
        match changed.as_mut() {
            Some(list) => {
                list.extend(paths.into_iter().map(Path::to_path_buf));
                true
            }
            None => false,
        }
    }

    /// Re-read each note recorded during a build and update the indexes from
    /// disk: reindex those that exist, remove those that don't. Also reloads
    /// the stopword lists.
    async fn replay_changed_notes(&self, changed: Vec<PathBuf>) {
        let mut seen = HashSet::new();
        let changed: Vec<PathBuf> = changed
            .into_iter()
            .filter(|p| seen.insert(p.clone()))
            .collect();
        let Ok(storage) = self.get_storage().await else {
            return;
        };
        let root = storage.canonical_root().to_path_buf();
        self.corpus_stats
            .write()
            .await
            .reload_stopwords(Some(&root));
        if changed.is_empty() {
            return;
        }
        let mut batch = Vec::new();
        for path in changed {
            let Ok(rel) = path.strip_prefix(&root) else {
                continue;
            };
            match storage.read_file(rel).await {
                Ok(content) => batch.push((path, content)),
                Err(_) => self.remove_from_indices_inner(&path).await,
            }
        }
        log::info!(
            "index build: replaying {} note(s) changed during the build",
            batch.len()
        );
        for (path, content) in &batch {
            self.reindex_note_inner(path, content).await;
        }
        self.resolve_all_backlinks().await;
    }

    /// True once the index build for the open notebox has finished.
    pub fn index_ready(&self) -> bool {
        self.index_ready.load(Ordering::Relaxed)
    }

    /// One note's metadata from the persistent cache, without compiling. `None`
    /// without a cache, an open notebox or a fresh entry. See
    /// [`crate::scanner::walker::note_from_cache`].
    pub async fn cached_note(
        &self,
        path: &std::path::Path,
    ) -> Option<crate::models::note::NoteMetadata> {
        let cache = self.metadata_cache.clone()?;
        let root = self.notebox_root.read().await.clone()?;
        let storage = self.get_storage().await.ok()?;
        crate::scanner::walker::note_from_cache(storage.as_ref(), cache.as_ref(), &root, path).await
    }

    async fn build_indexes_inner(&self) -> crate::errors::Result<IndexStats> {
        let (storage, notebox_root) = {
            let storage = self
                .storage
                .read()
                .await
                .clone()
                .ok_or(crate::errors::InkyCapError::NoteboxNotOpen)?;
            let notebox_root = self
                .notebox_root
                .read()
                .await
                .clone()
                .ok_or(crate::errors::InkyCapError::NoteboxNotOpen)?;
            (storage, notebox_root)
        };

        let cache = self.metadata_cache.clone();

        // Hold the compiler for the whole scan (needed for `typst query`).
        // Other locks are taken only briefly for the swap at the end.
        let mut compiler_guard = self.typst_compiler.lock().await;
        let compiler = compiler_guard
            .as_mut()
            .ok_or(crate::errors::InkyCapError::NoteboxNotOpen)?;

        let (scan, cache_stats) = if let Some(cache) = cache.as_ref() {
            let (scan, stats) = crate::scanner::walker::scan_notebox_cached(
                storage.as_ref(),
                &notebox_root,
                cache.as_ref(),
                compiler,
            )
            .await?;
            log::info!(
                "metadata cache: {} files, {} hits, {} misses, {} pruned",
                stats.total_files,
                stats.cache_hits,
                stats.cache_misses,
                stats.pruned
            );
            (scan, Some(stats))
        } else {
            let s = crate::scanner::walker::scan_notebox(storage.as_ref(), &notebox_root, compiler)
                .await?;
            (s, None)
        };

        // Empty the compiler's file caches, which the scan filled; interactive
        // compiles start better from empty caches.
        compiler.forget_cached_files();
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

        // Single "now" reused for both the corpus-stats and search-index save
        // timestamps below.
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        // Mycelial View corpus statistics: load the saved snapshot and update
        // it for changed files (by mtime), like the search index.
        let corpus_path = corpus_stats_path(&notebox_root);
        let corpus_stats = if let Some(persisted) =
            PersistedCorpusStats::load_from_file(&corpus_path)
        {
            let mut stats = persisted.stats;
            // `stopwords` is `#[serde(skip)]`, so re-derive it after load.
            stats.reload_stopwords(Some(&notebox_root));
            // Repair `total_docs` from the per-document maps; older snapshots
            // can have it far too low, which disables Mycelial's latent and
            // emergent analysis.
            stats.resync_total_docs();
            let saved_at = persisted.saved_at;

            // Drop docs for files pruned since the snapshot, and any indexed
            // path no longer present in the current scan.
            if let Some(ref cs) = cache_stats {
                for path in &cs.pruned_paths {
                    stats.delete_doc(path);
                }
            }
            let current_paths: HashSet<&Path> = contents.iter().map(|(p, _)| p.as_path()).collect();
            let stale: Vec<PathBuf> = stats
                .indexed_paths()
                .into_iter()
                .filter(|p| !current_paths.contains(p.as_path()))
                .collect();
            for path in &stale {
                stats.delete_doc(path);
            }

            // Re-project files newer than the snapshot, or not yet present.
            let mut updated = 0usize;
            for (path, content) in &contents {
                let mtime = file_mtimes.get(path).copied().unwrap_or(0);
                if mtime > saved_at || !stats.contains_doc(path) {
                    let projection = crate::search::text_projection::project(content);
                    stats.update_doc(path, &projection.tokens);
                    updated += 1;
                }
            }
            log::info!(
                "corpus stats: loaded persisted, {} docs, {} updated, {} pruned",
                stats.total_docs,
                updated,
                stale.len()
            );
            stats
        } else {
            let docs: Vec<(PathBuf, &str)> = contents
                .iter()
                .map(|(p, c)| (p.clone(), c.as_str()))
                .collect();
            let stats = CorpusStats::build(&docs, Some(&notebox_root));
            log::info!(
                "corpus stats: built from scratch ({} docs)",
                stats.total_docs
            );
            stats
        };
        // Persist for next launch.
        PersistedCorpusStats::save_borrowed(&corpus_stats, now, &corpus_path);
        self.last_corpus_save.store(now, Ordering::Relaxed);

        // Try to load the persisted search index and incrementally update it
        // rather than rebuilding from scratch.
        let index_path = search_index_path(&notebox_root);
        let search_engine = if let Some(persisted) =
            PersistedSearchIndex::load_from_file(&index_path)
        {
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

            log::info!(
                "search index: loaded persisted, {} updated, {} pruned",
                updated,
                stale_engine_paths.len() + cache_stats.as_ref().map_or(0, |s| s.pruned_paths.len())
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
            log::info!(
                "search index: built from scratch ({} files)",
                search_files.len()
            );
            SearchEngine::build(search_files)
        };
        // Save the search engine for next launch (reusing `now` from above).
        let persisted = PersistedSearchIndex {
            engine: search_engine,
            saved_at: now,
        };
        persisted.save_to_file(&index_path);
        // Record the save so the first edit after open does not write the
        // whole index out again straight away.
        self.last_search_save.store(now, Ordering::Relaxed);
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
        *self.corpus_stats.write().await = corpus_stats;

        Ok(stats)
    }

    /// "Rebuild cache": rebuild every index from disk, discarding the caches
    /// first so neither a corrupt entry nor an external change the watcher
    /// missed survives. Unlike [`build_indexes`], which reuses cached data by
    /// mtime, this re-parses the whole notebox, so treat it as a long operation.
    pub async fn rebuild_indexes_from_disk(&self) -> crate::errors::Result<IndexStats> {
        // Wait for any running build first: clearing its caches mid-scan would
        // leave that build reconciling against files that no longer exist.
        let _one_build_at_a_time = self.index_build_lock.lock().await;
        let notebox_root = self
            .notebox_root
            .read()
            .await
            .clone()
            .ok_or(crate::errors::InkyCapError::NoteboxNotOpen)?;

        // Remove this notebox's parse cache so every note is re-parsed (an
        // empty keep-set deletes all rows). A failure here must not block
        // recovery.
        if let Some(cache) = self.metadata_cache.as_ref() {
            if let Err(e) = cache.prune(&notebox_root, &HashSet::new()) {
                log::warn!("rebuild: clearing metadata cache failed: {e} — continuing");
            }
        }
        // Delete the saved search and corpus snapshots so they are rebuilt from
        // scratch. Missing files are fine.
        let _ = std::fs::remove_file(search_index_path(&notebox_root));
        let _ = std::fs::remove_file(corpus_stats_path(&notebox_root));

        self.build_indexes_locked().await
    }

    /// Write a re-parsed note to the metadata cache, so later starts don't
    /// re-parse it. Errors are logged and ignored; the cache is only an
    /// optimization.
    pub async fn cache_upsert_note(
        &self,
        abs_path: &std::path::Path,
        note: &crate::models::note::NoteMetadata,
        content: &str,
    ) {
        let cache = match self.metadata_cache.clone() {
            Some(c) => c,
            None => return,
        };
        let notebox_root = match self.notebox_root.read().await.clone() {
            Some(r) => r,
            None => return,
        };
        let relpath = abs_path
            .strip_prefix(&notebox_root)
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|_| abs_path.to_path_buf());

        let stat = match crate::scanner::walker::stat_file(abs_path).await {
            Ok(s) => s,
            Err(err) => {
                log::warn!(
                    "metadata cache: stat failed for {}: {err}",
                    abs_path.display()
                );
                return;
            }
        };

        let cached = crate::scanner::walker::note_to_cached_file(
            note, relpath, stat.mtime, stat.size, content,
        );
        if let Err(err) = cache.upsert_file(&notebox_root, &cached) {
            log::warn!("metadata cache: upsert_file failed: {err}");
        }
    }

    /// Remove a note from the metadata cache, so a deleted file doesn't come
    /// back on the next launch.
    pub async fn cache_remove_note(&self, abs_path: &std::path::Path) {
        let cache = match self.metadata_cache.clone() {
            Some(c) => c,
            None => return,
        };
        let notebox_root = match self.notebox_root.read().await.clone() {
            Some(r) => r,
            None => return,
        };
        let relpath = abs_path
            .strip_prefix(&notebox_root)
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|_| abs_path.to_path_buf());
        if let Err(err) = cache.delete_file(&notebox_root, &relpath) {
            log::warn!("metadata cache: delete_file failed: {err}");
        }
    }

    pub async fn get_storage(&self) -> crate::errors::Result<Arc<LocalNoteboxStorage>> {
        self.storage
            .read()
            .await
            .clone()
            .ok_or(crate::errors::InkyCapError::NoteboxNotOpen)
    }

    /// Fallback for [`reindex_note`] when a fresh stat is unavailable: copy the
    /// `file.*` properties from the note's existing index entry, if any.
    async fn carry_forward_file_props(
        &self,
        path: &std::path::Path,
        note: &mut crate::models::note::NoteMetadata,
    ) {
        let prop_index = self.property_index.read().await;
        if let Some(old) = prop_index.notes.get(&path.to_path_buf()) {
            for (k, v) in &old.properties {
                if k.starts_with("file.") {
                    note.properties
                        .entry(k.clone())
                        .or_insert_with(|| v.clone());
                }
            }
        }
    }

    /// Reindex one note in every index (link, search, property) and the
    /// metadata cache. Every note change (creation, save, property update,
    /// rename) must go through here so they stay consistent.
    ///
    /// Lock order:
    ///   0. typst_compiler (released before the index locks)
    ///   1. link_index (write)
    ///   2. property_index (read, then dropped)
    ///   3. search_engine (write)
    ///   4. metadata cache (through `cache_upsert_note`)
    ///   5. property_index (write, last)
    ///
    /// While an index build runs, the change is recorded and applied afterwards
    /// (see `changed_during_build`).
    pub async fn reindex_note(&self, path: &std::path::Path, content: &str) {
        if self.defer_while_building([path]) {
            return;
        }
        self.reindex_note_inner(path, content).await;
        // Resolve after the update, so backlinks to the note itself resolve on
        // first index.
        self.resolve_all_backlinks().await;
        self.maybe_save_search_index().await;
        self.maybe_save_corpus_stats().await;
    }

    /// Reindex several notes with one backlink resolution at the end instead of
    /// one per note. The watcher batches bursts of changes (a git checkout, a
    /// tool rewriting many notes) into one call.
    pub async fn reindex_notes(&self, batch: Vec<(std::path::PathBuf, String)>) {
        if batch.is_empty() || self.defer_while_building(batch.iter().map(|(p, _)| p.as_path())) {
            return;
        }
        for (path, content) in &batch {
            self.reindex_note_inner(path, content).await;
        }
        self.resolve_all_backlinks().await;
        self.maybe_save_search_index().await;
        self.maybe_save_corpus_stats().await;
    }

    /// Per-note update shared by [`reindex_note`] and [`reindex_notes`]: links,
    /// search, corpus stats, metadata cache and property index. The caller
    /// resolves backlinks and saves the search index once for the batch.
    async fn reindex_note_inner(&self, path: &std::path::Path, content: &str) {
        let notebox_root = self.notebox_root.read().await;
        let Some(root) = notebox_root.as_ref() else {
            return;
        };
        let root = root.clone();
        drop(notebox_root);

        // Acquire the compiler for typst query, then release it before
        // taking any index locks (no nesting).
        let mut note = {
            let mut compiler_guard = self.typst_compiler.lock().await;
            crate::scanner::walker::parse_note(path, content, &root, compiler_guard.as_mut())
        };

        // `parse_note` doesn't fill in `file.*` properties; take them from the
        // file, so filters like `file.ext == "typ"` include a brand-new note.
        // Fall back to the old entry's values if that fails.
        match self.get_storage().await {
            Ok(storage) => match storage.file_metadata(path).await {
                Ok(meta) => {
                    crate::scanner::walker::insert_file_properties(&mut note.properties, &meta)
                }
                Err(_) => self.carry_forward_file_props(path, &mut note).await,
            },
            Err(_) => self.carry_forward_file_props(path, &mut note).await,
        }

        // 1. Links: replace the note's links. The caller resolves backlinks
        //    afterwards.
        {
            let mut link_index = self.link_index.write().await;
            link_index.remove_note(&path.to_path_buf());
            for link_target in &note.links {
                link_index.add_link(path.to_path_buf(), link_target.clone());
            }
            link_index
                .attachments
                .record(path.to_path_buf(), &root, content);
        }

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
        let property_values = crate::search::engine::flatten_property_values(&note.properties);
        {
            let mut engine = self.search_engine.write().await;
            engine.update_doc(path, content, tags, title, property_keys, property_values);
        }

        // 2.5 Corpus statistics update.
        {
            let projection = crate::search::text_projection::project(content);
            let mut stats = self.corpus_stats.write().await;
            stats.update_doc(path, &projection.tokens);
        }

        // 3. Persistent cache write-through (best-effort).
        self.cache_upsert_note(path, &note, content).await;

        // 4. Property index — last, because it consumes `note`.
        let mut prop_index = self.property_index.write().await;
        prop_index.update_note(note);
        drop(prop_index);
    }

    /// Rebuild the backlink index from all indexed notes. Resolving only one
    /// note's links would miss notes that linked to it before it existed, and
    /// stale links to renamed or deleted notes. Takes `link_index` (write),
    /// then `property_index` (read).
    async fn resolve_all_backlinks(&self) {
        let mut link_index = self.link_index.write().await;
        let all_paths: Vec<std::path::PathBuf> = {
            let prop_index = self.property_index.read().await;
            prop_index.notes.keys().cloned().collect()
        };
        link_index.resolve_and_build_backlinks(&all_paths);
    }

    /// Remove a note from every index AND from the persistent metadata cache.
    /// Companion to [`reindex_note`].
    pub async fn remove_from_indices(&self, path: &std::path::Path) {
        if self.defer_while_building([path]) {
            return;
        }
        self.remove_from_indices_inner(path).await;
        self.resolve_all_backlinks().await;
        self.maybe_save_search_index().await;
        self.maybe_save_corpus_stats().await;
    }

    /// Per-note removal shared by [`remove_from_indices`] and the watcher's
    /// batches. The caller resolves backlinks and saves.
    async fn remove_from_indices_inner(&self, path: &std::path::Path) {
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
        {
            let mut stats = self.corpus_stats.write().await;
            stats.delete_doc(path);
        }
        self.cache_remove_note(path).await;
    }

    /// Save the search index if 60 seconds have passed since the last save.
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

        let notebox_root = match self.notebox_root.read().await.clone() {
            Some(r) => r,
            None => return,
        };

        let engine = self.search_engine.read().await;
        let index_path = search_index_path(&notebox_root);
        PersistedSearchIndex::save_borrowed(&engine, now, &index_path);
        self.last_search_save.store(now, Ordering::Relaxed);
    }

    /// Save the corpus stats if `SEARCH_SAVE_INTERVAL_SECS` have passed, as
    /// [`maybe_save_search_index`] does.
    async fn maybe_save_corpus_stats(&self) {
        const CORPUS_SAVE_INTERVAL_SECS: i64 = 60;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let last = self.last_corpus_save.load(Ordering::Relaxed);
        if now - last < CORPUS_SAVE_INTERVAL_SECS {
            return;
        }

        let notebox_root = match self.notebox_root.read().await.clone() {
            Some(r) => r,
            None => return,
        };

        let stats = self.corpus_stats.read().await;
        let path = corpus_stats_path(&notebox_root);
        PersistedCorpusStats::save_borrowed(&stats, now, &path);
        self.last_corpus_save.store(now, Ordering::Relaxed);
    }
}

/// Lock a std mutex even if it was poisoned; the data it guards stays
/// consistent after a panic.
fn lock_ignoring_poison<T>(mutex: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// App-wide state managed by Tauri: user settings, bookmarks, the shared
/// metadata cache, backup coordination, and the per-window [`NoteboxSession`]
/// map (see [`AppState::session`]).
pub struct AppState {
    /// Per-window notebox sessions, keyed by Tauri window label.
    sessions: RwLock<HashMap<String, Arc<NoteboxSession>>>,
    /// User-global settings, persisted at `$CONFIG_DIR/inkycap/settings.json`.
    pub settings: RwLock<UserSettings>,
    /// User bookmarks (notes, searches, headings, collections).
    pub bookmarks: RwLock<Vec<Bookmark>>,
    /// Persistent metadata cache (SQLite), shared into each [`NoteboxSession`].
    /// Optional, so a missing or corrupt cache never blocks launch.
    pub metadata_cache: RwLock<Option<Arc<MetadataCache>>>,
    /// Absolute paths the user just dropped on a window, filled by the Rust
    /// drop listener (see `lib.rs`) and used once by `copy_path_into_notebox`.
    /// The only proof that the user really dropped a file, so the frontend
    /// can't pass arbitrary paths. Entries expire after `DROP_ALLOWLIST_TTL`.
    drop_allowlist: StdMutex<HashMap<PathBuf, Instant>>,
    /// Ensures one backup runs at a time, so a manual and a scheduled backup
    /// can't collide.
    pub backup_run_lock: Mutex<()>,
    /// Wakes the backup scheduler after settings are saved, so a changed
    /// interval applies right away.
    pub backup_scheduler_wake: Arc<Notify>,
    /// Set by `cancel_backup`; the archive writer checks it between entries and
    /// stops. Cleared at the start of each run.
    pub backup_cancel: Arc<AtomicBool>,
}

/// How long a dropped path stays valid: enough for the frontend to call
/// `copy_path_into_notebox`, short enough that it can't be reused later.
const DROP_ALLOWLIST_TTL: Duration = Duration::from_secs(60);

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    pub fn new() -> Self {
        let settings = crate::settings::load_settings();
        // Move indexes from the old data_dir location to cache_dir. No-op once
        // done.
        crate::app_paths::migrate_legacy_cache_paths();
        // Open the metadata cache, locating it through `app_paths` (no
        // AppHandle here). On failure the app runs without a cache.
        let metadata_cache = Self::open_metadata_cache();
        Self {
            sessions: RwLock::new(HashMap::new()),
            settings: RwLock::new(settings),
            bookmarks: RwLock::new(bookmarks::load_bookmarks().unwrap_or_default()),
            metadata_cache: RwLock::new(metadata_cache),
            drop_allowlist: StdMutex::new(HashMap::new()),
            backup_run_lock: Mutex::new(()),
            backup_scheduler_wake: Arc::new(Notify::new()),
            backup_cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    /// The [`NoteboxSession`] for a window label, created on first use. The
    /// `Arc` is cloned out so the map isn't locked while the session is used.
    pub async fn session(&self, label: &str) -> Arc<NoteboxSession> {
        if let Some(s) = self.sessions.read().await.get(label) {
            return s.clone();
        }
        // Read the shared cache handle before taking the (write) map lock so we
        // never nest the two — avoids any lock-ordering question.
        let cache = self.metadata_cache.read().await.clone();
        let mut map = self.sessions.write().await;
        // Double-check: another task may have inserted between the read above
        // and acquiring the write lock.
        if let Some(s) = map.get(label) {
            return s.clone();
        }
        let session = Arc::new(NoteboxSession::new(label.to_string(), cache));
        map.insert(label.to_string(), session.clone());
        session
    }

    /// Drop a window's session (called when its window is destroyed), releasing
    /// its file watcher, health monitor, and in-memory indexes.
    pub async fn remove_session(&self, label: &str) {
        self.sessions.write().await.remove(label);
    }

    /// Every session's `Arc`, released from the map lock before any session
    /// lock is taken.
    async fn session_snapshot(&self) -> Vec<(String, Arc<NoteboxSession>)> {
        let map = self.sessions.read().await;
        map.iter().map(|(l, s)| (l.clone(), s.clone())).collect()
    }

    /// A window other than `exclude_label` with the notebox at `canonical_root`
    /// open, if any. A notebox can be open in only one window, since two
    /// editors on one file can overwrite each other.
    pub async fn window_for_notebox(
        &self,
        canonical_root: &Path,
        exclude_label: &str,
    ) -> Option<String> {
        for (label, session) in self.session_snapshot().await {
            if label == exclude_label {
                continue;
            }
            if session.notebox_root.read().await.as_deref() == Some(canonical_root) {
                return Some(label);
            }
        }
        None
    }

    /// Every window with a notebox open, as (label, root) pairs.
    pub async fn open_noteboxes(&self) -> Vec<(String, PathBuf)> {
        let mut out = Vec::new();
        for (label, session) in self.session_snapshot().await {
            if let Some(root) = session.notebox_root.read().await.clone() {
                out.push((label, root));
            }
        }
        out
    }

    /// Record the paths an OS drop delivered. Called from the drop listener in
    /// `lib.rs`; synchronous so the allowlist is filled before the frontend
    /// calls `copy_path_into_notebox`.
    pub fn register_drop_paths<I: IntoIterator<Item = PathBuf>>(&self, paths: I) {
        let mut allow = self.drop_allowlist.lock().expect("drop_allowlist poisoned");
        let now = Instant::now();
        // Prune expired entries opportunistically while we hold the lock.
        allow.retain(|_, t| now.duration_since(*t) < DROP_ALLOWLIST_TTL);
        for p in paths {
            allow.insert(p, now);
        }
    }

    /// Check whether `path` came from a recent drop and remove it (single use).
    /// True if it was listed and not expired.
    pub fn consume_drop_path(&self, path: &Path) -> bool {
        let mut allow = self.drop_allowlist.lock().expect("drop_allowlist poisoned");
        let now = Instant::now();
        allow.retain(|_, t| now.duration_since(*t) < DROP_ALLOWLIST_TTL);
        allow.remove(path).is_some()
    }

    /// Open the cache database in the user's cache folder, or `None` (logged)
    /// on failure.
    fn open_metadata_cache() -> Option<Arc<MetadataCache>> {
        let cache_dir = crate::app_paths::cache_dir();
        let db_path = cache_dir.join("metadata-cache.sqlite");
        match MetadataCache::open(&db_path) {
            Ok(cache) => Some(Arc::new(cache)),
            Err(err) => {
                log::warn!(
                    "metadata cache: failed to open at {}: {err}",
                    db_path.display()
                );
                None
            }
        }
    }
}

/// Resolve the on-disk path for the persisted search index. Keyed by a
/// hash of the notebox root so multiple noteboxes don't collide.
fn search_index_path(notebox_root: &Path) -> PathBuf {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(notebox_root.to_string_lossy().as_bytes());
    let short = &hex::encode(&hash)[..16];
    crate::app_paths::cache_dir().join(format!("search-index-{short}.bin"))
}

fn corpus_stats_path(notebox_root: &Path) -> PathBuf {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(notebox_root.to_string_lossy().as_bytes());
    let short = &hex::encode(&hash)[..16];
    crate::app_paths::cache_dir().join(format!("corpus-stats-{short}.bin"))
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
            let values = crate::search::engine::flatten_property_values(&note.properties);
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

/// The bibliography path to use, from the citation settings. For "zotero",
/// exports the Zotero database to `.inkycap/zotero-export.bib` so Typst can
/// resolve `@key`. Returns a notebox-relative path. Takes the global settings
/// (Zotero location) and the notebox's (source and bibliography path).
pub fn configure_bibliography(
    notebox_root: &Path,
    global: &CitationSettings,
    notebox: &NoteboxCitationSettings,
) -> Option<String> {
    match notebox.source.as_str() {
        "zotero" => {
            let db = global
                .zotero_database_path
                .as_ref()
                .map(PathBuf::from)
                .or_else(crate::typst_pipeline::zotero::auto_detect_path);
            let db_path = db?;
            match crate::typst_pipeline::zotero::read_entries(&db_path) {
                Ok(entries) => {
                    match crate::typst_pipeline::bibliography::write_zotero_export(
                        notebox_root,
                        &entries,
                    ) {
                        Ok(rel_path) => Some(rel_path),
                        Err(e) => {
                            log::error!("Failed to write Zotero export: {e}");
                            None
                        }
                    }
                }
                Err(e) => {
                    log::error!("Failed to read Zotero entries: {e}");
                    None
                }
            }
        }
        _ => notebox.bibliography_path.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::note::PropertyValue;

    fn note_source(title: &str) -> String {
        format!(
            "{}\n#note(title: \"{title}\")\nBody text.\n",
            crate::notebox_package::import_line()
        )
    }

    /// Open `dir` as a notebox holding `a.typ` and `b.typ`, fully indexed.
    async fn indexed_session(dir: &Path) -> (NoteboxSession, PathBuf, PathBuf) {
        std::fs::write(dir.join("a.typ"), note_source("One")).unwrap();
        std::fs::write(dir.join("b.typ"), note_source("Other")).unwrap();
        let session = NoteboxSession::new("main".into(), None);
        session
            .open_notebox_fast(dir.to_path_buf(), &CitationSettings::default())
            .await
            .unwrap();
        session.build_indexes().await.unwrap();
        let root = session
            .get_storage()
            .await
            .unwrap()
            .canonical_root()
            .to_path_buf();
        (session, root.join("a.typ"), root.join("b.typ"))
    }

    async fn indexed_title(session: &NoteboxSession, path: &Path) -> Option<String> {
        let index = session.property_index.read().await;
        match index
            .notes
            .get(&path.to_path_buf())?
            .properties
            .get("title")
        {
            Some(PropertyValue::String(s)) => Some(s.clone()),
            _ => None,
        }
    }

    fn start_recording(session: &NoteboxSession) {
        *session.changed_during_build.lock().unwrap() = Some(Vec::new());
    }

    #[tokio::test]
    async fn edit_during_a_build_is_held_back_then_replayed() {
        // `tempdir()` names start with a dot: a notebox folder with a hidden
        // name must still be scanned.
        let dir = tempfile::tempdir().unwrap();
        let (session, a, _) = indexed_session(dir.path()).await;
        assert_eq!(indexed_title(&session, &a).await.as_deref(), Some("One"));

        start_recording(&session);
        let edited = note_source("Two");
        std::fs::write(&a, &edited).unwrap();
        session.reindex_note(&a, &edited).await;
        // Held back: the build's swap would have overwritten it.
        assert_eq!(indexed_title(&session, &a).await.as_deref(), Some("One"));

        let recorded = session.changed_during_build.lock().unwrap().take().unwrap();
        session.replay_changed_notes(recorded).await;
        assert_eq!(indexed_title(&session, &a).await.as_deref(), Some("Two"));
    }

    #[tokio::test]
    async fn deletion_during_a_build_is_replayed_as_a_removal() {
        let dir = tempfile::tempdir().unwrap();
        let (session, _, b) = indexed_session(dir.path()).await;

        start_recording(&session);
        std::fs::remove_file(&b).unwrap();
        session.remove_from_indices(&b).await;
        assert!(indexed_title(&session, &b).await.is_some());

        let recorded = session.changed_during_build.lock().unwrap().take().unwrap();
        session.replay_changed_notes(recorded).await;
        assert!(indexed_title(&session, &b).await.is_none());
        assert!(!session.search_engine.read().await.contains_path(&b));
    }

    #[tokio::test]
    async fn a_build_stops_recording_when_it_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let (session, a, _) = indexed_session(dir.path()).await;
        assert!(session.changed_during_build.lock().unwrap().is_none());

        // Updates after the build apply straight away.
        let edited = note_source("Three");
        std::fs::write(&a, &edited).unwrap();
        session.reindex_note(&a, &edited).await;
        assert_eq!(indexed_title(&session, &a).await.as_deref(), Some("Three"));
    }
}
