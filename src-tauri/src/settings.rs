// User settings — persisted at $CONFIG_DIR/inkycap/settings.json.
// All fields use serde(default) so missing keys get sensible defaults.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::errors::Result;

/// Editor-related settings.
///
/// Old settings files may contain fields that no longer exist;
/// serde silently drops unknown fields since `deny_unknown_fields`
/// is intentionally absent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct EditorSettings {
    /// Base UI scale factor in pixels. Drives `--text-*` CSS sizes.
    /// (The editor's textual content uses `body_font_size` instead.)
    pub font_size: u32,
    /// Font family for the editor content area.
    pub body_font_family: String,
    /// Base font size in pixels for live preview mode.
    pub body_font_size: u32,
    /// Limit line width for comfortable reading.
    pub readable_line_length: bool,
    /// Maximum line width in characters (used when readable_line_length is true).
    pub max_line_width: u32,
    /// Enable browser-native spellcheck.
    pub spellcheck: bool,
    /// Auto-close brackets and quotes.
    pub auto_pair_brackets: bool,
    /// Auto-close Typst formatting delimiters (*, _, `, $).
    #[serde(alias = "auto_pair_markdown")]
    pub auto_pair_typst: bool,
    /// Smart list indentation on Enter/Tab.
    pub smart_indent_lists: bool,
    /// Require blank line for paragraph breaks.
    pub strict_line_breaks: bool,
    /// Default editing mode: "source" or "live-preview".
    pub default_editing_mode: String,
    /// Default reading format: "svg" (paginated) or "html" (flowing).
    pub default_reading_format: String,
    /// Show wikilinks inline in rendered (reading/export) output.
    pub show_inline_wikilinks: bool,
    /// Show tags inline in rendered (reading/export) output.
    pub show_inline_tags: bool,
    /// Focus mode for the visual editor: "none", "line", or "section".
    pub focus_mode: String,
    /// Dim unfocused text in the visual editor when focus mode is active.
    pub focus_dim: bool,
    /// Optional font family override applied to `#verse(...)` blocks.
    /// `None` (or empty) means the verse uses the surface's regular text
    /// font (visual editor body / reading view text font).
    pub verse_font: Option<String>,
    /// When `verse_font` is set, also propagate it to reading view and
    /// compiled output via `#set-vault(verse-font: ...)`. When false, the
    /// override applies only to the visual editor.
    pub apply_verse_font_to_output: bool,
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            font_size: 15,
            body_font_family: "\"Adwaita Sans\", Inter, \"Fira Sans\", \"Ubuntu Sans\", system-ui, -apple-system, sans-serif".to_string(),
            body_font_size: 17,
            readable_line_length: true,
            max_line_width: 80,
            spellcheck: false,
            auto_pair_brackets: true,
            auto_pair_typst: true,
            smart_indent_lists: true,
            strict_line_breaks: false,
            default_editing_mode: "live-preview".to_string(),
            default_reading_format: "svg".to_string(),
            show_inline_wikilinks: true,
            show_inline_tags: true,
            focus_mode: "none".to_string(),
            focus_dim: false,
            verse_font: None,
            apply_verse_font_to_output: false,
        }
    }
}

/// Appearance-related settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppearanceSettings {
    /// Theme: "dark", "light", or "system".
    pub theme: String,
    /// Background palette: "default" or "warm".
    pub bg_palette: String,
    /// Accent source: "default", "custom", or "os".
    /// Determines how the frontend resolves the working accent color.
    pub accent_source: String,
    /// Accent color as a CSS hex value (e.g. "#1D7874"). Used when
    /// `accent_source` is "custom"; otherwise ignored.
    pub accent_color: String,
    /// Font family for UI elements (sidebar, menus, etc.).
    pub interface_font: String,
    /// Font family for code blocks and monospace content.
    pub monospace_font: String,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            bg_palette: "default".to_string(),
            accent_source: "default".to_string(),
            accent_color: "#1D7874".to_string(),
            interface_font: "\"Adwaita Sans\", Inter, \"Fira Sans\", \"Ubuntu Sans\", system-ui, -apple-system, sans-serif".to_string(),
            monospace_font: "\"Adwaita Mono\", \"Ubuntu Mono\", \"Fira Mono\", \"IBM Plex Mono\", \"JetBrains Mono\", Consolas, monospace".to_string(),
        }
    }
}

/// File and link handling settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct FileSettings {
    /// Where new notes are created: "root", "current", or "specified".
    pub new_note_location: String,
    /// Folder path (relative to vault root) for new notes when location is "specified".
    pub new_note_folder: String,
    /// Folder path (relative to vault root) for attachments (images, files).
    pub attachment_folder: String,
    /// Regex patterns for files to exclude from search and quick-open.
    pub excluded_files_regex: Vec<String>,
    /// Automatically update wikilinks when a file is renamed or moved.
    pub auto_update_links_on_rename: bool,
    /// Folder path (relative to vault root) containing scaffold files.
    #[serde(alias = "template_folder")]
    pub scaffold_folder: String,
    /// Folder path (relative to vault root) containing Typst template files.
    #[serde(default = "default_typst_templates_folder")]
    pub typst_templates_folder: String,
    /// Show a confirmation dialog before deleting files.
    pub confirm_before_delete: bool,
}

fn default_typst_templates_folder() -> String {
    ".inkycap/templates".to_string()
}

impl Default for FileSettings {
    fn default() -> Self {
        Self {
            new_note_location: "root".to_string(),
            new_note_folder: String::new(),
            attachment_folder: "assets".to_string(),
            excluded_files_regex: Vec::new(),
            auto_update_links_on_rename: true,
            scaffold_folder: ".inkycap/scaffolds".to_string(),
            typst_templates_folder: ".inkycap/templates".to_string(),
            confirm_before_delete: true,
        }
    }
}

/// Startup behavior settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct StartupSettings {
    /// What to open on launch: "last-file", "creation-rule", or "specific-page".
    pub behavior: String,
    /// Target: creation rule ID or file/base path (depends on behavior).
    pub target: String,
    /// Vault-relative path of the last active file, persisted by the frontend.
    pub last_active_file: Option<String>,
}

impl Default for StartupSettings {
    fn default() -> Self {
        Self {
            behavior: "last-file".to_string(),
            target: String::new(),
            last_active_file: None,
        }
    }
}

/// Journal Scroll settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct JournalScrollSettings {
    /// How dates are determined for Date mode: "created", "modified", or "zid".
    pub date_sort: String,
    /// Tree scope: "folder" (siblings only) or "recursive" (include subfolders).
    pub tree_scope: String,
}

impl Default for JournalScrollSettings {
    fn default() -> Self {
        Self {
            date_sort: "created".to_string(),
            tree_scope: "folder".to_string(),
        }
    }
}

/// Citation and bibliography settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CitationSettings {
    /// Citation source: "file" or "zotero".
    pub source: String,
    /// Vault-relative path to bibliography file (.bib, .yml, .json).
    pub bibliography_path: Option<String>,
    /// Citation style name (e.g. "chicago-author-date", "apa").
    pub citation_style: Option<String>,
    /// Path to a custom .csl file for citation formatting.
    pub custom_csl_path: Option<String>,
    /// Absolute path to the Zotero SQLite database.
    pub zotero_database_path: Option<String>,
}

impl Default for CitationSettings {
    fn default() -> Self {
        Self {
            source: "file".to_string(),
            bibliography_path: None,
            citation_style: Some("chicago-author-date".to_string()),
            custom_csl_path: None,
            zotero_database_path: None,
        }
    }
}

/// Document defaults — Typst-facing settings that affect compilation,
/// reading view, and export. `None` means "use Typst's built-in default".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DocumentDefaults {
    /// Text font family name (e.g. "Linux Libertine"). None = Typst default.
    pub text_font: Option<String>,
    /// Text size in points (e.g. 11.0). None = Typst default (11pt).
    pub text_size: Option<f64>,
    /// Paper name (e.g. "a4", "us-letter"). None = Typst default ("a4").
    pub page_size: Option<String>,
}

impl Default for DocumentDefaults {
    fn default() -> Self {
        Self {
            text_font: None,
            text_size: None,
            page_size: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ExportSettings {
    /// Custom path to the Pandoc binary. If not set, auto-detected from PATH.
    pub pandoc_path: Option<String>,
}

impl Default for ExportSettings {
    fn default() -> Self {
        Self {
            pandoc_path: None,
        }
    }
}

/// Top-level user settings struct.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct UserSettings {
    pub editor: EditorSettings,
    pub appearance: AppearanceSettings,
    pub files: FileSettings,
    pub startup: StartupSettings,
    pub journal_scroll: JournalScrollSettings,
    pub citations: CitationSettings,
    pub export: ExportSettings,
    pub document: DocumentDefaults,
}

// --- Persistence ---

fn settings_path() -> PathBuf {
    let config_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    config_dir.join("inkycap").join("settings.json")
}

/// Load settings from disk, returning defaults for any missing fields.
pub fn load_settings() -> UserSettings {
    let path = settings_path();
    let raw = std::fs::read_to_string(&path).ok();

    // Check whether the raw JSON contains `accent_source` before
    // deserializing — we need this to distinguish legacy files (which
    // predate the field) from files where the user explicitly chose
    // "default".
    let has_accent_source = raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|v| v.get("appearance")?.get("accent_source").cloned())
        .is_some();

    let mut settings: UserSettings = raw
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    // Migrate legacy appearance settings: pre-`accent_source` configs
    // that lack the field entirely land with the serde default ("default")
    // but may carry a non-default `accent_color`. Promote those to
    // "custom" so the user's color survives the upgrade. Only run this
    // when `accent_source` was truly absent — otherwise the user has
    // explicitly chosen "default" and we must respect that.
    if !has_accent_source
        && settings.appearance.accent_source == "default"
        && !settings.appearance.accent_color.eq_ignore_ascii_case("#1D7874")
    {
        settings.appearance.accent_source = "custom".to_string();
    }

    settings
}

/// Save settings to disk.
pub fn save_settings(settings: &UserSettings) -> Result<()> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(settings)?;
    std::fs::write(&path, json)?;
    Ok(())
}
