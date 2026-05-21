import { invoke } from "@tauri-apps/api/core";
import { assertNoteboxWritable } from "../stores/notebox";
import type {
  NoteboxInfo,
  NoteboxRegistryEntry,
  NoteboxMoveResult,
  CollectionInfo,
  CollectionData,
  FileTreeNode,
  NoteMetadata,
  LinkInfo,
  PropertyValue,
  CollectionFile,
  SortRule,
  FilterGroup,
  NoteboxIndex,
  UserSettings,
  NoteboxSettings,
  SearchResult,
  SearchResponse,
  ReplaceResult,
  CreationRule,
  CreationResult,
  Bookmark,
  BookmarkKind,
  SnapshotInfo,
  MycelialData,
  PropertyType,
  AgendaItem,
  ConnectionFlags,
  ScrollEntry,
  ScrollFilter,
  ScrollQuery,
  ScrollSort,
  TypstCompileResult,
  TypstHtmlResult,
  BibEntry,
  FileCitation,
  AggregatedCitation,
} from "./types";

export async function getSavedNoteboxPath(): Promise<string | null> {
  return invoke<string | null>("get_saved_notebox_path");
}

export async function openNotebox(path: string): Promise<NoteboxInfo> {
  return invoke<NoteboxInfo>("open_notebox", { path });
}

export async function getNoteboxInfo(): Promise<NoteboxInfo | null> {
  return invoke<NoteboxInfo | null>("get_notebox_info");
}

export async function getNoteboxRegistry(): Promise<NoteboxRegistryEntry[]> {
  return invoke<NoteboxRegistryEntry[]>("get_notebox_registry");
}

export async function registerNotebox(
  path: string,
  displayName?: string,
): Promise<void> {
  return invoke<void>("register_notebox", { path, displayName });
}

export async function updateNoteboxEntry(
  path: string,
  displayName: string,
): Promise<void> {
  return invoke<void>("update_notebox_entry", { path, displayName });
}

export async function removeNoteboxFromRegistry(path: string): Promise<void> {
  return invoke<void>("remove_notebox_from_registry", { path });
}

export async function moveNotebox(
  oldPath: string,
  newPath: string,
): Promise<NoteboxMoveResult> {
  return invoke<NoteboxMoveResult>("move_notebox", { oldPath, newPath });
}

/** Result of seeding a new notebox's `.inkycap/` from an existing one. */
export interface NoteboxSeedResult {
  copied_files: number;
  copied_scaffolds: number;
  /** Non-fatal issues (e.g. an absolute path that no longer resolves was
   *  cleared). Surface these to the user so they can fix them. */
  warnings: string[];
}

/** True when the path has no per-notebox settings yet — used by the "Add
 *  notebox" flow to decide whether to offer the seed-from-existing prompt. */
export async function noteboxHasUserSettings(path: string): Promise<boolean> {
  return invoke<boolean>("notebox_has_user_settings", { path });
}

/** Copy `.inkycap/{settings.json, creation_rules.json, scaffolds/,
 *  property-types.json}` from `sourcePath` into `targetPath`. Refuses if
 *  the target already has a settings file. */
export async function seedNoteboxFromSource(
  targetPath: string,
  sourcePath: string,
): Promise<NoteboxSeedResult> {
  return invoke<NoteboxSeedResult>("seed_notebox_from_source", {
    targetPath,
    sourcePath,
  });
}

export async function listCollections(): Promise<CollectionInfo[]> {
  return invoke<CollectionInfo[]>("list_collections");
}

export async function getCollectionData(
  collectionPath: string,
  viewName: string,
): Promise<CollectionData> {
  return invoke<CollectionData>("get_collection_data", {
    collectionPath,
    viewName,
  });
}

export async function readFileContent(path: string): Promise<string> {
  return invoke<string>("read_file_content", { path });
}

export async function getFileTree(): Promise<FileTreeNode[]> {
  return invoke<FileTreeNode[]>("get_file_tree");
}

export async function getFileMetadata(path: string): Promise<NoteMetadata> {
  return invoke<NoteMetadata>("get_file_metadata", { path });
}

export async function getBacklinks(path: string): Promise<LinkInfo[]> {
  return invoke<LinkInfo[]>("get_backlinks", { path });
}

export async function getForwardLinks(path: string): Promise<LinkInfo[]> {
  return invoke<LinkInfo[]>("get_forward_links", { path });
}

export async function writeFileContent(
  path: string,
  content: string,
): Promise<void> {
  // Block writes after the health monitor has reported the notebox gone —
  // the IPC would fail anyway (target path doesn't resolve), but throwing
  // here surfaces a meaningful error before the round-trip and prevents
  // auto-save loops from hammering the backend.
  assertNoteboxWritable();
  return invoke<void>("write_file_content", { path, content });
}

export async function updateProperty(
  path: string,
  key: string,
  value: PropertyValue,
): Promise<void> {
  return invoke<void>("update_property", { path, key, value });
}

// Collection CRUD

export async function createCollectionFile(
  name: string,
): Promise<CollectionInfo> {
  return invoke<CollectionInfo>("create_collection_file", { name });
}

export async function saveCollectionFile(
  collectionPath: string,
  collectionFile: CollectionFile,
): Promise<void> {
  assertNoteboxWritable();
  return invoke<void>("save_collection_file", { collectionPath, collectionFile });
}

export async function deleteCollectionFile(collectionPath: string): Promise<void> {
  return invoke<void>("delete_collection_file", { collectionPath });
}

export async function renameCollectionFile(
  collectionPath: string,
  newName: string,
): Promise<CollectionInfo> {
  return invoke<CollectionInfo>("rename_collection_file", { collectionPath, newName });
}

export async function getCollectionFile(collectionPath: string): Promise<CollectionFile> {
  return invoke<CollectionFile>("get_collection_file", { collectionPath });
}

// View management

export async function updateViewSort(
  collectionPath: string,
  viewName: string,
  sortRules: SortRule[],
): Promise<void> {
  return invoke<void>("update_view_sort", { collectionPath, viewName, sortRules });
}

export async function updateViewColumns(
  collectionPath: string,
  viewName: string,
  columns: string[],
): Promise<void> {
  return invoke<void>("update_view_columns", { collectionPath, viewName, columns });
}

export async function updateCollectionFilters(
  collectionPath: string,
  viewName: string | null,
  filters: FilterGroup | null,
): Promise<void> {
  return invoke<void>("update_collection_filters", { collectionPath, viewName, filters });
}

export async function addView(
  collectionPath: string,
  viewName: string,
  viewType?: string,
): Promise<void> {
  return invoke<void>("add_view", { collectionPath, viewName, viewType });
}

export async function removeView(
  collectionPath: string,
  viewName: string,
): Promise<void> {
  return invoke<void>("remove_view", { collectionPath, viewName });
}

export async function renameView(
  collectionPath: string,
  oldName: string,
  newName: string,
): Promise<void> {
  return invoke<void>("rename_view", { collectionPath, oldName, newName });
}

export async function getAllPropertyKeys(): Promise<string[]> {
  return invoke<string[]>("get_all_property_keys");
}

/// Distinct values currently used for `key` across the notebox. List values
/// are exploded into individual entries. Used by the list-value picker so
/// users can choose from values they've already committed to elsewhere.
export async function getPropertyValues(key: string): Promise<string[]> {
  return invoke<string[]>("get_property_values", { key });
}

/// Reorder named arguments inside the file's `#note(...)` call so they
/// match `order`. Keys present in the file but missing from `order` are
/// appended in their original relative position.
export async function reorderProperties(
  path: string,
  order: string[],
): Promise<void> {
  return invoke<void>("reorder_properties", { path, order });
}

/// Ordered list of property keys exactly as they appear in the file's
/// `#note(...)` call. Empty when no `#note(...)` exists.
export async function getPropertyOrder(path: string): Promise<string[]> {
  return invoke<string[]>("get_property_order", { path });
}

export async function getNoteboxIndex(): Promise<NoteboxIndex> {
  return invoke<NoteboxIndex>("get_notebox_index");
}

// Property types and bulk tag/property operations

export async function getPropertyTypes(): Promise<Record<string, PropertyType>> {
  return invoke<Record<string, PropertyType>>("get_property_types");
}

export async function setPropertyType(
  key: string,
  ty: PropertyType,
): Promise<void> {
  return invoke<void>("set_property_type", { key, ty });
}

export async function renamePropertyKey(
  oldKey: string,
  newKey: string,
): Promise<void> {
  return invoke<void>("rename_property_key", { oldKey, newKey });
}

export async function deletePropertyKey(key: string): Promise<void> {
  return invoke<void>("delete_property_key", { key });
}

export async function removePropertyFromFile(
  path: string,
  key: string,
): Promise<void> {
  return invoke<void>("remove_property_from_file", { path, key });
}

export async function renameTag(
  oldTag: string,
  newTag: string,
): Promise<void> {
  return invoke<void>("rename_tag", { oldTag, newTag });
}

export async function deleteTag(tag: string): Promise<void> {
  return invoke<void>("delete_tag", { tag });
}

export async function resolveEmbedPath(
  target: string,
): Promise<string | null> {
  return invoke<string | null>("resolve_embed_path", { target });
}

// Link navigation

export async function resolveWikilink(
  target: string,
): Promise<string | null> {
  return invoke<string | null>("resolve_wikilink", { target });
}

export interface HeadingInfo {
  level: number;
  text: string;
  label: string | null;
}

export async function getNoteHeadings(
  path: string,
): Promise<HeadingInfo[]> {
  return invoke<HeadingInfo[]>("get_note_headings", { path });
}

export async function ensureHeadingLabel(
  path: string,
  headingText: string,
): Promise<string | null> {
  return invoke<string | null>("ensure_heading_label", { path, headingText });
}

export async function createNote(
  name: string,
  folder: string,
  scaffoldContent?: string,
): Promise<string> {
  return invoke<string>("create_note", {
    name,
    folder,
    scaffoldContent: scaffoldContent ?? null,
  });
}

export async function getNotePreview(
  path: string,
  maxChars?: number,
): Promise<string> {
  return invoke<string>("get_note_preview", {
    path,
    maxChars: maxChars ?? null,
  });
}

export interface BacklinkContext {
  line: string;
  context_before: string[];
  context_after: string[];
}

export async function getBacklinkContext(
  sourcePath: string,
  targetPath: string,
): Promise<BacklinkContext | null> {
  return invoke<BacklinkContext | null>("get_backlink_context", {
    sourcePath,
    targetPath,
  });
}

export interface OutboundLink {
  target: string;
  path: string;
  name: string;
  resolved: boolean;
  modified_time: number;
  created_time: number;
}

export async function getOutboundLinks(path: string): Promise<OutboundLink[]> {
  return invoke<OutboundLink[]>("get_outbound_links", { path });
}

export interface PotentialLink {
  path: string;
  name: string;
  line: string;
  context_before: string[];
  context_after: string[];
  modified_time: number;
  created_time: number;
}

/// Find notes that mention the current note's name in plain text but
/// don't yet wikilink to it. Mirrors the backend `get_potential_links`
/// command — see `commands::files::get_potential_links` for the matching
/// rules (phrase match on stem, excludes current note + resolved
/// backlinks + lines whose only match is inside a wikilink call).
export async function getPotentialLinks(path: string): Promise<PotentialLink[]> {
  return invoke<PotentialLink[]>("get_potential_links", { path });
}

// Aliases

export interface AliasEntry {
  alias: string;
  note_name: string;
  note_path: string;
}

export async function getAllAliases(): Promise<AliasEntry[]> {
  return invoke<AliasEntry[]>("get_all_aliases");
}

// Settings

export async function getSettings(): Promise<UserSettings> {
  return invoke<UserSettings>("get_settings");
}

export async function updateSettings(settings: UserSettings): Promise<void> {
  return invoke<void>("update_settings", { settings });
}

export async function getNoteboxSettings(): Promise<NoteboxSettings> {
  return invoke<NoteboxSettings>("get_notebox_settings");
}

export async function updateNoteboxSettings(settings: NoteboxSettings): Promise<void> {
  return invoke<void>("update_notebox_settings", { settings });
}

export async function generateZid(): Promise<string> {
  return invoke<string>("generate_zid");
}

/**
 * Query the operating system's accent color, returning `#rrggbb` when a
 * reliable source is available and `null` otherwise. The frontend treats
 * `null` as "Match OS not available on this platform" — typically a Linux
 * desktop other than GNOME 47+ or KDE.
 */
export async function getOsAccentColor(): Promise<string | null> {
  return invoke<string | null>("get_os_accent_color");
}

// Search

export async function noteboxSearch(
  query: string,
  maxResults?: number,
  caseSensitive?: boolean,
  offset?: number,
  useRegex?: boolean,
): Promise<SearchResponse> {
  return invoke<SearchResponse>("notebox_search", {
    query,
    maxResults: maxResults ?? null,
    offset: offset ?? null,
    caseSensitive: caseSensitive ?? null,
    useRegex: useRegex ?? null,
  });
}

export async function searchAndReplace(
  query: string,
  replacement: string,
  filePaths?: string[],
  caseSensitive?: boolean,
  useRegex?: boolean,
): Promise<ReplaceResult[]> {
  return invoke<ReplaceResult[]>("search_and_replace", {
    query,
    replacement,
    filePaths: filePaths ?? null,
    caseSensitive: caseSensitive ?? null,
    useRegex: useRegex ?? null,
  });
}


export async function getAllTags(): Promise<[string, number][]> {
  return invoke<[string, number][]>("get_all_tags");
}

// File operations

export async function createFolder(
  name: string,
  parent: string,
): Promise<string> {
  return invoke<string>("create_folder", { name, parent });
}

export async function renameFile(
  oldPath: string,
  newName: string,
): Promise<string> {
  return invoke<string>("rename_file", { oldPath, newName });
}

export async function renameAndUpdateLinks(
  oldPath: string,
  newName: string,
): Promise<string> {
  return invoke<string>("rename_and_update_links", { oldPath, newName });
}

export async function moveFile(
  oldPath: string,
  newFolder: string,
): Promise<string> {
  return invoke<string>("move_file", { oldPath, newFolder });
}

export async function moveFolder(
  oldPath: string,
  newParent: string,
): Promise<string> {
  return invoke<string>("move_folder", { oldPath, newParent });
}

export async function deleteFile(path: string): Promise<void> {
  return invoke<void>("delete_file", { path });
}

export async function deleteFolder(path: string): Promise<void> {
  return invoke<void>("delete_folder", { path });
}

export async function copyToAttachments(
  filename: string,
  dataBase64: string,
): Promise<string> {
  return invoke<string>("copy_to_attachments", { filename, dataBase64 });
}

/**
 * Copy a file identified by absolute filesystem path into the
 * notebox's attachments folder. Used by drag-drop / paste handlers
 * when the browser gives us a `file://` URL instead of an in-memory
 * File (the usual case on Linux/GNOME when dragging from Nautilus).
 */
export async function copyPathToAttachments(
  sourcePath: string,
): Promise<string> {
  return invoke<string>("copy_path_to_attachments", { sourcePath });
}

/**
 * Open a native file-picker and copy the selected files into the notebox's
 * configured attachments folder. Returns the notebox-root-relative saved
 * paths (empty array if the user cancelled).
 */
export async function pickAndUploadToAttachments(): Promise<string[]> {
  return invoke<string[]>("pick_and_upload_to_attachments");
}

export interface AttachmentMigrationPreview {
  current_folder: string;
  files_to_move: number;
  notes_to_update: number;
  target_exists: boolean;
  target_is_nonempty: boolean;
  target_file_count: number;
  name_conflicts: number;
}

export interface AttachmentMigrationResult {
  files_moved: number;
  notes_updated: number;
  errors: string[];
}

/**
 * Phase C of the portable-paths plan: preview the impact of renaming
 * the attachment folder. Read-only — counts files in the old folder
 * and notes whose source references `/<old>/...`.
 */
export async function previewAttachmentFolderMigration(
  newFolder: string,
): Promise<AttachmentMigrationPreview> {
  return invoke<AttachmentMigrationPreview>(
    "preview_attachment_folder_migration",
    { newFolder },
  );
}

/**
 * Phase C of the portable-paths plan: rename the attachment folder.
 * Moves the on-disk folder, rewrites every path-bearing call across
 * the notebox whose argument starts with `/<old>/`, and persists the
 * updated setting. Confirm before calling — this is destructive.
 */
export async function migrateAttachmentFolder(
  newFolder: string,
): Promise<AttachmentMigrationResult> {
  return invoke<AttachmentMigrationResult>("migrate_attachment_folder", {
    newFolder,
  });
}

/**
 * Read file paths from the system clipboard via wl-paste / xclip.
 * Returns an empty array if the clipboard has no file entries or
 * neither tool is installed. Used by the paste handler when the
 * webview's JS clipboardData has been blocked by cross-origin
 * security (the WebKitGTK case on Linux).
 */
export async function readClipboardFilePaths(): Promise<string[]> {
  return invoke<string[]>("read_clipboard_file_paths");
}

export async function showInExplorer(path: string): Promise<void> {
  return invoke<void>("show_in_explorer", { path });
}

export async function openFileExternally(path: string): Promise<void> {
  return invoke<void>("open_file_externally", { path });
}

// Creation rules

export async function listCreationRules(): Promise<CreationRule[]> {
  return invoke<CreationRule[]>("list_creation_rules");
}

/** Fetch the seeded default for a built-in rule, or null for user rules. */
export async function getDefaultCreationRule(
  ruleId: string,
): Promise<CreationRule | null> {
  return invoke<CreationRule | null>("get_default_creation_rule", { ruleId });
}

export async function saveCreationRule(rule: CreationRule): Promise<void> {
  return invoke<void>("save_creation_rule", { rule });
}

export async function deleteCreationRule(ruleId: string): Promise<void> {
  return invoke<void>("delete_creation_rule", { ruleId });
}

/**
 * Execute a creation rule.
 *
 * Pass `titleOverride` when the rule's filename_pattern is empty — the
 * backend uses it as the filename in that case. When the pattern is
 * non-empty, the override is ignored. Calling without a `titleOverride`
 * for a blank-pattern rule produces a BadRequest("filename-required")
 * error so the UI can prompt the user and retry.
 *
 * Pass `targetFolderOverride` (a notebox-root-relative path; empty string
 * means notebox root) to redirect the rule into a specific folder,
 * regardless of its own `target_folder` or the user's "New note location"
 * preference. This is what the file tree context menu uses to create a
 * note in the right-clicked folder via the New Note rule.
 */
export async function executeCreationRule(
  ruleId: string,
  titleOverride?: string,
  targetFolderOverride?: string,
): Promise<CreationResult> {
  return invoke<CreationResult>("execute_creation_rule", {
    ruleId,
    titleOverride: titleOverride ?? null,
    targetFolderOverride: targetFolderOverride ?? null,
  });
}

export async function listScaffolds(): Promise<string[]> {
  return invoke<string[]>("list_scaffolds");
}

export interface TemplateEntry {
  name: string;
  path: string;
  kind: "scaffold" | "template-file" | "template-package";
}

export async function listScaffoldEntries(): Promise<TemplateEntry[]> {
  return invoke<TemplateEntry[]>("list_scaffold_entries");
}

export async function createScaffold(name: string): Promise<string> {
  return invoke<string>("create_scaffold", { name });
}

export interface ScaffoldInsertResult {
  new_source: string;
  new_cursor_offset: number;
}

export interface InstalledPackage {
  spec: string;
  install_dir: string;
  files_written: number;
}

export async function installTypstPackageBySpec(
  spec: string,
): Promise<InstalledPackage> {
  return invoke<InstalledPackage>("install_typst_package_by_spec", { spec });
}

export async function installTypstPackageFromFile(
  archivePath: string,
  overrideSpec?: string,
): Promise<InstalledPackage> {
  return invoke<InstalledPackage>("install_typst_package_from_file", {
    archivePath,
    overrideSpec: overrideSpec ?? null,
  });
}

export interface InstalledPackageEntry {
  namespace: string;
  name: string;
  version: string;
  spec: string;
  install_dir: string;
  kind: "template" | "library";
  description: string | null;
}

export async function listInstalledPackages(): Promise<InstalledPackageEntry[]> {
  return invoke<InstalledPackageEntry[]>("list_installed_packages");
}

export async function uninstallTypstPackage(spec: string): Promise<void> {
  return invoke<void>("uninstall_typst_package", { spec });
}

export interface CreatedPackage {
  spec: string;
  install_dir: string;
  entrypoint_path: string;
}

export async function createLocalPackage(
  spec: string,
  asTemplate: boolean,
): Promise<CreatedPackage> {
  return invoke<CreatedPackage>("create_local_package", { spec, asTemplate });
}

export async function prepareScaffoldInsert(args: {
  scaffoldName: string;
  currentSource: string;
  title: string;
  cursorOffset: number;
  selectionFrom?: number;
  selectionTo?: number;
}): Promise<ScaffoldInsertResult> {
  return invoke<ScaffoldInsertResult>("prepare_scaffold_insert", {
    scaffoldName: args.scaffoldName,
    currentSource: args.currentSource,
    title: args.title,
    cursorOffset: args.cursorOffset,
    selectionFrom: args.selectionFrom ?? null,
    selectionTo: args.selectionTo ?? null,
  });
}

// Bookmarks

export async function listBookmarks(): Promise<Bookmark[]> {
  return invoke<Bookmark[]>("list_bookmarks");
}

export async function addBookmark(kind: BookmarkKind): Promise<string> {
  return invoke<string>("add_bookmark", { kind });
}

export async function removeBookmark(bookmarkId: string): Promise<boolean> {
  return invoke<boolean>("remove_bookmark", { bookmarkId });
}

export async function reorderBookmarks(
  fromIndex: number,
  toIndex: number,
): Promise<void> {
  return invoke<void>("reorder_bookmarks", { fromIndex, toIndex });
}

// Snapshots / Recovery

export async function createSnapshot(
  filePath: string,
  content: string,
): Promise<boolean> {
  return invoke<boolean>("create_snapshot", { filePath, content });
}

export async function listSnapshots(
  filePath: string,
): Promise<SnapshotInfo[]> {
  return invoke<SnapshotInfo[]>("list_snapshots", { filePath });
}

export async function restoreSnapshot(
  filePath: string,
  hash: string,
): Promise<string> {
  return invoke<string>("restore_snapshot", { filePath, hash });
}

export async function previewSnapshot(
  filePath: string,
  hash: string,
  maxChars?: number,
): Promise<string> {
  return invoke<string>("preview_snapshot", {
    filePath,
    hash,
    maxChars: maxChars ?? null,
  });
}

// Mycelial View

export async function getMycelialData(
  path: string,
  maxDepth?: number,
): Promise<MycelialData> {
  return invoke<MycelialData>("get_mycelial_data", {
    path,
    maxDepth: maxDepth ?? null,
  });
}

export async function addMycelialStopword(term: string): Promise<void> {
  return invoke<void>("add_mycelial_stopword", { term });
}

// Note Composer

export async function mergeNotes(
  paths: string[],
  targetPath: string,
  deleteSources?: boolean,
): Promise<string> {
  return invoke<string>("merge_notes", {
    paths,
    targetPath,
    deleteSources: deleteSources ?? false,
  });
}

export async function splitNote(
  path: string,
  heading: string,
): Promise<string> {
  return invoke<string>("split_note", { path, heading });
}

// Export

export async function exportNotePdf(
  path: string,
  includeBibliography?: boolean,
): Promise<number[]> {
  return invoke<number[]>("export_note_pdf", {
    path,
    includeBibliography: includeBibliography ?? null,
  });
}

/// PDF standard presets for native Typst PDF export. Mirrors `PdfStandardPreset`
/// on the Rust side (kebab-case serde).
export type PdfStandardPreset = "standard" | "pdf-a4" | "pdf-ua1";

export async function exportNotePdfToFile(
  path: string,
  outputPath: string,
  metadataMode: string = "exclude",
  pdfStandard?: PdfStandardPreset,
  includeBibliography?: boolean,
): Promise<void> {
  return invoke<void>("export_note_pdf_to_file", {
    path,
    outputPath,
    metadataMode,
    pdfStandard: pdfStandard ?? null,
    includeBibliography: includeBibliography ?? null,
  });
}

export async function exportSelfContainedTyp(
  path: string,
  outputPath: string,
): Promise<void> {
  return invoke<void>("export_self_contained_typ", { path, outputPath });
}

export async function exportNoteHtml(
  path: string,
  outputPath: string,
  metadataMode: string = "exclude",
  stripWikilinks: boolean = false,
  includeBibliography?: boolean,
): Promise<void> {
  return invoke<void>("export_note_html", {
    path,
    outputPath,
    metadataMode,
    stripWikilinks,
    includeBibliography: includeBibliography ?? null,
  });
}

export async function exportCollectionNotePdf(
  notePath: string,
  collectionPath: string,
  outputPath: string,
  metadataMode?: string,
  pdfStandard?: PdfStandardPreset,
  includeBibliography?: boolean,
): Promise<void> {
  return invoke<void>("export_collection_note_pdf", {
    notePath,
    collectionPath,
    outputPath,
    metadataMode: metadataMode ?? null,
    pdfStandard: pdfStandard ?? null,
    includeBibliography: includeBibliography ?? null,
  });
}

export async function exportCollectionBatchPdf(
  collectionPath: string,
  viewName: string,
  outputDir: string,
  metadataMode?: string,
  pdfStandard?: PdfStandardPreset,
  includeBibliography?: boolean,
): Promise<string[]> {
  return invoke<string[]>("export_collection_batch_pdf", {
    collectionPath,
    viewName,
    outputDir,
    metadataMode: metadataMode ?? null,
    pdfStandard: pdfStandard ?? null,
    includeBibliography: includeBibliography ?? null,
  });
}

/// Page-numbering schemes for the merged book export. Mirrors
/// `BookPageNumbering` on the Rust side — serde tags the variant on `style`.
export type BookPageNumbering =
  | { style: "arabic" }
  | { style: "arabic_from_chapters" }
  | { style: "roman_then_arabic" }
  | { style: "arabic_from_page"; start_page: number };

export type InjectChapterHeading = "always" | "fallback" | "never";
export type BookWikilinkMode = "internal" | "external" | "plain";

/// Per-export overrides accepted by `export_collection_book_pdf`. Any field
/// left undefined falls back to the collection's stored `book:` block, then
/// to defaults. Field names match the Rust struct (camelCase via serde).
export interface BookExportOverrides {
  title?: string | null;
  subtitle?: string | null;
  author?: string | null;
  date?: string | null;
  abstract?: string | null;
  tocDepth?: number;
  numberChapters?: boolean;
  injectChapterHeading?: InjectChapterHeading;
  wikilinkMode?: BookWikilinkMode;
  includeTitlePage?: boolean;
  includeOutline?: boolean;
  pageNumbering?: BookPageNumbering;
  pdfStandard?: PdfStandardPreset;
  /// When `false`, the merged PDF compiles with citation resolution intact
  /// but the rendered bibliography is suppressed via a Typst show rule.
  /// Defaults to `true` when omitted.
  includeBibliography?: boolean;
}

export async function exportCollectionBookPdf(
  collectionPath: string,
  viewName: string,
  outputPath: string,
  overrides?: BookExportOverrides,
): Promise<string> {
  return invoke<string>("export_collection_book_pdf", {
    collectionPath,
    viewName,
    outputPath,
    overrides: overrides ?? null,
  });
}

/// Result of a notebox-wide audit of `.typ` files for InkyCap compatibility.
/// Mirrors the `TypAuditReport` struct on the Rust side.
export interface TypAuditReport {
  totalScanned: number;
  /// Notebox-relative paths missing the inkycap-notebox `#import`.
  missingImport: string[];
  /// Notebox-relative paths missing a top-level `#note(...)` call.
  missingNote: string[];
}

export interface TypRepairSummary {
  repaired: string[];
  errors: string[];
}

export async function auditTypFiles(): Promise<TypAuditReport> {
  return invoke<TypAuditReport>("audit_typ_files");
}

export async function repairTypFiles(paths: string[]): Promise<TypRepairSummary> {
  return invoke<TypRepairSummary>("repair_typ_files", { paths });
}

export async function exportCollectionStaticSite(
  collectionPath: string,
  viewName: string,
  outputDir: string,
): Promise<string[]> {
  return invoke<string[]>("export_collection_static_site", {
    collectionPath,
    viewName,
    outputDir,
  });
}

export async function exportCollectionCsv(
  collectionPath: string,
  viewName: string,
): Promise<string> {
  return invoke<string>("export_collection_csv", { collectionPath, viewName });
}

export async function exportCollectionCsvToFile(
  collectionPath: string,
  viewName: string,
  outputPath: string,
  delimiter?: "comma" | "tab",
): Promise<void> {
  return invoke<void>("export_collection_csv_to_file", {
    collectionPath,
    viewName,
    outputPath,
    delimiter: delimiter ?? null,
  });
}

export async function detectPandoc(): Promise<string | null> {
  return invoke<string | null>("detect_pandoc");
}

export async function exportViaPandoc(
  path: string,
  outputPath: string,
  format: string,
  metadataMode: string = "exclude",
): Promise<void> {
  return invoke<void>("export_via_pandoc", { path, outputPath, format, metadataMode });
}

export async function exportFigures(
  path: string,
  outputDir: string,
): Promise<string[]> {
  return invoke<string[]>("export_figures", { path, outputDir });
}

// Typst compile pipeline (Phase 1 — reading mode)

/**
 * Compile a `.typ` note to per-page SVG. `path` may be notebox-relative or
 * absolute; the backend canonicalizes against the open notebox root and
 * rejects anything that escapes the sandbox. The result includes any
 * diagnostics — warnings may be present even on success.
 */
export async function compileTypstSvg(path: string): Promise<TypstCompileResult> {
  return invoke<TypstCompileResult>("compile_typst_svg", { path });
}

export async function compileTypstHtml(path: string): Promise<TypstHtmlResult> {
  return invoke<TypstHtmlResult>("compile_typst_html", { path });
}

// Bibliography (Phase 6)

export async function getBibliographyEntries(): Promise<BibEntry[]> {
  return invoke<BibEntry[]>("get_bibliography_entries");
}

export async function getFileCitations(path: string): Promise<FileCitation[]> {
  return invoke<FileCitation[]>("get_file_citations", { path });
}

export async function aggregateCitations(
  paths: string[],
): Promise<AggregatedCitation[]> {
  return invoke<AggregatedCitation[]>("aggregate_citations", { paths });
}

export async function refreshBibliography(): Promise<string | null> {
  return invoke<string | null>("refresh_bibliography");
}

export async function detectZoteroPath(): Promise<string | null> {
  return invoke<string | null>("detect_zotero_path");
}

export interface RefNote {
  content: string;
}

export async function getReferenceNotes(key: string): Promise<RefNote[]> {
  return invoke<RefNote[]>("get_reference_notes", { key });
}

export async function getBibliographySkipCount(): Promise<number> {
  return invoke<number>("get_bibliography_skip_count");
}

// Font discovery

export async function listSystemFonts(): Promise<string[]> {
  return invoke<string[]>("list_system_fonts");
}

export async function systemFontDefaults(): Promise<{
  sans: string;
  serif: string;
  mono: string;
}> {
  return invoke("system_font_defaults");
}

// Markdown conversion

export async function convertMarkdownToTypst(
  markdown: string,
  includePreamble: boolean,
): Promise<string> {
  return invoke<string>("convert_markdown_to_typst", {
    markdown,
    includePreamble,
  });
}

export async function pasteMarkdownAsTypst(): Promise<string | null> {
  return invoke<string | null>("paste_markdown_as_typst");
}

export interface ImportResult {
  notes_converted: number;
  files_copied: number;
  errors: string[];
}

export type MarkdownDialect = "standard" | "obsidian";

export async function importMarkdownNotebox(
  sourcePath: string,
  targetPath: string,
  dialect: MarkdownDialect | null = null,
): Promise<ImportResult> {
  return invoke<ImportResult>("import_markdown_notebox", {
    sourcePath,
    targetPath,
    dialect,
  });
}

/// Probe a source notebox and return the dialect the importer would use
/// by default ("obsidian" if an `.obsidian/` folder is present in the
/// source, otherwise "standard"). Used by the import dialog to
/// preselect its dialect toggle.
export async function detectMarkdownDialect(
  sourcePath: string,
): Promise<MarkdownDialect> {
  return invoke<MarkdownDialect>("detect_markdown_dialect", { sourcePath });
}

export type UnconvertibleMode = "preserve" | "omit";

export async function exportNoteMarkdownToFile(
  path: string,
  outputPath: string,
  unconvertibleMode: UnconvertibleMode,
): Promise<void> {
  return invoke<void>("export_note_markdown_to_file", {
    path,
    outputPath,
    unconvertibleMode,
  });
}

export async function exportCollectionBatchMarkdown(
  collectionPath: string,
  viewName: string,
  outputDir: string,
  unconvertibleMode: UnconvertibleMode,
): Promise<string[]> {
  return invoke<string[]>("export_collection_batch_markdown", {
    collectionPath,
    viewName,
    outputDir,
    unconvertibleMode,
  });
}

// Journal Scroll

export async function runScrollQuery(
  query: ScrollQuery,
): Promise<ScrollEntry[]> {
  return invoke<ScrollEntry[]>("run_scroll_query", { query });
}

export async function computeConnectionFlags(
  anchor: string,
  paths: string[],
): Promise<ConnectionFlags[]> {
  return invoke<ConnectionFlags[]>("compute_connection_flags", {
    anchor,
    paths,
  });
}

export async function findOffsetInScrollQuery(query: {
  filter: ScrollFilter;
  sort: ScrollSort;
  anchor: string;
  target: string;
}): Promise<number | null> {
  return invoke<number | null>("find_offset_in_scroll_query", { query });
}

// Agenda

/** Notebox-wide agenda — every task / dated item across all notes. */
export async function getAgendaItems(): Promise<AgendaItem[]> {
  return invoke<AgendaItem[]>("get_agenda_items");
}

/** Collection-scoped agenda — tasks / dated items for one collection view. */
export async function getCollectionAgenda(
  collectionPath: string,
  viewName: string,
): Promise<AgendaItem[]> {
  return invoke<AgendaItem[]>("get_collection_agenda", {
    collectionPath,
    viewName,
  });
}

// Backup

/** Persisted "last run" info for the backup feature. Mirrors the
 *  Rust `BackupState`. All fields optional/zero when no backup has
 *  ever run. */
export interface BackupState {
  /** Unix-epoch seconds of the last successful backup, or 0 if never. */
  last_success_unix: number;
  /** Frontend-canonical path of the most recent archive. */
  last_archive_path: string | null;
  /** Human-readable summary of the most recent attempt. */
  last_status: string | null;
}

/** Summary returned on a successful backup run. */
export interface BackupReport {
  archive_path: string;
  file_count: number;
  uncompressed_bytes: number;
  pruned: number;
  encrypted: boolean;
  timestamp_unix: number;
}

/** Run a backup immediately. Throws if no notebox is open, the
 *  destination isn't configured, or the archive write fails. */
export async function backupNow(): Promise<BackupReport | null> {
  return invoke<BackupReport | null>("backup_now");
}

/** Read the persisted "last backup" record. */
export async function getBackupState(): Promise<BackupState> {
  return invoke<BackupState>("get_backup_state");
}

/** Store a password in the OS keychain. Throws on empty input or
 *  keychain unavailability. */
export async function setBackupPassword(password: string): Promise<void> {
  return invoke<void>("set_backup_password", { password });
}

/** Wipe the stored password from the OS keychain. Idempotent. */
export async function clearBackupPassword(): Promise<void> {
  return invoke<void>("clear_backup_password");
}

/** True when a password is currently in the OS keychain. Used by the
 *  settings UI to show whether encryption is fully wired up — we never
 *  fetch the secret itself for display. */
export async function hasBackupPassword(): Promise<boolean> {
  return invoke<boolean>("has_backup_password");
}

/** One archive in the destination folder. */
export interface BackupEntry {
  path: string;
  name: string;
  size_bytes: number;
  mtime_unix: number;
}

/** One file/folder inside a backup archive. */
export interface BackupContentEntry {
  path_in_zip: string;
  is_dir: boolean;
  size_bytes: number;
  encrypted: boolean;
}

/** Conflict resolution when a restored file would land on top of an
 *  existing one. `skip` is the safe default — the existing file is
 *  preserved and the restored copy is dropped. */
export type RestoreConflictPolicy = "skip" | "overwrite" | "rename";

/** Per-file result of a restore operation. `outcome` is one of
 *  `"written"`, `"skipped"`, or `"renamed"`. */
export interface RestoreResult {
  dest_path: string;
  outcome: string;
}

/** Enumerate archives in the configured destination folder. Returns
 *  an empty list when the destination isn't set or doesn't exist. */
export async function listBackupArchives(): Promise<BackupEntry[]> {
  return invoke<BackupEntry[]>("list_backup_archives");
}

/** Open one archive and return its entry list. Encrypted entries
 *  are surfaced with `encrypted: true`; the password is not needed
 *  just to list. */
export async function listBackupContents(archivePath: string): Promise<BackupContentEntry[]> {
  return invoke<BackupContentEntry[]>("list_backup_contents", { archivePath });
}

/** Pull selected entries out of an archive into `targetRoot`. The
 *  password (if needed) is fetched from the OS keychain — callers
 *  don't pass it through. */
export async function restoreBackupFiles(
  archivePath: string,
  targetRoot: string,
  entries: string[],
  conflict: RestoreConflictPolicy,
): Promise<RestoreResult[]> {
  return invoke<RestoreResult[]>("restore_backup_files", {
    archivePath,
    targetRoot,
    entries,
    conflict,
  });
}
