//! Backup scheduler: a long-running task that runs backups at the configured
//! interval while the app is open.
//!
//! * One schedule for all noteboxes: when the interval has passed since the
//!   last success, the open notebox is backed up.
//! * `update_settings` fires `AppState.backup_scheduler_wake`, so a changed
//!   interval applies at once.
//! * The first run waits `STARTUP_DELAY`, to stay clear of indexing, LSP
//!   start-up and the first compile; an overdue backup still runs then.
//! * A failed run is logged and recorded with `runner::record_failure` (shown
//!   in Settings), and the loop carries on.

use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

use crate::settings::BackupSettings;
use crate::state::AppState;

use super::{runner, state};

/// Delay before the first run after start-up, past the usual indexing and LSP
/// warm-up.
const STARTUP_DELAY: Duration = Duration::from_secs(30);

/// Shortest interval allowed, so a bug firing wake-ups in a tight loop can't
/// run backups back to back.
const MIN_INTERVAL_SECS: u64 = 60;

/// Start the scheduler, once, from the setup hook in `lib.rs::run`. It looks up
/// `AppState` from the `AppHandle` on each run instead of keeping references.
///
/// Uses `tauri::async_runtime::spawn`: the setup hook runs before Tauri's Tokio
/// runtime is attached to this thread, so `tokio::spawn` would panic ("there is
/// no reactor running").
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        run_loop(app).await;
    });
}

async fn run_loop(app: AppHandle) {
    tokio::time::sleep(STARTUP_DELAY).await;

    loop {
        // Read what is needed each time, without holding a lock across the
        // sleep. The notebox root is needed to read this notebox's last backup
        // time.
        let (settings, notebox_root, wake) = {
            let state = app.state::<AppState>();
            let session = state.session("main").await;
            let settings = state.settings.read().await.backup.clone();
            let notebox_root = session.notebox_root.read().await.clone();
            (settings, notebox_root, state.backup_scheduler_wake.clone())
        };

        let sleep_for = compute_sleep_secs(&settings, notebox_root.as_deref());

        // Sleep until due or woken by a settings change. Both branches are
        // cancel-safe.
        match sleep_for {
            Some(secs) => {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(secs)) => {}
                    _ = wake.notified() => { continue; }
                }
            }
            None => {
                // Disabled: scheduler is dormant until settings change.
                wake.notified().await;
                continue;
            }
        }

        // Run.
        run_one_tick(&app).await;
    }
}

/// How long to sleep before the next run, or `None` to stay idle (interval 0,
/// no folder set, or no notebox open).
fn compute_sleep_secs(settings: &BackupSettings, notebox_root: Option<&Path>) -> Option<u64> {
    if !settings.enabled {
        return None;
    }
    let notebox_root = notebox_root?;
    if settings.interval_hours == 0 {
        return None;
    }
    let path = settings.path.as_ref()?;
    if path.is_empty() {
        return None;
    }

    let interval_secs = std::cmp::max(
        MIN_INTERVAL_SECS,
        (settings.interval_hours as u64).saturating_mul(3600),
    );

    let last = state::load(notebox_root).last_success_unix;
    if last <= 0 {
        // Never run before: the first backup is a full interval from now, not
        // immediately.
        return Some(interval_secs);
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let next_due_unix = (last as u64).saturating_add(interval_secs);
    Some(next_due_unix.saturating_sub(now).max(1))
}

async fn run_one_tick(app: &AppHandle) {
    let state = app.state::<AppState>();
    let session = state.session("main").await;

    let notebox_root = match session.notebox_root.read().await.clone() {
        Some(p) => p,
        None => {
            log::debug!("scheduled backup: no notebox open, skipping");
            return;
        }
    };
    let settings = state.settings.read().await.backup.clone();
    if settings.path.as_ref().map(|s| s.is_empty()).unwrap_or(true) {
        log::debug!("scheduled backup: no destination configured, skipping");
        return;
    }

    // Hold the run-lock for the entire archive write so a manual run
    // from the command palette parks behind us (or vice versa).
    let _guard = state.backup_run_lock.lock().await;

    // Clear any stale cancel flag from a previous (potentially manual)
    // run before starting the scheduled one.
    state.backup_cancel.store(false, Ordering::Release);
    let cancel = state.backup_cancel.clone();

    let user_config_root = crate::app_paths::config_dir();
    // The runner consumes `notebox_root` (moved into the blocking task);
    // keep a copy so a failure can be recorded against the right notebox.
    let notebox_root_for_record = notebox_root.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        runner::run(runner::RunInputs {
            settings: &settings,
            notebox_root: &notebox_root,
            user_config_root: &user_config_root,
            is_scheduled: true,
            cancel,
        })
    })
    .await;

    match outcome {
        Ok(Ok(Some(report))) => {
            log::info!(
                "scheduled backup: {} files, {:.1} MB → {}",
                report.file_count,
                report.uncompressed_bytes as f64 / 1024.0 / 1024.0,
                report.archive_path,
            );
            // Tell any open UI to refresh "Last backup".
            emit_state_changed(app);
        }
        Ok(Ok(None)) => {
            log::debug!("scheduled backup skipped (no changes since last run)");
        }
        Ok(Err(crate::errors::InkyCapError::Cancelled)) => {
            // The user cancelled; don't record it as a failure.
            log::info!("scheduled backup cancelled by user");
        }
        Ok(Err(e)) => {
            log::warn!("scheduled backup failed: {e}");
            runner::record_failure(&notebox_root_for_record, &e.to_string());
            emit_state_changed(app);
        }
        Err(e) => {
            log::warn!("scheduled backup task panicked: {e}");
            runner::record_failure(&notebox_root_for_record, &format!("task panicked: {e}"));
        }
    }
}

fn emit_state_changed(app: &AppHandle) {
    crate::events::publish(
        app,
        crate::events::Audience::AllWindows,
        crate::events::AppEvent::BackupStateChanged,
    );
}

/// Wake the scheduler to recompute when the next backup is due. Repeated wakes
/// collapse into one.
pub fn wake_now(state: &AppState) {
    state.backup_scheduler_wake.notify_one();
}
