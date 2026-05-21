//! Tauri commands that expose the backup feature to the frontend.
//!
//! Five run/state commands:
//!   - `backup_now`              — run an immediate one-shot backup.
//!   - `get_backup_state`        — read last-run info for the settings UI.
//!   - `set_backup_password`     — store a password in the OS keychain.
//!   - `clear_backup_password`   — wipe the stored password.
//!   - `has_backup_password`     — does the OS keychain currently hold one?
//!
//! Three browse/restore commands:
//!   - `list_backup_archives`    — enumerate archives in the destination.
//!   - `list_backup_contents`    — entry list of one archive.
//!   - `restore_backup_files`    — selective extract back to a target root.
//!
//! Scheduling (interval timer, on-launch trigger, only-on-change guard)
//! is a separate concern that lives in a background task spawned from
//! `lib.rs::run`; those don't need IPC bindings.

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, State};

use crate::backup::{password, restore, runner, state};
use crate::errors::{InkyCapError, Result};
use crate::state::AppState;

/// Run a backup immediately. Returns `Ok(None)` when the only-on-change
/// guard kicked in for a *scheduled* tick — manual runs from the command
/// palette set `is_scheduled=false` and never skip, so the frontend can
/// safely treat `None` as "this shouldn't happen here".
#[tauri::command]
pub async fn backup_now(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<runner::BackupReport>> {
    let notebox_root = state
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;

    // Snapshot settings under the lock, then release before the
    // blocking archive write so the rest of the app stays responsive.
    let settings = state.settings.read().await.backup.clone();
    let user_config_root = crate::app_paths::config_dir();

    // Exclusion mutex: a second invocation while the first is in flight
    // will park on this `lock()` rather than racing.
    let _guard = state.backup_run_lock.lock().await;

    // The zip writer is synchronous; do it in a blocking task so we
    // don't tie up the tokio reactor on big noteboxes. The cost of one
    // OS thread is negligible vs. the cost of stalling other commands.
    let result = tokio::task::spawn_blocking(move || {
        runner::run(runner::RunInputs {
            settings: &settings,
            notebox_root: &notebox_root,
            user_config_root: &user_config_root,
            is_scheduled: false,
        })
    })
    .await
    .map_err(|e| InkyCapError::ExportFailed(format!("backup task panicked: {e}")))?;

    // Record the failure into persisted state so the UI's "Last run"
    // line shows the actual error rather than the previous success.
    if let Err(e) = &result {
        runner::record_failure(&e.to_string());
    }

    // Tell the UI to refresh its "Last backup" line. Fires on both
    // success and failure — either way the persisted state changed.
    // Emit best-effort: a closed UI just drops the event harmlessly.
    let _ = app.emit("backup:state-changed", ());

    result
}

/// Read the persisted "last backup" record. Returns the same shape as
/// the on-disk state file so the UI can show it directly.
#[tauri::command]
pub async fn get_backup_state(_state: State<'_, AppState>) -> Result<state::BackupState> {
    Ok(state::load())
}

/// Store a new backup password in the OS keychain. Overwrites any
/// existing entry. Empty string is rejected at the boundary — the UI
/// should never call this with an empty string, but a defensive check
/// here saves us from a keychain that thinks "" is a valid password.
#[tauri::command]
pub async fn set_backup_password(password: String) -> Result<()> {
    if password.is_empty() {
        return Err(InkyCapError::BadRequest(
            "Password cannot be empty. To disable encryption, clear the password instead.".to_string(),
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

/// Probe the OS keychain — true when a backup password is currently
/// stored. Lets the settings UI render "Password set ✓" without ever
/// fetching the secret itself.
#[tauri::command]
pub async fn has_backup_password() -> Result<bool> {
    let res = tokio::task::spawn_blocking(password::get)
        .await
        .map_err(|e| InkyCapError::BadRequest(format!("keychain task panicked: {e}")))?;
    Ok(res?.is_some())
}

/// List archives in the configured backup destination folder, newest
/// first. Returns an empty list when the destination isn't set or
/// doesn't exist yet — the UI treats both as "nothing to restore from".
#[tauri::command]
pub async fn list_backup_archives(
    state: State<'_, AppState>,
) -> Result<Vec<restore::BackupEntry>> {
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

/// Open one archive and return its entry list. Decryption isn't needed
/// for listing (central directory metadata is plaintext), but the
/// `encrypted` flag on each entry lets the UI know whether a password
/// will be required to restore.
#[tauri::command]
pub async fn list_backup_contents(
    archive_path: String,
) -> Result<Vec<restore::BackupContentEntry>> {
    let path = PathBuf::from(archive_path);
    tokio::task::spawn_blocking(move || restore::list_contents(&path))
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("list-contents task panicked: {e}")))?
}

/// Pull selected entries out of `archive_path` into `target_root`.
/// When the entries are AES-encrypted, the password is fetched from
/// the OS keychain — the frontend never has to handle the secret.
///
/// `target_root` is the destination *root* (typically the notebox
/// root or a user-picked alternate folder); interior `notebox/` /
/// `user-config/` prefixes are stripped before joining so files land
/// at their original relative paths.
#[tauri::command]
pub async fn restore_backup_files(
    archive_path: String,
    target_root: String,
    entries: Vec<String>,
    conflict: restore::RestoreConflictPolicy,
) -> Result<Vec<restore::RestoreResult>> {
    let archive = PathBuf::from(archive_path);
    let target = PathBuf::from(target_root);
    let password = tokio::task::spawn_blocking(password::get)
        .await
        .map_err(|e| InkyCapError::BadRequest(format!("keychain task panicked: {e}")))??;
    tokio::task::spawn_blocking(move || {
        restore::extract_files(
            &archive,
            &target,
            &entries,
            password.as_deref(),
            conflict,
        )
    })
    .await
    .map_err(|e| InkyCapError::ExportFailed(format!("restore task panicked: {e}")))?
}
