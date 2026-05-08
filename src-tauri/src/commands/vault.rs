use tauri::{Emitter, Manager, State};

use crate::config;
use crate::errors::InkyCapError;
use crate::models::vault::VaultInfo;
use crate::state::AppState;
use crate::storage::traits::VaultStorage;
use crate::watcher::file_watcher;

#[tauri::command]
pub async fn get_saved_vault_path() -> Result<Option<String>, InkyCapError> {
    let cfg = config::load_config();
    Ok(cfg.vault_path)
}

#[tauri::command]
pub async fn open_vault(
    path: String,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<VaultInfo, InkyCapError> {
    let vault_path = std::path::PathBuf::from(&path);
    if !vault_path.is_dir() {
        return Err(InkyCapError::InvalidPath(format!(
            "Not a directory: {}",
            path
        )));
    }

    // Phase A — fast path: walk the directory, set vault_root + storage, list
    // collection files. The UI can render the file tree as soon as this returns.
    let note_count = state.open_vault_fast(vault_path.clone()).await?;

    // Narrow the Tauri asset protocol scope to the newly-opened vault so that
    // `convertFileSrc()` can only load images/attachments that live inside
    // the vault. The static config starts with an empty allow-list; we add
    // the canonical vault root here once it's known. (Tauri's scope is
    // additive across vault opens — this is a minor leak if the user hops
    // between vaults in a single session, but it never grants anything
    // outside a legitimately-opened vault, which is what matters for
    // untrusted-note defense.)
    if let Some(canonical_root) = state
        .vault_root
        .read()
        .await
        .as_ref()
        .cloned()
    {
        let scope = app_handle.asset_protocol_scope();
        if let Err(err) = scope.allow_directory(&canonical_root, true) {
            eprintln!(
                "warning: could not extend asset protocol scope to {}: {err}",
                canonical_root.display()
            );
        }
    }

    // Start file watcher and bridge events to the frontend
    match file_watcher::start_watching(&vault_path) {
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
                            let _ = handle.emit("vault:file-changed", serde_json::json!({
                                "path": path.display().to_string(),
                                "change": match change {
                                    crate::events::ChangeKind::Content => "Content",
                                    crate::events::ChangeKind::Metadata => "Metadata",
                                }
                            }));
                            sync_cache_for_changed_file(&handle, path.clone());
                        }
                        crate::events::AppEvent::FileCreated { path } => {
                            let _ = handle.emit("vault:file-created", serde_json::json!({
                                "path": path.display().to_string()
                            }));
                            sync_cache_for_changed_file(&handle, path.clone());
                        }
                        crate::events::AppEvent::FileDeleted { path } => {
                            let _ = handle.emit("vault:file-deleted", serde_json::json!({
                                "path": path.display().to_string()
                            }));
                            sync_cache_for_deleted_file(&handle, path.clone());
                        }
                        _ => {}
                    }
                }
            });
        }
        Err(err) => {
            eprintln!("Warning: could not start file watcher: {err}");
        }
    }

    // Persist the vault path and register in the vault registry
    let mut cfg = config::load_config();
    cfg.vault_path = Some(path.clone());

    let collection_files = state.collection_files.read().await;
    let collection_count = collection_files.len();
    drop(collection_files);

    let name = vault_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Vault".to_string());

    cfg.upsert_vault(&path, &name);
    let _ = config::save_config(&cfg);

    // Phase B — spawn the heavy index build in the background. The UI is
    // already interactive at this point; features that depend on the indexes
    // (search, tags, backlinks, properties) should show a loading state until
    // the `vault:index-ready` event fires.
    let bg_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let state = bg_handle.state::<AppState>();
        match state.build_indexes().await {
            Ok(stats) => {
                let _ = bg_handle.emit("vault:index-ready", &stats);
            }
            Err(err) => {
                eprintln!("Background index build failed: {err}");
                let _ = bg_handle.emit(
                    "vault:index-error",
                    serde_json::json!({ "error": err.to_string() }),
                );
            }
        }
    });

    Ok(VaultInfo {
        path: vault_path,
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
/// without a vault restart. Spawns a short-lived async task because the
/// watcher dispatcher runs on a blocking thread.
fn sync_cache_for_changed_file(handle: &tauri::AppHandle, path: std::path::PathBuf) {
    // Only `.typ` note files participate in the in-memory indices and cache.
    if path.extension().and_then(|e| e.to_str()) != Some("typ") {
        return;
    }

    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<AppState>();

        // Need both vault_root and storage to parse the file. If either is
        // missing the vault has been closed, so just bail out silently.
        let vault_root = match state.vault_root.read().await.clone() {
            Some(r) => r,
            None => return,
        };
        let storage = match state.storage.read().await.clone() {
            Some(s) => s,
            None => return,
        };

        // Skip files that fall outside the canonical vault root — the
        // storage layer canonicalizes vault_root on open, and watcher events
        // for symlinked files resolve to their real paths, so any event
        // whose path doesn't live under the root is an escape attempt and
        // we refuse to index it.
        if path.strip_prefix(&vault_root).is_err() {
            return;
        }

        // Read the current content through the validated storage pipeline
        // and push it into the unified reindex helper. We read via storage
        // (rather than calling the walker directly) so the path is
        // re-validated against the vault root even though it came from the
        // watcher — defense in depth for the symlink case above.
        let rel = path
            .strip_prefix(&vault_root)
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
                    "vault:index-updated",
                    serde_json::json!({ "path": path.display().to_string() }),
                );
            }
            Err(err) => {
                // File may have been deleted between the change event and
                // the re-parse — the next FileDeleted event will clean up.
                eprintln!(
                    "watcher reindex failed for {}: {err}",
                    path.display()
                );
            }
        }
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
            "vault:index-updated",
            serde_json::json!({ "path": path.display().to_string() }),
        );
    });
}

#[tauri::command]
pub async fn get_vault_info(
    state: State<'_, AppState>,
) -> Result<Option<VaultInfo>, InkyCapError> {
    let vault_root = state.vault_root.read().await;
    let Some(ref path) = *vault_root else {
        return Ok(None);
    };

    let index = state.property_index.read().await;
    let collection_files = state.collection_files.read().await;

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Vault".to_string());

    Ok(Some(VaultInfo {
        path: path.clone(),
        name,
        file_count: index.note_count(),
        collection_count: collection_files.len(),
        property_keys: index.property_keys.iter().cloned().collect(),
    }))
}

// ── Vault registry commands ──────────────────────────────────────────

#[tauri::command]
pub async fn get_vault_registry() -> Result<Vec<config::VaultRegistryEntry>, InkyCapError> {
    let cfg = config::load_config();
    let mut entries = cfg.vault_registry;
    entries.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
    Ok(entries)
}

#[tauri::command]
pub async fn register_vault(
    path: String,
    display_name: Option<String>,
) -> Result<(), InkyCapError> {
    let vault_path = std::path::PathBuf::from(&path);
    if !vault_path.is_dir() {
        return Err(InkyCapError::InvalidPath(format!(
            "Not a directory: {}",
            path
        )));
    }
    let name = display_name.unwrap_or_else(|| {
        vault_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Vault".to_string())
    });
    let mut cfg = config::load_config();
    cfg.upsert_vault(&path, &name);
    config::save_config(&cfg)?;
    Ok(())
}

#[tauri::command]
pub async fn update_vault_entry(
    path: String,
    display_name: String,
) -> Result<(), InkyCapError> {
    let mut cfg = config::load_config();
    let entry = cfg
        .vault_registry
        .iter_mut()
        .find(|e| e.path == path)
        .ok_or_else(|| {
            InkyCapError::InvalidPath(format!("Vault not in registry: {}", path))
        })?;
    entry.display_name = display_name;
    config::save_config(&cfg)?;
    Ok(())
}

#[tauri::command]
pub async fn remove_vault_from_registry(path: String) -> Result<(), InkyCapError> {
    let mut cfg = config::load_config();
    cfg.remove_vault(&path);
    config::save_config(&cfg)?;
    Ok(())
}

#[derive(Debug, serde::Serialize)]
pub struct VaultMoveResult {
    pub new_path: String,
    pub was_active: bool,
}

#[tauri::command]
pub async fn move_vault(
    old_path: String,
    new_path: String,
) -> Result<VaultMoveResult, InkyCapError> {
    let old = std::path::PathBuf::from(&old_path);
    let new = std::path::PathBuf::from(&new_path);

    if !old.is_dir() {
        return Err(InkyCapError::InvalidPath(format!(
            "Source vault not found: {}",
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
            "Failed to move vault from {} to {}: {}",
            old_path, new_path, e
        ))
    })?;

    let mut cfg = config::load_config();
    let was_active = cfg.vault_path.as_deref() == Some(&old_path);

    if let Some(entry) = cfg.vault_registry.iter_mut().find(|e| e.path == old_path) {
        entry.path = new_path.clone();
    }
    if was_active {
        cfg.vault_path = Some(new_path.clone());
    }
    config::save_config(&cfg)?;

    Ok(VaultMoveResult {
        new_path,
        was_active,
    })
}
