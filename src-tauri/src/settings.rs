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
    /// Which enabled dictionary is actively checking, set from the status-bar
    /// chip: `"all"` checks against every enabled dictionary (a word passes if
    /// any accepts it — for bilingual notes), or a single dictionary code to
    /// narrow checking to one language. Off is the `spellcheck` master toggle.
    pub spellcheck_active: String,
    /// Auto-close brackets and quotes.
    pub auto_pair_brackets: bool,
    /// Auto-close Typst formatting delimiters (*, _, `, $).
    #[serde(alias = "auto_pair_markdown")]
    pub auto_pair_typst: bool,
    /// Smart list indentation on Enter/Tab.
    pub smart_indent_lists: bool,
    /// When true, pressing Enter at the end of a line in the *visual
    /// editor* inserts a Typst linebreak (`\`) so the next line wraps as
    /// a new visual line in the rendered output, instead of being
    /// collapsed into a space (Typst's default behaviour for single
    /// newlines). A second consecutive Enter still produces a paragraph
    /// break. In the visual editor the `\` is hidden and managed as an
    /// atomic "soft break" so the writer never sees or edits it; source
    /// mode never auto-inserts it and shows any existing `\` as plain
    /// text.
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
    /// Accent source: "default", "custom", or "os".
    /// Determines how the frontend resolves the working accent color.
    pub accent_source: String,
    /// Accent color as a CSS hex value (e.g. "#1D7874"). Used when
    /// `accent_source` is "custom"; otherwise ignored.
    pub accent_color: String,
    /// What Ctrl+/Ctrl- adjusts: "content", "interface", or "both".
    pub zoom_target: String,
    /// How the file tree groups folders relative to files when sorting:
    /// "before" (folders first), "after" (files first), or "inline" (interleaved).
    pub folder_grouping: String,
    /// The user's chosen sort mode for the file tree. One of "name-asc",
    /// "name-desc", "modified-desc", "modified-asc", "created-desc",
    /// "created-asc". Persisted here so a re-open preserves the ordering
    /// the user picked. Stored as a string so the frontend's union type
    /// is the single source of truth — Rust just round-trips the value.
    pub file_tree_sort: String,
    /// Moment-style format pattern for displaying dates in the UI
    /// (Agenda due dates, backup timestamps, last-backup indicator, etc.).
    /// Does not affect how dates are stored — only their presentation.
    /// E.g. "D MMM YYYY" → "8 Nov 2024"; "YYYY-MM-DD" → "2024-11-08".
    pub date_format: String,
    /// BCP-47 code for the user-interface language (e.g. "en", "fr"). Drives
    /// which locale dictionary the frontend loads. "en" is the default and the
    /// fallback for any code without a shipped translation. Affects UI chrome
    /// only, not note content or how anything is stored.
    pub ui_locale: String,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            bg_palette_light: "default".to_string(),
            bg_palette_dark: "default".to_string(),
            accent_source: "default".to_string(),
            accent_color: "#1D7874".to_string(),
            zoom_target: "content".to_string(),
            folder_grouping: "before".to_string(),
            file_tree_sort: "name-asc".to_string(),
            date_format: "D MMM YYYY".to_string(),
            ui_locale: "en".to_string(),
        }
    }
}

/// File and link handling settings — workflow toggles that follow the user,
/// not the notebox. Folder paths and notebox-specific exclusions live in
/// `NoteboxFileSettings` instead (see `notebox_settings.rs`).
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
    /// When true, the file tree shows filename extensions (e.g. "note.typ").
    /// When false (default), the trailing `.<ext>` is stripped from file
    /// nodes (directories are unaffected).
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

/// Startup behavior settings — the user's "how should the app open"
/// preference. The notebox-specific target (file path / rule id) and the
/// last-active-file pointer live in `NoteboxStartupSettings`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct StartupSettings {
    /// What to open on launch: "default", "last-file", "creation-rule", "specific-page", or "specific-collection".
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
#[derive(Default)]
pub struct BehaviourSettings {
    /// When a file is opened in a new tab (Ctrl/Cmd+click or a right-click
    /// "open in new tab" action), switch the content focus to that tab
    /// immediately. When false, the tab opens in the background.
    pub switch_to_new_tab: bool,
}

/// In-app update preferences. A check never runs without user action unless
/// `check_on_startup` is explicitly enabled — InkyCap makes no network request
/// otherwise (local-first, no silent calls).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct UpdateSettings {
    /// Check once shortly after launch. Opt-in; default false.
    pub check_on_startup: bool,
    /// Also surface development (beta) releases — the even-numbered release
    /// channel. Default false: only user-facing (odd) releases are offered.
    pub include_beta: bool,
}

/// Typst-facing document defaults that affect compilation, reading view,
/// and export. User-global because typography is tuned to the device the
/// user is writing on (display size, eye comfort); a notebox or collection
/// can still override locally with Typst markup or a collection style.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DocumentDefaults {
    /// Text size in points (e.g. 11.0). None = Typst default (11pt).
    pub text_size: Option<f64>,
    /// Paper name (e.g. "a4", "us-letter"). None = Typst default ("a4").
    pub page_size: Option<String>,
}

/// Citation and bibliography settings — the user-global subset (system
/// install paths and a global style default). The notebox-specific source
/// selection, bibliography file path, and custom CSL override live in
/// `NoteboxCitationSettings`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CitationSettings {
    /// Citation style name (e.g. "chicago-author-date", "apa"). Global
    /// default — a notebox can override via its own settings or a
    /// collection-level style.
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

/// Font configuration. Each role picks one of System / Bundled / Custom
/// (plus role-specific extras: text adds "typst-default"; editor adds
/// "follow" interface; verse adds "follow" text). Resolution to a
/// concrete family name happens at the boundary (CSS for interface/editor;
/// Typst injection for mono/text/verse).
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
            monospace: FontChoice::system(),
            text: FontChoice::bundled(),
            verse: FontChoice::follow(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
#[derive(Default)]
pub struct ExportSettings {
    /// Custom path to the Pandoc binary. If not set, auto-detected from PATH.
    pub pandoc_path: Option<String>,
}

/// Notebox backup settings — controls how, when, and where the backup
/// runner writes zip snapshots of the currently-open notebox.
///
/// User-global because the destination (an external folder, e.g. a backup
/// volume) is a per-machine concern; the runner picks up whichever notebox
/// is open at the time it fires. The password itself is *not* stored here
/// — when `password_protected` is true the actual secret lives in the OS
/// keychain (Secret Service on Linux, Keychain on macOS, Credential Manager
/// on Windows). Settings.json only records that a password is set, so a
/// settings.json leak does not leak the secret.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct BackupSettings {
    /// Master on/off for the entire backup feature. When `false`, the
    /// scheduler is dormant and the manual "Back up now" command refuses
    /// to run — the user has explicitly opted out. Distinct from "no
    /// destination configured": this is an explicit user choice, not a
    /// missing configuration step. Defaults to `true` so users who
    /// upgrade with an already-configured destination keep their
    /// existing schedule.
    pub enabled: bool,
    /// Destination folder for backup archives. `None` disables the feature
    /// entirely (scheduled runner is dormant, command-palette entry is a
    /// no-op with a clear error). Stored as the frontend-canonical
    /// forward-slash string; converted to a `PathBuf` at use-sites.
    pub path: Option<String>,
    /// Hours between scheduled backups. `0` disables scheduled backups
    /// (manual command-palette runs still work).
    pub interval_hours: u32,
    /// Number of archives to keep in the destination folder. Older ones
    /// matching the configured filename pattern are pruned after each
    /// successful backup.
    pub keep_count: u32,
    /// Skip the scheduled backup if no notebox content has changed since
    /// the last successful backup. Manual runs ignore this flag.
    pub only_on_change: bool,
    /// Include the user-global config folder (`~/.config/inkycap/`) in
    /// the archive. Small but useful when restoring on a new machine.
    pub include_user_config: bool,
    /// True when a password is set in the OS keychain. The password
    /// itself is fetched at archive-write time via `keyring`; this flag
    /// is the persisted "feature enabled" toggle the settings UI binds
    /// to so the user can see whether encryption will be applied.
    pub password_protected: bool,
    /// Filename template. Supports tokens `{notebox}`, `{YYYY}`, `{MM}`,
    /// `{DD}`, `{HH}`, `{mm}`, `{ss}`. Substituted values are sanitized
    /// against Windows-reserved characters and reserved names before the
    /// final path is assembled.
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

/// Top-level user-global settings — preferences that follow the user across
/// every notebox. Notebox-specific settings (folder paths, journal scroll
/// preferences, bibliography source, etc.) live in
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
}

/// A user-registered external program InkyCap can pipe text through — the
/// generic "external tool" bridge. InkyCap ships *no* concrete tools; the user
/// points at an executable they trust, the same authorization model as the
/// Pandoc and Zotero paths. The executable is spawned from Rust (it is never
/// reachable from the webview shell allowlist), and the path lives only in
/// persisted settings — the frontend invokes a tool by `id`, never by path, so
/// it cannot ask InkyCap to run an arbitrary binary. See
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
    /// Arguments passed as a vector (never a shell string — no shell is
    /// involved). Each entry may contain the placeholders
    /// `$INKYCAP_NOTEBOX_ROOT`, `$INKYCAP_FILE`, and `$INKYCAP_SELECTION`,
    /// substituted at run time.
    pub args: Vec<String>,
    /// What InkyCap writes to the tool's stdin: `"selection"`, `"note"`, or
    /// `"none"`.
    pub input: String,
    /// What InkyCap does with the tool's stdout: `"insert"` (at the cursor),
    /// `"replace"` (the selection), `"notify"` (transient toast, document
    /// untouched), or `"panel"` (a persistent right-panel pane). The backend
    /// does not act on this — it echoes the value to the frontend, which
    /// applies the disposition.
    pub output: String,
    /// Where the tool is offered: `"palette"` (the global command palette,
    /// the default — it never disturbs the editor selection, so
    /// `input: "selection"` tools work), `"slash"` (the editor `/` menu, best
    /// for insert-at-cursor tools), or `"both"`. The backend does not act on
    /// this — the frontend reads it to decide where to surface the tool.
    pub show_in: String,
    /// When `true` (the default), the note/selection text is reduced to plain
    /// prose — the `#import` preamble, `#note(...)` metadata, inline markup,
    /// math, and code are stripped — before being written to the tool's stdin.
    /// Best for text-oriented tools (grammar/style checkers); turn off for
    /// tools that need the raw Typst source. See
    /// [`crate::typst_pipeline::plaintext`].
    pub strip_markup: bool,
    /// Optional icon for the tool's output pane tab, as a `"lucide:<name>"`
    /// string (the icon-picker format shared with collections). Empty means
    /// "use the default" (a terminal glyph). The backend does not act on this —
    /// the frontend resolves it when rendering the right-panel tab.
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

    // Check whether the raw JSON contains `accent_source` before
    // deserializing — we need this to distinguish legacy files (which
    // predate the field) from files where the user explicitly chose
    // "default".
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

    // Migrate legacy appearance settings: pre-`accent_source` configs
    // that lack the field entirely land with the serde default ("default")
    // but may carry a non-default `accent_color`. Promote those to
    // "custom" so the user's color survives the upgrade. Only run this
    // when `accent_source` was truly absent — otherwise the user has
    // explicitly chosen "default" and we must respect that.
    if !has_accent_source
        && settings.appearance.accent_source == "default"
        && !settings
            .appearance
            .accent_color
            .eq_ignore_ascii_case("#1D7874")
    {
        settings.appearance.accent_source = "custom".to_string();
    }

    // Migrate legacy `bg_palette` into both per-theme fields. Only run when
    // the new fields are still at their defaults — otherwise the user has
    // already chosen per-theme values and we must respect those.
    if let Some(legacy) = legacy_bg_palette {
        if settings.appearance.bg_palette_light == "default"
            && settings.appearance.bg_palette_dark == "default"
        {
            settings.appearance.bg_palette_light = legacy.clone();
            settings.appearance.bg_palette_dark = legacy;
        }
    }

    // Drop legacy editor "follow" mode — the option was removed from
    // the UI. Inherit the interface choice so the user's effective
    // editor font stays the same across the upgrade.
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
