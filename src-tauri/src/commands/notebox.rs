use tauri::{Emitter, Manager, State};

use crate::config;
use crate::errors::InkyCapError;
use crate::models::notebox::NoteboxInfo;
use crate::state::AppState;
use crate::storage::traits::NoteboxStorage;
use crate::watcher::file_watcher;

/// Return the persisted notebox path from the app config, if any.
#[tauri::command]
pub async fn get_saved_notebox_path() -> Result<Option<String>, InkyCapError> {
    let cfg = config::load_config();
    Ok(cfg.notebox_path)
}

/// Open a notebox at the given directory path: initialize storage, start the file watcher, and spawn background index build.
#[tauri::command]
pub async fn open_notebox(
    path: String,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<NoteboxInfo, InkyCapError> {
    let notebox_path = std::path::PathBuf::from(&path);
    if !notebox_path.is_dir() {
        return Err(InkyCapError::InvalidPath(format!(
            "Not a directory: {}",
            path
        )));
    }

    // Phase A — fast path: walk the directory, set notebox_root + storage, list
    // collection files. The UI can render the file tree as soon as this returns.
    let note_count = state.open_notebox_fast(notebox_path.clone()).await?;

    // Narrow the Tauri asset protocol scope to the newly-opened notebox so that
    // `convertFileSrc()` can only load images/attachments that live inside
    // the notebox. The static config starts with an empty allow-list; we add
    // the canonical notebox root here once it's known. (Tauri's scope is
    // additive across notebox opens — this is a minor leak if the user hops
    // between noteboxes in a single session, but it never grants anything
    // outside a legitimately-opened notebox, which is what matters for
    // untrusted-note defense.)
    if let Some(canonical_root) = state
        .notebox_root
        .read()
        .await
        .as_ref()
        .cloned()
    {
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
    if let Some(canonical_root) = state.notebox_root.read().await.clone() {
        let mut slot = state.health_monitor.write().await;
        if let Some(prev) = slot.take() {
            prev.abort();
        }
        *slot = Some(crate::notebox_health::spawn(
            app_handle.clone(),
            canonical_root,
        ));
    }

    // Start file watcher and bridge events to the frontend
    match file_watcher::start_watching(&notebox_path) {
        Ok((watcher, rx)) => {
            *state.watcher.write().await = Some(watcher);

            // Spawn a background task to forward watcher events to the Tauri
            // frontend, and to write file changes through to the persistent
            // metadata cache so externally-edited files don't have to be
            // re-parsed on next launch.
            //
            // The watcher channel is a synchronous `std::sync::mpsc`, so the
            // dispatcher itself runs on a blocking task; per-event async work
            // (cache upserts) is offloaded to short-lived tokio tasks.
            let handle = app_handle.clone();
            tokio::task::spawn_blocking(move || {
                while let Ok(event) = rx.recv() {
                    // Emit the event to all frontend windows
                    match &event {
                        crate::events::AppEvent::FileChanged { path, change } => {
                            let _ = handle.emit("notebox:file-changed", serde_json::json!({
                                "path": path.display().to_string(),
                                "change": match change {
                                    crate::events::ChangeKind::Content => "Content",
                                    crate::events::ChangeKind::Metadata => "Metadata",
                                }
                            }));
                            sync_cache_for_changed_file(&handle, path.clone());
                        }
                        crate::events::AppEvent::FileCreated { path } => {
                            let _ = handle.emit("notebox:file-created", serde_json::json!({
                                "path": path.display().to_string()
                            }));
                            sync_cache_for_changed_file(&handle, path.clone());
                        }
                        crate::events::AppEvent::FileDeleted { path } => {
                            let _ = handle.emit("notebox:file-deleted", serde_json::json!({
                                "path": path.display().to_string()
                            }));
                            sync_cache_for_deleted_file(&handle, path.clone());
                        }
                        crate::events::AppEvent::FileRenamed { from, to } => {
                            // Fire the existing delete+create events first so
                            // the frontend file tree refreshes the same way
                            // it always has — components that only care about
                            // tree state don't need to know about renames.
                            // The dedicated `notebox:file-renamed` event is for
                            // listeners that want to follow the move (e.g.
                            // an open editor tab transferring to the new path).
                            let _ = handle.emit("notebox:file-deleted", serde_json::json!({
                                "path": from.display().to_string()
                            }));
                            let _ = handle.emit("notebox:file-created", serde_json::json!({
                                "path": to.display().to_string()
                            }));
                            let _ = handle.emit("notebox:file-renamed", serde_json::json!({
                                "from": from.display().to_string(),
                                "to": to.display().to_string()
                            }));
                            sync_cache_for_renamed_file(&handle, from.clone(), to.clone());
                        }
                        _ => {}
                    }
                }
            });
        }
        Err(err) => {
            log::warn!("could not start file watcher: {err}");
        }
    }

    // Persist the notebox path and register in the notebox registry
    let mut cfg = config::load_config();
    cfg.notebox_path = Some(path.clone());

    let collection_files = state.collection_files.read().await;
    let collection_count = collection_files.len();
    drop(collection_files);

    let name = notebox_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Notebox".to_string());

    cfg.upsert_notebox(&path, &name);
    let _ = config::save_config(&cfg);

    // Phase B — spawn the heavy index build in the background. The UI is
    // already interactive at this point; features that depend on the indexes
    // (search, tags, backlinks, properties) should show a loading state until
    // the `notebox:index-ready` event fires.
    let bg_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let state = bg_handle.state::<AppState>();
        match state.build_indexes().await {
            Ok(stats) => {
                let _ = bg_handle.emit("notebox:index-ready", &stats);
            }
            Err(err) => {
                log::error!("Background index build failed: {err}");
                let _ = bg_handle.emit(
                    "notebox:index-error",
                    serde_json::json!({ "error": err.to_string() }),
                );
            }
        }
    });

    Ok(NoteboxInfo {
        path: notebox_path,
        name,
        file_count: note_count,
        collection_count,
        property_keys: Vec::new(),
    })
}

/// Re-parse a file that the watcher reported as changed/created and push the
/// result through [`AppState::reindex_note`]. That helper updates every
/// in-memory index (link, property, search) *and* writes through to the
/// persistent metadata cache, so the UI stays in sync with external edits
/// without a notebox restart. Spawns a short-lived async task because the
/// watcher dispatcher runs on a blocking thread.
fn sync_cache_for_changed_file(handle: &tauri::AppHandle, path: std::path::PathBuf) {
    // Only `.typ` note files participate in the in-memory indices and cache.
    if path.extension().and_then(|e| e.to_str()) != Some("typ") {
        return;
    }

    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<AppState>();

        // Need both notebox_root and storage to parse the file. If either is
        // missing the notebox has been closed, so just bail out silently.
        let notebox_root = match state.notebox_root.read().await.clone() {
            Some(r) => r,
            None => return,
        };
        let storage = match state.storage.read().await.clone() {
            Some(s) => s,
            None => return,
        };

        // Skip files that fall outside the canonical notebox root — the
        // storage layer canonicalizes notebox_root on open, and watcher events
        // for symlinked files resolve to their real paths, so any event
        // whose path doesn't live under the root is an escape attempt and
        // we refuse to index it.
        if path.strip_prefix(&notebox_root).is_err() {
            return;
        }

        // Read the current content through the validated storage pipeline
        // and push it into the unified reindex helper. We read via storage
        // (rather than calling the walker directly) so the path is
        // re-validated against the notebox root even though it came from the
        // watcher — defense in depth for the symlink case above.
        let rel = path
            .strip_prefix(&notebox_root)
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|_| path.clone());
        match storage.read_file(&rel).await {
            Ok(content) => {
                state.reindex_note(&path, &content).await;
                // Notify any UI that mirrors the in-memory indices that the
                // external change has been absorbed. Frontend components
                // like the backlinks pane refetch on this.
                use tauri::Emitter;
                let _ = handle.emit(
                    "notebox:index-updated",
                    serde_json::json!({ "path": path.display().to_string() }),
                );
            }
            Err(err) => {
                // File may have been deleted between the change event and
                // the re-parse — the next FileDeleted event will clean up.
                log::warn!(
                    "watcher reindex failed for {}: {err}",
                    path.display()
                );
            }
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

        let notebox_root = match state.notebox_root.read().await.clone() {
            Some(r) => r,
            None => return,
        };
        let storage = match state.storage.read().await.clone() {
            Some(s) => s,
            None => return,
        };

        // Symlink-escape defence: both endpoints must live under the
        // canonical notebox root. Watcher events for symlinked paths
        // resolve to their real targets, so an out-of-root path here
        // is an escape attempt.
        if from.strip_prefix(&notebox_root).is_err()
            || to.strip_prefix(&notebox_root).is_err()
        {
            return;
        }

        // Rewrite wikilinks in every backlink of the old path. Errors
        // are logged but non-fatal — a partial rewrite is still better
        // than no rewrite, and the user can re-save manually if needed.
        if let Err(err) = crate::commands::file_ops::rewrite_backlinks_for_rename(
            &from, &to, &storage, &*state,
        )
        .await
        {
            log::warn!(
                "wikilink rewrite failed during external rename {} → {}: {err}",
                from.display(),
                to.display()
            );
        }

        // Drop the old path from every index, then index the new path.
        state.remove_from_indices(&from).await;

        let rel = to
            .strip_prefix(&notebox_root)
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|_| to.clone());
        match storage.read_file(&rel).await {
            Ok(content) => {
                state.reindex_note(&to, &content).await;
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
                "from": from.display().to_string(),
                "to": to.display().to_string(),
            }),
        );
    });
}

/// Drop a deleted file from every in-memory index and the persistent
/// metadata cache.
fn sync_cache_for_deleted_file(handle: &tauri::AppHandle, path: std::path::PathBuf) {
    if path.extension().and_then(|e| e.to_str()) != Some("typ") {
        return;
    }
    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<AppState>();
        state.remove_from_indices(&path).await;
        use tauri::Emitter;
        let _ = handle.emit(
            "notebox:index-updated",
            serde_json::json!({ "path": path.display().to_string() }),
        );
    });
}

/// Return summary info (name, file count, property keys) for the currently open notebox, or `None` if no notebox is open.
#[tauri::command]
pub async fn get_notebox_info(
    state: State<'_, AppState>,
) -> Result<Option<NoteboxInfo>, InkyCapError> {
    let notebox_root = state.notebox_root.read().await;
    let Some(ref path) = *notebox_root else {
        return Ok(None);
    };

    let index = state.property_index.read().await;
    let collection_files = state.collection_files.read().await;

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Notebox".to_string());

    Ok(Some(NoteboxInfo {
        path: path.clone(),
        name,
        file_count: index.note_count(),
        collection_count: collection_files.len(),
        property_keys: index.property_keys.iter().cloned().collect(),
    }))
}

// ── Notebox registry commands ──────────────────────────────────────────

/// Return all registered noteboxes sorted by most recently opened.
#[tauri::command]
pub async fn get_notebox_registry() -> Result<Vec<config::NoteboxRegistryEntry>, InkyCapError> {
    let cfg = config::load_config();
    let mut entries = cfg.notebox_registry;
    entries.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
    Ok(entries)
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
pub async fn update_notebox_entry(
    path: String,
    display_name: String,
) -> Result<(), InkyCapError> {
    let mut cfg = config::load_config();
    let entry = cfg
        .notebox_registry
        .iter_mut()
        .find(|e| e.path == path)
        .ok_or_else(|| {
            InkyCapError::InvalidPath(format!("Notebox not in registry: {}", path))
        })?;
    entry.display_name = display_name;
    config::save_config(&cfg)?;
    Ok(())
}

/// Remove a notebox from the persistent registry (does not delete files on disk).
#[tauri::command]
pub async fn remove_notebox_from_registry(path: String) -> Result<(), InkyCapError> {
    let mut cfg = config::load_config();
    cfg.remove_notebox(&path);
    config::save_config(&cfg)?;
    Ok(())
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

    std::fs::rename(&old, &new).map_err(|e| {
        InkyCapError::InvalidPath(format!(
            "Failed to move notebox from {} to {}: {}",
            old_path, new_path, e
        ))
    })?;

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
