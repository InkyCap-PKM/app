//! One-time copy of per-app data from InkyCap's old app ID
//! (`com.inkycap.editor`) to the current one (`org.inkycap.editor`).
//!
//! The ID changed to match the project's domain (inkycap.org), which Flathub
//! and other app stores check. Most of InkyCap's data lives under a folder
//! named `inkycap` and is unaffected, but two kinds of data are stored under
//! the ID and would otherwise start over:
//!
//! - **Every install type:** window size/position and the webview's stored
//!   data (panel layout, last dialog folders). See `app_paths::app_id_dirs`.
//! - **Flatpak:** *everything* (settings, bookmarks, notebox list, …), because
//!   a Flatpak keeps all its data in `~/.var/app/<app id>/`, and the new ID is
//!   a separate app to Flatpak. The Flatpak manifest grants read-only access to
//!   the old app's folder for this copy; the sandbox hides it otherwise.
//!
//! Rules: it only ever copies, never deletes or changes the old data; it copies
//! a folder only when the new location doesn't have it yet, so it does nothing
//! on later launches and never overwrites anything the new version wrote.
//!
//! REMOVE this module, its call in `lib.rs`, the `take_id_migration_notice`
//! command, its frontend notice and the Flatpak manifest's read-only
//! `~/.var/app/com.inkycap.editor` permission about a year after the release
//! that changed the ID (target: late 2027), once almost nobody still runs a
//! version from before it.

use std::fs;
use std::path::Path;
use std::sync::Mutex;

use crate::app_paths;

/// The app ID used by releases up to 26.9.
pub const OLD_APP_ID: &str = "com.inkycap.editor";

/// What the copy did at this launch, kept for the frontend to ask about once.
#[derive(Default)]
pub struct IdMigrationReport {
    flatpak_data_copied: Mutex<bool>,
}

/// Copy the old app ID's data across. Must run before anything reads settings
/// and before the webview starts, so both find their data already in place.
pub fn run(new_app_id: &str) -> IdMigrationReport {
    for new_dir in app_paths::app_id_dirs(new_app_id) {
        if let Some(parent) = new_dir.parent() {
            copy_if_absent(&parent.join(OLD_APP_ID), &new_dir);
        }
    }

    let mut flatpak_data_copied = false;
    if std::env::var("FLATPAK_ID").as_deref() == Ok(new_app_id) {
        if let (Some(old_root), Some(new_root)) = (
            app_paths::flatpak_app_dir(OLD_APP_ID),
            app_paths::flatpak_app_dir(new_app_id),
        ) {
            flatpak_data_copied = copy_flatpak_data(&old_root, &new_root, new_app_id);
        }
    }

    IdMigrationReport {
        flatpak_data_copied: Mutex::new(flatpak_data_copied),
    }
}

/// Copy the old Flatpak's `config` and `data` folders into the new one,
/// renaming any folder named after the old ID (Tauri's own per-ID folders)
/// on the way. The cache is skipped: it rebuilds. Returns whether anything
/// was copied.
fn copy_flatpak_data(old_root: &Path, new_root: &Path, new_app_id: &str) -> bool {
    let mut copied = false;
    for area in ["config", "data"] {
        let Ok(entries) = fs::read_dir(old_root.join(area)) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let target_name = if name == OLD_APP_ID {
                new_app_id.into()
            } else {
                name
            };
            copied |= copy_if_absent(&entry.path(), &new_root.join(area).join(target_name));
        }
    }
    copied
}

/// Copy `src` (a file or folder) to `dst` when `src` exists and `dst` does
/// not. Failures are logged and skipped: the worst outcome is a setting that
/// starts over, never lost data. Returns whether a copy happened.
fn copy_if_absent(src: &Path, dst: &Path) -> bool {
    if !src.exists() || dst.exists() {
        return false;
    }
    let result = if src.is_dir() {
        crate::typst_packages::copy_dir_all(src, dst)
    } else {
        dst.parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| fs::copy(src, dst).map(|_| ()))
    };
    match result {
        Ok(()) => {
            // path-stringification-ok: log message, not IPC
            log::info!(
                "id_migration: copied {} to {}",
                src.display(),
                dst.display()
            );
            true
        }
        Err(err) => {
            // path-stringification-ok: log message, not IPC
            log::warn!("id_migration: could not copy {}: {err}", src.display());
            false
        }
    }
}

/// Whether this launch copied data from the old InkyCap Flatpak, answered
/// once: the frontend shows its notice about removing the old copy, and a
/// second call (a reload) returns `false`.
#[tauri::command]
pub fn take_id_migration_notice(report: tauri::State<'_, IdMigrationReport>) -> bool {
    report
        .flatpak_data_copied
        .lock()
        .map(|mut copied| std::mem::take(&mut *copied))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEW: &str = "org.inkycap.editor";

    #[test]
    fn copies_a_folder_only_when_the_new_one_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join(OLD_APP_ID);
        let new = tmp.path().join(NEW);
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("window-state.json"), "old").unwrap();

        assert!(copy_if_absent(&old, &new));
        assert_eq!(
            fs::read_to_string(new.join("window-state.json")).unwrap(),
            "old"
        );

        // A second run, or a run after the new version wrote its own data,
        // leaves the new data alone.
        fs::write(new.join("window-state.json"), "new").unwrap();
        assert!(!copy_if_absent(&old, &new));
        assert_eq!(
            fs::read_to_string(new.join("window-state.json")).unwrap(),
            "new"
        );
        assert_eq!(
            fs::read_to_string(old.join("window-state.json")).unwrap(),
            "old"
        );
    }

    #[test]
    fn missing_old_data_is_not_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!copy_if_absent(
            &tmp.path().join("nothing"),
            &tmp.path().join("new")
        ));
        assert!(!tmp.path().join("new").exists());
    }

    #[test]
    fn flatpak_copy_brings_settings_and_renames_id_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join(OLD_APP_ID);
        let new = tmp.path().join(NEW);
        fs::create_dir_all(old.join("config/inkycap")).unwrap();
        fs::write(old.join("config/inkycap/settings.json"), "{}").unwrap();
        fs::create_dir_all(old.join("config").join(OLD_APP_ID)).unwrap();
        fs::write(
            old.join("config")
                .join(OLD_APP_ID)
                .join("window-state.json"),
            "w",
        )
        .unwrap();
        fs::create_dir_all(old.join("data/inkycap")).unwrap();
        fs::create_dir_all(old.join("cache/inkycap")).unwrap();
        // Flatpak creates the new app's empty folders before it starts.
        fs::create_dir_all(new.join("config")).unwrap();

        assert!(copy_flatpak_data(&old, &new, NEW));
        assert!(new.join("config/inkycap/settings.json").exists());
        assert!(new
            .join("config")
            .join(NEW)
            .join("window-state.json")
            .exists());
        assert!(new.join("data/inkycap").exists());
        assert!(
            !new.join("cache").exists(),
            "the cache rebuilds and is not copied"
        );
        assert!(
            old.join("config/inkycap/settings.json").exists(),
            "the old copy is untouched"
        );

        // Nothing new to copy the second time.
        assert!(!copy_flatpak_data(&old, &new, NEW));
    }
}
