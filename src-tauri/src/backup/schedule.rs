//! Backup scheduler — the long-running tokio task that fires the
//! runner on the user-configured interval while the app is open.
//!
//! Design notes:
//!
//! * The schedule is **global, not per-notebox.** A user with three
//!   noteboxes shouldn't get three independent timers running over each
//!   other; we back up *the currently-open notebox* whenever the
//!   interval elapses since the last successful run.
//!
//! * **Wake-on-settings-change.** `AppState.backup_scheduler_wake` is
//!   fired by `update_settings` so a change from 24h to 1h takes
//!   effect immediately — without it the new interval would only kick
//!   in at the next natural wake (potentially hours later).
//!
//! * **Startup delay.** We wait `STARTUP_DELAY` after boot so the
//!   first scheduled tick doesn't fight indexing, LSP warm-up, and
//!   the initial Typst compile. The on-launch check still picks up an
//!   overdue backup — it just runs once the app has settled.
//!
//! * **Failure isolation.** A backend run failure logs + records via
//!   `runner::record_failure` (which the settings UI surfaces) and the
//!   scheduler keeps going. We never panic the task or stop the loop.

use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

use crate::settings::BackupSettings;
use crate::state::AppState;

use super::{runner, state};

/// Delay before the first scheduled tick after app boot. Picked to
/// land *after* the typical indexing/LSP warm-up window so the first
/// scheduled archive doesn't compete with foreground work.
const STARTUP_DELAY: Duration = Duration::from_secs(30);

/// Minimum interval we'll honour. Guards against a user typing `1` for
/// "every hour" but having a millisecond-loop bug elsewhere accidentally
/// triggering wake notifications in a tight loop. Real value of 1 hour
/// is unaffected.
const MIN_INTERVAL_SECS: u64 = 60;

/// Spawn the scheduler. Called once at app boot from `lib.rs::run`'s
/// setup hook. The task holds an `AppHandle` so it can resolve the
/// managed `AppState` on each tick — keeping no long-lived references
/// to fields avoids deadlocks and survives runtime state mutations.
///
/// Uses `tauri::async_runtime::spawn` rather than bare `tokio::spawn`
/// because the setup hook runs before Tauri's own Tokio reactor is
/// attached to the current thread — `tokio::spawn` would panic with
/// "there is no reactor running, must be called from the context of
/// a Tokio 1.x runtime". The Tauri wrapper hands the task to the
/// managed runtime regardless of which thread we're on.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        run_loop(app).await;
    });
}

async fn run_loop(app: AppHandle) {
    tokio::time::sleep(STARTUP_DELAY).await;

    loop {
        // Snapshot what we need on every iteration. Cheap; avoids
        // holding any state lock across the sleep below. The notebox root
        // (not just "is one open?") is needed so the next-due calc reads
        // *this* notebox's last-backup time.
        let (settings, notebox_root, wake) = {
            let state = app.state::<AppState>();
            let session = state.session("main").await;
            let settings = state.settings.read().await.backup.clone();
            let notebox_root = session.notebox_root.read().await.clone();
            (settings, notebox_root, state.backup_scheduler_wake.clone())
        };

        let sleep_for = compute_sleep_secs(&settings, notebox_root.as_deref());

        // Sleep until either due-time or a settings-change wake. The
        // `select!` cancellation is safe because both branches are
        // cancel-safe (sleep and Notify::notified).
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

/// Compute how long to sleep before the next scheduled tick. Returns
/// `None` when the scheduler should be dormant (interval is 0, path is
/// unset, or no notebox is open — the runner would fail anyway).
fn compute_sleep_secs(settings: &BackupSettings, notebox_root: Option<&Path>) -> Option<u64> {
    if !settings.enabled {
        return None;
    }
    let Some(notebox_root) = notebox_root else {
        return None;
    };
    if settings.interval_hours == 0 {
        return None;
    }
    let Some(path) = settings.path.as_ref() else {
        return None;
    };
    if path.is_empty() {
        return None;
    }

    let interval_secs = std::cmp::max(
        MIN_INTERVAL_SECS,
        (settings.interval_hours as u64).saturating_mul(3600),
    );

    let last = state::load(notebox_root).last_success_unix;
    if last <= 0 {
        // Never run before — schedule the first one one full interval
        // from now. Avoids "open the app, get a backup immediately"
        // surprise on first launch with a freshly-configured path.
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
            // Tell any open UI to refresh the "Last backup" line. The
            // settings panel listens for this event; if no UI is open
            // the event is a harmless broadcast.
            if let Err(e) = emit_state_changed(app) {
                log::debug!("scheduled backup: state-changed emit failed (UI may be closed): {e}");
            }
        }
        Ok(Ok(None)) => {
            log::debug!("scheduled backup skipped (no changes since last run)");
        }
        Ok(Err(crate::errors::InkyCapError::Cancelled)) => {
            // Cancel happens through a UI button the user pressed.
            // Don't persist it as a "Last attempt failed" status —
            // the user knows; record_failure would spam their
            // settings panel with a false negative.
            log::info!("scheduled backup cancelled by user");
        }
        Ok(Err(e)) => {
            log::warn!("scheduled backup failed: {e}");
            runner::record_failure(&notebox_root_for_record, &e.to_string());
            let _ = emit_state_changed(app);
        }
        Err(e) => {
            log::warn!("scheduled backup task panicked: {e}");
            runner::record_failure(&notebox_root_for_record, &format!("task panicked: {e}"));
        }
    }
}

fn emit_state_changed(app: &AppHandle) -> tauri::Result<()> {
    use tauri::Emitter;
    app.emit("backup:state-changed", ())
}

/// Fire the wake notifier so the running scheduler reruns its
/// next-due computation. Cheap to call; idempotent (multiple wakes
/// before the task observes one just collapse into a single iteration).
pub fn wake_now(state: &AppState) {
    state.backup_scheduler_wake.notify_one();
}
