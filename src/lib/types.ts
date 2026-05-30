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
}

export interface LinkInfo {
  path: string;
  name: string;
  /** Unix epoch seconds. Zero if the backend couldn't stat the file. */
  modified_time: number;
  created_time: number;
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
  page_numbering?:
    | { style: "arabic" }
    | { style: "arabic_from_chapters" }
    | { style: "roman_then_arabic" }
    | { style: "arabic_from_page"; start_page: number }
    | null;
  include_bibliography?: boolean | null;
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
   * How the file tree groups folders relative to files when sorting:
   * - "before" — all folders first, then files (both sorted by the chosen mode).
   * - "after"  — all files first, then folders.
   * - "inline" — folders and files are interleaved together under the chosen sort.
   */
  folder_grouping: FolderGrouping;
  /**
   * Moment-style format pattern for displaying dates in the UI (Agenda due
   * dates, backup timestamps, last-backup indicator, etc.). Does not affect
   * how dates are stored — only their presentation. Tokens match the
   * Zettelkasten ID pattern: YYYY, YY, MMMM, MMM, MM, M, DD, D, HH, mm,
   * ss, dddd, ddd. Any non-token characters are kept verbatim.
   */
  date_format: string;
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

/** What kind of change an incoming item carries. `.typ` notes render as
 *  suggestions (`modified`) or stage whole (`added`); non-note files are
 *  `binary` (whole-file decision, not suggestion-ized). */
export type GitChangeKind = "added" | "modified" | "deleted" | "binary";

/** One incoming change in a review session. */
export interface GitReviewItem {
  /** Notebox-relative (or absolute) path of the working note. */
  path: string;
  kind: GitChangeKind;
  /** Staged copy to open for review (under `.inkycap/incoming/`), when one was
   *  written (`modified`/`added`). `null` for deletes and binary files. */
  stagedPath: string | null;
  /** Suggestions rendered (`modified` only). */
  total: number;
  /** Of those, how many are conflicts needing a hand decision. */
  conflicts: number;
  /** The diff could not be rendered as suggestions; show the raw-diff view. */
  fallback: boolean;
}

/** The result of a fetch-and-review. */
export interface GitReviewSession {
  items: GitReviewItem[];
  /** Incoming tip commit's author/message, for the review banner. */
  incoming: GitCommitInfo | null;
  /** Local already matches the remote tip — nothing to review. */
  upToDate: boolean;
}

/** How the user chose to resolve a conflicted binary (non-`.typ`) file.
 *  Mirrors `commands/git.rs::BinaryDecision`. */
export type GitBinaryDecision = "keepMine" | "takeTheirs" | "keepBoth";

/** Outcome of resolving one binary conflict. Mirrors
 *  `commands/git.rs::BinaryResolution`. */
export interface GitBinaryResolution {
  /** The notebox-relative path that now holds the resolved file. */
  path: string;
  /** For `keepBoth`: the sibling path the incoming copy was written to. */
  addedPath: string | null;
}

/** One incoming change in the post-sync digest ("what landed from others"). */
export interface GitDigestEntry {
  /** Notebox-relative path (frontend string form). */
  path: string;
  status: "added" | "modified" | "deleted";
}

/** Outcome of a Sync / Check for updates / finalize. Mirrors
 *  `src-tauri/src/commands/git.rs::SyncOutcome`. */
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
  /** The merge hit conflicts and is paused: resolve `conflicts` then finalize.
   *  The clean incoming changes have already been applied. */
  paused: boolean;
  /** Conflicted notes/files needing a hand decision. Populated when `paused`. */
  conflicts: GitReviewItem[];
  /** The shared settings.json was edited on both sides and structurally merged;
   *  this lists any same-key clashes still needing a pick. `null` when settings
   *  didn't conflict or merged with no clashes. Populated when `paused`. */
  settingsConflict: GitSettingsConflict | null;
  /** What collaborators changed since the merge base — the "what landed" digest. */
  digest: GitDigestEntry[];
  /** The incoming tip commit's author/message, for the digest banner. */
  incoming: GitCommitInfo | null;
}

/** One key both sides changed differently in settings.json. Mirrors
 *  `git/json_merge.rs::KeyConflict`. `mine`/`theirs` are arbitrary JSON values. */
export interface GitKeyConflict {
  /** Dotted key path, e.g. "citations.zoteroPath". */
  path: string;
  mine: unknown;
  theirs: unknown;
}

/** A structurally-merged settings.json with same-key clashes left to decide.
 *  Mirrors `commands/git.rs::SettingsConflict`. */
export interface GitSettingsConflict {
  /** Notebox-relative path of the settings file. */
  path: string;
  conflicts: GitKeyConflict[];
}

/** Per-key resolution for a settings clash: dotted path → which side to keep. */
export type GitSettingsDecisions = Record<string, "mine" | "theirs">;

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
  /** ISO `YYYY-MM-DD` due date, when known. */
  date: string | null;
  /** ISO `YYYY-MM-DD` file creation date. */
  created: string | null;
  done: boolean;
  tags: string[];
  zid: string | null;
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
  | { type: "Collection"; data: { path: string; name: string } };

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
