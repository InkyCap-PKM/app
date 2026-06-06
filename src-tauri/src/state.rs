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

/// The per-window notebox session: everything that belongs to *one open
/// notebox in one OS window*. Each window (identified by its Tauri label —
/// `main`, `note-docs`, `note-<ts>`) owns exactly one of these, looked up via
/// [`AppState::session`]. Splitting this out of `AppState` is what lets two
/// windows show different noteboxes without clobbering each other.
///
/// **Lock ordering invariant.** Several fields below are `RwLock`s and any
/// code path that holds more than one of them at the same time MUST acquire
/// them in this order to prevent deadlocks:
///
/// 1. `link_index`
/// 2. `property_index`
/// 3. `search_engine`
///
/// (The persistent `metadata_cache` is a shared `Arc` accessed last, after the
/// index locks are released.) Non-nested single-lock acquisitions (acquire,
/// use, release, then the next) are always safe. The one helper that nests two
/// locks is [`NoteboxSession::reindex_note`], which holds `link_index` (write)
/// while briefly acquiring `property_index` (read) to snapshot the note path
/// set. If you add a helper that nests differently, either follow the order
/// above or split it into sequential single-lock steps.
///
/// The `AppState::sessions` map lock is always acquired *outside* (before) any
/// of these — and only ever to clone the `Arc<NoteboxSession>` out, never held
/// while a session lock is taken — so it adds no new deadlock surface.
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
    /// Notebox health monitor abort handle. See [`crate::notebox_health`].
    /// Owned here so opening a new notebox can cancel the previous monitor
    /// before spawning its replacement.
    pub health_monitor: RwLock<Option<tokio::task::AbortHandle>>,
    /// Per-notebox settings, persisted at `<notebox>/.inkycap/settings.json`.
    /// Reset to defaults until a notebox is opened; loaded in
    /// `open_notebox_fast`.
    pub notebox_settings: RwLock<NoteboxSettings>,
    /// Full-text search engine with inverted index.
    pub search_engine: RwLock<SearchEngine>,
    /// Corpus statistics for the Mycelial View (TF-IDF + PMI).
    pub corpus_stats: RwLock<CorpusStats>,
    /// Property type registry for this notebox, persisted per-notebox.
    pub property_types: RwLock<PropertyTypeRegistry>,
    /// Typst compile pipeline, instantiated on notebox open. The Mutex (rather
    /// than RwLock) is intentional: every compile mutates the underlying
    /// World's source/main caches, so all access is single-writer.
    pub typst_compiler: Mutex<Option<TypstCompiler>>,
    /// Persistent metadata cache (SQLite), shared process-wide. Cloned in from
    /// `AppState` at session creation — the cache is opened once at startup and
    /// keyed internally by notebox root, so a single handle safely serves every
    /// window. Optional because cache open is best-effort.
    metadata_cache: Option<Arc<MetadataCache>>,
    /// Unix timestamp of the last search index save. Used to debounce
    /// persistence — the index is only written to disk if at least
    /// `SEARCH_SAVE_INTERVAL_SECS` have elapsed since the last save.
    last_search_save: AtomicI64,
    /// Unix timestamp of the last corpus-stats save. Same debounce as the
    /// search index — both are caches reconciled against file mtimes on open.
    last_corpus_save: AtomicI64,
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
            last_search_save: AtomicI64::new(0),
            last_corpus_save: AtomicI64::new(0),
        }
    }

    /// Fast notebox open: sets `notebox_root`, `storage`, lists collection files, clears
    /// the indexes, and returns the rough `.typ` file count from a directory
    /// walk. The expensive metadata parse / link resolution / search index
    /// build happens later in [`NoteboxSession::build_indexes`], typically
    /// spawned as a background task by the `open_notebox` Tauri command.
    ///
    /// `global_citations` is the user-global citation settings, threaded in by
    /// the caller (`open_notebox`) because the per-notebox compiler style falls
    /// back to the global named style when the notebox has no override.
    ///
    /// Returns the number of note files discovered, so the caller can
    /// populate `NoteboxInfo.file_count` immediately.
    pub async fn open_notebox_fast(
        &self,
        path: PathBuf,
        global_citations: &CitationSettings,
    ) -> crate::errors::Result<usize> {
        let storage = Arc::new(LocalNoteboxStorage::new(path.clone())?);
        // Canonicalize the root so that every in-memory path we store uses
        // the same prefix that the storage layer validates against. This
        // prevents subtle mismatches when the user-supplied path contains a
        // symlink or trailing separators.
        let canonical_path = storage.canonical_root().to_path_buf();

        // Scaffold reserved `.inkycap/` directories before the scanner runs so
        // the collections folder exists by the time we list it. The scaffold
        // also writes the notebox library; the original placement (later in
        // this function) is preserved by being idempotent.
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

        // Reset stale state from any previously open notebox before swapping in
        // the new notebox root. Empty indexes are fine — UI features that depend
        // on them should show a loading state until `notebox:index-ready` fires.
        *self.property_index.write().await = PropertyIndex::new();
        *self.link_index.write().await = LinkIndex::new();
        *self.search_engine.write().await = SearchEngine::new();

        *self.collection_files.write().await = collection_files;
        *self.property_types.write().await = PropertyTypeRegistry::load(&canonical_path);

        // Load this notebox's settings so subsequent reads (folder paths,
        // citation source, journal scroll preferences, etc.) reflect what
        // travels with the notebox, not the previous one.
        *self.notebox_settings.write().await =
            crate::notebox_settings::load_settings(&canonical_path);

        // (Scaffold already ran above so the notebox library is on disk
        // before the compiler is constructed.)

        // Pre-warm the Typst compiler at notebox-open time so the first
        // reading-mode render doesn't pay the ~340ms font-discovery cost
        // measured in the Phase 0 bench. Construction is synchronous; future
        // work that adds system fonts may want to spawn this off-thread.
        let mut compiler = TypstCompiler::new(canonical_path.clone());
        {
            let notebox = self.notebox_settings.read().await;
            // Per-notebox `custom_csl_path` overrides the user-global default
            // style. If no override, fall back to the user-global named
            // style (unless it's "custom" with no path — treat as no style).
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

    /// Build the property index, link index, and full-text search index for
    /// this session's notebox. Intended to run as a background task after
    /// [`NoteboxSession::open_notebox_fast`]; the indexes are computed locally
    /// and then swapped in with brief write locks so that read-side IPC
    /// commands aren't blocked for the entire build.
    pub async fn build_indexes(&self) -> crate::errors::Result<IndexStats> {
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

        // Acquire the compiler for the duration of the scan so that
        // `typst query` metadata extraction can run. The compiler
        // mutex is the only exclusive lock here — other state locks
        // (property_index, link_index, etc.) are acquired only briefly
        // at the end for the swap.
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

        // Corpus statistics for the Mycelial View. Load the persisted snapshot
        // and incrementally reconcile it against the current files (mtime vs
        // `saved_at`) rather than re-tokenizing the whole corpus on every open
        // — the same load-then-update pattern the search index uses.
        let corpus_path = corpus_stats_path(&notebox_root);
        let corpus_stats = if let Some(persisted) =
            PersistedCorpusStats::load_from_file(&corpus_path)
        {
            let mut stats = persisted.stats;
            // `stopwords` is `#[serde(skip)]`, so re-derive it after load.
            stats.reload_stopwords(Some(&notebox_root));
            // Repair `total_docs` against the per-document maps. Snapshots
            // written before the `remove_doc` over-decrement fix (e.g. a corpus
            // built entirely via `update_doc` during a bulk markdown import) can
            // carry a `total_docs` stuck near 1 while holding thousands of docs,
            // which silently disables Mycelial's latent/emergent analysis.
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

    /// Force a full rebuild of every index from disk, discarding the persisted
    /// caches first. This is the user-initiated "Rebuild cache" recovery action
    /// — distinct from [`build_indexes`], which reconciles against the caches by
    /// mtime for speed. Here we clear them so neither a corrupt cache entry nor
    /// a watcher-missed external change (a rename/move done in another app while
    /// InkyCap was closed) can survive into the rebuilt indexes.
    ///
    /// Clearing == pruning this notebox's metadata (parse) cache with an empty
    /// keep-set so every note is re-parsed, plus deleting the persisted search
    /// and corpus snapshots so they are rebuilt from scratch rather than
    /// reconciled. Then [`build_indexes`] re-parses every note and rebuilds the
    /// link, property, search, and corpus indexes. This re-parses the whole
    /// notebox (the slow path), so callers should treat it as a long operation.
    pub async fn rebuild_indexes_from_disk(&self) -> crate::errors::Result<IndexStats> {
        let notebox_root = self
            .notebox_root
            .read()
            .await
            .clone()
            .ok_or(crate::errors::InkyCapError::NoteboxNotOpen)?;

        // Drop the parse cache for this notebox so `build_indexes` re-parses
        // every note instead of trusting cached metadata. An empty keep-set
        // means "no file is still present", so `prune` deletes all rows for
        // this notebox. Best-effort: a cache failure must not block recovery.
        if let Some(cache) = self.metadata_cache.as_ref() {
            if let Err(e) = cache.prune(&notebox_root, &HashSet::new()) {
                log::warn!("rebuild: clearing metadata cache failed: {e} — continuing");
            }
        }
        // Delete the persisted search-index and corpus-stats snapshots so
        // `build_indexes` takes its build-from-scratch branch. Missing files
        // are fine (first rebuild, or never persisted).
        let _ = std::fs::remove_file(search_index_path(&notebox_root));
        let _ = std::fs::remove_file(corpus_stats_path(&notebox_root));

        self.build_indexes().await
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

    /// Remove a note's entry from the persistent metadata cache. Called from
    /// the in-app deletion paths so a deleted file doesn't linger in the
    /// cache and reappear on next launch.
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

    /// Re-index a single note across **every** in-memory index (link, search,
    /// property) and write through to the persistent metadata cache.
    ///
    /// This is the single authoritative write-through path. Any mutation of a
    /// note — creation, content save, property update, rename — must funnel
    /// through here so the indices and cache stay coherent.
    ///
    /// Lock ordering (to avoid deadlocks with the watcher-side path):
    ///   0. typst_compiler (acquired first, released before index locks)
    ///   1. link_index (write)
    ///   2. property_index (read, then dropped)
    ///   3. search_engine (write)
    ///   4. metadata cache (via `cache_upsert_note`, acquires its own guard)
    ///   5. property_index (write, last — consumes the parsed note)
    pub async fn reindex_note(&self, path: &std::path::Path, content: &str) {
        self.reindex_note_inner(path, content).await;
        // Resolve once after the per-note update. For a single note the prop
        // index now contains it (the inner step updates it before we get here),
        // so backlinks for newly-arrived self-references resolve on first index.
        self.resolve_all_backlinks().await;
        self.maybe_save_search_index().await;
        self.maybe_save_corpus_stats().await;
    }

    /// Re-index a *batch* of notes with a **single** backlink resolution at the
    /// end, instead of one O(notebox) re-resolution per note.
    ///
    /// The watcher coalesces bursts of file changes (a git checkout, a tool
    /// rewriting many notes, an editor's write-then-touch double event) into
    /// one call here — collapsing what used to be N concurrent tasks each
    /// doing an O(N) StemIndex rebuild (O(N²) total, all contending on the
    /// single compiler mutex) into one sequential pass plus one resolve.
    pub async fn reindex_notes(&self, batch: Vec<(std::path::PathBuf, String)>) {
        if batch.is_empty() {
            return;
        }
        for (path, content) in &batch {
            self.reindex_note_inner(path, content).await;
        }
        self.resolve_all_backlinks().await;
        self.maybe_save_search_index().await;
        self.maybe_save_corpus_stats().await;
    }

    /// Per-note index update shared by [`reindex_note`] and [`reindex_notes`].
    /// Updates the link forward-edges, search engine, corpus stats, metadata
    /// cache, and property index — but does **not** resolve backlinks or
    /// persist the search index; the caller does that once for the whole batch.
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

        // parse_note does not populate file.* properties (those come from the
        // filesystem). Derive them from a fresh stat so filters like
        // `file.ext == "typ"` work — crucially for a brand-new note (e.g. one
        // just written by a collaboration apply), which has no prior index
        // entry to carry forward from and would otherwise be excluded from
        // every collection until a full rescan (restart). Fall back to the old
        // entry's file.* if the stat fails for any reason.
        match self.get_storage().await {
            Ok(storage) => match storage.file_metadata(path).await {
                Ok(meta) => {
                    crate::scanner::walker::insert_file_properties(&mut note.properties, &meta)
                }
                Err(_) => self.carry_forward_file_props(path, &mut note).await,
            },
            Err(_) => self.carry_forward_file_props(path, &mut note).await,
        }

        // 1. Link index: forget the old links, record the new ones. The
        // notebox-wide re-resolution is deferred to `resolve_all_backlinks`,
        // run once by the caller after every note in the batch is updated.
        {
            let mut link_index = self.link_index.write().await;
            link_index.remove_note(&path.to_path_buf());
            for link_target in &note.links {
                link_index.add_link(path.to_path_buf(), link_target.clone());
            }
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

    /// Rebuild the whole backlink index from the current set of indexed notes.
    ///
    /// A targeted `resolve_note_links(path)` was tempting (cheaper per call)
    /// but it only updates the *current* note's outgoing links and the
    /// backlinks of its targets. It does not fix two real cases:
    ///   • A newly-arrived note B that other pre-existing notes A already
    ///     wikilinked by name — those `forward_raw["B"]` entries were resolved
    ///     before B existed and so still produce an empty `forward[A]`.
    ///   • A renamed/deleted note that leaves stale `forward[A]` entries on
    ///     other notes pointing at a path that no longer exists.
    /// `resolve_and_build_backlinks` is O(N + L_total) over the StemIndex and
    /// produces a coherent index unconditionally. Acquires `link_index` (write)
    /// then `property_index` (read), preserving the documented lock ordering.
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
        self.remove_from_indices_inner(path).await;
        self.resolve_all_backlinks().await;
        self.maybe_save_search_index().await;
        self.maybe_save_corpus_stats().await;
    }

    /// Per-note removal shared by [`remove_from_indices`] and the watcher's
    /// batched apply path. Drops the note from every index and the cache but
    /// does not resolve backlinks or persist — the caller does that once.
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

        let notebox_root = match self.notebox_root.read().await.clone() {
            Some(r) => r,
            None => return,
        };

        let engine = self.search_engine.read().await;
        let index_path = search_index_path(&notebox_root);
        PersistedSearchIndex::save_borrowed(&engine, now, &index_path);
        self.last_search_save.store(now, Ordering::Relaxed);
    }

    /// Persist the corpus stats if at least `SEARCH_SAVE_INTERVAL_SECS` have
    /// elapsed since the last save. Same debounce and rationale as
    /// [`maybe_save_search_index`] — both are mtime-reconciled caches.
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

/// Global application state, managed by Tauri. Holds the genuinely app-wide
/// state (user settings, bookmarks, the shared metadata cache, backup
/// coordination) plus the per-window [`NoteboxSession`] map. Per-notebox state
/// lives on `NoteboxSession`, looked up via [`AppState::session`].
pub struct AppState {
    /// Per-window notebox sessions, keyed by Tauri window label.
    sessions: RwLock<HashMap<String, Arc<NoteboxSession>>>,
    /// User-global settings, persisted at `$CONFIG_DIR/inkycap/settings.json`.
    pub settings: RwLock<UserSettings>,
    /// User bookmarks (notes, searches, headings, collections).
    pub bookmarks: RwLock<Vec<Bookmark>>,
    /// Persistent metadata cache (SQLite). Optional because cache open is
    /// best-effort — a missing or corrupt cache should never block app launch.
    /// Shared into each [`NoteboxSession`] at creation.
    pub metadata_cache: RwLock<Option<Arc<MetadataCache>>>,
    /// Allowlist of absolute paths that the user has just dropped onto a
    /// window via the OS drag-drop event. Populated by the Rust-side
    /// `on_drag_drop_event` listener (see `lib.rs`) and consumed once by
    /// `copy_path_to_attachments`. This is the only authority for "did the
    /// user really drop this file?" — it prevents a compromised renderer or
    /// future plugin from invoking the command with arbitrary paths.
    /// Entries auto-expire after `DROP_ALLOWLIST_TTL`.
    drop_allowlist: StdMutex<HashMap<PathBuf, Instant>>,
    /// Serialises backup runs so a manual command-palette trigger and a
    /// scheduled tick can't overlap and corrupt each other's archives.
    /// Held only for the duration of one run; the unit type is a marker
    /// — we just need exclusion, not shared state.
    pub backup_run_lock: Mutex<()>,
    /// Wakes the backup scheduler when settings change so it can
    /// recompute the next-due time. Without this, switching the
    /// interval from 24h to 1h would only take effect at the next
    /// natural wake (up to 24h later) — surprising for the user.
    /// Fired from `update_settings` after any successful save.
    pub backup_scheduler_wake: Arc<Notify>,
    /// Cooperative cancellation flag for an in-flight backup run.
    /// The `cancel_backup` Tauri command sets it; the archive writer
    /// polls it between entries and aborts cleanly. Cleared at the
    /// start of every run so a leftover flag from a previous attempt
    /// can't kill the next one. `Arc` so blocking-thread workers can
    /// share it without borrowing into the tokio task.
    pub backup_cancel: Arc<AtomicBool>,
}

/// How long a dropped-path entry remains valid before it's pruned. Long
/// enough to cover the round-trip through the JS event listener and the
/// async `copy_path_to_attachments` invocation, short enough that a stale
/// entry can't be reused later in the session.
const DROP_ALLOWLIST_TTL: Duration = Duration::from_secs(60);

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    pub fn new() -> Self {
        let settings = crate::settings::load_settings();
        // Move regenerable indexes from the legacy data_dir location to the
        // cache_dir layout. Safe to run on every launch — it's a no-op once
        // migrated, and losing a cache file at worst forces a single cold
        // rebuild.
        crate::app_paths::migrate_legacy_cache_paths();
        // Open the persistent metadata cache. We can't use the Tauri AppHandle
        // here (this is called inside the builder), so we resolve the cache
        // directory via `app_paths` — same approach the rest of the codebase
        // uses for config / bookmarks. A cache failure is logged and the app
        // continues with no cache (slow path).
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

    /// Resolve the [`NoteboxSession`] for a given window label, creating an
    /// empty one on first use. The session `Arc` is cloned out so the caller
    /// holds it without keeping the map locked — the map lock is never held
    /// while a per-session lock is taken, so it adds no deadlock surface.
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

    /// Snapshot every session's `Arc` out of the map, releasing the map lock
    /// before any per-session lock is taken (honours the lock-ordering note on
    /// `NoteboxSession`).
    async fn session_snapshot(&self) -> Vec<(String, Arc<NoteboxSession>)> {
        let map = self.sessions.read().await;
        map.iter().map(|(l, s)| (l.clone(), s.clone())).collect()
    }

    /// The label of a window — other than `exclude_label` — that currently has
    /// the notebox at `canonical_root` open, if any. Enforces one-notebox-per-
    /// window: a notebox can't be open in two windows, because two editors over
    /// the same file can silently overwrite each other.
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

    /// Every window that currently has a notebox open, as (window label,
    /// notebox root) pairs. Lets the frontend disable / focus already-open
    /// noteboxes in the switcher and picker.
    pub async fn open_noteboxes(&self) -> Vec<(String, PathBuf)> {
        let mut out = Vec::new();
        for (label, session) in self.session_snapshot().await {
            if let Some(root) = session.notebox_root.read().await.clone() {
                out.push((label, root));
            }
        }
        out
    }

    /// Record that the OS drag-drop event delivered these absolute paths to
    /// our window. Called from the Rust-side `on_drag_drop_event` listener
    /// in `lib.rs`. Synchronous (no `await`) so it can populate the allowlist
    /// before the parallel JS event handler races to call
    /// `copy_path_to_attachments`.
    pub fn register_drop_paths<I: IntoIterator<Item = PathBuf>>(&self, paths: I) {
        let mut allow = self.drop_allowlist.lock().expect("drop_allowlist poisoned");
        let now = Instant::now();
        // Prune expired entries opportunistically while we hold the lock.
        allow.retain(|_, t| now.duration_since(*t) < DROP_ALLOWLIST_TTL);
        for p in paths {
            allow.insert(p, now);
        }
    }

    /// Atomically check whether `path` was registered by a recent OS drop and
    /// remove it (single-use). Returns `true` if the path was on the
    /// allowlist and not expired.
    pub fn consume_drop_path(&self, path: &Path) -> bool {
        let mut allow = self.drop_allowlist.lock().expect("drop_allowlist poisoned");
        let now = Instant::now();
        allow.retain(|_, t| now.duration_since(*t) < DROP_ALLOWLIST_TTL);
        allow.remove(path).is_some()
    }

    /// Resolve the cache database path under the user's cache directory and
    /// open it. Errors are logged and surfaced as `None` so callers fall back
    /// to the cacheless cold path.
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

/// Resolve the bibliography override path based on citation settings.
/// When the source is "zotero", reads entries from the Zotero database and
/// exports them to `.inkycap/zotero-export.bib` so the Typst compiler can
/// resolve `@key` citations. Returns the notebox-relative path to use as the
/// bibliography override.
///
/// Takes both the user-global citations (for the system Zotero install path)
/// and the notebox-specific citations (source choice, bibliography path).
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
