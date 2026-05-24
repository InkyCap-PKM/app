// Per-notebox settings — preferences that belong to a specific notebox and
// travel with it (folder paths, citation source, journal scroll behaviour,
// document defaults, last-active file). Persisted at
// `<notebox>/.inkycap/settings.json`.
//
// User-global preferences (editor ergonomics, theme, fonts, system binary
// paths, etc.) live in [`crate::settings::UserSettings`] and are persisted
// at `$CONFIG_DIR/inkycap/settings.json`. The split is by what the field
// describes — a notebox's structure vs. the user's environment — not by
// which surface configures it.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::errors::Result;

/// File and link settings whose meaning depends on a specific notebox's
/// folder layout. The user-global workflow toggles (link auto-update,
/// confirm-on-delete, Zettelkasten behaviour, etc.) live in
/// [`crate::settings::FileSettings`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct NoteboxFileSettings {
    /// Where new notes are created: "root", "current", or "specified".
    pub new_note_location: String,
    /// Folder path (relative to notebox root) for new notes when location is "specified".
    pub new_note_folder: String,
    /// Folder path (relative to notebox root) for attachments (images, files).
    pub attachment_folder: String,
    /// Regex patterns for files to exclude from search and quick-open.
    pub excluded_files_regex: Vec<String>,
}

impl Default for NoteboxFileSettings {
    fn default() -> Self {
        Self {
            new_note_location: "root".to_string(),
            new_note_folder: String::new(),
            attachment_folder: "Assets".to_string(),
            excluded_files_regex: Vec::new(),
        }
    }
}

/// Per-notebox startup state. The user-global "behavior" choice
/// ("last-file", "default", etc.) is in [`crate::settings::StartupSettings`];
/// what gets opened is per-notebox.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct NoteboxStartupSettings {
    /// Target: creation rule ID or file/base path (depends on the
    /// user-global startup behaviour). *Notebox-shared* — describes where
    /// this notebox opens, so it travels through git collaboration.
    pub target: String,
    /// Notebox-relative path of the last active file, persisted by the
    /// frontend. *Per-machine* — this is the user's cursor position on this
    /// device, not a property of the notebox. It is presented to the
    /// frontend as part of this struct, but persisted separately (see the
    /// settings-split note on [`NoteboxLocalState`]) so it never travels
    /// through git collaboration.
    pub last_active_file: Option<String>,
}

/// Git collaboration configuration for a notebox. When present, the notebox
/// is *collaborative*: its root is a git repository backed by `remote`, and
/// the whole notebox (not a subset) syncs through it.
///
/// This carries only the *notebox-shared* facts about the repo — the remote
/// URL and the tracked branch — which are fine to travel through git like
/// any other shared setting. **Commit author identity is deliberately not
/// here:** if it travelled in the committed settings file, every
/// collaborator who opened the notebox would commit under the same name.
/// Identity is per-user and is resolved at commit time from a
/// per-installation store keyed by remote URL (see
/// [`crate::git::auth`]), which keeps it per-notebook (a user can use a
/// different account per notebox) without leaking it to collaborators.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct NoteboxGitConfig {
    /// Remote URL — SSH (`git@host:owner/repo.git`) or HTTPS
    /// (`https://host/owner/repo.git`).
    pub remote: String,
    /// Branch that collaboration tracks (e.g. `"main"`).
    pub branch: String,
}

/// Per-machine notebox state that must **not** travel through git
/// collaboration. Persisted to a gitignored `.inkycap/local.json`, separate
/// from the shared `.inkycap/settings.json`.
///
/// The settings-split audit (Phase 1 of the notebox-git plan) found that the
/// other per-machine state already lives *outside* the notebox tree — window
/// state under the OS config dir, the metadata cache and search index under
/// the OS cache dir — so it never enters the repo in the first place. The
/// only per-machine field that previously lived inside the notebox was the
/// startup cursor (`last_active_file`); routing it here is what keeps the
/// committed `settings.json` free of device-specific churn that would
/// otherwise surface as a needless conflict on every pull.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct NoteboxLocalState {
    /// Notebox-relative path of the last active file on *this* machine.
    pub last_active_file: Option<String>,
}

/// Journal Scroll settings. Entirely per-notebox: each notebox has its own
/// feed configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct JournalScrollSettings {
    /// Sort axis for the feed: "created", "modified", "zid", or "note_date".
    pub date_sort: String,
    /// Maximal scope of notes the scroll may show:
    /// "all" (whole notebox), "daily" (the Daily Note rule's folder), or
    /// "custom" (the folder named in `custom_scope_folder`).
    pub anchor_scope: String,
    /// Notebox-relative folder used when `anchor_scope == "custom"`.
    pub custom_scope_folder: String,
}

impl Default for JournalScrollSettings {
    fn default() -> Self {
        Self {
            date_sort: "created".to_string(),
            anchor_scope: "all".to_string(),
            custom_scope_folder: String::new(),
        }
    }
}

/// Citation and bibliography settings whose meaning is tied to a specific
/// notebox's research apparatus. The user-global default style and Zotero
/// install path live in [`crate::settings::CitationSettings`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct NoteboxCitationSettings {
    /// Citation source: "file" or "zotero".
    pub source: String,
    /// Notebox-relative path to bibliography file (.bib, .yml, .json).
    pub bibliography_path: Option<String>,
    /// Path to a custom .csl file for citation formatting. Overrides the
    /// user-global `citation_style` default when set.
    pub custom_csl_path: Option<String>,
}

impl Default for NoteboxCitationSettings {
    fn default() -> Self {
        Self {
            source: "file".to_string(),
            bibliography_path: None,
            custom_csl_path: None,
        }
    }
}

/// Top-level per-notebox settings. Persisted at
/// `<notebox>/.inkycap/settings.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct NoteboxSettings {
    pub files: NoteboxFileSettings,
    pub startup: NoteboxStartupSettings,
    pub journal_scroll: JournalScrollSettings,
    pub citations: NoteboxCitationSettings,
    /// Git collaboration config. `None` ⇒ the notebox is not collaborative.
    /// Notebox-shared (travels): see [`NoteboxGitConfig`].
    pub git: Option<NoteboxGitConfig>,
}

// --- Persistence ---
//
// Per-notebox settings are split across two files so that collaboration can
// share one and ignore the other:
//   - `.inkycap/settings.json`  — notebox-*shared* state; travels via git.
//   - `.inkycap/local.json`     — per-*machine* state; gitignored.
// [`load_settings`] / [`save_settings`] present a single merged
// [`NoteboxSettings`] to the rest of the app; the split is purely a
// persistence concern and is invisible to callers and the frontend.

/// Storage path for a notebox's *shared* settings file (travels via git).
pub fn settings_path(notebox_root: &Path) -> PathBuf {
    notebox_root.join(".inkycap").join("settings.json")
}

/// Storage path for a notebox's *per-machine* local state (gitignored).
pub fn local_state_path(notebox_root: &Path) -> PathBuf {
    notebox_root.join(".inkycap").join("local.json")
}

/// Load per-notebox local (per-machine) state, returning defaults if the
/// file doesn't exist or is unparseable.
pub fn load_local_state(notebox_root: &Path) -> NoteboxLocalState {
    let path = local_state_path(notebox_root);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Save per-notebox local (per-machine) state. Creates `.inkycap/` if needed.
pub fn save_local_state(notebox_root: &Path, local: &NoteboxLocalState) -> Result<()> {
    let path = local_state_path(notebox_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(local)?;
    std::fs::write(&path, json)?;
    Ok(())
}

/// Load per-notebox settings from disk, returning defaults if the file
/// doesn't exist or is unparseable. The per-machine `last_active_file` is
/// read from `local.json` and overlaid so callers see one merged object.
pub fn load_settings(notebox_root: &Path) -> NoteboxSettings {
    let path = settings_path(notebox_root);
    let mut settings: NoteboxSettings = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    // Overlay per-machine state from the gitignored local file.
    settings.startup.last_active_file = load_local_state(notebox_root).last_active_file;
    settings
}

/// Save per-notebox settings to disk. Creates the `.inkycap/` parent dir if
/// it doesn't exist. Per-machine state (`last_active_file`) is written to the
/// gitignored `local.json`; the shared `settings.json` always records it as
/// `null` so device-specific cursor state never travels through git.
pub fn save_settings(notebox_root: &Path, settings: &NoteboxSettings) -> Result<()> {
    // 1. Per-machine state → local.json.
    save_local_state(
        notebox_root,
        &NoteboxLocalState {
            last_active_file: settings.startup.last_active_file.clone(),
        },
    )?;

    // 2. Shared state → settings.json, with the per-machine field blanked so
    //    it is never committed.
    let mut shared = settings.clone();
    shared.startup.last_active_file = None;

    let path = settings_path(notebox_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&shared)?;
    std::fs::write(&path, json)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Round-trip: shared fields and the per-machine cursor both survive a
    /// save→load, even though they live in different files.
    #[test]
    fn settings_round_trip_merges_shared_and_local() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        let mut settings = NoteboxSettings::default();
        settings.files.attachment_folder = "Media".to_string();
        settings.startup.target = "daily".to_string();
        settings.startup.last_active_file = Some("notes/today.typ".to_string());
        settings.git = Some(NoteboxGitConfig {
            remote: "git@codeberg.org:joch/notes.git".to_string(),
            branch: "main".to_string(),
        });

        save_settings(root, &settings).unwrap();
        let loaded = load_settings(root);

        assert_eq!(loaded.files.attachment_folder, "Media");
        assert_eq!(loaded.startup.target, "daily");
        assert_eq!(
            loaded.startup.last_active_file.as_deref(),
            Some("notes/today.typ")
        );
        let git = loaded.git.expect("git config preserved");
        assert_eq!(git.remote, "git@codeberg.org:joch/notes.git");
        assert_eq!(git.branch, "main");
    }

    /// The committed `settings.json` must never carry the per-machine cursor:
    /// it is the field that would otherwise conflict on every collaborator
    /// pull. It is blanked there and lives only in the gitignored `local.json`.
    #[test]
    fn last_active_file_is_not_written_to_shared_settings() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        let mut settings = NoteboxSettings::default();
        settings.startup.last_active_file = Some("private/scratch.typ".to_string());
        save_settings(root, &settings).unwrap();

        let shared = std::fs::read_to_string(settings_path(root)).unwrap();
        assert!(
            !shared.contains("private/scratch.typ"),
            "cursor path leaked into the shared, committed settings.json"
        );

        let local = std::fs::read_to_string(local_state_path(root)).unwrap();
        assert!(
            local.contains("private/scratch.typ"),
            "cursor path missing from the per-machine local.json"
        );
    }

    /// A notebox with no git config loads as non-collaborative.
    #[test]
    fn absent_git_config_means_not_collaborative() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        save_settings(root, &NoteboxSettings::default()).unwrap();
        assert!(load_settings(root).git.is_none());
    }
}
