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
    /// user-global startup behaviour).
    pub target: String,
    /// Notebox-relative path of the last active file, persisted by the
    /// frontend.
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
}

// --- Persistence ---

/// Storage path for a notebox's settings file.
pub fn settings_path(notebox_root: &Path) -> PathBuf {
    notebox_root.join(".inkycap").join("settings.json")
}

/// Load per-notebox settings from disk, returning defaults if the file
/// doesn't exist or is unparseable.
pub fn load_settings(notebox_root: &Path) -> NoteboxSettings {
    let path = settings_path(notebox_root);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Save per-notebox settings to disk. Creates the `.inkycap/` parent dir
/// if it doesn't exist.
pub fn save_settings(notebox_root: &Path, settings: &NoteboxSettings) -> Result<()> {
    let path = settings_path(notebox_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(settings)?;
    std::fs::write(&path, json)?;
    Ok(())
}
