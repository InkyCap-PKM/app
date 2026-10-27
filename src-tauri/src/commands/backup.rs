//! Backup commands for the frontend.
//!
//! Run and state:
//!   - `backup_now`: run a backup now.
//!   - `get_backup_state`: last-run info for Settings.
//!   - `set_backup_password` / `clear_backup_password`: store or remove the
//!     keychain password.
//!   - `has_backup_password`: whether the keychain holds one.
//!
//! Browse and restore:
//!   - `list_backup_archives`: archives in the destination.
//!   - `list_backup_contents`: one archive's entries.
//!   - `restore_backup_files`: extract chosen entries to a folder.
//!
//! Scheduling runs in a background task started from `lib.rs::run`.

use std::path::PathBuf;
use std::sync::atomic::Ordering;

use tauri::{AppHandle, State};

use crate::events::{publish, AppEvent, Audience};

use crate::backup::{password, restore, runner, state};
use crate::errors::{InkyCapError, Result};
use crate::state::AppState;
use crate::storage::to_frontend_string;

/// Run a backup now. `Ok(None)` means the only-on-change check skipped a
/// scheduled run; manual runs pass `is_scheduled=false` and never skip.
#[tauri::command]
pub async fn backup_now(
    app: AppHandle,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<runner::BackupReport>> {
    let session = state.session(window.label()).await;
    let notebox_root = session
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;

    // Snapshot settings under the lock, then release before the
    // blocking archive write so the rest of the app stays responsive.
    let settings = state.settings.read().await.backup.clone();
    if !settings.enabled {
        return Err(InkyCapError::BadRequest(
            "Backups are disabled. Enable Notebox backup in Settings before running.".to_string(),
        ));
    }
    let user_config_root = crate::app_paths::config_dir();

    // Exclusion mutex: a second invocation while the first is in flight
    // will park on this `lock()` rather than racing.
    let _guard = state.backup_run_lock.lock().await;

    // Fresh-start the cancel flag. A leftover `true` from a previous
    // cancelled run would otherwise abort this one immediately.
    state.backup_cancel.store(false, Ordering::Release);
    let cancel = state.backup_cancel.clone();

    // The runner consumes `notebox_root` (moved into the blocking task);
    // keep a copy so a failure can be recorded against the right notebox.
    let notebox_root_for_record = notebox_root.clone();

    // The zip writer is synchronous; run it on a blocking thread so other
    // commands aren't stalled.
    let result = tokio::task::spawn_blocking(move || {
        runner::run(runner::RunInputs {
            settings: &settings,
            notebox_root: &notebox_root,
            user_config_root: &user_config_root,
            is_scheduled: false,
            cancel,
        })
    })
    .await
    .map_err(|e| InkyCapError::ExportFailed(format!("backup task panicked: {e}")))?;

    // Save a failure so "Last run" shows the error. A cancellation isn't a
    // failure; the previous success stays the record.
    if let Err(e) = &result {
        if !matches!(e, InkyCapError::Cancelled) {
            runner::record_failure(&notebox_root_for_record, &e.to_string());
        }
    }

    // Tell the UI to refresh "Last backup", after success or failure.
    publish(&app, Audience::AllWindows, AppEvent::BackupStateChanged);

    result
}

/// The last-backup record for the open notebox (backups are per notebox), or
/// the "never ran" default with none open.
#[tauri::command]
pub async fn get_backup_state(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<state::BackupState> {
    let session = state.session(window.label()).await;
    let notebox_root = session.notebox_root.read().await.clone();
    Ok(match notebox_root {
        Some(root) => state::load(&root),
        None => state::BackupState::default(),
    })
}

/// Ask a running backup to stop: sets the flag the archive writer checks
/// between entries and returns at once. Harmless when none is running (the flag
/// is cleared at the start of each run).
#[tauri::command]
pub async fn cancel_backup(state: State<'_, AppState>) -> Result<()> {
    state.backup_cancel.store(true, Ordering::Release);
    Ok(())
}

/// Store a backup password in the OS keychain, replacing any existing one. An
/// empty password is refused.
#[tauri::command]
pub async fn set_backup_password(password: String) -> Result<()> {
    if password.is_empty() {
        return Err(InkyCapError::BadRequest(
            "Password cannot be empty. To disable encryption, clear the password instead."
                .to_string(),
        ));
    }
    tokio::task::spawn_blocking(move || password::set(&password))
        .await
        .map_err(|e| InkyCapError::BadRequest(format!("keychain task panicked: {e}")))?
}

/// Delete the stored backup password from the OS keychain. Idempotent.
#[tauri::command]
pub async fn clear_backup_password() -> Result<()> {
    tokio::task::spawn_blocking(password::clear)
        .await
        .map_err(|e| InkyCapError::BadRequest(format!("keychain task panicked: {e}")))?
}

/// Whether the keychain holds a backup password, so Settings can show "Password
/// set" without reading it.
#[tauri::command]
pub async fn has_backup_password() -> Result<bool> {
    let res = tokio::task::spawn_blocking(password::get)
        .await
        .map_err(|e| InkyCapError::BadRequest(format!("keychain task panicked: {e}")))?;
    Ok(res?.is_some())
}

/// Archives in the backup folder, newest first. Empty when the folder isn't set
/// or doesn't exist yet.
#[tauri::command]
pub async fn list_backup_archives(state: State<'_, AppState>) -> Result<Vec<restore::BackupEntry>> {
    let settings = state.settings.read().await.backup.clone();
    let Some(folder) = settings.path.as_ref() else {
        return Ok(Vec::new());
    };
    if folder.is_empty() {
        return Ok(Vec::new());
    }
    let folder = PathBuf::from(folder);
    let pattern = settings.filename_pattern.clone();
    tokio::task::spawn_blocking(move || restore::list_archives(&folder, &pattern))
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("list task panicked: {e}")))?
}

/// One archive's entries. No password is needed to list; each entry's
/// `encrypted` flag shows whether restoring needs one.
#[tauri::command]
pub async fn list_backup_contents(
    archive_path: String,
) -> Result<Vec<restore::BackupContentEntry>> {
    let path = PathBuf::from(archive_path);
    tokio::task::spawn_blocking(move || restore::list_contents(&path))
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("list-contents task panicked: {e}")))?
}

/// Extract the chosen entries of `archive_path` into `target_root`.
///
/// Each archive uses the keychain password at the time it was made, and the
/// keychain only holds the current one, so `password_override` lets the user
/// give an older password; `None` uses the keychain.
///
/// `target_root` is the destination root (the notebox or another folder);
/// `notebox/` and `user-config/` prefixes are removed so files land at their
/// original relative paths.
#[tauri::command]
pub async fn restore_backup_files(
    archive_path: String,
    target_root: String,
    entries: Vec<String>,
    conflict: restore::RestoreConflictPolicy,
    password_override: Option<String>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    app_handle: AppHandle,
) -> Result<Vec<restore::RestoreResult>> {
    let archive = PathBuf::from(archive_path);
    let target = PathBuf::from(&target_root);
    let password = match password_override {
        Some(p) if !p.is_empty() => Some(p),
        _ => tokio::task::spawn_blocking(password::get)
            .await
            .map_err(|e| InkyCapError::BadRequest(format!("keychain task panicked: {e}")))??,
    };
    // An in-place restore of this window's notebox decides whether
    // `user-config/` entries go back to the app config folder and whether the
    // indexes are rebuilt.
    let session = state.session(window.label()).await;
    let restoring_to_open_notebox = match session.notebox_root.read().await.clone() {
        Some(root) => std::fs::canonicalize(&target_root)
            .map(|tc| to_frontend_string(&tc) == to_frontend_string(&root))
            .unwrap_or(false),
        None => false,
    };

    let results = tokio::task::spawn_blocking(move || -> Result<Vec<restore::RestoreResult>> {
        if restoring_to_open_notebox {
            // `user-config/` entries are a snapshot of the app config folder
            // and go back there; `notebox/` (and unprefixed) entries go to the
            // notebox.
            let (config_entries, notebox_entries): (Vec<String>, Vec<String>) = entries
                .into_iter()
                .partition(|e| e.starts_with("user-config/"));
            let mut out = restore::extract_files(
                &archive,
                &target,
                &notebox_entries,
                password.as_deref(),
                conflict,
            )?;
            if !config_entries.is_empty() {
                let config_root = crate::app_paths::config_dir();
                std::fs::create_dir_all(&config_root)?;
                out.extend(restore::extract_files(
                    &archive,
                    &config_root,
                    &config_entries,
                    password.as_deref(),
                    conflict,
                )?);
            }
            Ok(out)
        } else {
            // Alternate-folder restore: an explicit "extract everything here"
            // recovery action, so honour the single target the user chose.
            restore::extract_files(&archive, &target, &entries, password.as_deref(), conflict)
        }
    })
    .await
    .map_err(|e| InkyCapError::ExportFailed(format!("restore task panicked: {e}")))??;

    // Rebuild the indexes after an in-place restore; the watcher can miss a
    // bulk write.
    if restoring_to_open_notebox {
        crate::commands::notebox::spawn_index_rebuild(app_handle, session.clone());
    }
    Ok(results)
}
