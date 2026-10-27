// Per-notebox settings that travel with the notebox (folder paths, citation
// source, Journal Scroll, document defaults, last-active file), stored in
// `<notebox>/.inkycap/settings.json`.
//
// Per-user preferences (editor, theme, fonts, program paths) are in
// [`crate::settings::UserSettings`], stored in
// `$CONFIG_DIR/inkycap/settings.json`. The split follows what a field
// describes, the notebox or the user's environment.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::errors::Result;
use crate::git::auth::GitIdentity;

/// File and link settings that depend on a notebox's folders. Per-user toggles
/// are in [`crate::settings::FileSettings`].
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
    /// How the file tree places folders when sorting: "before" (folders first),
    /// "after" (files first) or "inline". Per notebox. A string, since the
    /// frontend's type defines the values.
    pub folder_grouping: String,
}

impl NoteboxFileSettings {
    /// The notebox-relative folder for new notes when nothing more specific
    /// applies: the chosen folder for "specified", `current_folder` for
    /// "current", otherwise the root (""). May contain template variables like
    /// `{{date:YYYY}}`.
    pub fn default_note_folder(&self, current_folder: &str) -> String {
        let folder = match self.new_note_location.as_str() {
            "specified" => self.new_note_folder.as_str(),
            "current" => current_folder,
            _ => "",
        };
        folder
            .trim()
            .trim_matches(|c| c == '/' || c == '\\')
            .to_string()
    }
}

impl Default for NoteboxFileSettings {
    fn default() -> Self {
        Self {
            new_note_location: "root".to_string(),
            new_note_folder: String::new(),
            attachment_folder: "Assets".to_string(),
            excluded_files_regex: Vec::new(),
            folder_grouping: "before".to_string(),
        }
    }
}

/// Per-notebox startup state. The "behavior" choice is per user, in
/// [`crate::settings::StartupSettings`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct NoteboxStartupSettings {
    /// A creation rule ID or a file path, depending on the startup behaviour.
    /// Shared through git.
    pub target: String,
    /// Notebox-relative path of the last active file. Per machine: shown as
    /// part of this struct, but stored in `local.json` (see
    /// [`NoteboxLocalState`]), so it never travels through git.
    pub last_active_file: Option<String>,
}

/// Git collaboration config. When present, the whole notebox is a git repo
/// synced through `remote`.
///
/// It holds only the remote URL and branch. The commit identity is per user and
/// isn't stored here, or every collaborator would commit under one name; see
/// `NoteboxLocalState::git_identity`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct NoteboxGitConfig {
    /// Remote URL, SSH (`git@host:owner/repo.git`) or HTTPS
    /// (`https://host/owner/repo.git`). Empty in package mode, where the
    /// notebox shares its history as exported files (see
    /// [`Self::is_package_mode`] and the package commands in
    /// `commands/git.rs`).
    pub remote: String,
    /// Branch that collaboration tracks (e.g. `"main"`).
    pub branch: String,
}

impl NoteboxGitConfig {
    /// Whether this notebox collaborates through packages rather than a git
    /// server: an empty `remote` means no server, so Sync and Check aren't
    /// offered. Setting a `remote` adds a server later.
    pub fn is_package_mode(&self) -> bool {
        self.remote.trim().is_empty()
    }
}

/// Per-machine notebox state that must not travel through git, stored in the
/// gitignored `.inkycap/local.json`. Other per-machine state (window state,
/// caches, search index) already lives outside the notebox; keeping the startup
/// cursor here keeps `settings.json` free of device-specific changes.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct NoteboxLocalState {
    /// Notebox-relative path of the last active file on *this* machine.
    pub last_active_file: Option<String>,
    /// HEAD (full oid) at this machine's last package export, in package mode.
    /// There are changes to share when the tree is dirty or HEAD has moved past
    /// it. `None` before the first export; server-backed noteboxes use the
    /// tracking ref instead.
    pub last_shared_oid: Option<String>,
    /// When set, Sync and package export first copy the Typst packages the
    /// notebox imports (with their dependencies) into `.inkycap/packages/`, so
    /// recipients can compile without downloading them. The copies are ordinary
    /// tracked files. A per-machine choice, off by default. Read by
    /// `commands::git::run_sync` and `git_export_package`.
    pub bundle_packages: bool,
    /// Local HEAD (full oid) just before the last Sync or package import merged
    /// incoming changes: the baseline for "Changes since last sync". `None`
    /// when no merge has happened here yet (or the first pull was into an empty
    /// branch). Set by `commands::git::run_sync`.
    pub last_sync_oid: Option<String>,
    /// Notebox-relative paths where the last sync took the incoming side over a
    /// local edit, flagged in the Changes pane. Replaced on each sync.
    pub last_sync_conflicted: Vec<String>,
    /// Git collaboration config on this machine; `None` when not collaborative
    /// here. The remote and branch are per-clone details and collaborating is a
    /// per-machine choice, so it stays out of the shared `settings.json`, where
    /// setting up collaboration would look like a change to share. See
    /// [`NoteboxGitConfig`].
    pub git: Option<NoteboxGitConfig>,
    /// Commit name and email for this notebox on this machine. Per notebox, so
    /// two clones of a repo can commit as different people. Falls back to git
    /// config when `None`.
    pub git_identity: Option<GitIdentity>,
}

/// Journal Scroll settings. Entirely per-notebox: each notebox has its own
/// feed configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct JournalScrollSettings {
    /// Sort axis for the feed: "created", "modified", "zid", or "note_date".
    pub date_sort: String,
    /// Which notes the scroll may show: "all", "daily" (the Daily Note rule's
    /// folder) or "custom" (`custom_scope_folder`).
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

/// Citation settings tied to this notebox. The default style and Zotero
/// location are per user, in [`crate::settings::CitationSettings`].
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
    /// Git collaboration config, or `None`. Part of the merged settings the app
    /// sees, but stored in the per-machine `local.json` (see
    /// [`NoteboxLocalState::git`]).
    pub git: Option<NoteboxGitConfig>,
}

// --- Persistence ---
//
// Per-notebox settings are stored in two files:
//   - `.inkycap/settings.json`: shared; travels through git.
//   - `.inkycap/local.json`: per machine; gitignored.
// [`load_settings`] / [`save_settings`] present one merged
// [`NoteboxSettings`], so callers never see the split.

/// True when the folder already holds a notebox (it has `.inkycap`).
/// `settings.json` alone isn't reliable; it is only written once a setting
/// changes from its default.
pub fn is_existing_notebox(folder: &Path) -> bool {
    folder.join(".inkycap").is_dir()
}

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

/// Load the notebox's settings, or defaults if missing or unreadable, with the
/// per-machine fields from `local.json` merged in.
pub fn load_settings(notebox_root: &Path) -> NoteboxSettings {
    let path = settings_path(notebox_root);
    let mut settings: NoteboxSettings = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    // Overlay per-machine state from the gitignored local file.
    let local = load_local_state(notebox_root);
    settings.startup.last_active_file = local.last_active_file;
    // The git config lives in local.json; fall back to an older value in
    // settings.json, which `migrate_git_config` or the next save moves.
    if local.git.is_some() {
        settings.git = local.git;
    }
    settings
}

/// Save the notebox's settings, creating `.inkycap/` if needed. Per-machine
/// fields go to the gitignored `local.json`; `settings.json` records them as
/// `null`.
pub fn save_settings(notebox_root: &Path, settings: &NoteboxSettings) -> Result<()> {
    // 1. Per-machine state → local.json, merged with what is there so fields
    //    outside `NoteboxSettings` (e.g. `last_sync_oid`) survive.
    let mut local = load_local_state(notebox_root);
    local.last_active_file = settings.startup.last_active_file.clone();
    local.git = settings.git.clone();
    save_local_state(notebox_root, &local)?;

    // 2. Shared state → settings.json, with the per-machine fields blanked so
    //    they never get committed and travel to collaborators.
    let mut shared = settings.clone();
    shared.startup.last_active_file = None;
    shared.git = None;

    let path = settings_path(notebox_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&shared)?;
    std::fs::write(&path, json)?;
    Ok(())
}

/// Move an older notebox's git config from `settings.json` to `local.json`, so
/// it stops being shared and showing as a change to share. No-op once done, so
/// safe on every open.
pub fn migrate_git_config(notebox_root: &Path) -> Result<()> {
    let raw = match std::fs::read_to_string(settings_path(notebox_root)) {
        Ok(s) => s,
        Err(_) => return Ok(()), // no settings file yet → nothing to migrate
    };
    let has_git_block = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.get("git").cloned())
        .is_some_and(|g| !g.is_null());
    if !has_git_block {
        return Ok(());
    }
    // `load_settings` picks up the git block from either file; `save_settings`
    // writes it to local.json and removes it from settings.json.
    let settings = load_settings(notebox_root);
    save_settings(notebox_root, &settings)
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

    /// The shared `settings.json` never contains the per-machine cursor.
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

    /// The git config never reaches the shared `settings.json`.
    #[test]
    fn git_config_is_not_written_to_shared_settings() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        let settings = NoteboxSettings {
            git: Some(NoteboxGitConfig {
                remote: "https://codeberg.org/athena-otlet/notes".to_string(),
                branch: "main".to_string(),
            }),
            ..Default::default()
        };
        save_settings(root, &settings).unwrap();

        let shared = std::fs::read_to_string(settings_path(root)).unwrap();
        assert!(
            !shared.contains("athena-otlet"),
            "git remote leaked into the shared, committed settings.json"
        );
        let local = std::fs::read_to_string(local_state_path(root)).unwrap();
        assert!(
            local.contains("athena-otlet"),
            "git remote missing from the per-machine local.json"
        );
    }

    /// An older notebox with `git` in `settings.json` migrates to `local.json`;
    /// the merged settings are unchanged.
    #[test]
    fn migrate_moves_legacy_git_block_to_local() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".inkycap")).unwrap();
        // Hand-write a legacy settings.json carrying the git block.
        std::fs::write(
            settings_path(root),
            r#"{"git":{"remote":"https://codeberg.org/athena-otlet/notes","branch":"main"}}"#,
        )
        .unwrap();

        migrate_git_config(root).unwrap();

        let shared = std::fs::read_to_string(settings_path(root)).unwrap();
        assert!(
            !shared.contains("athena-otlet"),
            "legacy git block not stripped"
        );
        let local = std::fs::read_to_string(local_state_path(root)).unwrap();
        assert!(
            local.contains("athena-otlet"),
            "git block not migrated to local.json"
        );
        // The merged view still reports the config.
        assert_eq!(
            load_settings(root)
                .git
                .expect("git config preserved")
                .remote,
            "https://codeberg.org/athena-otlet/notes"
        );

        // Idempotent: a second run is a no-op (settings.json already clean).
        migrate_git_config(root).unwrap();
        assert!(!std::fs::read_to_string(settings_path(root))
            .unwrap()
            .contains("athena-otlet"));
    }
}
