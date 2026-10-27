use tauri::{Manager, State};

use crate::config;
use crate::errors::InkyCapError;
use crate::events::{publish, AppEvent, Audience};
use crate::models::notebox::NoteboxInfo;
use crate::state::AppState;
use crate::storage::to_frontend_string;
use crate::storage::traits::NoteboxStorage;
use crate::watcher::file_watcher;

/// Return the persisted notebox path from the app config, if any.
#[tauri::command]
pub async fn get_saved_notebox_path() -> Result<Option<String>, InkyCapError> {
    let cfg = config::load_config();
    Ok(cfg.notebox_path)
}

/// Where the documentation window starts: the notebox root and the note to open
/// first. `index` is `None` only if there is no top-level `.typ`.
#[derive(serde::Serialize)]
pub struct DocsNoteboxLocation {
    pub root: String,
    pub index: Option<String>,
}

/// Config folder name of the documentation notebox for a UI locale. English is
/// the default and fallback; translated manuals have a suffixed folder (e.g.
/// `InkyCap-Documentation-fr-CA`).
fn docs_notebox_dir_name(ui_locale: &str) -> &'static str {
    match ui_locale {
        "fr-CA" => "InkyCap-Documentation-fr-CA",
        _ => "InkyCap-Documentation",
    }
}

/// Resolve the bundled "InkyCap Documentation" notebox, creating it on first
/// use, and return its path and landing note.
///
/// It lives in the config folder, apart from user noteboxes, and matches the UI
/// language when a translated manual exists. Its contents are refreshed from
/// the manual built into the app (see [`crate::docs_manual`]); the `.inkycap/`
/// scaffold is reapplied each time.
#[tauri::command]
pub async fn open_documentation_notebox(
    state: State<'_, AppState>,
) -> Result<DocsNoteboxLocation, InkyCapError> {
    let top_level_typ = |dir: &std::path::Path| -> Vec<std::path::PathBuf> {
        let mut v: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
            .map(|rd| {
                rd.flatten()
                    .map(|e| e.path())
                    .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("typ"))
                    .collect()
            })
            .unwrap_or_default();
        v.sort();
        v
    };

    let config_dir = crate::app_paths::config_dir();
    let ui_locale = state.settings.read().await.appearance.ui_locale.clone();

    // `docs_notebox_dir_name` falls back to English; `seed_if_stale` does
    // nothing for a folder we don't bundle.
    let dir_name = docs_notebox_dir_name(&ui_locale);
    let root = config_dir.join(dir_name);

    std::fs::create_dir_all(&root)?;
    crate::docs_manual::seed_if_stale(dir_name, &root)?;
    crate::notebox_package::scaffold(&root);

    // Landing note: a top-level `.typ` whose name contains "index"
    // (case-insensitive), else the first by name.
    let files = top_level_typ(&root);
    let index = files
        .iter()
        .find(|p| {
            p.file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.to_lowercase().contains("index"))
                .unwrap_or(false)
        })
        .or_else(|| files.first())
        .map(|p| to_frontend_string(p));

    Ok(DocsNoteboxLocation {
        root: to_frontend_string(&root),
        index,
    })
}

/// Open a notebox at the given directory path: initialize storage, start the file watcher, and spawn background index build.
#[tauri::command]
pub async fn open_notebox(
    path: String,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<NoteboxInfo, InkyCapError> {
    // Each window owns its own notebox session (keyed by window label), so a
    // second window opening a different notebox never disturbs the first.
    let label = window.label().to_string();
    let session = state.session(&label).await;

    let notebox_path = std::path::PathBuf::from(&path);
    if !notebox_path.is_dir() {
        return Err(InkyCapError::InvalidPath(format!(
            "Not a directory: {}",
            path
        )));
    }

    // Canonicalize early so the exclusivity + nesting guards compare the same
    // shape the rest of the backend stores.
    let canonical = crate::storage::path::canonicalize_root(&notebox_path)?;

    // The documentation notebox keeps edits for the session but never writes
    // them, and refuses structural changes. Set on every open, so a reused
    // window becomes writable again.
    let is_docs = is_docs_notebox(&path);
    if is_docs {
        log::info!("documentation notebox opened: ephemeral edits + docs fonts active");
    }
    session.set_documentation(is_docs);

    // A notebox can be open in only one window; the frontend focuses the other
    // window instead.
    if let Some(other) = state.window_for_notebox(&canonical, &label).await {
        return Err(InkyCapError::NoteboxAlreadyOpen(other));
    }

    // No nested noteboxes (a notebox inside another, or one that contains
    // another) — the inner notebox's files would also belong to the outer.
    validate_no_notebox_nesting(&canonical)?;

    // Fast path: set up the root and storage and list collections, so the file
    // tree can render right away.
    let global_citations = state.settings.read().await.citations.clone();
    let note_count = session
        .open_notebox_fast(notebox_path.clone(), &global_citations)
        .await?;

    // Replace the health monitor with one for this notebox. It detects a
    // vanished root and repairs `.inkycap/`.
    if let Some(canonical_root) = session.notebox_root.read().await.clone() {
        let mut slot = session.health_monitor.write().await;
        if let Some(prev) = slot.take() {
            prev.abort();
        }
        *slot = Some(crate::notebox_health::spawn(
            app_handle.clone(),
            label.clone(),
            canonical_root,
        ));
    }

    // Start file watcher and bridge events to the frontend. The watcher is
    // per-session; its events are targeted at the owning window only.
    match file_watcher::start_watching(&notebox_path) {
        Ok((watcher, rx)) => {
            *session.watcher.write().await = Some(watcher);

            // Forward watcher events to the frontend and write changes through
            // to the metadata cache. The watcher channel is synchronous, so the
            // dispatcher runs on a blocking task, with async work in short
            // tokio tasks.
            let handle = app_handle.clone();
            let owner = label.clone();
            tokio::task::spawn_blocking(move || {
                use std::sync::mpsc::RecvTimeoutError;
                use std::time::Duration;

                // Batch a burst of events (until `COALESCE_WINDOW` passes
                // quietly or `COALESCE_MAX` is reached), so a git checkout or
                // bulk rewrite causes one reindex.
                const COALESCE_WINDOW: Duration = Duration::from_millis(200);
                const COALESCE_MAX: usize = 1024;

                // `recv` returns `Err` when the sender is dropped (watcher
                // replaced or notebox closed), which ends the loop.
                while let Ok(first) = rx.recv() {
                    let mut events = vec![first];
                    let mut disconnected = false;
                    while events.len() < COALESCE_MAX {
                        match rx.recv_timeout(COALESCE_WINDOW) {
                            Ok(e) => events.push(e),
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => {
                                disconnected = true;
                                break;
                            }
                        }
                    }
                    dispatch_watcher_batch(&handle, &owner, events);
                    if disconnected {
                        break;
                    }
                }
            });
        }
        Err(err) => {
            log::warn!("could not start file watcher: {err}");
        }
    }

    // If the notebox has a git config and is a repo, refresh its `.gitignore`
    // and send a status summary. Opening never fetches.
    if let Some(canonical_root) = session.notebox_root.read().await.clone() {
        // Move the git config from the shared settings.json to the per-machine
        // local.json, for older noteboxes. Idempotent.
        if let Err(err) = crate::notebox_settings::migrate_git_config(&canonical_root) {
            log::warn!("notebox git: could not migrate git config to local.json: {err}");
        }
        let git_cfg = session.notebox_settings.read().await.git.clone();
        match git_cfg {
            Some(git_cfg) => {
                surface_git_status(&app_handle, label.clone(), canonical_root, git_cfg)
            }
            // No config, but it may be a repo with a remote (e.g. an external
            // clone): offer to reconnect.
            None => surface_reconnectable_git(&app_handle, label.clone(), canonical_root),
        }
    }

    let name = notebox_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Notebox".to_string());

    // Save the last-opened notebox and registry entry only for the main window,
    // so other windows (documentation, "open in new window") don't change what
    // opens next launch.
    if label == "main" {
        let mut cfg = config::load_config();
        cfg.notebox_path = Some(path.clone());
        cfg.upsert_notebox(&path, &name);
        let _ = config::save_config(&cfg);
    }

    let collection_count = session.collection_files.read().await.len();

    // Build the indexes in the background. Search, tags, backlinks and
    // properties show a loading state until `notebox:index-ready`.
    spawn_index_rebuild(app_handle.clone(), session.clone());

    Ok(NoteboxInfo {
        path: to_frontend_string(&notebox_path),
        name,
        file_count: note_count,
        collection_count,
        property_keys: Vec::new(),
    })
}

/// Rebuild a session's indexes in the background after a bulk change on disk
/// (open, import, sync, package import, restore), then emit
/// `notebox:index-ready` (or `notebox:index-error`).
///
/// `build_indexes` is incremental (by mtime), so this is cheap for small
/// changes. The file watcher alone isn't enough: its OS event queue can overflow
/// when thousands of files change at once.
pub(crate) fn spawn_index_rebuild(
    app_handle: tauri::AppHandle,
    session: std::sync::Arc<crate::state::NoteboxSession>,
) {
    let owner = session.owner_label.clone();
    let task = tauri::async_runtime::spawn({
        let session = session.clone();
        async move {
            let event = match session.build_indexes().await {
                Ok(stats) => AppEvent::IndexReady(stats),
                Err(err) => {
                    log::error!("Background index rebuild failed: {err}");
                    AppEvent::IndexError {
                        error: err.to_string(),
                    }
                }
            };
            publish(&app_handle, Audience::Window(&owner), event);
        }
    });
    // Cancels a build still running from before: this one covers its work.
    session.replace_index_build(task.inner().abort_handle());
}

/// "Rebuild cache" (Settings → Files & Links): discard the caches and rebuild
/// every index from disk (see [`NoteboxSession::rebuild_indexes_from_disk`]).
/// Waits until done, so the frontend can show a busy state; can take minutes on
/// a large notebox. Then emits `notebox:index-ready` and
/// `notebox:index-updated` to this window.
#[tauri::command]
pub async fn rebuild_notebox_indexes(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<crate::state::IndexStats, InkyCapError> {
    let session = state.session(window.label()).await;
    let stats = session.rebuild_indexes_from_disk().await?;
    let audience = Audience::Window(window.label());
    publish(
        window.app_handle(),
        audience,
        AppEvent::IndexReady(stats.clone()),
    );
    publish(
        window.app_handle(),
        audience,
        AppEvent::IndexesRebuiltFromDisk,
    );
    Ok(stats)
}

/// When a collaborative notebox opens (it has a [`NoteboxGitConfig`] and is a
/// repo), refresh its `.gitignore` and emit `notebox:git-status`. On a blocking
/// task, since libgit2 is synchronous.
///
/// Read-only: never fetches or commits. A notebox with a remote configured but
/// no repo yet is skipped; creating a repo is the user's choice.
///
/// [`NoteboxGitConfig`]: crate::notebox_settings::NoteboxGitConfig
fn surface_git_status(
    handle: &tauri::AppHandle,
    owner_label: String,
    root: std::path::PathBuf,
    git_cfg: crate::notebox_settings::NoteboxGitConfig,
) {
    let handle = handle.clone();
    tokio::task::spawn_blocking(move || {
        use crate::git::backend::{ensure_collaboration_gitignore, GitBackend};

        if !GitBackend::is_repo(&root) {
            log::info!(
                "notebox git: remote configured but notebox is not a git repo yet; \
                 skipping status (set up collaboration to initialize)"
            );
            return;
        }

        // Keep the ignore rules current (self-heals if the file was deleted);
        // idempotent, so safe to run on every open.
        if let Err(err) = ensure_collaboration_gitignore(&root) {
            log::warn!("notebox git: could not write .gitignore: {err}");
        }

        let backend = match GitBackend::open(&root) {
            Ok(b) => b,
            Err(err) => {
                log::warn!("notebox git: open failed: {err}");
                return;
            }
        };

        match backend.status_summary() {
            Ok(mut status) => {
                // Fill in outgoing commits (needs the configured branch), so the
                // frontend's Publish affordance is correct from notebox-open.
                status.unpushed = backend
                    .unpushed_count(crate::commands::git::REMOTE_NAME, &git_cfg.branch)
                    .unwrap_or(0);
                log::info!(
                    "notebox git: branch={:?} head={:?} dirty={} ahead={} behind={}",
                    status.branch,
                    status.head,
                    status.dirty,
                    status.ahead,
                    status.behind
                );
                // Scoped to the opening window: another window showing a
                // different notebox must not adopt this one's git status.
                publish(
                    &handle,
                    Audience::Window(&owner_label),
                    AppEvent::GitStatus {
                        remote: git_cfg.remote,
                        branch: git_cfg.branch,
                        status,
                    },
                );
            }
            Err(err) => log::warn!("notebox git: status failed: {err}"),
        }
    });
}

/// When a notebox without a collaboration config opens, check whether it is a
/// git repo with an `origin` remote. If so, emit `notebox:git-reconnectable` so
/// the frontend can offer a one-click reconnect.
fn surface_reconnectable_git(
    handle: &tauri::AppHandle,
    owner_label: String,
    root: std::path::PathBuf,
) {
    let handle = handle.clone();
    tokio::task::spawn_blocking(move || {
        use crate::git::backend::GitBackend;

        if !GitBackend::is_repo(&root) {
            return;
        }
        let backend = match GitBackend::open(&root) {
            Ok(b) => b,
            Err(_) => return,
        };
        let remote = match backend.remote_url(crate::commands::git::REMOTE_NAME) {
            Some(r) if !r.trim().is_empty() => r,
            // A repo without an origin remote isn't a collaboration we can rejoin.
            _ => return,
        };
        let branch = backend
            .current_head()
            .ok()
            .flatten()
            .map(|(b, _)| b)
            .unwrap_or_else(|| "main".to_string());
        log::info!("notebox git: reconnectable repo (origin set, no collaboration config)");
        publish(
            &handle,
            Audience::Window(&owner_label),
            AppEvent::GitReconnectable { remote, branch },
        );
    });
}

/// Apply one batch of watcher events. Frontend refresh events go out per event,
/// so the UI stays responsive; the reindex is batched, so a burst causes one
/// backlink rebuild. Deletes and renames are handled per event, and a path
/// deleted or renamed by the end of the batch isn't reindexed.
fn dispatch_watcher_batch(
    handle: &tauri::AppHandle,
    owner: &str,
    events: Vec<crate::events::AppEvent>,
) {
    use std::collections::HashSet;
    use std::path::PathBuf;

    let is_note = |p: &std::path::Path| p.extension().and_then(|e| e.to_str()) == Some("typ");
    let mut reindex_order: Vec<PathBuf> = Vec::new();
    let mut reindex_set: HashSet<PathBuf> = HashSet::new();
    let mut removals_and_renames: Vec<WatcherIndexStep> = Vec::new();

    for event in &events {
        match event {
            AppEvent::FileChanged { path, .. } => {
                publish(handle, Audience::Window(owner), event.clone());
                if is_note(path) && reindex_set.insert(path.clone()) {
                    reindex_order.push(path.clone());
                }
            }
            AppEvent::FileCreated { path } => {
                publish(handle, Audience::Window(owner), event.clone());
                if is_note(path) && reindex_set.insert(path.clone()) {
                    reindex_order.push(path.clone());
                }
            }
            AppEvent::FileDeleted { path } => {
                publish(handle, Audience::Window(owner), event.clone());
                // If this file was changed earlier in the same window, drop it
                // from the reindex set — the delete wins.
                reindex_set.remove(path);
                removals_and_renames.push(WatcherIndexStep::Remove(path.clone()));
            }
            AppEvent::FileRenamed { from, to } => {
                // Delete and create refresh the tree; the rename event lets an
                // open tab follow the move.
                let audience = Audience::Window(owner);
                publish(
                    handle,
                    audience,
                    AppEvent::FileDeleted { path: from.clone() },
                );
                publish(handle, audience, AppEvent::FileCreated { path: to.clone() });
                publish(handle, audience, event.clone());
                // The rename helper reindexes `to` itself; drop both endpoints
                // from the batch.
                reindex_set.remove(from);
                reindex_set.remove(to);
                removals_and_renames.push(WatcherIndexStep::Rename(from.clone(), to.clone()));
            }
            _ => {}
        }
    }

    // Drop any path that ended the window deleted/renamed (still present in
    // `reindex_order` but removed from the set).
    reindex_order.retain(|p| reindex_set.contains(p));

    // Apply the index work on the watcher thread, in order, before the next
    // batch: separate tasks could run out of order and, say, drop a note after
    // its re-creation was indexed.
    if !removals_and_renames.is_empty() || !reindex_order.is_empty() {
        tauri::async_runtime::block_on(apply_watcher_index_work(
            handle,
            owner,
            removals_and_renames,
            reindex_order,
        ));
    }
}

/// Index work for one removed or renamed file, in watcher order.
enum WatcherIndexStep {
    Remove(std::path::PathBuf),
    Rename(std::path::PathBuf, std::path::PathBuf),
}

/// Bring the indexes up to date with one watcher batch. See
/// [`dispatch_watcher_batch`].
async fn apply_watcher_index_work(
    handle: &tauri::AppHandle,
    owner: &str,
    removals_and_renames: Vec<WatcherIndexStep>,
    reindex: Vec<std::path::PathBuf>,
) {
    let state = handle.state::<AppState>();
    let session = state.session(owner).await;
    for step in removals_and_renames {
        match step {
            WatcherIndexStep::Remove(path) => drop_deleted_note(handle, &session, path).await,
            WatcherIndexStep::Rename(from, to) => {
                follow_renamed_note(handle, &session, from, to).await
            }
        }
    }
    if !reindex.is_empty() {
        reindex_changed_notes(handle, &session, reindex).await;
    }
}

/// Re-parse changed notes and pass them to [`NoteboxSession::reindex_notes`],
/// with one backlink resolution for the batch. Each path is checked against the
/// canonical root and read through the storage layer.
///
/// [`NoteboxSession::reindex_notes`]: crate::state::NoteboxSession::reindex_notes
async fn reindex_changed_notes(
    handle: &tauri::AppHandle,
    session: &crate::state::NoteboxSession,
    paths: Vec<std::path::PathBuf>,
) {
    // Need both notebox_root and storage. If either is missing the notebox
    // has been closed, so bail out silently.
    let Some(notebox_root) = session.notebox_root.read().await.clone() else {
        return;
    };
    let Some(storage) = session.storage.read().await.clone() else {
        return;
    };

    let mut batch: Vec<(std::path::PathBuf, String)> = Vec::with_capacity(paths.len());
    for path in paths {
        // Events for symlinks resolve to their real paths; refuse anything
        // outside the root.
        let rel = match path.strip_prefix(&notebox_root) {
            Ok(rel) => rel.to_path_buf(),
            Err(_) => continue,
        };
        match storage.read_file(&rel).await {
            Ok(content) => batch.push((path, content)),
            Err(err) => {
                // File may have been deleted between the change event and
                // the re-parse — the next FileDeleted event will clean up.
                log::warn!("watcher reindex failed for {}: {err}", path.display());
            }
        }
    }

    if batch.is_empty() {
        return;
    }

    // Reindex the whole batch with one backlink resolution, then notify
    // UI that mirrors the in-memory indices (e.g. the backlinks pane).
    let updated: Vec<std::path::PathBuf> = batch.iter().map(|(p, _)| p.clone()).collect();
    session.reindex_notes(batch).await;
    for path in updated {
        publish(
            handle,
            Audience::Window(&session.owner_label),
            AppEvent::NoteIndexUpdated { path },
        );
    }
}

/// An external rename: rewrite wikilinks to `from` so they point at `to`, then
/// update the indexes. Otherwise an external `mv` would leave dangling `[[Old
/// Name]]` links.
async fn follow_renamed_note(
    handle: &tauri::AppHandle,
    session: &crate::state::NoteboxSession,
    from: std::path::PathBuf,
    to: std::path::PathBuf,
) {
    // Only notes are in the link index. A rename to a non-note arrives as
    // delete and create instead.
    if to.extension().and_then(|e| e.to_str()) != Some("typ") {
        return;
    }

    let Some(notebox_root) = session.notebox_root.read().await.clone() else {
        return;
    };
    let Some(storage) = session.storage.read().await.clone() else {
        return;
    };

    // Both ends must be under the canonical root (symlinks resolve to their
    // real targets).
    if from.strip_prefix(&notebox_root).is_err() || to.strip_prefix(&notebox_root).is_err() {
        return;
    }

    // Errors are logged; a partial rewrite is better than none.
    if let Err(err) =
        crate::commands::file_ops::rewrite_backlinks_for_rename(&from, &to, &storage, session).await
    {
        log::warn!(
            "wikilink rewrite failed during external rename {} → {}: {err}",
            from.display(),
            to.display()
        );
    }

    // Drop the old path from every index, then index the new path.
    session.remove_from_indices(&from).await;

    let rel = to
        .strip_prefix(&notebox_root)
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|_| to.clone());
    match storage.read_file(&rel).await {
        Ok(content) => {
            session.reindex_note(&to, &content).await;
        }
        Err(err) => {
            log::warn!(
                "watcher reindex failed for renamed file {}: {err}",
                to.display()
            );
        }
    }

    publish(
        handle,
        Audience::Window(&session.owner_label),
        AppEvent::NoteRenameIndexed { from, to },
    );
}

/// Drop a deleted file from every in-memory index and the persistent
/// metadata cache.
async fn drop_deleted_note(
    handle: &tauri::AppHandle,
    session: &crate::state::NoteboxSession,
    path: std::path::PathBuf,
) {
    if path.extension().and_then(|e| e.to_str()) != Some("typ") {
        return;
    }
    session.remove_from_indices(&path).await;
    publish(
        handle,
        Audience::Window(&session.owner_label),
        AppEvent::NoteIndexUpdated { path },
    );
}

/// Return summary info (name, file count, property keys) for the currently open notebox, or `None` if no notebox is open.
#[tauri::command]
pub async fn get_notebox_info(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<NoteboxInfo>, InkyCapError> {
    let session = state.session(window.label()).await;
    let notebox_root = session.notebox_root.read().await;
    let Some(ref path) = *notebox_root else {
        return Ok(None);
    };

    let index = session.property_index.read().await;
    let collection_files = session.collection_files.read().await;

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Notebox".to_string());

    Ok(Some(NoteboxInfo {
        path: to_frontend_string(path),
        name,
        file_count: index.note_count(),
        collection_count: collection_files.len(),
        property_keys: index.property_keys.iter().cloned().collect(),
    }))
}

/// True for a documentation notebox, English or any locale
/// (`InkyCap-Documentation-fr-CA`, …): a folder directly in the config dir whose
/// name starts with `InkyCap-Documentation`.
pub(crate) fn is_docs_notebox(path: &str) -> bool {
    let candidate = std::path::PathBuf::from(path);
    let canon = std::fs::canonicalize(&candidate).unwrap_or(candidate);
    let config_dir = crate::app_paths::config_dir();
    let config = std::fs::canonicalize(&config_dir).unwrap_or(config_dir);
    match (canon.parent(), canon.file_name().and_then(|n| n.to_str())) {
        (Some(parent), Some(name)) => {
            parent == config
                && (name == "InkyCap-Documentation" || name.starts_with("InkyCap-Documentation-"))
        }
        _ => false,
    }
}

/// Reject a folder inside another notebox or containing a registered one; the
/// outer notebox would scan the inner one's files.
fn validate_no_notebox_nesting(canonical: &std::path::Path) -> Result<(), InkyCapError> {
    // Child-of-notebox: any ancestor folder that is itself a notebox.
    let marker = crate::notebox_package::format_marker_relpath();
    let mut ancestor = canonical.parent();
    while let Some(dir) = ancestor {
        if dir.join(marker).is_file() {
            return Err(InkyCapError::InvalidPath(format!(
                "That folder is inside an existing notebox ({}). Choose a folder outside it.",
                dir.display()
            )));
        }
        ancestor = dir.parent();
    }
    // Parent-of-notebox: a registered notebox that lives below this folder.
    let cfg = config::load_config();
    for entry in &cfg.notebox_registry {
        let entry_path = std::path::PathBuf::from(&entry.path);
        let entry_canon = std::fs::canonicalize(&entry_path).unwrap_or(entry_path);
        if entry_canon != *canonical && entry_canon.starts_with(canonical) {
            return Err(InkyCapError::InvalidPath(format!(
                "That folder contains an existing notebox ({}). Choose a different folder.",
                entry_canon.display()
            )));
        }
    }
    Ok(())
}

/// A notebox open in some window: its path and the window's label.
#[derive(Debug, serde::Serialize)]
pub struct OpenNoteboxWindow {
    pub path: String,
    pub label: String,
}

/// Check a folder before adding it to the notebox list: reject one already
/// listed, or nested inside or containing another notebox, so Settings can
/// explain why.
#[tauri::command]
pub async fn validate_notebox_location(path: String) -> Result<(), InkyCapError> {
    let p = std::path::PathBuf::from(&path);
    if !p.is_dir() {
        return Err(InkyCapError::InvalidPath(format!("Not a folder: {path}")));
    }
    let canonical = crate::storage::path::canonicalize_root(&p)?;

    // Already in the user's list (compare canonically so trailing slashes /
    // symlinks don't sneak a duplicate through).
    let cfg = config::load_config();
    for entry in &cfg.notebox_registry {
        let entry_canon = std::fs::canonicalize(&entry.path)
            .unwrap_or_else(|_| std::path::PathBuf::from(&entry.path));
        if entry_canon == canonical {
            return Err(InkyCapError::BadRequest(
                "That folder is already in your notebox list.".to_string(),
            ));
        }
    }

    // Not nested inside, and doesn't contain, another notebox.
    validate_no_notebox_nesting(&canonical)
}

/// List every notebox currently open across all windows.
#[tauri::command]
pub async fn list_open_noteboxes(
    state: State<'_, AppState>,
) -> Result<Vec<OpenNoteboxWindow>, InkyCapError> {
    Ok(state
        .open_noteboxes()
        .await
        .into_iter()
        .map(|(label, root)| OpenNoteboxWindow {
            path: to_frontend_string(&root),
            label,
        })
        .collect())
}

// ── Notebox registry commands ──────────────────────────────────────────

/// A registry entry for the frontend, with `collaborative` computed on each
/// call from the notebox's settings (it isn't stored, so it can't go stale).
#[derive(Debug, serde::Serialize)]
pub struct NoteboxRegistryItem {
    pub path: String,
    pub display_name: String,
    pub last_opened: u64,
    /// This notebox carries a git collaboration config in its settings.
    pub collaborative: bool,
}

/// Return all registered noteboxes sorted by most recently opened, each tagged
/// with whether it is set up for git collaboration.
#[tauri::command]
pub async fn get_notebox_registry() -> Result<Vec<NoteboxRegistryItem>, InkyCapError> {
    let cfg = config::load_config();
    let mut entries = cfg.notebox_registry;
    // The system documentation notebox is reachable only from the F1 Help
    // panel — never list it among the user's noteboxes.
    entries.retain(|e| !is_docs_notebox(&e.path));
    entries.sort_by_key(|b| std::cmp::Reverse(b.last_opened));
    Ok(entries
        .into_iter()
        .map(|e| {
            // Reads only the notebox's settings.json. A missing file means not
            // collaborative.
            let collaborative =
                crate::notebox_settings::load_settings(std::path::Path::new(&e.path))
                    .git
                    .is_some();
            NoteboxRegistryItem {
                path: e.path,
                display_name: e.display_name,
                last_opened: e.last_opened,
                collaborative,
            }
        })
        .collect())
}

/// Add or update a notebox in the persistent registry. The path must be an existing directory.
#[tauri::command]
pub async fn register_notebox(
    path: String,
    display_name: Option<String>,
) -> Result<(), InkyCapError> {
    let notebox_path = std::path::PathBuf::from(&path);
    if !notebox_path.is_dir() {
        return Err(InkyCapError::InvalidPath(format!(
            "Not a directory: {}",
            path
        )));
    }
    let name = display_name.unwrap_or_else(|| {
        notebox_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Notebox".to_string())
    });
    let mut cfg = config::load_config();
    cfg.upsert_notebox(&path, &name);
    config::save_config(&cfg)?;
    Ok(())
}

/// Update the display name of an existing notebox registry entry.
#[tauri::command]
pub async fn update_notebox_entry(path: String, display_name: String) -> Result<(), InkyCapError> {
    let mut cfg = config::load_config();
    let entry = cfg
        .notebox_registry
        .iter_mut()
        .find(|e| e.path == path)
        .ok_or_else(|| InkyCapError::InvalidPath(format!("Notebox not in registry: {}", path)))?;
    entry.display_name = display_name;
    config::save_config(&cfg)?;
    Ok(())
}

/// Remove a notebox from the registry (files on disk are kept). If it was the
/// saved notebox, the pointer is cleared so it isn't reopened. The frontend
/// unloads it separately (see `closeActiveNotebox` in stores/notebox.ts).
#[tauri::command]
pub async fn remove_notebox_from_registry(path: String) -> Result<(), InkyCapError> {
    let mut cfg = config::load_config();
    cfg.remove_notebox(&path);
    if cfg.notebox_path.as_deref() == Some(path.as_str()) {
        cfg.notebox_path = None;
    }
    config::save_config(&cfg)?;
    Ok(())
}

/// `true` if `path` is an empty directory or doesn't exist yet, as git requires
/// for a clone destination. An existing notebox has `.inkycap/`, so cloning
/// into one is refused.
#[tauri::command]
pub async fn dir_is_empty(path: String) -> Result<bool, InkyCapError> {
    let dir = std::path::PathBuf::from(&path);
    if !dir.exists() {
        return Ok(true);
    }
    if !dir.is_dir() {
        return Ok(false);
    }
    let mut entries = std::fs::read_dir(&dir)
        .map_err(|e| InkyCapError::InvalidPath(format!("Cannot read directory {}: {}", path, e)))?;
    Ok(entries.next().is_none())
}

#[derive(Debug, serde::Serialize)]
pub struct NoteboxMoveResult {
    pub new_path: String,
    pub was_active: bool,
}

/// Rename/move a notebox directory on disk and update the registry and active notebox path accordingly.
#[tauri::command]
pub async fn move_notebox(
    old_path: String,
    new_path: String,
) -> Result<NoteboxMoveResult, InkyCapError> {
    let old = std::path::PathBuf::from(&old_path);
    let new = std::path::PathBuf::from(&new_path);

    if !old.is_dir() {
        return Err(InkyCapError::InvalidPath(format!(
            "Source notebox not found: {}",
            old_path
        )));
    }
    if new.exists() {
        return Err(InkyCapError::InvalidPath(format!(
            "Destination already exists: {}",
            new_path
        )));
    }
    if let Some(parent) = new.parent() {
        if !parent.is_dir() {
            return Err(InkyCapError::InvalidPath(format!(
                "Destination parent does not exist: {}",
                parent.display()
            )));
        }
    }

    // On a blocking thread: a move across filesystems can turn into a recursive
    // copy.
    {
        let (old, new) = (old.clone(), new.clone());
        tauri::async_runtime::spawn_blocking(move || std::fs::rename(&old, &new))
            .await
            .map_err(|e| std::io::Error::other(format!("move task failed: {e}")))?
            .map_err(|e| {
                InkyCapError::InvalidPath(format!(
                    "Failed to move notebox from {} to {}: {}",
                    old_path, new_path, e
                ))
            })?;
    }

    let mut cfg = config::load_config();
    let was_active = cfg.notebox_path.as_deref() == Some(&old_path);

    if let Some(entry) = cfg.notebox_registry.iter_mut().find(|e| e.path == old_path) {
        entry.path = new_path.clone();
    }
    if was_active {
        cfg.notebox_path = Some(new_path.clone());
    }
    config::save_config(&cfg)?;

    Ok(NoteboxMoveResult {
        new_path,
        was_active,
    })
}

/// Result of copying notebox setup files from a source notebox.
#[derive(Debug, serde::Serialize)]
pub struct NoteboxSeedResult {
    pub copied_files: usize,
    pub copied_scaffolds: usize,
    /// Non-fatal issues — e.g. an absolute `bibliography_path` in the
    /// source that didn't resolve in the destination, so it was cleared.
    pub warnings: Vec<String>,
}

/// `true` if the folder already holds a notebox (it has `.inkycap`).
#[tauri::command]
pub async fn notebox_is_existing(path: String) -> Result<bool, InkyCapError> {
    let dir = std::path::PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(InkyCapError::InvalidPath(format!(
            "Not a directory: {}",
            path
        )));
    }
    Ok(crate::notebox_settings::is_existing_notebox(&dir))
}

/// Seed a new notebox's `.inkycap/` from another notebox: settings, creation
/// rules, scaffolds and property types. Absolute paths in the settings
/// (`citations.bibliography_path`, `citations.custom_csl_path`) that don't
/// resolve in the new notebox are cleared, with a warning.
///
/// Refuses if the target is already a notebox. Both paths must be existing
/// directories.
#[tauri::command]
pub async fn seed_notebox_from_source(
    target_path: String,
    source_path: String,
) -> Result<NoteboxSeedResult, InkyCapError> {
    // The body is a sequence of blocking std::fs copies; run it on a blocking
    // pool so the async worker isn't stalled.
    tauri::async_runtime::spawn_blocking(move || {
        seed_notebox_from_source_blocking(&target_path, &source_path)
    })
    .await
    .map_err(|e| std::io::Error::other(format!("seed task failed: {e}")))?
}

/// Synchronous worker for [`seed_notebox_from_source`], run on a blocking pool.
fn seed_notebox_from_source_blocking(
    target_path: &str,
    source_path: &str,
) -> Result<NoteboxSeedResult, InkyCapError> {
    let target = std::path::PathBuf::from(target_path);
    let source = std::path::PathBuf::from(source_path);

    if !target.is_dir() {
        return Err(InkyCapError::InvalidPath(format!(
            "Target notebox not a directory: {}",
            target_path
        )));
    }
    if !source.is_dir() {
        return Err(InkyCapError::InvalidPath(format!(
            "Source notebox not a directory: {}",
            source_path
        )));
    }
    if target == source {
        return Err(InkyCapError::InvalidPath(
            "Source and target must be different noteboxes".to_string(),
        ));
    }

    let target_inkycap = target.join(".inkycap");
    let source_inkycap = source.join(".inkycap");
    if !source_inkycap.is_dir() {
        return Err(InkyCapError::InvalidPath(format!(
            "Source has no .inkycap folder: {}",
            source_path
        )));
    }

    if crate::notebox_settings::is_existing_notebox(&target) {
        return Err(InkyCapError::BadRequest(
            "Target is already a notebox — refusing to overwrite its setup".to_string(),
        ));
    }

    std::fs::create_dir_all(&target_inkycap)?;

    let mut copied_files = 0usize;
    let mut copied_scaffolds = 0usize;
    let mut warnings = Vec::new();

    // Settings — load, sanitize absolute paths, write.
    let src_settings_path = crate::notebox_settings::settings_path(&source);
    if src_settings_path.is_file() {
        let mut nb_settings = crate::notebox_settings::load_settings(&source);
        // Keep an absolute bibliography path only if it exists; keep relative
        // ones as they are.
        if let Some(ref bib) = nb_settings.citations.bibliography_path {
            if std::path::Path::new(bib).is_absolute() && !std::path::Path::new(bib).exists() {
                warnings.push(format!(
                    "Cleared citations.bibliography_path (no longer resolves): {bib}"
                ));
                nb_settings.citations.bibliography_path = None;
            }
        }
        // The custom CSL path is notebox-root-absolute; `styles/` isn't copied,
        // so clear it if the file isn't in the new notebox.
        if let Some(ref csl) = nb_settings.citations.custom_csl_path {
            if !target.join(csl.trim_start_matches('/')).exists() {
                warnings.push(format!(
                    "Cleared citations.custom_csl_path (no longer resolves): {csl}"
                ));
                nb_settings.citations.custom_csl_path = None;
            }
        }
        crate::notebox_settings::save_settings(&target, &nb_settings)?;
        copied_files += 1;
    }

    // Creation rules — copy verbatim. `scaffold_path` and `target_folder`
    // are notebox-relative; the copied scaffolds below preserve them.
    let src_rules = source_inkycap.join("creation_rules.json");
    if src_rules.is_file() {
        std::fs::copy(&src_rules, target_inkycap.join("creation_rules.json"))?;
        copied_files += 1;
    }

    // Property type registry.
    let src_props = source_inkycap.join("property-types.json");
    if src_props.is_file() {
        std::fs::copy(&src_props, target_inkycap.join("property-types.json"))?;
        copied_files += 1;
    }

    // The user's word lists (spellcheck dictionary and Mycelial stopwords).
    for name in ["dictionary.txt", "mycelial-stopwords.txt"] {
        let src = source_inkycap.join(name);
        if src.is_file() {
            std::fs::copy(&src, target_inkycap.join(name))?;
            copied_files += 1;
        }
    }

    // Scaffolds, which the copied creation rules refer to by name.
    let src_scaffolds = source_inkycap.join("scaffolds");
    if src_scaffolds.is_dir() {
        let dst_scaffolds = target_inkycap.join("scaffolds");
        std::fs::create_dir_all(&dst_scaffolds)?;
        for entry in std::fs::read_dir(&src_scaffolds)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_file() {
                if let Some(name) = path.file_name() {
                    std::fs::copy(&path, dst_scaffolds.join(name))?;
                    copied_scaffolds += 1;
                }
            }
        }
    }

    Ok(NoteboxSeedResult {
        copied_files,
        copied_scaffolds,
        warnings,
    })
}

#[cfg(test)]
mod seed_tests {
    use super::*;

    /// A source notebox with settings and creation rules to copy from.
    fn source_notebox(root: &std::path::Path) -> std::path::PathBuf {
        let source = root.join("source");
        std::fs::create_dir_all(source.join(".inkycap")).unwrap();
        std::fs::write(source.join(".inkycap/settings.json"), "{}").unwrap();
        std::fs::write(source.join(".inkycap/creation_rules.json"), "source rules").unwrap();
        source
    }

    #[test]
    fn seeds_a_folder_that_is_not_yet_a_notebox() {
        let tmp = tempfile::tempdir().unwrap();
        let source = source_notebox(tmp.path());
        let target = tmp.path().join("target");
        std::fs::create_dir_all(&target).unwrap();

        seed_notebox_from_source_blocking(target.to_str().unwrap(), source.to_str().unwrap())
            .unwrap();

        assert_eq!(
            std::fs::read_to_string(target.join(".inkycap/creation_rules.json")).unwrap(),
            "source rules"
        );
    }

    #[test]
    fn refuses_an_existing_notebox_that_has_only_default_settings() {
        // An existing notebox whose settings were never changed has an
        // `.inkycap` folder but no `settings.json`; its own files must survive.
        let tmp = tempfile::tempdir().unwrap();
        let source = source_notebox(tmp.path());
        let target = tmp.path().join("target");
        std::fs::create_dir_all(target.join(".inkycap")).unwrap();
        std::fs::write(target.join(".inkycap/creation_rules.json"), "own rules").unwrap();

        assert!(crate::notebox_settings::is_existing_notebox(&target));
        let result =
            seed_notebox_from_source_blocking(target.to_str().unwrap(), source.to_str().unwrap());

        assert!(result.is_err());
        assert_eq!(
            std::fs::read_to_string(target.join(".inkycap/creation_rules.json")).unwrap(),
            "own rules"
        );
    }
}
