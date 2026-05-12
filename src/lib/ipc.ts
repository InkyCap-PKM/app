import { invoke } from "@tauri-apps/api/core";
import type {
  VaultInfo,
  VaultRegistryEntry,
  VaultMoveResult,
  CollectionInfo,
  CollectionData,
  FileTreeNode,
  NoteMetadata,
  LinkInfo,
  PropertyValue,
  CollectionFile,
  SortRule,
  FilterGroup,
  VaultIndex,
  UserSettings,
  SearchResult,
  ReplaceResult,
  CreationRule,
  CreationResult,
  Bookmark,
  BookmarkKind,
  SnapshotInfo,
  FlowData,
  PropertyType,
  JournalScrollEntry,
  TypstCompileResult,
  TypstHtmlResult,
  BibEntry,
  FileCitation,
} from "./types";

export async function getSavedVaultPath(): Promise<string | null> {
  return invoke<string | null>("get_saved_vault_path");
}

export async function openVault(path: string): Promise<VaultInfo> {
  return invoke<VaultInfo>("open_vault", { path });
}

export async function getVaultInfo(): Promise<VaultInfo | null> {
  return invoke<VaultInfo | null>("get_vault_info");
}

export async function getVaultRegistry(): Promise<VaultRegistryEntry[]> {
  return invoke<VaultRegistryEntry[]>("get_vault_registry");
}

export async function registerVault(
  path: string,
  displayName?: string,
): Promise<void> {
  return invoke<void>("register_vault", { path, displayName });
}

export async function updateVaultEntry(
  path: string,
  displayName: string,
): Promise<void> {
  return invoke<void>("update_vault_entry", { path, displayName });
}

export async function removeVaultFromRegistry(path: string): Promise<void> {
  return invoke<void>("remove_vault_from_registry", { path });
}

export async function moveVault(
  oldPath: string,
  newPath: string,
): Promise<VaultMoveResult> {
  return invoke<VaultMoveResult>("move_vault", { oldPath, newPath });
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
  folder: string,
): Promise<CollectionInfo> {
  return invoke<CollectionInfo>("create_collection_file", { name, folder });
}

export async function saveCollectionFile(
  collectionPath: string,
  collectionFile: CollectionFile,
): Promise<void> {
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
): Promise<void> {
  return invoke<void>("add_view", { collectionPath, viewName });
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

/// Distinct values currently used for `key` across the vault. List values
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

export async function getVaultIndex(): Promise<VaultIndex> {
  return invoke<VaultIndex>("get_vault_index");
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

export async function getBacklinkContext(
  sourcePath: string,
  targetPath: string,
): Promise<string | null> {
  return invoke<string | null>("get_backlink_context", { sourcePath, targetPath });
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

export async function vaultSearch(
  query: string,
  maxResults?: number,
  caseSensitive?: boolean,
): Promise<SearchResult[]> {
  return invoke<SearchResult[]>("vault_search", {
    query,
    maxResults: maxResults ?? null,
    caseSensitive: caseSensitive ?? null,
  });
}

export async function searchAndReplace(
  query: string,
  replacement: string,
  filePaths?: string[],
  caseSensitive?: boolean,
): Promise<ReplaceResult[]> {
  return invoke<ReplaceResult[]>("search_and_replace", {
    query,
    replacement,
    filePaths: filePaths ?? null,
    caseSensitive: caseSensitive ?? null,
  });
}


export async function getAllTags(): Promise<[string, number][]> {
  return invoke<[string, number][]>("get_all_tags");
}

// File operations

export async function createFile(
  name: string,
  folder: string,
): Promise<string> {
  return invoke<string>("create_file", { name, folder });
}

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
 * vault's attachments folder. Used by drag-drop / paste handlers
 * when the browser gives us a `file://` URL instead of an in-memory
 * File (the usual case on Linux/GNOME when dragging from Nautilus).
 */
export async function copyPathToAttachments(
  sourcePath: string,
): Promise<string> {
  return invoke<string>("copy_path_to_attachments", { sourcePath });
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

export async function saveCreationRule(rule: CreationRule): Promise<void> {
  return invoke<void>("save_creation_rule", { rule });
}

export async function deleteCreationRule(ruleId: string): Promise<void> {
  return invoke<void>("delete_creation_rule", { ruleId });
}

export async function executeCreationRule(ruleId: string): Promise<CreationResult> {
  return invoke<CreationResult>("execute_creation_rule", { ruleId });
}

export async function listScaffolds(): Promise<string[]> {
  return invoke<string[]>("list_scaffolds");
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

// Flow View

export async function getFlowData(
  path: string,
  maxDepth?: number,
): Promise<FlowData> {
  return invoke<FlowData>("get_flow_data", {
    path,
    maxDepth: maxDepth ?? null,
  });
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

/// Result of a vault-wide audit of `.typ` files for InkyCap compatibility.
/// Mirrors the `TypAuditReport` struct on the Rust side.
export interface TypAuditReport {
  totalScanned: number;
  /// Vault-relative paths missing the inkycap-vault `#import`.
  missingImport: string[];
  /// Vault-relative paths missing a top-level `#note(...)` call.
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
 * Compile a `.typ` note to per-page SVG. `path` may be vault-relative or
 * absolute; the backend canonicalizes against the open vault root and
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

export async function importMarkdownVault(
  sourcePath: string,
  targetPath: string,
): Promise<ImportResult> {
  return invoke<ImportResult>("import_markdown_vault", {
    sourcePath,
    targetPath,
  });
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

export async function getJournalScrollFiles(
  anchorPath: string,
  mode: string,
  config: { date_sort?: string; tree_scope?: string },
  offset: number,
  limit: number,
): Promise<JournalScrollEntry[]> {
  return invoke<JournalScrollEntry[]>("get_journal_scroll_files", {
    anchorPath,
    mode,
    config,
    offset,
    limit,
  });
}
