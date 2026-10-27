//! Notebox health monitor, started when a notebox opens. Every
//! [`HEALTH_TICK_INTERVAL`] it checks:
//!
//! 1. **That the notebox folder exists.** If it was deleted or unmounted while
//!    open, it sends `notebox:lost` so the frontend can warn that nothing can
//!    be saved, then stops.
//! 2. **That `.inkycap/` is intact.** If the library file is missing,
//!    [`notebox_package::scaffold`] recreates the `.inkycap/` folder (library,
//!    scaffolds and defaults, collections), which the file watcher ignores. A
//!    healthy notebox costs one `exists()` call.
//!
//! Its [`tokio::task::AbortHandle`] is kept in [`AppState::health_monitor`];
//! opening another notebox stops the old monitor first.

use std::path::PathBuf;
use std::time::Duration;

use tauri::AppHandle;

use crate::events::{publish, AppEvent, Audience};
use tokio::task::AbortHandle;

/// How often the monitor checks: soon enough that a missing notebox is reported
/// quickly, and the cost (two `exists()` calls) is negligible.
pub const HEALTH_TICK_INTERVAL: Duration = Duration::from_secs(5);

/// Start a monitor for the notebox root and return its abort handle. The caller
/// stores it (usually in `AppState::health_monitor`) and aborts it before
/// opening another notebox, so two monitors don't run at once.
pub fn spawn(app: AppHandle, owner_label: String, notebox_root: PathBuf) -> AbortHandle {
    let handle = tokio::spawn(run(app, owner_label, notebox_root));
    handle.abort_handle()
}

async fn run(app: AppHandle, owner_label: String, notebox_root: PathBuf) {
    let lib_path = crate::notebox_package::library_path(&notebox_root);
    loop {
        tokio::time::sleep(HEALTH_TICK_INTERVAL).await;

        // The notebox folder is gone: send the event and stop. The frontend
        // shows the warning; in-memory state is kept so open tabs still show
        // their content and the user can copy it.
        if !notebox_root.exists() {
            log::warn!(
                "notebox health: root vanished at {}; telling its window",
                notebox_root.display(),
            );
            publish(
                &app,
                Audience::Window(&owner_label),
                AppEvent::NoteboxLost {
                    path: notebox_root.clone(),
                },
            );
            return;
        }

        // `.inkycap/` was deleted: rerun the scaffold to restore it.
        // `scaffold()` is safe on a healthy notebox too, but the check avoids
        // the file work.
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
