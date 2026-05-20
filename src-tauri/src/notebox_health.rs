//! Per-notebox health monitor.
//!
//! Spawned once per notebox open. Wakes every [`HEALTH_TICK_INTERVAL`] and
//! does two things:
//!
//! 1. **Notebox-root existence check.** If the notebox directory has been
//!    deleted out from under the running app (OS file manager, `rm -rf`,
//!    unmounted drive), emits a `notebox:lost` event so the frontend can
//!    warn the user that nothing can be saved. The monitor then stops —
//!    there's nothing further it can do until a new notebox is opened.
//!
//! 2. **`.inkycap/` integrity check.** If the canonical library file is
//!    missing, runs [`notebox_package::scaffold`] to re-seed the reserved
//!    `.inkycap/` tree (library, scaffolds dir + defaults, collections
//!    dir). This auto-heals mid-session deletions of the package files,
//!    which the file watcher otherwise ignores. The check is just one
//!    `exists()` syscall per tick when the notebox is healthy.
//!
//! Cancellation: the monitor's [`tokio::task::AbortHandle`] lives on
//! [`AppState::health_monitor`]. Opening another notebox aborts the old
//! handle before spawning a new one.

use std::path::PathBuf;
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio::task::AbortHandle;

/// How often the monitor wakes to check the notebox. 5 s is fast enough that
/// the user sees the "notebox missing" warning shortly after the directory
/// disappears, and slow enough that the cost (two `exists()` calls) is
/// negligible.
pub const HEALTH_TICK_INTERVAL: Duration = Duration::from_secs(5);

/// Frontend event name fired when the notebox root no longer exists on
/// disk. Payload: `{ "path": "<notebox root>" }`.
pub const NOTEBOX_LOST_EVENT: &str = "notebox:lost";

/// Spawn a fresh monitor for the given notebox root and return its abort
/// handle. The caller is responsible for storing the handle (typically on
/// `AppState::health_monitor`) and aborting it before opening another
/// notebox — otherwise the previous monitor would race the new one.
pub fn spawn(app: AppHandle, notebox_root: PathBuf) -> AbortHandle {
    let handle = tokio::spawn(run(app, notebox_root));
    handle.abort_handle()
}

async fn run(app: AppHandle, notebox_root: PathBuf) {
    let lib_path = crate::notebox_package::library_path(&notebox_root);
    loop {
        tokio::time::sleep(HEALTH_TICK_INTERVAL).await;

        // Notebox root vanished — emit the lost event and stop. The frontend
        // is responsible for the "save your content elsewhere" warning; we
        // don't tear down in-memory state here so any open editor tabs can
        // still display (and the user can copy from) their content.
        if !notebox_root.exists() {
            log::warn!(
                "notebox health: root vanished at {}; emitting {}",
                notebox_root.display(),
                NOTEBOX_LOST_EVENT
            );
            let _ = app.emit(
                NOTEBOX_LOST_EVENT,
                serde_json::json!({ "path": crate::storage::to_frontend_string(&notebox_root) }),
            );
            return;
        }

        // The notebox is still there but `.inkycap/` was deleted. Re-run the
        // scaffold to restore the library + reserved subdirs + seeded
        // scaffold files. `scaffold()` is idempotent so calling it from
        // here is safe even on a healthy notebox, but the existence check
        // avoids the file I/O in the common case.
        if !lib_path.exists() {
            log::info!(
                "notebox health: .inkycap/ missing at {}; re-seeding",
                notebox_root.display()
            );
            crate::notebox_package::scaffold(&notebox_root);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tick_interval_is_reasonable() {
        // Sanity: not so short the file syscalls dominate, not so long
        // the user is left staring at a stale UI.
        assert!(HEALTH_TICK_INTERVAL >= Duration::from_secs(1));
        assert!(HEALTH_TICK_INTERVAL <= Duration::from_secs(30));
    }
}
