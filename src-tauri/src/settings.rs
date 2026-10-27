// User settings — persisted at $CONFIG_DIR/inkycap/settings.json.
// All fields use serde(default) so missing keys get sensible defaults.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::errors::Result;

/// Editor settings. Unknown fields in older files are ignored
/// (`deny_unknown_fields` isn't set).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct EditorSettings {
    /// Base UI scale factor in pixels. Drives `--text-*` CSS sizes.
    /// (The editor's textual content uses `body_font_size` instead.)
    pub font_size: u32,
    /// Base font size in pixels for live preview mode.
    pub body_font_size: u32,
    /// Limit line width for comfortable reading.
    pub readable_line_length: bool,
    /// Maximum line width in characters (used when readable_line_length is true).
    pub max_line_width: u32,
    /// Master on/off for in-editor spell checking.
    pub spellcheck: bool,
    /// Dictionary codes the user has enabled (e.g. `["en_CA", "fr"]`) — the set
    /// the status-bar language switcher offers.
    pub spellcheck_languages: Vec<String>,
    /// The dictionary checking text, from the status-bar chip: `"all"` (a word
    /// passes if any enabled dictionary accepts it) or one dictionary code.
    /// `spellcheck` turns checking off.
    pub spellcheck_active: String,
    /// Auto-close brackets and quotes.
    pub auto_pair_brackets: bool,
    /// Auto-close Typst formatting delimiters (*, _, `, $).
    #[serde(alias = "auto_pair_markdown")]
    pub auto_pair_typst: bool,
    /// Smart list indentation on Enter/Tab.
    pub smart_indent_lists: bool,
    /// When true, Enter at the end of a line in the visual editor inserts a
    /// Typst line break (`\`), so the line breaks in the output instead of
    /// joining with a space. A second Enter makes a paragraph break. The visual
    /// editor hides the `\`; source mode never inserts it.
    pub enter_inserts_line_break: bool,
    /// Default editing mode: "source" or "live-preview".
    pub default_editing_mode: String,
    /// Default reading format: "svg" (paginated) or "html" (flowing).
    pub default_reading_format: String,
    /// Show wikilinks inline in rendered (reading/export) output.
    pub show_inline_wikilinks: bool,
    /// Show tags inline in rendered (reading/export) output.
    pub show_inline_tags: bool,
    /// Keep the cursor line vertically centred in the visual editor while
    /// typing (typewriter scrolling).
    pub typewriter_mode: bool,
    /// Focus mode for the visual editor: "none", "line", or "section".
    pub focus_mode: String,
    /// Dim unfocused text in the visual editor when focus mode is active.
    pub focus_dim: bool,
    /// Auto-expand function markup on cursor in visual mode.
    pub auto_expand_markup: bool,
    /// Show popup toolbar when text is selected in visual mode.
    pub selection_toolbar: bool,
    /// Enable slash (/) command shortcut in visual mode.
    pub command_palette: bool,
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            font_size: 15,
            body_font_size: 17,
            readable_line_length: true,
            max_line_width: 80,
            spellcheck: false,
            spellcheck_languages: vec!["en_CA".to_string()],
            spellcheck_active: "all".to_string(),
            auto_pair_brackets: true,
            auto_pair_typst: true,
            smart_indent_lists: true,
            enter_inserts_line_break: true,
            default_editing_mode: "live-preview".to_string(),
            default_reading_format: "svg".to_string(),
            show_inline_wikilinks: true,
            show_inline_tags: true,
            typewriter_mode: false,
            focus_mode: "none".to_string(),
            focus_dim: false,
            auto_expand_markup: false,
            selection_toolbar: true,
            command_palette: true,
        }
    }
}

/// Appearance-related settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppearanceSettings {
    /// Theme: "dark", "light", or "system".
    pub theme: String,
    /// Background palette for the light theme: "default" or "warm".
    pub bg_palette_light: String,
    /// Background palette for the dark theme: "default" or "warm".
    pub bg_palette_dark: String,
    /// Switch the colours that carry meaning (errors, warnings, diff colours,
    /// Mycelial View kinds, source-mode strings and numbers) to a set that
    /// stays distinct for colourblind users. The accent colour and note content
    /// are unaffected.
    pub colourblind_friendly: bool,
    /// Accent source: "default", "custom", or "os".
    /// Determines how the frontend resolves the working accent color.
    pub accent_source: String,
    /// Accent color as a CSS hex value (e.g. "#1D7874"). Used when
    /// `accent_source` is "custom"; otherwise ignored.
    pub accent_color: String,
    /// What Ctrl+/Ctrl- adjusts: "content", "interface", or "both".
    pub zoom_target: String,
    /// File-tree sort: "name-asc", "name-desc", "modified-desc",
    /// "modified-asc", "created-desc" or "created-asc". A string, since the
    /// frontend's type defines the values.
    pub file_tree_sort: String,
    /// Format pattern for dates shown in the UI; stored dates are unaffected.
    /// E.g. "D MMM YYYY" → "8 Nov 2024".
    pub date_format: String,
    /// BCP-47 code for the interface language (e.g. "en", "fr"). "en" is the
    /// default and the fallback for codes without a translation. Doesn't affect
    /// note content.
    pub ui_locale: String,
    /// When true, a note created under a non-English UI language gets `#set
    /// text(lang: …, region: …)` after its import (e.g. "fr-CA" → lang "fr",
    /// region "CA"), for correct hyphenation, spacing and quotes. The only way
    /// the UI language affects note content. No effect when `ui_locale` is
    /// "en". Default true.
    pub use_locale_typesetting: bool,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            bg_palette_light: "default".to_string(),
            bg_palette_dark: "default".to_string(),
            colourblind_friendly: false,
            accent_source: "default".to_string(),
            accent_color: "#1D7874".to_string(),
            zoom_target: "content".to_string(),
            file_tree_sort: "name-asc".to_string(),
            date_format: "D MMM YYYY".to_string(),
            ui_locale: "en".to_string(),
            use_locale_typesetting: true,
        }
    }
}

/// File and link settings that follow the user. Folder paths and notebox
/// exclusions are in `NoteboxFileSettings` (`notebox_settings.rs`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct FileSettings {
    /// Automatically update wikilinks when a file is renamed or moved.
    pub auto_update_links_on_rename: bool,
    /// Show a confirmation dialog before deleting files.
    pub confirm_before_delete: bool,
    /// Enable Zettelkasten IDs (zid). When enabled, new notes automatically
    /// receive a `zid` property generated from `zid_pattern`.
    pub zettelkasten_enabled: bool,
    /// Moment-style format pattern for generating Zettelkasten IDs.
    /// E.g. "YYYYMMDDHHmmss" produces "20260511143025".
    pub zid_pattern: String,
    /// When true, new notes are automatically titled with the generated ZID
    /// instead of prompting the user for a title.
    pub auto_title_as_zid: bool,
    /// Show file extensions in the file tree (e.g. "note.typ"). Off by default;
    /// folders are unaffected.
    pub show_file_extensions: bool,
}

impl Default for FileSettings {
    fn default() -> Self {
        Self {
            auto_update_links_on_rename: true,
            confirm_before_delete: true,
            zettelkasten_enabled: true,
            zid_pattern: "YYYYMMDDHHmmss".to_string(),
            auto_title_as_zid: false,
            show_file_extensions: false,
        }
    }
}

/// Startup behaviour. The notebox's target and last-active file are in
/// `NoteboxStartupSettings`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct StartupSettings {
    /// What to open on launch: "default", "last-file", "previous-tabs",
    /// "creation-rule", "specific-page" or "specific-collection". The tabs for
    /// "previous-tabs" are stored per machine outside the notebox, in
    /// [`crate::tab_sessions`].
    pub behavior: String,
}

impl Default for StartupSettings {
    fn default() -> Self {
        Self {
            behavior: "last-file".to_string(),
        }
    }
}

/// General behaviour settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct BehaviourSettings {
    /// Switch to a tab opened with Ctrl/Cmd+click or "Open in new tab". When
    /// false, it opens in the background.
    pub switch_to_new_tab: bool,

    /// Show the most recently modified notes on the new tab page.
    pub new_tab_recent_notes: bool,
    /// Show the tasks and dated reminders due today on the new tab page.
    pub new_tab_today: bool,
    /// Show notes that are linked to but not written yet on the new tab page.
    pub new_tab_unwritten_notes: bool,
    /// How many entries each list on the new tab page shows (3, 6 or 12).
    pub new_tab_list_length: u32,

    /// Linux only: set `WEBKIT_DISABLE_DMABUF_RENDERER=1` and
    /// `WEBKIT_DISABLE_COMPOSITING_MODE=1` at startup, to avoid stray or
    /// duplicated UI on some GPU and driver combinations (notably
    /// NVIDIA/Nouveau and some Wayland sessions). Read before the webview
    /// starts (see `crate::run`), so changes need a restart. Off by default.
    /// See issue #22.
    pub disable_dmabuf_renderer: bool,
}

impl Default for BehaviourSettings {
    fn default() -> Self {
        Self {
            switch_to_new_tab: false,
            new_tab_recent_notes: false,
            new_tab_today: false,
            new_tab_unwritten_notes: false,
            new_tab_list_length: 6,
            disable_dmabuf_renderer: false,
        }
    }
}

/// Update settings. No update check runs without user action unless
/// `check_on_startup` is on.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct UpdateSettings {
    /// Check once shortly after launch. Opt-in; default false.
    pub check_on_startup: bool,
    /// Also surface development (beta) releases — the odd-numbered release
    /// channel. Default false: only user-facing (even) releases are offered.
    pub include_beta: bool,
    /// Advanced: a different release feed for the update check. Empty means
    /// InkyCap's own. For forks; set in `settings.json` only. Must be `https`;
    /// when set, the check never falls back to InkyCap's hosts.
    #[serde(default)]
    pub feed_url: Option<String>,
}

/// User overrides of keyboard shortcuts. Defaults live in the frontend command
/// registry (`src/lib/commands.ts`). Keys are command ids (e.g.
/// `"file:quick-open"`): `Some("Ctrl+Shift+O")` rebinds, `None` unbinds, and a
/// missing key keeps the default. Combos use the frontend's platform-neutral
/// form (`Cmd` stored as `Ctrl`). Rust only stores the map; the frontend
/// resolves and checks conflicts.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ShortcutSettings {
    pub overrides: HashMap<String, Option<String>>,
}

/// Document defaults for compiling, reading and export. Per user, because
/// typography is tuned to the device; a notebox or collection can override
/// them.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DocumentDefaults {
    /// Text size in points (e.g. 11.0). None = Typst default (11pt).
    pub text_size: Option<f64>,
    /// Paper name (e.g. "a4", "us-letter"). None = Typst default ("a4").
    pub page_size: Option<String>,
}

/// Per-user citation settings (install paths and the default style). The
/// notebox's source, bibliography file and CSL override are in
/// `NoteboxCitationSettings`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CitationSettings {
    /// Citation style name (e.g. "chicago-author-date", "apa"). A notebox or
    /// collection can override it.
    pub citation_style: Option<String>,
    /// Absolute path to the Zotero SQLite database.
    pub zotero_database_path: Option<String>,
}

impl Default for CitationSettings {
    fn default() -> Self {
        Self {
            citation_style: Some("chicago-author-date".to_string()),
            zotero_database_path: None,
        }
    }
}

/// One font role's selection. See module-level docs on `FontSettings`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct FontChoice {
    /// `"system"` | `"bundled"` | `"typst-default"` | `"follow"` | `"custom"`.
    pub mode: String,
    /// Family name used when `mode == "custom"`. Empty otherwise.
    pub custom: String,
}

impl FontChoice {
    pub const SYSTEM: &'static str = "system";
    pub const BUNDLED: &'static str = "bundled";
    pub const TYPST_DEFAULT: &'static str = "typst-default";
    pub const FOLLOW: &'static str = "follow";
    pub const CUSTOM: &'static str = "custom";

    pub fn system() -> Self {
        Self {
            mode: Self::SYSTEM.into(),
            custom: String::new(),
        }
    }
    pub fn bundled() -> Self {
        Self {
            mode: Self::BUNDLED.into(),
            custom: String::new(),
        }
    }
    pub fn follow() -> Self {
        Self {
            mode: Self::FOLLOW.into(),
            custom: String::new(),
        }
    }
    pub fn custom(name: impl Into<String>) -> Self {
        Self {
            mode: Self::CUSTOM.into(),
            custom: name.into(),
        }
    }
}

impl Default for FontChoice {
    fn default() -> Self {
        Self::system()
    }
}

/// Fonts. Each role is System, Bundled or Custom, plus role-specific options
/// ("typst-default" for text, "follow" for editor and verse). Resolved to a
/// family in CSS (interface, editor) or in the injected Typst (mono, text,
/// verse).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct FontSettings {
    pub interface: FontChoice,
    pub editor: FontChoice,
    pub monospace: FontChoice,
    /// Compiled output / reading view body.
    pub text: FontChoice,
    /// `#verse(...)` body. Default mode "follow" inherits Text.
    pub verse: FontChoice,
}

impl Default for FontSettings {
    fn default() -> Self {
        Self {
            interface: FontChoice::system(),
            editor: FontChoice::system(),
            // Bundled rather than system, because monospace goes into the Typst
            // compile: a system default would differ by OS and need system fonts
            // on the first render. Interface and editor fonts are CSS, where
            // following the OS is right.
            monospace: FontChoice::bundled(),
            text: FontChoice::bundled(),
            verse: FontChoice::follow(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ExportSettings {
    /// Custom path to the Pandoc binary. If not set, auto-detected from PATH.
    pub pandoc_path: Option<String>,
    /// Add the `inkycap-notebox` import to a note that lacks it without asking.
    /// When `false`, the editor asks first.
    pub auto_add_notebox_import: bool,
}

impl Default for ExportSettings {
    fn default() -> Self {
        Self {
            pandoc_path: None,
            auto_add_notebox_import: true,
        }
    }
}

/// Backup settings: how, when and where zip snapshots of the open notebox are
/// written. Per user, because the destination is per machine; a backup covers
/// whichever notebox is open. The password isn't stored here: it is kept in the
/// OS keychain, and this file only records that one is set.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct BackupSettings {
    /// Turns backups on or off. When off, the scheduler is idle and "Back up
    /// now" refuses to run. Defaults to `true`, so an existing destination
    /// keeps its schedule.
    pub enabled: bool,
    /// Destination folder. `None` disables backups. Stored in forward-slash
    /// form.
    pub path: Option<String>,
    /// Hours between scheduled backups. `0` disables scheduled backups
    /// (manual command-palette runs still work).
    pub interval_hours: u32,
    /// Archives to keep; older ones matching the filename pattern are deleted
    /// after each backup.
    pub keep_count: u32,
    /// Skip the scheduled backup if no notebox content has changed since
    /// the last successful backup. Manual runs ignore this flag.
    pub only_on_change: bool,
    /// Include the user-global config folder (`~/.config/inkycap/`) in
    /// the archive. Small but useful when restoring on a new machine.
    pub include_user_config: bool,
    /// True when a password is in the OS keychain; it is read when an archive
    /// is written.
    pub password_protected: bool,
    /// Filename template with `{notebox}`, `{YYYY}`, `{MM}`, `{DD}`, `{HH}`,
    /// `{mm}`, `{ss}`. Substituted values are made safe for Windows file names.
    pub filename_pattern: String,
}

impl Default for BackupSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            path: None,
            interval_hours: 24,
            keep_count: 7,
            only_on_change: true,
            include_user_config: true,
            password_protected: false,
            filename_pattern: "inkycap-{notebox}-{YYYY}{MM}{DD}-{HH}{mm}.zip".to_string(),
        }
    }
}

/// Settings that follow the user across noteboxes. Per-notebox settings are in
/// [`crate::notebox_settings::NoteboxSettings`].
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct UserSettings {
    pub editor: EditorSettings,
    pub appearance: AppearanceSettings,
    pub files: FileSettings,
    pub startup: StartupSettings,
    pub citations: CitationSettings,
    pub export: ExportSettings,
    pub document: DocumentDefaults,
    pub fonts: FontSettings,
    pub behaviour: BehaviourSettings,
    pub backup: BackupSettings,
    pub external_tools: ExternalToolSettings,
    pub updates: UpdateSettings,
    pub shortcuts: ShortcutSettings,
}

/// An external program the user registered for piping text through. InkyCap
/// ships none. It is started from Rust, and the frontend refers to it by `id`,
/// never by path, so it can't run an arbitrary binary. See
/// `documentation/developer/extending/external-tools.md` and
/// [`crate::external_tools`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ExternalTool {
    /// Stable identifier the frontend uses to invoke the tool. Opaque; the UI
    /// generates it.
    pub id: String,
    /// Human-readable name shown in the command palette / menu.
    pub name: String,
    /// Absolute path to the executable to run.
    pub command: String,
    /// Arguments, passed as a list (no shell). May contain
    /// `$INKYCAP_NOTEBOX_ROOT`, `$INKYCAP_FILE` and `$INKYCAP_SELECTION`.
    pub args: Vec<String>,
    /// What InkyCap writes to the tool's stdin: `"selection"`, `"note"`, or
    /// `"none"`.
    pub input: String,
    /// What to do with the output: `"insert"`, `"replace"`, `"notify"` or
    /// `"panel"`. Applied by the frontend.
    pub output: String,
    /// Where the tool is offered: `"palette"` (default; keeps the editor
    /// selection), `"slash"` (the `/` menu) or `"both"`. Used by the frontend.
    pub show_in: String,
    /// When `true` (the default), send plain prose, with the import,
    /// `#note(...)`, markup, math and code removed. Turn off for tools that
    /// need Typst source. See [`crate::typst_pipeline::plaintext`].
    pub strip_markup: bool,
    /// Icon for the tool's output tab, as `"lucide:<name>"`. Empty means the
    /// default (a terminal). Used by the frontend.
    pub icon: String,
}

impl Default for ExternalTool {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            command: String::new(),
            args: Vec::new(),
            input: "selection".to_string(),
            output: "replace".to_string(),
            show_in: "palette".to_string(),
            strip_markup: true,
            icon: String::new(),
        }
    }
}

/// User-global registry of external tools (the "external tool" bridge).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ExternalToolSettings {
    pub tools: Vec<ExternalTool>,
}

// --- Persistence ---

fn settings_path() -> PathBuf {
    crate::app_paths::config_dir().join("settings.json")
}

/// Load settings from disk, returning defaults for any missing fields.
pub fn load_settings() -> UserSettings {
    let path = settings_path();
    let raw = std::fs::read_to_string(&path).ok();

    // Note whether `accent_source` is in the file, to tell older files from an
    // explicit "default".
    let parsed_raw = raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());

    let has_accent_source = parsed_raw
        .as_ref()
        .and_then(|v| v.get("appearance")?.get("accent_source").cloned())
        .is_some();

    // Legacy single `bg_palette` field — present on configs written before
    // the light/dark split. Copy it into both new fields below.
    let legacy_bg_palette: Option<String> = parsed_raw.as_ref().and_then(|v| {
        v.get("appearance")?
            .get("bg_palette")?
            .as_str()
            .map(str::to_string)
    });

    let mut settings: UserSettings = raw
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    // Older files without `accent_source` but with a custom `accent_color`
    // become "custom", so the colour is kept.
    if !has_accent_source
        && settings.appearance.accent_source == "default"
        && !settings
            .appearance
            .accent_color
            .eq_ignore_ascii_case("#1D7874")
    {
        settings.appearance.accent_source = "custom".to_string();
    }

    // Copy an older `bg_palette` into both per-theme fields, unless they have
    // already been set.
    if let Some(legacy) = legacy_bg_palette {
        if settings.appearance.bg_palette_light == "default"
            && settings.appearance.bg_palette_dark == "default"
        {
            settings.appearance.bg_palette_light = legacy.clone();
            settings.appearance.bg_palette_dark = legacy;
        }
    }

    // The editor "follow" font option was removed; use the interface choice so
    // the font stays the same.
    if settings.fonts.editor.mode == FontChoice::FOLLOW {
        settings.fonts.editor = settings.fonts.interface.clone();
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
