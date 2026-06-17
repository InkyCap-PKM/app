// Property values mirror Rust's PropertyValue enum
export type PropertyValue =
  | string
  | number
  | boolean
  | PropertyValue[]
  | null;

export interface NoteMetadata {
  path: string;
  properties: Record<string, PropertyValue>;
  links: string[];
  tags: string[];
  /** Document-level repeat rule from `#note(recurrence: …)`, kept out of
   *  `properties` (it's structured, not a scalar). `null` when the note's date
   *  doesn't recur. Mirrors the Rust `NoteMetadata.recurrence`. */
  recurrence?: Recurrence | null;
}

/** A repeat rule for a dated reminder. Mirrors the Rust `Recurrence`, which in
 *  turn mirrors the queryable Typst `recurrence: (…)` dict. Reminder-only:
 *  recurrence attaches to dates, never to checkbox tasks. */
export interface Recurrence {
  /** How often it repeats. */
  freq: "day" | "week" | "month" | "year";
  /** Repeat every N periods (>= 1). */
  interval: number;
  /** Weekly only: weekday codes (`"mo".."su"`) the rule lands on. Empty means
   *  "the anchor's own weekday". */
  by_day: string[];
  /** Inclusive end date (`YYYY-MM-DD`), or `null` when unbounded by a date. */
  until: string | null;
  /** Maximum occurrences from the anchor, or `null` when unbounded by a count. */
  count: number | null;
}

export interface FileMetadata {
  name: string;
  folder: string;
  ext: string;
  path: string;
  ctime: string | null;
  mtime: string | null;
  size: number;
}

export interface NoteboxInfo {
  path: string;
  name: string;
  file_count: number;
  collection_count: number;
  property_keys: string[];
}

export interface NoteboxRegistryEntry {
  path: string;
  display_name: string;
  last_opened: number;
  /** This notebox is set up for git collaboration (computed fresh by the
   *  backend from the notebox's own settings, not persisted in the registry). */
  collaborative: boolean;
}

export interface NoteboxMoveResult {
  new_path: string;
  was_active: boolean;
}

export interface CollectionInfo {
  name: string;
  path: string;
  view_count: number;
  icon: string | null;
  /// Unix epoch seconds for the `.collection` file; zero when unknown.
  modified_time: number;
  created_time: number;
}

export interface CollectionData {
  columns: string[];
  rows: CollectionRow[];
  views: ViewInfo[];
  /** Distinct scalar values present per column across the view's member set
   *  (before per-column header filters narrow it). Powers the multi-select
   *  checklist in a list/commalist column's header filter. Columns with too
   *  many distinct values, or none, are omitted. */
  columnValues: Record<string, string[]>;
}

export interface CollectionRow {
  file_path: string;
  file_name: string;
  cells: Record<string, PropertyValue>;
}

export interface ViewInfo {
  name: string;
  view_type: string;
}

export interface FileTreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileTreeNode[];
  /** Unix epoch seconds. Zero means "unknown" (backend couldn't read
   *  the stat field). Used by the file-tree sort. */
  modified_time: number;
  created_time: number;
  /** The note's `#note(zid:)`, or null when absent (folders and notes
   *  without a zid). Used by the file-tree zid sort. */
  zid?: string | null;
}

export interface LinkInfo {
  path: string;
  name: string;
  /** Unix epoch seconds. Zero if the backend couldn't stat the file. */
  modified_time: number;
  created_time: number;
  /** The linked note's `#note(zid:)`, or null when absent. */
  zid?: string | null;
}

// .collection file editing types (mirror Rust structs)

export interface SortRule {
  property: string;
  direction: "ASC" | "DESC";
}

/// A member of a filter group's list: either a leaf expression string
/// (e.g. `collection.contains("paper")`) or a nested group. This recursion
/// is what lets a collection express `(A or B) and C`. Mirrors the backend
/// `FilterGroup` whose members are untyped YAML values.
export type FilterNode = string | FilterGroup;

export interface FilterGroup {
  and?: FilterNode[];
  or?: FilterNode[];
  not?: FilterNode[];
}

export interface ViewDef {
  type: string;
  name: string;
  filters?: FilterGroup | null;
  /** Per-column quick filters set from a column header, keyed by property name.
   *  A scope separate from `filters` (the advanced FilterBuilder) so the two
   *  clear independently. */
  columnFilters?: Record<string, FilterGroup> | null;
  order?: string[] | null;
  sort?: SortRule[] | null;
  columnSize?: Record<string, number> | null;
  summaries?: Record<string, string> | null;
}

export interface NoteboxIndex {
  tags: [string, number][];
  property_keys: [string, number][];
}

// Global property type registry. `Auto` means "infer from the value"
// (the legacy behavior); all other variants force a specific editor
// and a coerced on-disk shape.
export type PropertyType =
  | "auto"
  | "checkbox"
  | "date"
  | "datetime"
  | "list"
  | "commalist"
  | "number"
  | "text";

export interface CollectionPageStyle {
  paper?: string | null;
  margin?: string | null;
  columns?: number | null;
  numbering?: string | null;
}

export interface CollectionTextStyle {
  font?: string | null;
  size?: string | null;
  lang?: string | null;
  region?: string | null;
}

export interface CollectionParagraphStyle {
  leading?: string | null;
  spacing?: string | null;
  first_line_indent?: string | null;
  justify?: boolean | null;
}

export interface CollectionHeadingStyle {
  numbering?: string | null;
}

export interface CollectionStyle {
  page?: CollectionPageStyle | null;
  text?: CollectionTextStyle | null;
  paragraph?: CollectionParagraphStyle | null;
  heading?: CollectionHeadingStyle | null;
}

export interface CollectionFile {
  icon?: string | null;
  typst_template?: string | null;
  bibliography_style?: string | null;
  bibliography_file?: string | null;
  style?: CollectionStyle | null;
  /** Raw Typst injected verbatim at export, after the generated style rules and
   *  any template, so it overrides both. The power-user escape hatch for
   *  styling the Style Overrides UI doesn't expose. */
  custom_typst?: string | null;
  book?: BookExportConfig | null;
  filters?: FilterGroup | null;
  formulas?: Record<string, string> | null;
  summaries?: Record<string, string> | null;
  views: ViewDef[];
}

/** One selectable role for the contributors editor: a stored value (CRediT
 *  URL, or CSL bibliographic-role token) and a human label. Mirrors the Rust
 *  `CatalogEntry`. */
export interface CatalogEntry {
  value: string;
  label: string;
}

/** Role vocabularies for the contributors editor. Mirrors `ContributorCatalogs`. */
export interface ContributorCatalogs {
  credit_roles: CatalogEntry[];
  biblio_roles: CatalogEntry[];
}

export interface Contributor {
  name: string;
  biblio_role?: string | null;
  credit_roles: string[];
}

/// Where the merged book's table of contents sits relative to the chapters.
/// Mirrors the Rust `TocPlacement` (internally tagged on `kind`). `stem` is
/// the chapter note's file stem; an anchor whose stem isn't in the export set
/// falls back to `beginning` at build time.
export type TocPlacement =
  | { kind: "beginning" }
  | { kind: "end" }
  | { kind: "after_chapter"; stem: string };

/// How the merged book sources its bibliography. `unified` consolidates one
/// list at the back (stripping per-note declarations); `per_chapter` emits one
/// auto-generated, chapter-scoped list at the end of each chapter; `in_place`
/// keeps each note's own `#bibliography(...)` (Typst 0.15 allows several).
/// Mirrors the Rust `BibliographyMode`.
export type BibliographyMode = "unified" | "per_chapter" | "in_place";

/// Persistent "Export as book" configuration. Mirrors the Rust
/// `BookExportConfig`. All fields optional; defaults are supplied when
/// missing (see `BookExportOverrides` in `ipc.ts`).
export interface BookExportConfig {
  title?: string | null;
  subtitle?: string | null;
  author?: string | null;
  contributors?: Contributor[];
  date?: string | null;
  abstract?: string | null;
  toc_depth?: number | null;
  inject_chapter_heading?: "always" | "fallback" | "never" | null;
  wikilink_mode?: "internal" | "external" | "plain" | null;
  include_title_page?: boolean | null;
  include_outline?: boolean | null;
  toc_placement?: TocPlacement | null;
  page_numbering?:
    | { style: "arabic" }
    | { style: "arabic_from_chapters" }
    | { style: "roman_then_arabic" }
    | { style: "arabic_from_page"; start_page: number }
    | null;
  bibliography_mode?: BibliographyMode | null;
  /** When false, the CRediT contributions statement is omitted from the book
   *  export (the byline still renders). Defaults to true when unset. */
  include_credit_statement?: boolean | null;
}

// User settings (mirrors Rust UserSettings struct)

export interface EditorSettings {
  font_size: number;
  body_font_size: number;
  readable_line_length: boolean;
  max_line_width: number;
  spellcheck: boolean;
  spellcheck_languages: string[];
  /** Active dictionary from the status-bar switcher: "all" (union of enabled)
   *  or a single dictionary code. Off is the `spellcheck` master toggle. */
  spellcheck_active: string;
  auto_pair_brackets: boolean;
  auto_pair_typst: boolean;
  smart_indent_lists: boolean;
  enter_inserts_line_break: boolean;
  default_editing_mode: "source" | "live-preview";
  default_reading_format: "svg" | "html";
  show_inline_wikilinks: boolean;
  show_inline_tags: boolean;
  typewriter_mode: boolean;
  focus_mode: "none" | "line" | "section";
  focus_dim: boolean;
  auto_expand_markup: boolean;
  selection_toolbar: boolean;
  command_palette: boolean;
}

export type AccentSource = "default" | "custom" | "os";
export type BgPalette = "default" | "warm";
export type ZoomTarget = "content" | "interface" | "both";
export type FolderGrouping = "before" | "after" | "inline";

export type FileSortMode =
  | "name-asc"
  | "name-desc"
  | "modified-desc"
  | "modified-asc"
  | "created-desc"
  | "created-asc"
  | "zid-asc"
  | "zid-desc";

export interface AppearanceSettings {
  theme: "dark" | "light" | "system";
  /**
   * Background palette for the light theme:
   * - "default" — cool gray.
   * - "warm"    — coffee beige.
   */
  bg_palette_light: BgPalette;
  /**
   * Background palette for the dark theme:
   * - "default" — teal-ink.
   * - "warm"    — warm charcoal.
   */
  bg_palette_dark: BgPalette;
  /**
   * Where the accent color comes from:
   * - "default" — InkyCap's built-in accent (#1D7874). `accent_color` is ignored.
   * - "custom"  — the value in `accent_color` is used.
   * - "os"      — the operating-system accent is queried at runtime; falls back
   *               to default when unavailable.
   */
  accent_source: AccentSource;
  accent_color: string;
  zoom_target: ZoomTarget;
  /**
   * The user's chosen sort for the file tree. Persisted so a re-open of
   * the app (or a different notebox) preserves the ordering they picked.
   */
  file_tree_sort: FileSortMode;
  /**
   * Moment-style format pattern for displaying dates in the UI (Agenda due
   * dates, backup timestamps, last-backup indicator, etc.). Does not affect
   * how dates are stored — only their presentation. Tokens match the
   * Zettelkasten ID pattern: YYYY, YY, MMMM, MMM, MM, M, DD, D, HH, mm,
   * ss, dddd, ddd. Any non-token characters are kept verbatim.
   */
  date_format: string;
  /**
   * BCP-47 code for the user-interface language (e.g. "en", "fr"). Selects
   * which locale dictionary the frontend loads; "en" is the default and the
   * fallback for any code without a shipped translation. UI chrome only — it
   * does not affect note content.
   */
  ui_locale: string;
  /**
   * When true, a note created under a non-English UI locale gets a
   * `#set text(lang: …, region: …)` directive injected after its `#import`
   * line (derived from `ui_locale`) for correct hyphenation, punctuation
   * spacing, and smart quotes. The one place the UI locale touches note
   * content; no effect when `ui_locale` is "en". Default true.
   */
  use_locale_typesetting: boolean;
}

/** Typst-facing document defaults — text size and page size. User-global
 *  because typography is tuned to the device the user is writing on; a
 *  notebox or collection can override locally with Typst markup or a
 *  collection style. */
export interface DocumentDefaults {
  text_size: number | null;
  page_size: string | null;
}

/** User-global file workflow toggles. Folder paths and notebox-specific
 *  exclusions live in `NoteboxFileSettings`. */
export interface FileSettings {
  auto_update_links_on_rename: boolean;
  confirm_before_delete: boolean;
  zettelkasten_enabled: boolean;
  zid_pattern: string;
  auto_title_as_zid: boolean;
  show_file_extensions: boolean;
}

/** User-global citation defaults. The notebox-specific source choice,
 *  bibliography file path, and CSL override live in
 *  `NoteboxCitationSettings`. */
export interface CitationSettings {
  citation_style: string | null;
  zotero_database_path: string | null;
}

/** User-global startup behaviour. The notebox-specific target and
 *  last-active file pointer live in `NoteboxStartupSettings`. */
export interface StartupSettings {
  behavior: "default" | "last-file" | "creation-rule" | "specific-page" | "specific-collection";
}

export interface ExportSettings {
  pandoc_path: string | null;
}

/** Notebox backup settings. Controls scheduling, destination, retention,
 *  and encryption of zip snapshots of the currently-open notebox. The
 *  password itself is stored in the OS keychain, not in this struct;
 *  `password_protected` is the persisted "feature on" toggle. */
export interface BackupSettings {
  /** Master on/off for the backup feature. When false, the scheduler is
   *  dormant and the manual "Back up now" command refuses to run — an
   *  explicit user opt-out, distinct from "no destination configured". */
  enabled: boolean;
  /** Destination folder. `null` disables the feature. */
  path: string | null;
  /** Hours between scheduled backups. `0` disables the scheduler
   *  (the command-palette entry still works). */
  interval_hours: number;
  /** How many archives to keep in the destination. */
  keep_count: number;
  /** Skip scheduled backups when nothing has changed since the last one. */
  only_on_change: boolean;
  /** Include `~/.config/inkycap/` in the archive. */
  include_user_config: boolean;
  /** True when a password is set in the OS keychain — the actual secret
   *  is fetched at archive-write time, not stored here. */
  password_protected: boolean;
  /** Filename template with `{notebox}`, `{YYYY}`, `{MM}`, `{DD}`, `{HH}`,
   *  `{mm}`, `{ss}` tokens. Substituted values are sanitized against
   *  Windows-reserved characters and reserved names before the final
   *  path is assembled. */
  filename_pattern: string;
}

export interface BehaviourSettings {
  /** When a file is opened in a new tab (Ctrl/Cmd+click or a right-click
   *  "open in new tab" action), switch the content focus to that tab
   *  immediately. When false, the tab opens in the background. */
  switch_to_new_tab: boolean;
}

/** In-app update preferences. A check never runs without user action unless
 *  `check_on_startup` is explicitly enabled (local-first, no silent calls). */
export interface UpdateSettings {
  /** Check once shortly after launch. Opt-in; default false. */
  check_on_startup: boolean;
  /** Also surface development (beta) releases — the even-numbered release
   *  channel. Default false: only user-facing (odd) releases are offered. */
  include_beta: boolean;
}

export type FontMode = "system" | "bundled" | "typst-default" | "follow" | "custom";

export interface FontChoice {
  mode: FontMode;
  /** Family name when mode === "custom"; empty otherwise. */
  custom: string;
}

export interface FontSettings {
  interface: FontChoice;
  /** Default mode "follow" inherits Interface. */
  editor: FontChoice;
  monospace: FontChoice;
  /** Compiled output / reading view body. */
  text: FontChoice;
  /** `#verse(...)` body. Default mode "follow" inherits Text. */
  verse: FontChoice;
}

export interface SystemFontDefaults {
  sans: string;
  serif: string;
  mono: string;
}

/** User-global settings — preferences that follow the user across every
 *  notebox. Notebox-specific settings live in `NoteboxSettings`. */
export interface UserSettings {
  editor: EditorSettings;
  appearance: AppearanceSettings;
  files: FileSettings;
  startup: StartupSettings;
  citations: CitationSettings;
  export: ExportSettings;
  document: DocumentDefaults;
  fonts: FontSettings;
  behaviour: BehaviourSettings;
  backup: BackupSettings;
  external_tools: ExternalToolSettings;
  updates: UpdateSettings;
}

/** A user-registered external program the external-tool bridge can pipe text
 *  through. InkyCap ships no concrete tools — the user points at an executable
 *  they trust (same model as the Pandoc/Zotero paths). The executable is
 *  spawned from Rust and resolved by `id`, never by a frontend-supplied path.
 *  See `documentation/developer/extending/external-tools.md`. */
export interface ExternalTool {
  /** Stable identifier used to invoke the tool (the UI generates it). */
  id: string;
  /** Human-readable name shown in the command palette / menu. */
  name: string;
  /** Absolute path to the executable. */
  command: string;
  /** Arguments (passed as a vector, never a shell string). May contain the
   *  placeholders `$INKYCAP_NOTEBOX_ROOT`, `$INKYCAP_FILE`,
   *  `$INKYCAP_SELECTION`. */
  args: string[];
  /** What is written to the tool's stdin. */
  input: "selection" | "note" | "none";
  /** What InkyCap does with the tool's stdout: insert at the cursor, replace
   *  the selection, show it transiently (`notify`), or show it in a persistent
   *  right-panel pane (`panel`). */
  output: "insert" | "replace" | "notify" | "panel";
  /** Where the tool is offered: the global command palette (`palette`, the
   *  default — never disturbs the editor selection, so `selection`-input tools
   *  work), the editor `/` menu (`slash`, best for insert-at-cursor tools), or
   *  `both`. */
  show_in: "palette" | "slash" | "both";
  /** When true (the default), the note/selection is reduced to plain prose
   *  (markup, `#import`, `#note(...)`, math, and code stripped) before being
   *  sent to the tool's stdin. Turn off for tools that need raw Typst source. */
  strip_markup: boolean;
  /** Optional icon for the tool's output-pane tab, as a `"lucide:<name>"`
   *  string (the icon-picker format). Empty means the default terminal glyph. */
  icon: string;
}

/** User-global registry of external tools. */
export interface ExternalToolSettings {
  tools: ExternalTool[];
}

/** Result of running an external tool (see {@link ExternalTool}). */
export interface ExternalToolResult {
  /** The tool's stdout. */
  stdout: string;
  /** The configured output disposition, echoed from the tool's settings. */
  output: "insert" | "replace" | "notify" | "panel";
}

// ============================================================================
// Per-notebox settings — preferences scoped to a single notebox.
// Mirrors src-tauri/src/notebox_settings.rs.
// ============================================================================

/** Notebox-coupled folder paths and exclusion patterns. */
export interface NoteboxFileSettings {
  new_note_location: "root" | "current" | "specified";
  new_note_folder: string;
  attachment_folder: string;
  excluded_files_regex: string[];
  /**
   * How this notebox's file tree groups folders relative to files when sorting:
   * - "before" — all folders first, then files (both sorted by the chosen mode).
   * - "after"  — all files first, then folders.
   * - "inline" — folders and files are interleaved together under the chosen sort.
   *
   * Per-notebox so each notebox can present its own folder layout the way that
   * suits it (a flat journal vs. a deeply-nested research notebox want
   * different defaults).
   */
  folder_grouping: FolderGrouping;
}

/** Notebox-specific startup state. */
export interface NoteboxStartupSettings {
  /** Target: creation rule ID or file/base path (depends on the
   *  user-global startup `behavior`). */
  target: string;
  last_active_file: string | null;
}

/** Journal Scroll settings — entirely per-notebox. */
export interface JournalScrollSettings {
  date_sort: "created" | "modified" | "zid" | "note_date";
  /** Maximal scope of notes the scroll may show. */
  anchor_scope: "all" | "daily" | "custom";
  /** Notebox-relative folder used when `anchor_scope === "custom"`. */
  custom_scope_folder: string;
}

/** Notebox-specific citation source. The global `citation_style` and Zotero
 *  install path live in `CitationSettings`. */
export interface NoteboxCitationSettings {
  source: "file" | "zotero";
  bibliography_path: string | null;
  /** Per-notebox CSL override. Wins over the user-global `citation_style`. */
  custom_csl_path: string | null;
}

/** Git collaboration config for a notebox. `null` ⇒ the notebox is not
 *  collaborative. Mirrors `src-tauri/src/notebox_settings.rs::NoteboxGitConfig`.
 *  Carries only the notebox-shared facts (remote + branch); commit author
 *  identity is per-user and stored separately (keyed by remote), never here. */
export interface NoteboxGitConfig {
  /** Remote URL — SSH (`git@host:owner/repo.git`) or HTTPS. */
  remote: string;
  /** Tracked branch (e.g. `"main"`). */
  branch: string;
}

export interface NoteboxSettings {
  files: NoteboxFileSettings;
  startup: NoteboxStartupSettings;
  journal_scroll: JournalScrollSettings;
  citations: NoteboxCitationSettings;
  /** Git collaboration config; `null` when the notebox is not collaborative.
   *  Carried here so a settings save never drops a configured remote. The
   *  Phase 4 setup UI writes it via `gitSetupCollaboration`. */
  git: NoteboxGitConfig | null;
}

// ============================================================================
// Git collaboration (Phase 4 review surface).
//
// Mirrors the serde shapes in `src-tauri/src/commands/git.rs` and
// `src-tauri/src/git/backend.rs`. `GitReviewItem`/`GitReviewSession` are
// camelCase (rename_all); `GitCommitInfo` keeps the backend's snake_case field
// names, matching how other backend structs cross the IPC boundary here.
// ============================================================================

/** A short, content-free summary of a collaborative notebox's git state. */
export interface GitStatusSummary {
  /** Checked-out branch, or `null` on an unborn head. */
  branch: string | null;
  /** Short hash of the head commit, or `null` before the first commit. */
  head: string | null;
  /** Working tree has uncommitted changes (gitignored files excluded). */
  dirty: boolean;
  /** Commits ahead of upstream (outgoing); `0` with no upstream yet. */
  ahead: number;
  /** Commits behind upstream (incoming); `0` with no upstream yet. */
  behind: number;
  /** Commits present locally but not yet on the remote — what "Publish" sends.
   *  Counts all local commits before the first push (unlike `ahead`), so the
   *  initial publish is surfaced. */
  unpushed: number;
  /** Whether there's local work collaborators haven't received — the
   *  qualitative "Changes to share" signal shown instead of a commit count.
   *  Server mode: dirty or unpushed. Package mode: dirty or HEAD moved past the
   *  last export (commit counts never reset with no remote). */
  unshared: boolean;
}

/** Author + message of a commit — the review context the loop harvests. */
export interface GitCommitInfo {
  author_name: string;
  author_email: string;
  /** Commit time, seconds since the Unix epoch (UTC). */
  timestamp: number;
  message: string;
  /** Short hash (7 hex chars). */
  short_hash: string;
}

/** One incoming change in the post-sync digest ("what landed from others"). */
export interface GitDigestEntry {
  /** Notebox-relative path (frontend string form); the *new* path for a rename. */
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** For `"renamed"`, the previous path (frontend string form). */
  oldPath?: string | null;
}

/** One note still carrying unresolved `#suggestion(...)` tracked changes —
 *  the notebox-wide "changes to resolve" list. Mirrors
 *  `src-tauri/src/commands/git.rs::UnresolvedEntry`. */
export interface GitUnresolvedEntry {
  /** Absolute path (frontend string form) — used to open / dedupe the note. */
  path: string;
  /** Notebox-relative path (frontend string form) — drives the basename. */
  relPath: string;
  /** Count of open suggestions in the note. */
  count: number;
}

/** Outcome of a Sync / Check for updates. Mirrors
 *  `src-tauri/src/commands/git.rs::SyncOutcome`. Merge-first — never pauses. */
export interface GitSyncOutcome {
  /** Nothing incoming and nothing outgoing — already in sync. */
  upToDate: boolean;
  /** Local working edits were committed as part of the sync. */
  committed: boolean;
  /** Incoming changes were folded into the working tree (fast-forward/merge). */
  pulled: boolean;
  /** Local commits were pushed to the remote (Sync only). */
  pushed: boolean;
  /** The push was rejected (the remote moved) — sync again. */
  rejected: boolean;
  /** What collaborators changed since the merge base — the "what landed" digest. */
  digest: GitDigestEntry[];
  /** Notebox-relative paths (frontend form) where the merge took *theirs* over an
   *  overlapping local edit. The merge-first model never pauses, so these are
   *  surfaced for after-the-fact review (revert from the Changes pane). Empty for
   *  a clean merge / fast-forward. */
  conflicted: string[];
  /** The incoming tip commit's author/message, for the digest banner. */
  incoming: GitCommitInfo | null;
}

/** One note the last sync changed — the notebox-wide "review what landed" list.
 *  Mirrors `src-tauri/src/commands/git.rs::SinceSyncEntry`. */
export interface GitSinceSyncEntry {
  /** Absolute path (frontend string form) — used to open / dedupe the note. */
  path: string;
  /** Notebox-relative path (frontend string form) — drives the basename. The
   *  *new* path for a rename. */
  relPath: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** For `"renamed"`, the previous notebox-relative path (frontend form). */
  oldRelPath?: string | null;
  /** The sync resolved this path by taking *theirs* over a local edit. */
  conflicted: boolean;
}

/** One changed region of a note relative to the pre-sync baseline. Identity and
 *  scroll target are the current-side line range `[currentStart, currentEnd)`
 *  (0-based, end-exclusive). Mirrors `git/sync_review.rs::SyncHunk`. */
export interface GitSyncHunk {
  currentStart: number;
  currentEnd: number;
  /** The baseline (pre-sync) text — what reverting this hunk restores. Empty
   *  when the sync *added* the region. */
  baselineText: string;
  /** The current text. Empty when the sync *deleted* a baseline region. */
  currentText: string;
}

/** A note's changes since the last sync, split by origin. Mirrors
 *  `commands/git.rs::SyncNoteDiff`. */
export interface GitSyncNoteDiff {
  /** Changes the last sync folded in (theirs) — reviewable/revertable. */
  incoming: GitSyncHunk[];
  /** The user's own uncommitted edits since the sync (yours) — informational. */
  local: GitSyncHunk[];
  /** The sync added this note — show a single "added" status, not a whole-file hunk. */
  incomingCreated: boolean;
  /** The note is brand-new local work — show a single "created" status. */
  localCreated: boolean;
}

/** Result of a read-only "Check for updates": how far the local branch is
 *  behind the remote, fetched without pulling. Mirrors `commands/git.rs::CheckResult`. */
export interface GitCheckResult {
  /** Local already has everything on the remote. */
  upToDate: boolean;
  /** Commits the remote has that local lacks (what a Sync would bring in). */
  behind: number;
  /** The incoming tip commit's author/message. */
  incoming: GitCommitInfo | null;
}

/** One past version of a note (a row in its version history). Commit metadata
 *  only — content is fetched on demand. Mirrors `git/backend.rs::FileVersion`. */
export interface GitNoteVersion {
  /** Full commit hash — the opaque handle to view/restore this version. */
  commit: string;
  /** Short hash (7 hex chars). */
  shortHash: string;
  authorName: string;
  /** Commit time, seconds since the Unix epoch (UTC). */
  timestamp: number;
  message: string;
  /** This is the user's own version from just before the last sync took *theirs*
   *  over their edit to this note — i.e. what the merge replaced. The History
   *  view flags it so the user can compare it with the current note. */
  tookTheirsBaseline: boolean;
}

/** A commit author identity (name + email). Stored per-installation, keyed by
 *  remote — never in the repo. */
export interface GitIdentity {
  name: string;
  email: string;
}

/** Outcome of `gitSetupCollaboration`. */
export interface GitSetupResult {
  /** A fresh `git init` happened (notebox was not a repo before). */
  initialized: boolean;
  status: GitStatusSummary;
}

/** Outcome of `gitExportPackage` (Phase 7 offline package handoff). Mirrors
 *  `commands/git.rs::PackageExportResult`. */
export interface GitPackageExportResult {
  /** Where the package was written. */
  path: string;
  /** Files written from `.git` (objects, refs, etc.). */
  fileCount: number;
  /** Uncompressed bytes of `.git` packaged. */
  bytes: number;
  /** When packages were included: canonical specs (`@ns/name:ver`) vendored
   *  into the notebox so they travel with the export. */
  vendoredPackages: string[];
  /** Imported package specs that couldn't be located locally and so were NOT
   *  bundled — the recipient may be unable to compile notes that need them. */
  unresolvedPackages: string[];
}

/** Outcome of enabling "bundle packages" (`gitSetBundlePackages`). Mirrors
 *  `commands/git.rs::BundlePackagesResult`. */
export interface GitBundlePackagesResult {
  /** Canonical specs (`@ns/name:ver`) newly vendored into the notebox. */
  vendored: string[];
  /** Imported specs that couldn't be located locally and so were NOT bundled. */
  unresolved: string[];
}

// ============================================================================
// Journal Scroll — ScrollQuery primitive.
//
// Mirrors `src-tauri/src/commands/journal_scroll.rs`. The Journal Scroll
// feed itself only ever uses `all` and `folder` (driven by the "Anchor
// scope" setting); the remaining variants are used by the right-panel
// sub-panes and wikilink routing.
// ============================================================================

export type PropertyValueJson =
  | string
  | number
  | boolean
  | PropertyValueJson[]
  | null;

export type SortDir = "asc" | "desc";

export type ScrollFilter =
  | { kind: "all" }
  | { kind: "folder"; path: string; recursive: boolean }
  | { kind: "property_eq"; name: string; value: PropertyValueJson }
  | { kind: "property_any"; name: string }
  | { kind: "linked_from"; source: string }
  | { kind: "linked_to"; target: string };

export type ScrollSort =
  | { kind: "property"; name: string; direction: SortDir }
  | { kind: "title"; direction: SortDir }
  | { kind: "zid"; direction: SortDir };

export interface ScrollQuery {
  filter: ScrollFilter;
  sort: ScrollSort;
  anchor: string;
  /** Signed offset relative to the anchor in the sorted result. */
  offset: number;
  limit: number;
}

export interface ScrollEntry {
  path: string;
  title: string;
}

/** @deprecated use `ScrollEntry` directly. */
export type JournalScrollEntry = ScrollEntry;

/** Connection of an entry to the scroll's anchor. Drives the always-on
 *  `journal-scroll__entry--*` accent-strip CSS classes and the per-entry
 *  header connection icons. */
export interface ConnectionFlags {
  path: string;
  is_anchor: boolean;
  links_to_anchor: boolean;
  linked_from_anchor: boolean;
  shares_tags: boolean;
}

// Agenda — aggregated tasks & dated reminders.

/** One row in the Agenda pane. Mirrors the Rust `AgendaItem`. */
export interface AgendaItem {
  /** Stable per-item id (`<note-path>#note` or `<note-path>#m<idx>`). */
  id: string;
  /** `"note"` (document-level), `"task"` or `"date"` (inline marker). */
  source: "note" | "task" | "date";
  /** Whether this item is a task (has a checkbox) or a pure dated reminder. */
  is_task: boolean;
  note_path: string;
  note_title: string;
  /** Marker body, or the note title for a document-level item. */
  text: string;
  /** ISO `YYYY-MM-DD` due date, when known. For a recurring item this is the
   *  occurrence's own date, not the rule's anchor. */
  date: string | null;
  /** ISO `YYYY-MM-DD` file creation date. */
  created: string | null;
  done: boolean;
  tags: string[];
  zid: string | null;
  /** True when this row is one occurrence of a recurring reminder. */
  recurring: boolean;
  /** `0` for the current/next occurrence (full emphasis), `1, 2, …` for
   *  subsequent upcoming ones (de-emphasized). `null` for non-recurring rows. */
  occurrence_index: number | null;
  /** The repeat rule, for rendering a human summary. `null` when not recurring. */
  recurrence: Recurrence | null;
}

// Search types

export interface SearchResult {
  path: string;
  file_name: string;
  line_number: number;
  line_text: string;
  match_ranges: [number, number][];
  score: number;
  modified_time: number;
  created_time: number;
  context_before: string[];
  context_after: string[];
}

export interface SearchResponse {
  results: SearchResult[];
  total_count: number;
}

/// How a search treats text inside `#annotation[…]` / `#suggestion[…]` marks.
/// Sent verbatim across IPC; mirrors the Rust `AnnotationScope` enum.
///   "all"     — search body prose and annotation text alike (default)
///   "only"    — restrict matches to annotation/suggestion lines
///   "exclude" — hide annotation/suggestion text, search only body prose
export type AnnotationScope = "all" | "only" | "exclude";

export interface ReplaceResult {
  path: string;
  replacements: number;
}

// Creation rules

export interface CreationRule {
  id: string;
  name: string;
  icon_emoji: string;
  scaffold_path: string;
  target_folder: string;
  filename_pattern: string;
  creation_mode: "create" | "create_and_open";
  hotkey: string | null;
  show_in_toolbar: boolean;
  description: string;
  builtin: boolean;
  typst_template: string;
  /** Soft-disabled: hidden from toolbar, palette, and hotkey wiring, but
   *  remains in the settings list so the user can re-enable it. */
  disabled: boolean;
}

export interface CreationResult {
  path: string;
  cursor_offset: number | null;
}

// Bookmarks

export type BookmarkKind =
  | { type: "Note"; data: { path: string; name: string } }
  | { type: "Search"; data: { query: string } }
  | { type: "Heading"; data: { path: string; name: string; heading: string } }
  | { type: "Collection"; data: { path: string; name: string } }
  // A saved Agenda view: a named, JSON-serialized filter snapshot, scoped to
  // the notebox it was created in (its tag/task-list selections don't apply
  // elsewhere). `filter` is a JSON `AgendaFilterSnapshot`.
  | { type: "AgendaView"; data: { name: string; notebox: string; filter: string } };

export interface Bookmark {
  id: string;
  type: string;
  data: Record<string, string>;
}

// Mycelial View — link graph node/edge types are used for BFS neighborhood seeding

export interface FlowNode {
  id: string;
  name: string;
  depth: number;
  direction: "center" | "anchor" | "backlink" | "forward";
}

export interface FlowEdge {
  source: string;
  target: string;
}

/** One note that mentions a term, with context for deep-linking the editor. */
export interface SourceMention {
  path: string;
  name: string;
  snippet: string;
  /** 1-indexed line number. */
  line: number;
  /** Byte offsets of the mention within its line. */
  char_start: number;
  char_end: number;
}

/** An existing page mentioned in notes that haven't linked to it yet. */
export interface LatentLink {
  term: string;
  target_path: string;
  target_name: string;
  score: number;
  is_bigram: boolean;
  mentions: SourceMention[];
}

/** A recurring concept with no page of its own — a candidate new note. */
export interface EmergentConcept {
  term: string;
  score: number;
  is_bigram: boolean;
  mentions: SourceMention[];
}

/** A term the stopword filter suppressed that would otherwise have surfaced as
 *  an emergent concept — shown in the Concept Filtering pane for rescue. */
export interface ExcludedTerm {
  term: string;
  /** Neighborhood notes the term recurs in — the "worth rescuing?" signal. */
  doc_count: number;
  /** "builtin" (bundled EN/FR list — rescue via dictionary) or "user" (the
   *  notebox's mycelial-stopwords.txt — rescue by removing the line). */
  source: "builtin" | "user";
}

export interface MycelialData {
  center: string;
  /** Notes a signal emerged from — inner provenance nodes. */
  source_notes: FlowNode[];
  /** Wikilink neighbors with no signal — the faint outer horizon ring. */
  context_notes: FlowNode[];
  /** Wikilinks among center / source / context notes. */
  context_edges: FlowEdge[];
  latent_links: LatentLink[];
  emergent_concepts: EmergentConcept[];
  /** Terms the stopword filter held back — surfaced for the Concept
   *  Filtering pane so the user can see and rescue them. */
  excluded_terms: ExcludedTerm[];
}

// Bibliography (Phase 6)

export interface BibEntry {
  key: string;
  title: string;
  authors: string[];
  year: string | null;
  entry_type: string;
  zotero_item_key?: string;
  /** True if the source has user notes/annotations attached to this entry. */
  has_notes: boolean;
}

export interface FileCitation {
  key: string;
  title: string | null;
  authors: string[];
  year: string | null;
  entry_type: string | null;
  zotero_item_key?: string;
}

export interface AggregatedCitation {
  key: string;
  title: string | null;
  authors: string[];
  year: string | null;
  entry_type: string | null;
  count: number;
  paths: string[];
  /** Zotero library item key — present only with a Zotero-backed
   *  bibliography; absent (field omitted) otherwise. */
  zotero_item_key?: string | null;
}

// Typst compile pipeline (Phase 1 — reading mode)

export interface TypstFrame {
  /** Raw inline SVG. The frontend renders it via innerHTML so the SVG DOM
   *  is preserved (text remains selectable, links remain clickable). */
  svg: string;
  /** Page dimensions in Typst points (1pt = 1/72 inch). Used to size the
   *  page container so layout doesn't reflow on each compile. */
  width_pt: number;
  height_pt: number;
}

export interface TypstSpan {
  /** Notebox-relative path of the file the span points into. `null` when
   *  Typst couldn't resolve the source — usually a synthesized fragment. */
  path: string | null;
  /** Byte offsets into the file's UTF-8 source. */
  start: number;
  end: number;
  /** 1-based line and column of `start`. `null` when the offset couldn't be
   *  mapped to a source position. For the main note these are shifted back
   *  from compiled-source space to the user's on-disk file by the backend. */
  line: number | null;
  column: number | null;
  /** True when the span points into the note being compiled rather than an
   *  imported file. */
  is_main: boolean;
}

export interface TypstDiagnostic {
  severity: "error" | "warning";
  message: string;
  primary: TypstSpan | null;
  trace: string[];
  hints: string[];
}

export interface TypstCompileResult {
  /** True only on a fully clean compile. Warnings may still be present.
   *  When false, check `recovered`. */
  ok: boolean;
  /** True when the compile failed but error recovery salvaged a degraded
   *  render: `frames` is populated and `diagnostics` lists the real errors. */
  recovered: boolean;
  frames: TypstFrame[];
  diagnostics: TypstDiagnostic[];
}

export interface TypstHtmlResult {
  ok: boolean;
  /** See {@link TypstCompileResult.recovered}: true when `html` was salvaged
   *  by error recovery after a failed compile. */
  recovered: boolean;
  html: string;
  diagnostics: TypstDiagnostic[];
}
