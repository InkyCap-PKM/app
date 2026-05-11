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

export interface VaultInfo {
  path: string;
  name: string;
  file_count: number;
  collection_count: number;
  property_keys: string[];
}

export interface VaultRegistryEntry {
  path: string;
  display_name: string;
  last_opened: number;
}

export interface VaultMoveResult {
  new_path: string;
  was_active: boolean;
}

export interface CollectionInfo {
  name: string;
  path: string;
  view_count: number;
  icon: string | null;
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
}

export interface LinkInfo {
  path: string;
  name: string;
}

// .collection file editing types (mirror Rust structs)

export interface SortRule {
  property: string;
  direction: "ASC" | "DESC";
}

export interface FilterGroup {
  and?: string[];
  or?: string[];
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

export interface VaultIndex {
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
  book?: BookExportConfig | null;
  metadata?: Record<string, string> | null;
  filters?: FilterGroup | null;
  formulas?: Record<string, string> | null;
  summaries?: Record<string, string> | null;
  views: ViewDef[];
}

/// Persistent "Export as book" configuration. Mirrors the Rust
/// `BookExportConfig`. All fields optional; defaults are supplied when
/// missing (see `BookExportOverrides` in `ipc.ts`).
export interface BookExportConfig {
  title?: string | null;
  subtitle?: string | null;
  author?: string | null;
  date?: string | null;
  abstract?: string | null;
  toc_depth?: number | null;
  number_chapters?: boolean | null;
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
}

// User settings (mirrors Rust UserSettings struct)

export interface EditorSettings {
  font_size: number;
  body_font_family: string;
  body_font_size: number;
  readable_line_length: boolean;
  max_line_width: number;
  spellcheck: boolean;
  auto_pair_brackets: boolean;
  auto_pair_typst: boolean;
  smart_indent_lists: boolean;
  strict_line_breaks: boolean;
  default_editing_mode: "source" | "live-preview";
  default_reading_format: "svg" | "html";
  show_inline_wikilinks: boolean;
  show_inline_tags: boolean;
  focus_mode: "none" | "line" | "section";
  focus_dim: boolean;
  verse_font: string | null;
  auto_expand_markup: boolean;
  apply_verse_font_to_output: boolean;
}

export type AccentSource = "default" | "custom" | "os";
export type BgPalette = "default" | "warm";
export type ZoomTarget = "content" | "interface" | "both";

export interface AppearanceSettings {
  theme: "dark" | "light" | "system";
  /**
   * Background palette:
   * - "default" — cool gray (light) / teal-ink (dark).
   * - "warm"    — coffee beige (light) / warm charcoal (dark).
   */
  bg_palette: BgPalette;
  /**
   * Where the accent color comes from:
   * - "default" — InkyCap's built-in accent (#1D7874). `accent_color` is ignored.
   * - "custom"  — the value in `accent_color` is used.
   * - "os"      — the operating-system accent is queried at runtime; falls back
   *               to default when unavailable.
   */
  accent_source: AccentSource;
  accent_color: string;
  interface_font: string;
  monospace_font: string;
  zoom_target: ZoomTarget;
}

export interface FileSettings {
  new_note_location: "root" | "current" | "specified";
  new_note_folder: string;
  attachment_folder: string;
  excluded_files_regex: string[];
  auto_update_links_on_rename: boolean;
  scaffold_folder: string;
  typst_templates_folder: string;
  confirm_before_delete: boolean;
}

export interface CitationSettings {
  source: "file" | "zotero";
  bibliography_path: string | null;
  citation_style: string | null;
  custom_csl_path: string | null;
  zotero_database_path: string | null;
}

export interface StartupSettings {
  behavior: "last-file" | "creation-rule" | "specific-page";
  target: string;
  last_active_file: string | null;
}

export interface JournalScrollSettings {
  date_sort: "created" | "modified" | "zid";
  tree_scope: "folder" | "recursive";
}

export interface ExportSettings {
  pandoc_path: string | null;
}

export interface DocumentDefaults {
  text_font: string | null;
  text_size: number | null;
  page_size: string | null;
}

export interface UserSettings {
  editor: EditorSettings;
  appearance: AppearanceSettings;
  files: FileSettings;
  startup: StartupSettings;
  journal_scroll: JournalScrollSettings;
  citations: CitationSettings;
  export: ExportSettings;
  document: DocumentDefaults;
}

export interface JournalScrollEntry {
  path: string;
  title: string;
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

// Snapshots / Recovery

export interface SnapshotInfo {
  hash: string;
  timestamp: string;
  size: number;
}

// Flow View

export interface FlowNode {
  id: string;
  name: string;
  depth: number;
  direction: "center" | "backlink" | "forward";
}

export interface FlowEdge {
  source: string;
  target: string;
}

export interface FlowData {
  nodes: FlowNode[];
  edges: FlowEdge[];
  center: string;
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
  /** Vault-relative path of the file the span points into. `null` when
   *  Typst couldn't resolve the source — usually a synthesized fragment. */
  path: string | null;
  /** Byte offsets into the file's UTF-8 source. */
  start: number;
  end: number;
}

export interface TypstDiagnostic {
  severity: "error" | "warning";
  message: string;
  primary: TypstSpan | null;
  trace: string[];
  hints: string[];
}

export interface TypstCompileResult {
  /** True if a paged document was produced. Warnings may be present even
   *  on success; on failure, `frames` is empty. */
  ok: boolean;
  frames: TypstFrame[];
  diagnostics: TypstDiagnostic[];
}

export interface TypstHtmlResult {
  ok: boolean;
  html: string;
  diagnostics: TypstDiagnostic[];
}
