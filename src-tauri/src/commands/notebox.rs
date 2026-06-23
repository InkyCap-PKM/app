use tauri::{Emitter, Manager, State};

use crate::config;
use crate::errors::InkyCapError;
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

/// Where the documentation window should boot: the system notebox root plus the
/// landing note to open first (so the window doesn't start on a blank "no file
/// selected" pane). `index` is `None` only if the notebox somehow has no
/// top-level `.typ` at all.
#[derive(serde::Serialize)]
pub struct DocsNoteboxLocation {
    pub root: String,
    pub index: Option<String>,
}

/// Config-dir folder name for the documentation notebox in a given UI locale.
/// English is the base manual and the universal fallback; other locales live in
/// a suffixed sibling (e.g. `InkyCap-Documentation-fr-CA`). A locale only earns
/// its own notebox once that manual has actually been authored — until then the
/// caller falls back to English.
fn docs_notebox_dir_name(ui_locale: &str) -> &'static str {
    match ui_locale {
        "fr-CA" => "InkyCap-Documentation-fr-CA",
        _ => "InkyCap-Documentation",
    }
}

/// Resolve (and lazily seed) the bundled "InkyCap Documentation" system
/// notebox, returning its path plus the landing note for the frontend to open
/// in a window.
///
/// It lives under the per-platform config dir (alongside the notebox registry),
/// so it survives notebox switches and is never confused with a user notebox.
/// The notebox served matches the user's UI locale when a translated manual
/// exists for it (falling back to the English manual otherwise), so a
/// French-language user gets the French documentation window.
///
/// The working copy is seeded (and refreshed on app updates / content changes)
/// from the manual bundled into the binary — see [`crate::docs_manual`]. The
/// `.inkycap/` scaffold is reapplied on every call (idempotent).
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

    // Serve the manual matching the UI locale. `docs_notebox_dir_name` already
    // falls back to the English folder for any locale without a bundled manual,
    // and `seed_if_stale` is a no-op for a folder we don't bundle.
    let dir_name = docs_notebox_dir_name(&ui_locale);
    let root = config_dir.join(dir_name);

    std::fs::create_dir_all(&root)?;
    crate::docs_manual::seed_if_stale(dir_name, &root)?;
    crate::notebox_package::scaffold(&root);

    // Pick the landing note: a top-level `.typ` whose stem contains "index"
    // (case-insensitive — matches both the seeded `index.typ` and a renamed
    // "0 - Index.typ" in the authored manual), falling back to the first note
    // when sorted by name.
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

    // Flag the bundled documentation notebox as a special, help-only session:
    // content edits are kept for the session but never written to disk, and
    // structural mutations are refused (see the mutating commands). Set on every
    // open so a window reused for a different notebox reverts to a normal,
    // writable session.
    let is_docs = is_docs_notebox(&path);
    if is_docs {
        log::info!("documentation notebox opened: ephemeral edits + docs fonts active");
    }
    session.set_documentation(is_docs);

    // One notebox per window: a notebox open in two windows would let two
    // editors over the same file silently overwrite each other. If it's
    // already open elsewhere, refuse — the frontend focuses that window
    // instead of opening a duplicate.
    if let Some(other) = state.window_for_notebox(&canonical, &label).await {
        return Err(InkyCapError::NoteboxAlreadyOpen(other));
    }

    // No nested noteboxes (a notebox inside another, or one that contains
    // another) — the inner notebox's files would also belong to the outer.
    validate_no_notebox_nesting(&canonical)?;

    // Phase A — fast path: walk the directory, set notebox_root + storage, list
    // collection files. The UI can render the file tree as soon as this returns.
    // Citation style falls back to the user-global named style, so pass the
    // global citation settings in.
    let global_citations = state.settings.read().await.citations.clone();
    let note_count = session
        .open_notebox_fast(notebox_path.clone(), &global_citations)
        .await?;

    // Narrow the Tauri asset protocol scope to the newly-opened notebox so that
    // `convertFileSrc()` can only load images/attachments that live inside
    // the notebox. The static config starts with an empty allow-list; we add
    // the canonical notebox root here once it's known. (Tauri's scope is
    // additive across notebox opens — this is a minor leak if the user hops
    // between noteboxes in a single session, but it never grants anything
    // outside a legitimately-opened notebox, which is what matters for
    // untrusted-note defense.)
    if let Some(canonical_root) = session.notebox_root.read().await.as_ref().cloned() {
        let scope = app_handle.asset_protocol_scope();
        if let Err(err) = scope.allow_directory(&canonical_root, true) {
            log::warn!(
                "could not extend asset protocol scope to {}: {err}",
                canonical_root.display()
            );
        }
    }

    // Replace the per-notebox health monitor: abort any previous one (from
    // a notebox that's just been closed/reopened) and spawn a fresh monitor
    // for this notebox's canonical root. The monitor handles both
    // "notebox root vanished" detection and `.inkycap/` auto-healing.
    if let Some(canonical_root) = session.notebox_root.read().await.clone() {
        let mut slot = session.health_monitor.write().await;
        if let Some(prev) = slot.take() {
            prev.abort();
        }
        *slot = Some(crate::notebox_health::spawn(
            app_handle.clone(),
            canonical_root,
        ));
    }

    // Start file watcher and bridge events to the frontend. The watcher is
    // per-session; its events are targeted at the owning window only.
    match file_watcher::start_watching(&notebox_path) {
        Ok((watcher, rx)) => {
            *session.watcher.write().await = Some(watcher);

            // Spawn a background task to forward watcher events to the Tauri
            // frontend, and to write file changes through to the persistent
            // metadata cache so externally-edited files don't have to be
            // re-parsed on next launch.
            //
            // The watcher channel is a synchronous `std::sync::mpsc`, so the
            // dispatcher itself runs on a blocking task; per-event async work
            // (cache upserts) is offloaded to short-lived tokio tasks.
            let handle = app_handle.clone();
            let owner = label.clone();
            tokio::task::spawn_blocking(move || {
                use std::sync::mpsc::RecvTimeoutError;
                use std::time::Duration;

                // Coalesce a burst of watcher events into one batch: after the
                // first event, keep draining until the stream goes quiet for
                // `COALESCE_WINDOW` (or we hit `COALESCE_MAX`). This collapses a
                // git checkout / bulk rewrite / editor write-then-touch storm
                // into a single reindex pass — one notebox-wide backlink
                // rebuild — instead of one O(notebox) rebuild per event.
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

    // Notebox-level git collaboration: if this notebox carries a git config
    // and is already a git repo, refresh its `.gitignore` and surface a
    // status summary to the frontend. No auto-fetch — review always sits
    // between fetch and apply, so opening only reads local state.
    if let Some(canonical_root) = session.notebox_root.read().await.clone() {
        // One-time migration for noteboxes from before the git config moved out
        // of the shared settings.json into the per-machine local.json. Idempotent
        // and a no-op for already-migrated (and never-collaborative) noteboxes.
        if let Err(err) = crate::notebox_settings::migrate_git_config(&canonical_root) {
            log::warn!("notebox git: could not migrate git config to local.json: {err}");
        }
        let git_cfg = session.notebox_settings.read().await.git.clone();
        match git_cfg {
            Some(git_cfg) => {
                surface_git_status(&app_handle, label.clone(), canonical_root, git_cfg)
            }
            // No collaboration config, but the notebox may still be a git repo
            // with a remote (an external clone, or a config dropped/not yet
            // written) — surface a reconnect offer rather than treating it as
            // plainly non-collaborative.
            None => surface_reconnectable_git(&app_handle, label.clone(), canonical_root),
        }
    }

    let name = notebox_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Notebox".to_string());

    // Persist the "last opened" notebox + registry entry ONLY for the main
    // window. A secondary window (the docs window, an "open in new window"
    // note) opening a different notebox must not change what the app reopens
    // next launch, nor add system noteboxes to the user's registry.
    if label == "main" {
        let mut cfg = config::load_config();
        cfg.notebox_path = Some(path.clone());
        cfg.upsert_notebox(&path, &name);
        let _ = config::save_config(&cfg);
    }

    let collection_count = session.collection_files.read().await.len();

    // Phase B — spawn the heavy index build in the background for this
    // session. The UI is already interactive; features that depend on the
    // indexes (search, tags, backlinks, properties) show a loading state until
    // the `notebox:index-ready` event fires.
    spawn_index_rebuild(app_handle.clone(), session.clone());

    Ok(NoteboxInfo {
        path: to_frontend_string(&notebox_path),
        name,
        file_count: note_count,
        collection_count,
        property_keys: Vec::new(),
    })
}

/// Rebuild a session's indexes in the background after a bulk on-disk change
/// (notebox open, markdown import, git sync/pull, package import, backup
/// restore) and signal the frontend when they are ready via
/// `notebox:index-ready` (or `notebox:index-error` on failure).
///
/// `build_indexes` is incremental — the metadata cache reconciles by mtime, so
/// only files that actually changed are re-parsed — which makes this cheap for a
/// small sync and correct for a large one. It is the reliable alternative to
/// leaning on the file watcher alone, whose OS event queue can silently overflow
/// when thousands of files land at once (a bulk import, a large pull, a full
/// restore), leaving the link graph, search index, and corpus stale so
/// backlinks, search, and the Mycelial View show the new notes as unconnected.
pub(crate) fn spawn_index_rebuild(
    app_handle: tauri::AppHandle,
    session: std::sync::Arc<crate::state::NoteboxSession>,
) {
    tauri::async_runtime::spawn(async move {
        match session.build_indexes().await {
            Ok(stats) => {
                let _ = app_handle.emit("notebox:index-ready", &stats);
            }
            Err(err) => {
                log::error!("Background index rebuild failed: {err}");
                let _ = app_handle.emit(
                    "notebox:index-error",
                    serde_json::json!({ "error": err.to_string() }),
                );
            }
        }
    });
}

/// User-initiated "Rebuild cache" recovery action (Settings → Files & Links).
///
/// Discards this notebox's persisted caches and rebuilds every index from disk
/// (see [`NoteboxSession::rebuild_indexes_from_disk`]). Unlike the open-time
/// background rebuild, this blocks until done so the frontend can drive a busy
/// state off the returned promise; it re-parses the whole notebox, so it can
/// take seconds-to-minutes on a large one. On success it emits the same
/// refresh signals the open flow does — `notebox:index-ready` (counts, aliases)
/// and `notebox:index-updated` (open collection views) — scoped to this window
/// since the notebox is per-window.
#[tauri::command]
pub async fn rebuild_notebox_indexes(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<crate::state::IndexStats, InkyCapError> {
    let session = state.session(window.label()).await;
    let stats = session.rebuild_indexes_from_disk().await?;
    let _ = window.emit_to(window.label(), "notebox:index-ready", &stats);
    let _ = window.emit_to(
        window.label(),
        "notebox:index-updated",
        serde_json::json!({ "rebuilt": true }),
    );
    Ok(stats)
}

/// On opening a *collaborative* notebox (one carrying a [`NoteboxGitConfig`]
/// that is already a git repo), refresh its `.gitignore` and emit a status
/// summary (`notebox:git-status`) the frontend can show. Runs on a blocking
/// task because libgit2 calls are synchronous.
///
/// Deliberately read-only: it never fetches or commits. A notebox that has a
/// configured remote but has not been initialized as a repo yet (Phase 4
/// setup) is skipped with a log line, not auto-`init`ed — turning a notebox
/// into a repo is an explicit user action, not a side effect of opening it.
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
                let _ = handle.emit_to(
                    owner_label.as_str(),
                    "notebox:git-status",
                    serde_json::json!({
                        "remote": git_cfg.remote,
                        "branch": git_cfg.branch,
                        "status": status,
                    }),
                );
            }
            Err(err) => log::warn!("notebox git: status failed: {err}"),
        }
    });
}

/// On opening a notebox that has **no** collaboration config, check whether it
/// is nonetheless a git repo with an `origin` remote — an external clone, or a
/// config that was dropped or never written. If so, emit
/// `notebox:git-reconnectable` so the frontend can offer a one-click reconnect
/// (deriving the remote/branch from git) instead of presenting a blank setup
/// form. A plain notebox (no repo, or a repo without a remote) emits nothing.
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
        let _ = handle.emit_to(
            owner_label.as_str(),
            "notebox:git-reconnectable",
            serde_json::json!({ "remote": remote, "branch": branch }),
        );
    });
}

/// Apply one coalesced window of watcher events.
///
/// Frontend refresh events are emitted immediately, per event, so the file
/// tree and open editors stay responsive (each window self-scopes; see the
/// dispatcher comment). The *heavy* index work — re-parsing notes and
/// rebuilding the backlink index — is collapsed into a single batched reindex
/// so a burst doesn't trigger N concurrent O(notebox) rebuilds.
///
/// Deletes and renames are rarer and keep their dedicated per-event helpers,
/// but a path that ends the window deleted or renamed is removed from the
/// reindex set so we never re-parse a file that no longer exists.
fn dispatch_watcher_batch(
    handle: &tauri::AppHandle,
    owner: &str,
    events: Vec<crate::events::AppEvent>,
) {
    use crate::events::{AppEvent, ChangeKind};
    use std::collections::HashSet;
    use std::path::PathBuf;

    let is_note = |p: &std::path::Path| p.extension().and_then(|e| e.to_str()) == Some("typ");
    let mut reindex_order: Vec<PathBuf> = Vec::new();
    let mut reindex_set: HashSet<PathBuf> = HashSet::new();

    for event in &events {
        match event {
            AppEvent::FileChanged { path, change } => {
                let _ = handle.emit(
                    "notebox:file-changed",
                    serde_json::json!({
                        "path": to_frontend_string(path),
                        "change": match change {
                            ChangeKind::Content => "Content",
                            ChangeKind::Metadata => "Metadata",
                        }
                    }),
                );
                if is_note(path) && reindex_set.insert(path.clone()) {
                    reindex_order.push(path.clone());
                }
            }
            AppEvent::FileCreated { path } => {
                let _ = handle.emit(
                    "notebox:file-created",
                    serde_json::json!({ "path": to_frontend_string(path) }),
                );
                if is_note(path) && reindex_set.insert(path.clone()) {
                    reindex_order.push(path.clone());
                }
            }
            AppEvent::FileDeleted { path } => {
                let _ = handle.emit(
                    "notebox:file-deleted",
                    serde_json::json!({ "path": to_frontend_string(path) }),
                );
                // If this file was changed earlier in the same window, drop it
                // from the reindex set — the delete wins.
                reindex_set.remove(path);
                sync_cache_for_deleted_file(handle, owner.to_string(), path.clone());
            }
            AppEvent::FileRenamed { from, to } => {
                // Fire delete+create so the tree refreshes the same way it
                // always has, plus the dedicated rename event for listeners
                // that follow the move (e.g. an open editor tab).
                let _ = handle.emit(
                    "notebox:file-deleted",
                    serde_json::json!({ "path": to_frontend_string(from) }),
                );
                let _ = handle.emit(
                    "notebox:file-created",
                    serde_json::json!({ "path": to_frontend_string(to) }),
                );
                let _ = handle.emit(
                    "notebox:file-renamed",
                    serde_json::json!({
                        "from": to_frontend_string(from),
                        "to": to_frontend_string(to)
                    }),
                );
                // The rename helper reindexes `to` itself; drop both endpoints
                // from the batch.
                reindex_set.remove(from);
                reindex_set.remove(to);
                sync_cache_for_renamed_file(handle, owner.to_string(), from.clone(), to.clone());
            }
            _ => {}
        }
    }

    // Drop any path that ended the window deleted/renamed (still present in
    // `reindex_order` but removed from the set).
    reindex_order.retain(|p| reindex_set.contains(p));
    if !reindex_order.is_empty() {
        spawn_batch_reindex(handle, owner.to_string(), reindex_order);
    }
}

/// Re-parse a coalesced set of changed/created notes and push them through
/// [`AppState::reindex_notes`] — a single notebox-wide backlink resolution for
/// the whole batch. Each path is re-validated against the canonical notebox
/// root (defense in depth for symlinked watcher events) and read through the
/// validated storage pipeline. Spawns a short-lived async task because the
/// watcher dispatcher runs on a blocking thread.
fn spawn_batch_reindex(handle: &tauri::AppHandle, owner: String, paths: Vec<std::path::PathBuf>) {
    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<AppState>();
        let session = state.session(&owner).await;

        // Need both notebox_root and storage. If either is missing the notebox
        // has been closed, so bail out silently.
        let notebox_root = match session.notebox_root.read().await.clone() {
            Some(r) => r,
            None => return,
        };
        let storage = match session.storage.read().await.clone() {
            Some(s) => s,
            None => return,
        };

        let mut batch: Vec<(std::path::PathBuf, String)> = Vec::with_capacity(paths.len());
        for path in paths {
            // Skip files outside the canonical notebox root — watcher events
            // for symlinked files resolve to their real paths, so an out-of-
            // root path is an escape attempt and we refuse to index it.
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
        for path in &updated {
            let _ = handle.emit(
                "notebox:index-updated",
                serde_json::json!({ "path": to_frontend_string(path) }),
            );
        }
    });
}

/// Handle an externally-observed rename: rewrite wikilinks in every note
/// that referenced `from` so they point at `to`, then update the indices
/// (drop `from`, index `to`). Without this, external `mv`s would leave
/// orphan `[[Old Name]]` / `#wikilink("Old Name")` references behind,
/// since the watcher's split delete+create events provide no way to
/// correlate the two sides.
fn sync_cache_for_renamed_file(
    handle: &tauri::AppHandle,
    owner: String,
    from: std::path::PathBuf,
    to: std::path::PathBuf,
) {
    // Only `.typ` notes participate in the link index. A rename whose
    // *new* side isn't a note (e.g. `note.typ` → `note.bak`) is handled
    // upstream by the watcher emitting the asymmetric delete/create
    // pair, so we won't see a `FileRenamed` for it.
    if to.extension().and_then(|e| e.to_str()) != Some("typ") {
        return;
    }

    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<AppState>();
        let session = state.session(&owner).await;

        let notebox_root = match session.notebox_root.read().await.clone() {
            Some(r) => r,
            None => return,
        };
        let storage = match session.storage.read().await.clone() {
            Some(s) => s,
            None => return,
        };

        // Symlink-escape defence: both endpoints must live under the
        // canonical notebox root. Watcher events for symlinked paths
        // resolve to their real targets, so an out-of-root path here
        // is an escape attempt.
        if from.strip_prefix(&notebox_root).is_err() || to.strip_prefix(&notebox_root).is_err() {
            return;
        }

        // Rewrite wikilinks in every backlink of the old path. Errors
        // are logged but non-fatal — a partial rewrite is still better
        // than no rewrite, and the user can re-save manually if needed.
        if let Err(err) =
            crate::commands::file_ops::rewrite_backlinks_for_rename(&from, &to, &storage, &session)
                .await
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

        let _ = handle.emit(
            "notebox:index-updated",
            serde_json::json!({
                "from": to_frontend_string(&from),
                "to": to_frontend_string(&to),
            }),
        );
    });
}

/// Drop a deleted file from every in-memory index and the persistent
/// metadata cache.
fn sync_cache_for_deleted_file(handle: &tauri::AppHandle, owner: String, path: std::path::PathBuf) {
    if path.extension().and_then(|e| e.to_str()) != Some("typ") {
        return;
    }
    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<AppState>();
        let session = state.session(&owner).await;
        session.remove_from_indices(&path).await;
        use tauri::Emitter;
        let _ = handle.emit(
            "notebox:index-updated",
            serde_json::json!({ "path": to_frontend_string(&path) }),
        );
    });
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

/// True if `path` refers to a system documentation notebox — the English
/// `InkyCap-Documentation` or any locale variant (`InkyCap-Documentation-fr-CA`,
/// …). Matched structurally: a directory sitting directly under the config dir
/// whose name is (or is prefixed by) `InkyCap-Documentation`. This recognizes
/// every shipped manual, not just the English one, so the special-case
/// behaviour (ephemeral edits, docs fonts) applies to the localized docs too.
fn is_docs_notebox(path: &str) -> bool {
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

/// Reject a notebox folder that is nested inside another notebox, or that
/// contains an existing (registered) notebox. Nesting breaks the model — the
/// inner notebox's files would also be scanned as part of the outer.
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

/// A notebox currently open in some window: its path plus the owning window's
/// label. Lets the frontend disable / focus already-open noteboxes (a notebox
/// is exclusive to one window).
#[derive(Debug, serde::Serialize)]
pub struct OpenNoteboxWindow {
    pub path: String,
    pub label: String,
}

/// Validate a folder the user wants to add to their notebox list, BEFORE the
/// add is committed. Rejects a folder that is already in the registry, or that
/// is nested inside / contains another notebox — so the Settings "Add" button
/// can disable itself and explain why instead of silently no-op'ing.
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

/// A registry entry as presented to the frontend. Extends the persisted
/// [`config::NoteboxRegistryEntry`] with `collaborative`, computed fresh per
/// call so the Settings list can show each notebox's true collaboration state
/// without opening it. (The persisted registry deliberately does not store
/// this — it would drift from the source of truth, the notebox's own
/// `.inkycap/settings.json`.)
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
            // Cheap: reads only the notebox's own settings.json (no index, no
            // git subprocess). A missing/unreadable file yields a non-collaborative
            // default, which is the correct fallback for the toggle.
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

/// Remove a notebox from the persistent registry (does not delete files on disk).
///
/// If the removed notebox was also the saved/active one, the `notebox_path`
/// pointer is cleared so a later launch doesn't try to reopen a notebox the
/// user just removed. The frontend separately unloads the active notebox (see
/// `closeActiveNotebox` in stores/notebox.ts) so the user is walked back to a
/// valid notebox rather than left editing one that is no longer registered.
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

/// Returns `true` if `path` is a directory containing no entries, or does not
/// exist yet (a clone will create it). Used by the clone-from-remote flow to
/// keep a collaborator from cloning onto a folder that already holds files —
/// git requires an empty destination, and overlaying a clone onto live notes
/// would be destructive. An existing notebox always contains `.inkycap/`, so
/// this also rejects "clone into my other notebox" by construction.
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

    // Run the rename on a blocking pool — a cross-directory move can fall back
    // to a recursive copy on some filesystems, which must not block the async
    // worker.
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

/// Returns `true` if the directory has no per-notebox settings file yet —
/// i.e. it's a fresh notebox where the seed-from-existing flow would apply.
/// Used by the frontend to decide whether to offer the copy prompt.
#[tauri::command]
pub async fn notebox_has_user_settings(path: String) -> Result<bool, InkyCapError> {
    let dir = std::path::PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(InkyCapError::InvalidPath(format!(
            "Not a directory: {}",
            path
        )));
    }
    let settings_path = crate::notebox_settings::settings_path(&dir);
    Ok(settings_path.exists())
}

/// Seed a fresh notebox's `.inkycap/` from another notebox: copies the
/// per-notebox settings file, the creation rules file, the scaffolds
/// folder, and the property-types registry. Absolute paths inside the
/// copied settings (`citations.bibliography_path`,
/// `citations.custom_csl_path`) are sanitized — any path that doesn't
/// resolve in the destination is cleared and a warning is surfaced so the
/// user can fix it later.
///
/// Refuses to run if the target already has a `.inkycap/settings.json`
/// (assume the user opened the wrong notebox). Both paths must exist as
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

    let target_settings = crate::notebox_settings::settings_path(&target);
    if target_settings.exists() {
        return Err(InkyCapError::BadRequest(
            "Target notebox already has settings — refusing to overwrite".to_string(),
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
        // Bibliography path: if absolute, only keep it when it resolves
        // on disk. Notebox-relative paths are kept as-is — they'll
        // resolve (or not) inside the new notebox.
        if let Some(ref bib) = nb_settings.citations.bibliography_path {
            if std::path::Path::new(bib).is_absolute() && !std::path::Path::new(bib).exists() {
                warnings.push(format!(
                    "Cleared citations.bibliography_path (no longer resolves): {bib}"
                ));
                nb_settings.citations.bibliography_path = None;
            }
        }
        // Custom CSL path: notebox-root-absolute (`/styles/foo.csl`). Resolve
        // it against the new notebox and clear it if the style file didn't
        // travel (seeding copies `.inkycap/`, not the notebox's `styles/`
        // folder), so the new notebox carries no dangling style reference.
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

    // User word lists — the shared dictionary (spellcheck + Mycelial rescue
    // allow-list) and the Mycelial stopword list. Both are personal vocabulary
    // the user has curated, worth carrying into a notebox seeded from this one.
    for name in ["dictionary.txt", "mycelial-stopwords.txt"] {
        let src = source_inkycap.join(name);
        if src.is_file() {
            std::fs::copy(&src, target_inkycap.join(name))?;
            copied_files += 1;
        }
    }

    // Scaffolds folder — copy every `.typ` file (creation rules reference
    // these by name, so the rules-copy above won't make sense without
    // them).
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
