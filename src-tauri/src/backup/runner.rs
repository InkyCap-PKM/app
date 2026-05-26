//! One-shot backup runner — orchestrates archive build + retention prune
//! + state update for a single backup invocation.
//!
//! Synchronization: held behind a `tokio::sync::Mutex` in `AppState` so
//! a manual command-palette run and a scheduled tick can't overlap. The
//! mutex is acquired by the caller (`commands::backup::backup_now`),
//! not here — keeps the runner pure and testable.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::Local;

use crate::errors::{InkyCapError, Result};
use crate::settings::BackupSettings;

use super::{archive, filename, password, state};

/// Per-invocation summary returned to the frontend so the settings UI
/// can render "Last backup: 2026-05-20 14:30 — 412 files, 1.2 MB".
#[derive(Debug, serde::Serialize)]
pub struct BackupReport {
    /// Absolute path to the archive that was just written, in
    /// frontend-canonical (forward-slash) form.
    pub archive_path: String,
    pub file_count: u64,
    pub uncompressed_bytes: u64,
    /// Number of older archives pruned by retention.
    pub pruned: usize,
    /// True when the archive is AES-256-encrypted.
    pub encrypted: bool,
    /// Unix-epoch seconds when the run completed.
    pub timestamp_unix: i64,
}

/// Inputs the runner needs that aren't on `BackupSettings` itself.
pub struct RunInputs<'a> {
    pub settings: &'a BackupSettings,
    pub notebox_root: &'a Path,
    pub user_config_root: &'a Path,
    /// Set when the caller is a *scheduled* tick rather than a manual
    /// run — the only-on-change guard only applies in that case.
    pub is_scheduled: bool,
    /// Cooperative cancellation flag. Polled between archive entries;
    /// when set, the run aborts with `InkyCapError::Cancelled` and the
    /// partially-written archive is removed. Cleared by the caller at
    /// the start of each run (a stale `true` from a prior cancel would
    /// otherwise immediately abort the next attempt).
    pub cancel: Arc<AtomicBool>,
}

/// Run one backup. Returns `Ok(None)` when the only-on-change guard
/// kicked in and we deliberately skipped without writing anything;
/// `Ok(Some(report))` on success; `Err(...)` on real failures.
pub fn run(inputs: RunInputs<'_>) -> Result<Option<BackupReport>> {
    let dest_root = match inputs.settings.path.as_ref() {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => {
            return Err(InkyCapError::BadRequest(
                "No backup destination is configured. Set one in Settings → Import & Backup."
                    .to_string(),
            ));
        }
    };

    // Only-on-change guard — skip without touching anything if the
    // notebox has had no writes since the last successful backup. We
    // only consult the notebox tree (not the user-config folder) here
    // because user-config changes alone don't justify a fresh archive.
    let st = state::load(inputs.notebox_root);
    if inputs.is_scheduled && inputs.settings.only_on_change && st.last_success_unix > 0 {
        let max_mtime = newest_mtime_under(inputs.notebox_root).unwrap_or(0);
        if max_mtime <= st.last_success_unix {
            return Ok(None);
        }
    }

    // Ensure destination exists before composing the archive path —
    // makes the "your chosen folder no longer exists" failure mode
    // crisp instead of bubbling up from the zip writer.
    std::fs::create_dir_all(&dest_root).map_err(|e| {
        InkyCapError::BadRequest(format!(
            "Couldn't create backup folder {}: {e}",
            dest_root.display()
        ))
    })?;

    let notebox_name = inputs
        .notebox_root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("notebox");

    let now = Local::now();
    let filename_str = filename::resolve(&inputs.settings.filename_pattern, notebox_name, now);
    let archive_path = dest_root.join(&filename_str);

    // Windows long-path pre-flight. Without LongPathsEnabled the limit
    // is 260 chars including the null terminator; we error out before
    // calling `File::create` so the user sees a clear message instead
    // of a low-level ERROR_PATH_NOT_FOUND from CreateFileW.
    #[cfg(target_os = "windows")]
    {
        if archive_path.as_os_str().len() >= 260 {
            return Err(InkyCapError::BadRequest(format!(
                "Backup destination path is too long for Windows ({} chars; \
                 limit is 259). Shorten the destination folder or the filename pattern.",
                archive_path.as_os_str().len()
            )));
        }
    }

    // Resolve password from the keychain only if encryption is enabled.
    // We treat "password_protected=true but no entry in keychain" as a
    // hard error — silently dropping encryption would be a security
    // foot-gun ("I set a password, why is my backup unencrypted?").
    let password_string;
    let password_ref = if inputs.settings.password_protected {
        match password::get()? {
            Some(p) => {
                password_string = p;
                Some(password_string.as_str())
            }
            None => {
                return Err(InkyCapError::BadRequest(
                    "Backup encryption is enabled but no password is set in the OS keychain. \
                     Re-enter the password in Settings → Import & Backup."
                        .to_string(),
                ));
            }
        }
    } else {
        None
    };

    let user_config_for_archive = if inputs.settings.include_user_config {
        Some(inputs.user_config_root)
    } else {
        None
    };

    let summary = match archive::write(archive::ArchiveJob {
        notebox_root: inputs.notebox_root,
        destination: &archive_path,
        user_config_root: user_config_for_archive,
        password: password_ref,
        cancel: inputs.cancel.clone(),
    }) {
        Ok(s) => s,
        Err(e) => {
            // Best-effort cleanup of the partial archive on any error.
            // Particularly important for `Cancelled`: leaving a corrupt
            // half-zip lying around in the destination would confuse
            // both the retention pruner and the restore browser.
            let _ = std::fs::remove_file(&archive_path);
            return Err(e);
        }
    };

    // Retention prune. Keep the N most recent matching archives; the
    // one we just wrote is included in the count, so a keep_count of 7
    // means "this one plus the six previous". keep_count of 0 is
    // treated as 1 (delete everything older than this one) rather than
    // "delete all" — interpreting 0 as "delete every archive" would
    // foot-gun a user who fat-fingered the input.
    let keep = inputs.settings.keep_count.max(1) as usize;
    let archives = archive::list_matching_archives(&dest_root, &inputs.settings.filename_pattern)?;
    let mut pruned = 0;
    for victim in archives.iter().skip(keep) {
        if let Err(e) = std::fs::remove_file(victim) {
            log::warn!("backup retention failed to delete {}: {e}", victim.display());
            continue;
        }
        pruned += 1;
    }

    // Persist state so the next scheduled tick / settings UI can read
    // it. Errors here are non-fatal — we already wrote the archive.
    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let canonical = crate::storage::path::to_frontend_string(&archive_path);
    let new_state = state::BackupState {
        last_success_unix: now_unix,
        last_archive_path: Some(canonical.clone()),
        last_status: Some("Success".to_string()),
    };
    if let Err(e) = state::save(inputs.notebox_root, &new_state) {
        log::warn!("backup state save failed (archive still written): {e}");
    }

    Ok(Some(BackupReport {
        archive_path: canonical,
        file_count: summary.file_count,
        uncompressed_bytes: summary.uncompressed_bytes,
        pruned,
        encrypted: password_ref.is_some(),
        timestamp_unix: now_unix,
    }))
}

/// Record a failure into the persisted backup state for `notebox_root`
/// without changing its `last_success_unix` timestamp. Used by the manual
/// run and the scheduler tick so the settings UI can surface "Last attempt
/// failed: <message>" for the notebox the attempt was made against.
pub fn record_failure(notebox_root: &Path, message: &str) {
    let mut st = state::load(notebox_root);
    st.last_status = Some(message.to_string());
    if let Err(e) = state::save(notebox_root, &st) {
        log::warn!("backup state save failed during failure-record: {e}");
    }
}

/// Walk `root` and return the newest mtime found, in unix-epoch seconds.
/// Returns `None` if the tree is empty or unreadable.
fn newest_mtime_under(root: &Path) -> Option<i64> {
    let mut max = 0i64;
    let walker = walkdir::WalkDir::new(root).follow_links(true).into_iter();
    for entry in walker.flatten() {
        // Skip dot-folders that we don't archive anyway, so a stale
        // `.git` index doesn't keep triggering scheduled backups
        // forever after a single commit.
        if entry
            .path()
            .components()
            .any(|c| c.as_os_str() == ".git")
        {
            continue;
        }
        // walkdir::DirEntry::metadata returns walkdir::Result, but
        // SystemTime modification returns io::Result — pulling them
        // apart side-steps the "and_then with two error types" issue.
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let m = match meta.modified() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let secs = m
            .duration_since(UNIX_EPOCH)
            .map(|d: std::time::Duration| d.as_secs() as i64)
            .unwrap_or(0);
        if secs > max {
            max = secs;
        }
    }
    if max == 0 {
        None
    } else {
        Some(max)
    }
}
