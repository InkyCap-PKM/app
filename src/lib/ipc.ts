import { Channel, invoke } from "@tauri-apps/api/core";
import { assertNoteboxWritable } from "../stores/notebox";
import type {
  TabRestore,
  TypstFrame,
  DeepLinkDelivery,
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
  ContributorCatalogs,
  SortRule,
  FilterGroup,
  NoteboxIndex,
  UserSettings,
  ExternalToolResult,
  NoteboxSettings,
  NoteboxTabSession,
  SearchResult,
  SearchResponse,
  ReplaceResult,
  CreationRule,
  CreationResult,
  Bookmark,
  BookmarkKind,
  MycelialData,
  MycelialExclusionInfo,
  PropertyType,
  AgendaItem,
  RecentNote,
  UnwrittenNote,
  Recurrence,
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
  GitStatusSummary,
  GitDigestEntry,
  GitUnresolvedEntry,
  GitSinceSyncEntry,
  GitSyncNoteDiff,
  GitSyncOutcome,
  GitCheckResult,
  GitNoteVersion,
  GitIdentity,
  GitSetupResult,
  GitPackageExportResult,
  GitBundlePackagesResult,
  AnnotationScope,
  TocPlacement,
  BibliographyMode,
  LinkedFilesOptions,
} from "./types";

export async function getSavedNoteboxPath(): Promise<string | null> {
  return invoke<string | null>("get_saved_notebox_path");
}

export async function openNotebox(path: string): Promise<NoteboxInfo> {
  return invoke<NoteboxInfo>("open_notebox", { path });
}

/** Where the documentation window should boot: notebox root + landing note. */
export interface DocsNoteboxLocation {
  root: string;
  index: string | null;
}

/**
 * Resolve the bundled "InkyCap Documentation" notebox, creating it on first
 * use. Returns its root and the note to open first.
 */
export async function openDocumentationNotebox(): Promise<DocsNoteboxLocation> {
  return invoke<DocsNoteboxLocation>("open_documentation_notebox");
}

/** A notebox currently open in some window: its path + the owning window label. */
export interface OpenNoteboxWindow {
  path: string;
  label: string;
}

/**
 * Every notebox open in any window. A notebox can be open in only one window.
 */
export async function listOpenNoteboxes(): Promise<OpenNoteboxWindow[]> {
  return invoke<OpenNoteboxWindow[]>("list_open_noteboxes");
}

/**
 * Check a folder the user wants to add to their notebox list. Rejects one
 * already listed, or one inside or containing another notebox.
 */
export async function validateNoteboxLocation(path: string): Promise<void> {
  return invoke<void>("validate_notebox_location", { path });
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

/**
 * True when `path` is an empty directory or doesn't exist, so it is a safe
 * target for "Clone from remote". An existing notebox has `.inkycap/`, so it
 * returns false.
 */
export async function dirIsEmpty(path: string): Promise<boolean> {
  return invoke<boolean>("dir_is_empty", { path });
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

/** True when the folder already holds a notebox (it has `.inkycap/`). */
export async function noteboxIsExisting(path: string): Promise<boolean> {
  return invoke<boolean>("notebox_is_existing", { path });
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

/** The notes that use the notebox file at `path` (an image, PDF, media or
 *  data file) through `#image`, `#read`, `#bibliography`, `#video` or
 *  `#audio`. */
export async function getAttachmentReferences(path: string): Promise<LinkInfo[]> {
  return invoke<LinkInfo[]>("get_attachment_references", { path });
}

/** Number of pages in the PDF at `path`. */
export async function getPdfPageCount(path: string): Promise<number> {
  return invoke<number>("get_pdf_page_count", { path });
}

/** Page `page` (1-based) of the PDF at `path`, drawn by Typst as SVG. */
export async function renderPdfPage(path: string, page: number): Promise<TypstFrame> {
  return invoke<TypstFrame>("render_pdf_page", { path, page });
}

export async function getForwardLinks(path: string): Promise<LinkInfo[]> {
  return invoke<LinkInfo[]>("get_forward_links", { path });
}

export async function writeFileContent(
  path: string,
  content: string,
): Promise<void> {
  // Refuse writes once the health monitor reports the notebox gone, so
  // auto-save doesn't keep retrying.
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

/** Set or clear (`null`) a note's recurrence rule in `#note(recurrence: …)`. */
export async function setNoteRecurrence(
  path: string,
  recurrence: Recurrence | null,
): Promise<void> {
  return invoke<void>("set_note_recurrence", { path, recurrence });
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

/** Role vocabularies (CRediT + bibliographic) for the contributors editor. */
export async function contributorCatalogs(): Promise<ContributorCatalogs> {
  return invoke<ContributorCatalogs>("contributor_catalogs");
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

export async function updateViewColumnWidths(
  collectionPath: string,
  viewName: string,
  widths: Record<string, number>,
): Promise<void> {
  return invoke<void>("update_view_column_widths", { collectionPath, viewName, widths });
}

export async function updateCollectionFilters(
  collectionPath: string,
  viewName: string | null,
  filters: FilterGroup | null,
): Promise<void> {
  return invoke<void>("update_collection_filters", { collectionPath, viewName, filters });
}

/** Set or clear a single column's header quick filter. `filters: null` clears
 *  that column. Stored separately from the advanced FilterBuilder. */
export async function setCollectionColumnFilter(
  collectionPath: string,
  viewName: string,
  column: string,
  filters: FilterGroup | null,
): Promise<void> {
  return invoke<void>("set_collection_column_filter", {
    collectionPath,
    viewName,
    column,
    filters,
  });
}

/** Clear every column header filter on a view in one write. */
export async function clearCollectionColumnFilters(
  collectionPath: string,
  viewName: string,
): Promise<void> {
  return invoke<void>("clear_collection_column_filters", { collectionPath, viewName });
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

/** Reorder the collection's views to match `orderedNames` (drag-and-drop). */
export async function reorderViews(
  collectionPath: string,
  orderedNames: string[],
): Promise<void> {
  return invoke<void>("reorder_views", { collectionPath, orderedNames });
}

export async function getAllPropertyKeys(): Promise<string[]> {
  return invoke<string[]>("get_all_property_keys");
}

/// Distinct values used for `key` across the notebox, with list values split
/// into entries. Used by the list-value picker.
export async function getPropertyValues(key: string): Promise<string[]> {
  return invoke<string[]>("get_property_values", { key });
}

/// Reorder the named arguments of the file's `#note(...)` call to match
/// `order`. Keys not in `order` keep their relative position at the end.
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

/// The built-in system property keys whose types are fixed and cannot be
/// reassigned. Used by the import mapping dialog to lock the type column.
export async function getSystemPropertyKeys(): Promise<string[]> {
  return invoke<string[]>("get_system_property_keys");
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

/** A standalone `<label>` in a note — one the writer attached to prose, a
 *  figure, or an equation. A heading's own label arrives via `getNoteHeadings`. */
export interface LabelInfo {
  name: string;
  /** The words the label tags, for showing what a link would point at. */
  context: string;
}

export async function getNoteLabels(
  path: string,
): Promise<LabelInfo[]> {
  return invoke<LabelInfo[]>("get_note_labels", { path });
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

/** Plain prose for display. `marks` are the `[start, end)` stretches to
 *  highlight (links to the target note), in UTF-16 code units. */
export interface DisplayText {
  text: string;
  marks: [number, number][];
}

/** One stretch of note text: its Typst source (for copying) and plain prose
 *  for display, shortened with an ellipsis when long. */
export interface PassageText extends DisplayText {
  source: string;
}

/** The text around one wikilink: the paragraph (or list item, or heading plus
 *  the paragraph after it) holding it, and for context the units of writing
 *  just before and after (null at the edges). `snippet` is the short preview:
 *  the sentence holding the link with up to one sentence either side, from
 *  the link's own line (a list item without its sub-items). */
export interface LinkPassage {
  heading: string | null;
  paragraph: PassageText;
  snippet: DisplayText;
  before: PassageText | null;
  after: PassageText | null;
}

/** The passages in `sourcePath` that link to `targetPath`, in document order.
 *  Empty when the source links only from its properties. */
export async function getLinkPassages(
  sourcePath: string,
  targetPath: string,
): Promise<LinkPassage[]> {
  return invoke<LinkPassage[]>("get_link_passages", { sourcePath, targetPath });
}

/** The opening passage of the note at `path` (its first paragraph, list item,
 *  or heading with the paragraph after it), or null when its body is empty. */
export async function getLeadPassage(path: string): Promise<LinkPassage | null> {
  return invoke<LinkPassage | null>("get_lead_passage", { path });
}

/** The passages in the note at `path` whose prose holds `phrase` (as whole
 *  words, ignoring case), in document order, with the phrase marked. */
export async function getPhrasePassages(path: string, phrase: string): Promise<LinkPassage[]> {
  return invoke<LinkPassage[]>("get_phrase_passages", { path, phrase });
}

/** The whole body of the note at `path`, ready to copy into another note:
 *  no `#import` lines, `#note(...)` or `#bibliography(...)` call, and
 *  relative paths rebased to the notebox root. */
export async function getNoteBodyForCopy(path: string): Promise<string> {
  return invoke<string>("get_note_body_for_copy", { path });
}

/** `content` with `sourceName` added to its `derived-from` property, or null
 *  when the property already lists that note. Text in, text out, so an open
 *  note's unsaved changes are kept. */
export async function noteWithDerivedFrom(
  content: string,
  sourceName: string,
): Promise<string | null> {
  return invoke<string | null>("note_with_derived_from", { content, sourceName });
}

/** Lowercase names of the notes `content`'s wikilinks point at. */
export async function wikilinkNames(content: string): Promise<string[]> {
  return invoke<string[]>("wikilink_names", { content });
}

export interface OutboundLink {
  target: string;
  path: string;
  name: string;
  resolved: boolean;
  modified_time: number;
  created_time: number;
  /** The resolved note's `#note(zid:)`, or null (always null when unresolved). */
  zid?: string | null;
}

export async function getOutboundLinks(path: string): Promise<OutboundLink[]> {
  return invoke<OutboundLink[]>("get_outbound_links", { path });
}

export interface PotentialLink {
  path: string;
  name: string;
  line: string;
  /** `[start, end)` stretches of `line` holding the note's name, in UTF-16
   *  code units. */
  marks: [number, number][];
  context_before: string[];
  context_after: string[];
  modified_time: number;
  created_time: number;
  /** The mentioning note's `#note(zid:)`, or null when absent. */
  zid?: string | null;
}

/// Notes that mention this note's name in plain text without linking to it. See
/// `commands::files::get_potential_links` for the matching rules.
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

// Note identifiers

/** A note's `title` and `zid` properties, for finding it by either one. */
export interface NoteIdentifiers {
  path: string;
  title: string | null;
  zid: string | null;
}

/**
 * Title and zid of every note that has one, from the in-memory index. Empty
 * until the index is built.
 */
export async function getNoteIdentifiers(): Promise<NoteIdentifiers[]> {
  return invoke<NoteIdentifiers[]>("get_note_identifiers");
}

/** The note whose `zid` property is `zid` (fewest path components wins when
 *  several share it), or `null`. Always `null` until the index is built. */
export async function findNoteByZid(zid: string): Promise<string | null> {
  return invoke<string | null>("find_note_by_zid", { zid });
}

// Settings

export async function getSettings(): Promise<UserSettings> {
  return invoke<UserSettings>("get_settings");
}

export async function updateSettings(settings: UserSettings): Promise<void> {
  return invoke<void>("update_settings", { settings });
}

/** One discovered declarative-plugin manifest file (raw, unvalidated). */
export interface PluginManifestFile {
  /** Frontend-canonical path of the manifest, for diagnostics. */
  path: string;
  /** Raw JSON contents — the frontend owns parsing + validation. */
  contents: string;
}

/** Discover declarative-plugin manifests (`*.json`) from the user-global and
 *  per-notebox plugins directories. Returns raw files; the caller validates. */
export async function readPluginManifests(): Promise<PluginManifestFile[]> {
  return invoke<PluginManifestFile[]>("read_plugin_manifests");
}

/**
 * Run a registered external tool. The executable is resolved by the backend
 * from `toolId`; `inputText` goes to its stdin and `selection` / `filePath`
 * fill the argument placeholders. Returns its output and how to use it.
 */
export async function runExternalTool(
  toolId: string,
  inputText: string,
  selection: string,
  filePath: string | null,
): Promise<ExternalToolResult> {
  return invoke<ExternalToolResult>("run_external_tool", {
    toolId,
    inputText,
    selection,
    filePath,
  });
}

export async function getNoteboxSettings(): Promise<NoteboxSettings> {
  return invoke<NoteboxSettings>("get_notebox_settings");
}

export async function updateNoteboxSettings(settings: NoteboxSettings): Promise<void> {
  return invoke<void>("update_notebox_settings", { settings });
}

// ───────────────────────── Previous-tab session ─────────────────────────
// For the "Open previous tabs" startup option. Stored per machine, outside the
// notebox.

/**
 * Tabs this machine last had open in this notebox, and whether to hold them
 * back instead of reopening them. A reopen stays marked in progress until
 * cleared with `setTabRestorePending`. Deleted notes are already left out.
 */
export async function startTabRestore(): Promise<TabRestore> {
  return invoke<TabRestore>("start_tab_restore");
}

/** Mark or clear "reopen in progress" for the notebox at `noteboxPath`. */
export async function setTabRestorePending(noteboxPath: string, pending: boolean): Promise<void> {
  return invoke<void>("set_tab_restore_pending", { noteboxPath, pending });
}

/** Record the current notebox's open tabs, replacing the previous record. */
export async function saveNoteboxTabSession(session: NoteboxTabSession): Promise<void> {
  return invoke<void>("save_notebox_tab_session", { session });
}

/** Forget the recorded tabs of every notebox. Needs no notebox to be open. */
export async function clearAllNoteboxTabSessions(): Promise<void> {
  return invoke<void>("clear_all_notebox_tab_sessions");
}

export async function generateZid(): Promise<string> {
  return invoke<string>("generate_zid");
}

// ─────────────────────────── Git collaboration ─────────────────────────────
// All git work runs on a blocking task in the backend.

/**
 * Make the open notebox a collaborative git repo: initialize or adopt it, write
 * `.gitignore`, set `origin`, save the optional sign-in and commit identity, and
 * store the remote and branch (per machine, in local.json). Safe to re-run.
 */
export async function gitSetupCollaboration(args: {
  remote: string;
  branch?: string;
  identityName?: string;
  identityEmail?: string;
  username?: string;
  password?: string;
}): Promise<GitSetupResult> {
  return invoke<GitSetupResult>("git_setup_collaboration", {
    remote: args.remote,
    branch: args.branch ?? null,
    identityName: args.identityName ?? null,
    identityEmail: args.identityEmail ?? null,
    username: args.username ?? null,
    password: args.password ?? null,
  });
}

/**
 * Restore collaboration for a git repo with an `origin` remote but no
 * collaboration config, using the repo's remote and branch.
 */
export async function gitReconnectCollaboration(): Promise<GitSetupResult> {
  return invoke<GitSetupResult>("git_reconnect_collaboration");
}

/** Current git status for the open notebox, or `null` when it is not
 *  collaborative or not yet a repo. */
export async function gitStatus(): Promise<GitStatusSummary | null> {
  return invoke<GitStatusSummary | null>("git_status");
}

/**
 * Files changed since the last share, i.e. what a sync would send. Empty when
 * nothing is pending or the notebox isn't a repo.
 */
export async function gitChangesToShare(): Promise<GitDigestEntry[]> {
  return invoke<GitDigestEntry[]>("git_changes_to_share");
}

/**
 * Notes with unresolved `#suggestion(...)` changes. Empty when there are none
 * or the notebox isn't collaborative.
 */
export async function gitUnresolvedChanges(): Promise<GitUnresolvedEntry[]> {
  return invoke<GitUnresolvedEntry[]>("git_unresolved_changes");
}

/**
 * Notes the last sync changed, compared with the pre-sync baseline, each
 * flagged if the merge took the other side. Empty before the first sync or when
 * it changed nothing.
 */
export async function gitChangesSinceSync(): Promise<GitSinceSyncEntry[]> {
  return invoke<GitSinceSyncEntry[]>("git_changes_since_sync");
}

/**
 * One note's diff against its pre-sync baseline, using the current text, so
 * reverted hunks drop out.
 */
export async function gitNoteSyncDiff(path: string): Promise<GitSyncNoteDiff> {
  return invoke<GitSyncNoteDiff>("git_note_sync_diff", { path });
}

/**
 * Revert one hunk of a note to its pre-sync baseline, by its current line range
 * (from `gitNoteSyncDiff`). Throws BadRequest if the range no longer matches a
 * hunk; refetch the diff.
 */
export async function gitRevertSyncHunk(
  path: string,
  currentStart: number,
  currentEnd: number,
): Promise<void> {
  return invoke<void>("git_revert_sync_hunk", { path, currentStart, currentEnd });
}

/** Revert a whole note to its pre-sync baseline (or delete it when the sync
 *  added it). An ordinary edit the user then re-syncs. */
export async function gitRevertNoteSinceSync(path: string): Promise<void> {
  return invoke<void>("git_revert_note_since_sync", { path });
}

/** The saved sign-in username for a remote, for pre-filling the connect form.
 *  Null when none was saved. */
export async function gitSavedUsername(remote: string): Promise<string | null> {
  return invoke<string | null>("git_saved_username", { remote });
}

/**
 * Stop collaborating: remove the notebox's git config. With `deleteHistory`,
 * also delete `.git` (irreversible). Stored credentials are kept.
 */
export async function gitDisableCollaboration(deleteHistory: boolean): Promise<void> {
  return invoke<void>("git_disable_collaboration", { deleteHistory });
}

/**
 * Clone a collaborative notebox into `dest`, saving the optional sign-in first.
 * Returns the notebox path; the caller registers and opens it.
 */
export async function gitCloneNotebox(args: {
  remote: string;
  branch?: string;
  dest: string;
  username?: string;
  password?: string;
}): Promise<string> {
  return invoke<string>("git_clone_notebox", {
    remote: args.remote,
    branch: args.branch ?? null,
    dest: args.dest,
    username: args.username ?? null,
    password: args.password ?? null,
  });
}

/**
 * Sync the notebox: pull and merge incoming changes, then push. Overlapping
 * edits take the incoming side; they are listed in `conflicted` for review.
 */
export async function gitSync(): Promise<GitSyncOutcome> {
  assertNoteboxWritable();
  return invoke<GitSyncOutcome>("git_sync");
}

/** Read-only check for incoming changes: fetches and reports how far behind the
 *  remote is, **without** pulling files into the notebox. Sync applies them. */
export async function gitCheckUpdates(): Promise<GitCheckResult> {
  return invoke<GitCheckResult>("git_check_updates");
}

/** A note's past versions, newest first (commit metadata only). Empty when the
 *  note has no committed history yet. */
export async function gitNoteHistory(path: string): Promise<GitNoteVersion[]> {
  return invoke<GitNoteVersion[]>("git_note_history", { path });
}

/** A note's UTF-8 content at a past commit, for the read-only version-compare
 *  (diff) view. `commit` is a full hash from `gitNoteHistory`. */
export async function gitNoteVersionText(path: string, commit: string): Promise<string> {
  return invoke<string>("git_note_version_text", { path, commit });
}

/** Restore a past version: write its content back to the working note as a new
 *  edit (then the user Syncs). Non-destructive — history is never rewritten. */
export async function gitRestoreNoteVersion(path: string, commit: string): Promise<void> {
  assertNoteboxWritable();
  return invoke<void>("git_restore_note_version", { path, commit });
}

/** Set the commit identity for this notebox's remote (per-installation store). */
export async function gitSetIdentity(name: string, email: string): Promise<void> {
  return invoke<void>("git_set_identity", { name, email });
}

/** The commit identity configured for this notebox's remote, if any. */
export async function gitGetIdentity(): Promise<GitIdentity | null> {
  return invoke<GitIdentity | null>("git_get_identity");
}

/** The identity InkyCap would stamp on commits (per-notebox choice, else the
 *  git-config fallback) — for pre-filling the identity fields. */
export async function gitDefaultCommitIdentity(): Promise<GitIdentity | null> {
  return invoke<GitIdentity | null>("git_default_commit_identity");
}

// ── Offline package handoff (collaboration without a server) ──
// Export the notebox's git history to one file; the recipient imports it as a
// new notebox or merges it into theirs.

/**
 * Set up the open notebox for collaboration without a remote (history plus
 * package export/import). Stores a git config with an empty remote.
 */
export async function gitSetupPackageHandoff(args: {
  branch?: string;
  identityName?: string;
  identityEmail?: string;
}): Promise<GitSetupResult> {
  return invoke<GitSetupResult>("git_setup_package_handoff", {
    branch: args.branch ?? null,
    identityName: args.identityName ?? null,
    identityEmail: args.identityEmail ?? null,
  });
}

/** Export the open notebox — with its full git history — to a single
 *  (optionally AES-256-encrypted) package file. Commits pending edits first. */
export async function gitExportPackage(
  dest: string,
  password?: string,
): Promise<GitPackageExportResult> {
  assertNoteboxWritable();
  return invoke<GitPackageExportResult>("git_export_package", {
    dest,
    password: password ?? null,
  });
}

/**
 * Import a received package into the open notebox, merging its history as Sync
 * does (without pushing). Overlapping edits take the incoming side and are
 * listed in `conflicted`.
 */
export async function gitImportPackage(
  archive: string,
  password?: string,
): Promise<GitSyncOutcome> {
  assertNoteboxWritable();
  return invoke<GitSyncOutcome>("git_import_package", {
    archive,
    password: password ?? null,
  });
}

/** Import a received package as a brand-new notebox at `dest` (a first-time
 *  recipient). Returns the new notebox path; the caller registers + opens it. */
export async function gitImportPackageAsNotebox(args: {
  archive: string;
  password?: string;
  dest: string;
}): Promise<string> {
  return invoke<string>("git_import_package_as_notebox", {
    archive: args.archive,
    password: args.password ?? null,
    dest: args.dest,
  });
}

/** Whether the open notebox bundles its Typst packages on share (a per-machine
 *  preference; off by default). */
export async function gitGetBundlePackages(): Promise<boolean> {
  return invoke<boolean>("git_get_bundle_packages");
}

/**
 * Set whether the notebox bundles its Typst packages when sharing. Enabling
 * bundles the current packages right away and returns what was bundled and what
 * couldn't be found.
 */
export async function gitSetBundlePackages(
  enabled: boolean,
): Promise<GitBundlePackagesResult> {
  return invoke<GitBundlePackagesResult>("git_set_bundle_packages", { enabled });
}

/**
 * The OS accent colour as `#rrggbb`, or `null` when there's no reliable source
 * (most Linux desktops other than GNOME 47+ and KDE).
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
  annotationScope?: AnnotationScope,
): Promise<SearchResponse> {
  return invoke<SearchResponse>("notebox_search", {
    query,
    maxResults: maxResults ?? null,
    offset: offset ?? null,
    caseSensitive: caseSensitive ?? null,
    useRegex: useRegex ?? null,
    annotationScope: annotationScope ?? null,
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

/**
 * Where an incoming file goes. `targetFolder` is a folder the user dropped
 * onto; every file goes there. Otherwise notes follow the "New note location"
 * setting (`currentNote` supplies its "Current folder") and other files go to
 * the attachments folder. Mirrors the Rust `IncomingPlacement`.
 */
export interface IncomingPlacement {
  targetFolder?: string;
  currentNote?: string;
}

/** Like {@link copyPathIntoNotebox}, for file contents given as base64. */
export async function copyBytesIntoNotebox(
  filename: string,
  dataBase64: string,
  placement?: IncomingPlacement,
): Promise<string> {
  return invoke<string>("copy_bytes_into_notebox", {
    filename,
    dataBase64,
    placement: placement ?? null,
  });
}

/**
 * Copy a file, by absolute path, into the notebox per `placement` (see {@link
 * IncomingPlacement}). Returns the notebox-relative path. For drops and pastes
 * that give a `file://` URL instead of a File (common on Linux).
 */
export async function copyPathIntoNotebox(
  sourcePath: string,
  placement?: IncomingPlacement,
): Promise<string> {
  return invoke<string>("copy_path_into_notebox", {
    sourcePath,
    placement: placement ?? null,
  });
}

/**
 * Pick files with the native dialog and copy them into the attachments folder.
 * Returns their notebox-relative paths (empty if cancelled).
 */
export async function pickAndUploadToAttachments(): Promise<string[]> {
  return invoke<string[]>("pick_and_upload_to_attachments");
}

/**
 * Pick a `.csl` file and copy it into the notebox (unless already inside),
 * returning its notebox-root path (`/styles/foo.csl`) for `custom_csl_path`, or
 * `null` if cancelled. The Typst compiler can only read files inside the
 * notebox.
 */
export async function importCslStyle(
  title: string,
  filterName: string,
): Promise<string | null> {
  return invoke<string | null>("import_csl_style", { title, filterName });
}

/** One file chosen in {@link pickFilesForImport}: its path and whether it's a
 *  markdown source (so the UI can offer "convert to Typst?" only for those). */
export interface PickedImportFile {
  path: string;
  is_markdown: boolean;
}

/**
 * Pick files with the native dialog and return their paths and a Markdown flag,
 * without copying anything. Each path is authorized for a following {@link
 * copyPathIntoNotebox} or {@link importMarkdownFile} call. Empty if cancelled.
 */
export async function pickFilesForImport(): Promise<PickedImportFile[]> {
  return invoke<PickedImportFile[]>("pick_files_for_import");
}

/**
 * Convert a Markdown file, by absolute path, into a `.typ` note at the notebox
 * root and return its notebox-relative path. The path must come from a recent
 * OS drop or {@link pickFilesForImport}.
 */
export async function importMarkdownFile(
  sourcePath: string,
  placement?: IncomingPlacement,
): Promise<string> {
  return invoke<string>("import_markdown_file", {
    sourcePath,
    placement: placement ?? null,
  });
}

/**
 * Convert Markdown bytes (base64 UTF-8) into a `.typ` note placed per
   `placement`, returning its
 * notebox-relative path. Used for drops on Windows, which give bytes rather
   than a path.
 */
export async function importMarkdownText(
  filename: string,
  contentBase64: string,
  placement?: IncomingPlacement,
): Promise<string> {
  return invoke<string>("import_markdown_text", {
    filename,
    contentBase64,
    placement: placement ?? null,
  });
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
 * Preview renaming the attachment folder: counts its files and the notes that
 * reference `/<old>/...`. Read-only.
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
 * Rename the attachment folder: move it, rewrite every path argument starting
 * with `/<old>/`, and save the setting. Destructive; confirm first.
 */
export async function migrateAttachmentFolder(
  newFolder: string,
): Promise<AttachmentMigrationResult> {
  return invoke<AttachmentMigrationResult>("migrate_attachment_folder", {
    newFolder,
  });
}

export interface IndexStats {
  file_count: number;
  collection_count: number;
  property_keys: string[];
}

/**
 * "Rebuild cache": discard this notebox's caches and rebuild every index from
 * disk. Can take minutes on a large notebox, so show a busy state until it
 * resolves. Emits the same refresh events as opening a notebox.
 */
export async function rebuildNoteboxIndexes(): Promise<IndexStats> {
  return invoke<IndexStats>("rebuild_notebox_indexes");
}

/**
 * File paths on the system clipboard, read with wl-paste or xclip. Empty if
 * there are none or neither tool is installed. For WebKitGTK on Linux, where
 * clipboardData is blocked.
 */
export async function readClipboardFilePaths(): Promise<string[]> {
  return invoke<string[]>("read_clipboard_file_paths");
}

/**
 * Copy the native clipboard's files or image into the notebox (placed per
 * `placement`) and return the paths to insert. For WebKitGTK on Linux, where
 * clipboardData is empty.
 */
export async function pasteClipboardIntoNotebox(
  placement?: IncomingPlacement,
): Promise<string[]> {
  return invoke<string[]>("paste_clipboard_into_notebox", {
    placement: placement ?? null,
  });
}

/**
 * A media file's bytes, for `#video` / `#audio` playback through a `blob:` URL
 * (WebKitGTK doesn't reliably stream media through the asset protocol). `path`
 * is notebox-root-absolute.
 */
export async function readMediaBytes(path: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("read_media_bytes", { target: path });
}

/**
 * An embedded image's bytes, for the `#image` widgets through a `blob:` URL
 * (the asset protocol fails for images on Windows). `path` takes the same forms
 * as {@link resolveEmbedPath}.
 */
export async function readEmbedBytes(path: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("read_embed_bytes", { target: path });
}

export async function showInExplorer(path: string): Promise<void> {
  return invoke<void>("show_in_explorer", { path });
}

/** Options for the export save/folder dialogs; same shape as the dialog
 *  plugin's `save()` options. */
export interface ExportDialogOptions {
  title?: string;
  /** A suggested file path, or a folder to start in. */
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

/**
 * Ask where to save an export; null if cancelled. Export commands only write
 * where the user chose through this or {@link pickExportFolder}, so use these
 * for every export destination.
 */
export async function pickExportFile(options: ExportDialogOptions): Promise<string | null> {
  return invoke<string | null>("pick_export_file", { options });
}

/** Ask for a folder to export into. Resolves with the chosen folder, or null
 *  if the user cancelled. See {@link pickExportFile}. */
export async function pickExportFolder(options: ExportDialogOptions): Promise<string | null> {
  return invoke<string | null>("pick_export_folder", { options });
}

/**
 * Open a file in the default application. Without `confirmed`, program files
 * and files outside the notebox are refused (`open-program-file` /
 * `open-outside-notebox`) so the caller can ask first. Use
 * `openFileInDefaultApp` (lib/open-link.ts), which does the asking.
 */
export async function openFileExternally(path: string, confirmed = false): Promise<void> {
  return invoke<void>("open_file_externally", { path, confirmed });
}

/**
 * Open a URL (http(s), mailto, or an app scheme such as `zotero://`) in the OS
 * default handler. The backend refuses `file:` and dangerous schemes.
 */
export async function openUrlExternally(url: string): Promise<void> {
  return invoke<void>("open_url_externally", { url });
}

/**
 * Follow an `inkycap://` link clicked in InkyCap as if another app had sent it:
 * the backend checks it and sends the right window an `app:deep-link` event.
 * Fails with `bad-request` for a malformed link.
 */
export async function openInkycapUrl(url: string): Promise<void> {
  return invoke<void>("open_inkycap_url", { url });
}

/**
 * Called once by the main window at startup, before restoring a notebox: the
 * `inkycap://` link InkyCap was started with, if any. Later links arrive as
 * `app:deep-link` events. Other windows get `null`.
 */
export async function deepLinkReady(): Promise<DeepLinkDelivery | null> {
  return invoke<DeepLinkDelivery | null>("deep_link_ready");
}

/**
 * Read a bundled third-party licence notices file (Settings → Sources). The
 * backend only accepts the listed `kind`s.
 */
export async function readThirdPartyNotices(kind: "rust" | "js"): Promise<string> {
  return invoke<string>("read_third_party_notices", { kind });
}

/** The running app's version string, e.g. `26.6.1`. */
export async function appVersion(): Promise<string> {
  return invoke<string>("app_version");
}

/** The newest release, as returned by `check_latest_release`. */
export interface LatestRelease {
  /** Version with any leading `v` stripped, e.g. `26.6.10`. */
  version: string;
  /** This release's own page, to open in the browser. */
  url: string;
  /** Release notes (may be empty). */
  notes: string;
  /** Whether this is a pre-release (beta) build. */
  isPrerelease: boolean;
  /** Where all releases are listed ("View releases"). */
  releasesUrl: string;
  /** Where users download installers ("Download"). */
  downloadUrl: string;
}

/**
 * The latest release, from InkyCap's release feed or, failing that, the forge's
 * releases API. `releasesUrl` and `downloadUrl` come back with the answer.
 *
 * `includeBeta` includes pre-releases. `feedUrl` is the
 * `settings.updates.feed_url` override, or null for the default. The caller
 * compares `version` with `appVersion()`. Throws on network failure.
 */
export async function checkLatestRelease(
  includeBeta: boolean,
  feedUrl: string | null = null,
): Promise<LatestRelease> {
  return invoke<LatestRelease>("check_latest_release", { includeBeta, feedUrl });
}

/**
 * Whether this copy can update itself: `available` (installed by InkyCap's own
 * installers), `flatpak` (updated by hand), `managed` (updated by its software
 * centre, e.g. Flathub; no update controls shown), or `unsupported` (repackaged
 * or self-built). Download is offered in every case but `managed`.
 */
export type UpgradeSupport = "available" | "flatpak" | "managed" | "unsupported";

export async function upgradeSupport(): Promise<UpgradeSupport> {
  return invoke<UpgradeSupport>("upgrade_support");
}

/** Bytes downloaded so far; `total` is null when the server doesn't say. */
export interface UpgradeProgress {
  downloaded: number;
  total: number | null;
}

/**
 * Download the newest release for this system and verify its signature,
 * reporting to `onProgress`. Installs nothing. Resolves to the version
 * downloaded. `feedUrl` as in `checkLatestRelease`.
 */
export async function upgradeDownload(
  includeBeta: boolean,
  feedUrl: string | null,
  onProgress: (progress: UpgradeProgress) => void,
): Promise<string> {
  const channel = new Channel<UpgradeProgress>();
  channel.onmessage = onProgress;
  return invoke<string>("upgrade_download", { includeBeta, feedUrl, onProgress: channel });
}

/**
 * Install the update `upgradeDownload` fetched. On Linux this shows the
 * administrator password prompt; cancelling rejects with `cancelled`. On
 * Windows the installer restarts the app, so this doesn't resolve.
 */
export async function upgradeInstall(): Promise<void> {
  return invoke<void>("upgrade_install");
}

/** Restart InkyCap into the newly installed version. */
export async function upgradeRestart(): Promise<void> {
  return invoke<void>("upgrade_restart");
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

/** Persist a new creation-rule order. `orderedIds` is the full list of rule
 *  ids in the desired order (every rule, not just toolbar-visible ones). */
export async function reorderCreationRules(
  orderedIds: string[],
): Promise<void> {
  return invoke<void>("reorder_creation_rules", { orderedIds });
}

/**
 * Run a creation rule.
 *
 * - `titleOverride`: the filename when the rule's `filename_pattern` is empty
 *   (ignored otherwise). Without it, a blank-pattern rule fails with
 *   BadRequest("filename-required") so the UI can ask and retry.
 * - `targetFolderOverride`: a notebox-relative folder (empty for the root) that
 *   overrides the rule's folder and the "New note location" setting. Used by
 *   the file tree's New Note.
 * - `scaffoldOverride`: a scaffold name or scaffolds-relative path (`.typ`
 *   optional) to use instead of the rule's own.
 * - `currentNote`: the note being worked in, for the "Current folder" location
 *   option.
 */
export async function executeCreationRule(
  ruleId: string,
  titleOverride?: string,
  targetFolderOverride?: string,
  scaffoldOverride?: string,
  currentNote?: string,
): Promise<CreationResult> {
  return invoke<CreationResult>("execute_creation_rule", {
    ruleId,
    titleOverride: titleOverride ?? null,
    targetFolderOverride: targetFolderOverride ?? null,
    scaffoldOverride: scaffoldOverride ?? null,
    currentNote: currentNote ?? null,
  });
}

export async function listScaffolds(): Promise<string[]> {
  return invoke<string[]>("list_scaffolds");
}

export interface TemplateEntry {
  name: string;
  path: string;
  kind: "scaffold" | "template-file" | "template-package";
  /** True for the system scaffolds (new-note, daily-note), which must not
   *  offer a delete affordance. Always false for non-scaffold entries. */
  builtin: boolean;
}

export async function listScaffoldEntries(): Promise<TemplateEntry[]> {
  return invoke<TemplateEntry[]>("list_scaffold_entries");
}

/**
 * Move a user scaffold to the OS trash. The backend refuses system scaffolds.
 */
export async function deleteScaffold(scaffoldName: string): Promise<void> {
  return invoke<void>("delete_scaffold", { scaffoldName });
}

/**
 * Create a scaffold file and return its absolute path. Without `content` it
 * gets the starter template (see {@link getScaffoldStarter}); with it,
 * `content` is written as is.
 */
export async function createScaffold(
  name: string,
  content?: string,
): Promise<string> {
  return invoke<string>("create_scaffold", { name, content: content ?? null });
}

/** Starter content used to prefill a brand-new scaffold in the editor. */
export async function getScaffoldStarter(): Promise<string> {
  return invoke<string>("get_scaffold_starter");
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

/** What an installed package's `typst.toml` says about it, and the files that
 *  explain how to use it. Paths are absolute, except `thumbnail_path`, which is
 *  notebox-root-absolute (`/.inkycap/…`) for {@link readEmbedBytes}. Links are
 *  `http(s)` only. */
export interface PackageDetails {
  description: string | null;
  authors: string[];
  license: string | null;
  homepage: string | null;
  repository: string | null;
  categories: string[];
  /** The package's Typst Universe page; `@preview` packages only. */
  universe_url: string | null;
  readme_path: string | null;
  /** A template's starter file: the author's example of how to use it. */
  starter_path: string | null;
  thumbnail_path: string | null;
}

/** One parameter of a package function. */
export interface PackageDocParam {
  name: string;
  kind: "positional" | "named" | "rest";
  /** Accepted types as Tinymist infers them; `null` when any value works. */
  ty: string | null;
  default: string | null;
  docs: string | null;
}

/** A top-level name a package exports. */
export interface PackageDocSymbol {
  name: string;
  kind: "function" | "variable" | "module";
  /** The author's description (Markdown), when it could be read. */
  docs: string | null;
  params: PackageDocParam[];
}

export interface PackageDocs {
  symbols: PackageDocSymbol[];
  /** A template, which applies only when exporting to PDF. */
  is_template: boolean;
}

/** Reference documentation for `spec`, generated by the bundled Tinymist. */
export async function getPackageDocs(spec: string): Promise<PackageDocs> {
  return invoke<PackageDocs>("get_package_docs", { spec });
}

/** The packages the note at `path` imports at top level, as saved on disk. */
export async function listNotePackageImports(path: string): Promise<string[]> {
  return invoke<string[]>("list_note_package_imports", { path });
}

/** Import everything from `spec` in the note, above the notebox import.
 *  Use `addPackageToNote` (lib/note-packages.ts), which saves and reloads. */
export async function addNotePackage(path: string, spec: string): Promise<void> {
  return invoke<void>("add_note_package", { path, spec });
}

/** `source` importing everything from `spec` above the notebox import
 *  (unchanged if already imported), for edits in the open editor. */
export async function addPackageToSource(source: string, spec: string): Promise<string> {
  return invoke<string>("add_package_to_source", { source, spec });
}

/** Remove the note's imports of `spec`, and template rules that need it. */
export async function removeNotePackage(path: string, spec: string): Promise<void> {
  return invoke<void>("remove_note_package", { path, spec });
}

/** Move a clashing `*` import of `spec` above the notebox import. */
export async function fixNotePackageImport(path: string, spec: string): Promise<void> {
  return invoke<void>("fix_note_package_import", { path, spec });
}

/** For each of `specs` with functions named like InkyCap's own, those names
 *  (what importing it with `*` would replace). Others are left out. */
export async function listPackageNameClashes(specs: string[]): Promise<Record<string, string[]>> {
  return invoke<Record<string, string[]>>("list_package_name_clashes", { specs });
}

/** Details of the installed package `spec`, for the Templates panel. */
export async function getPackageDetails(spec: string): Promise<PackageDetails> {
  return invoke<PackageDetails>("get_package_details", { spec });
}

/**
 * `customTypst` with the `#show: <fn>.with(…)` rule from an installed template
 * package's starter applied: added at the top, or in place of the rule an
 * earlier template left, and kept as is if already there. With
 * `collectionPath`, the starter's `bibliography("…")` points at the
 * collection's generated bibliography. Null when there is no such template or
 * rule.
 */
export async function applyTemplateStarter(
  spec: string,
  customTypst: string,
  collectionPath?: string,
): Promise<string | null> {
  return invoke<string | null>("apply_template_starter", {
    spec,
    customTypst,
    collectionPath,
  });
}

/** Functions that `customTypst`'s template rules apply but the collection's
 *  `template` doesn't supply (left from an earlier template, or with none
 *  set). Exports leave those rules out. */
export async function staleTemplateRules(
  customTypst: string,
  template: string | null,
): Promise<string[]> {
  return invoke<string[]>("stale_template_rules", { customTypst, template });
}

/** `customTypst` without the rules {@link staleTemplateRules} finds. */
export async function removeStaleTemplateRules(
  customTypst: string,
  template: string | null,
): Promise<string> {
  return invoke<string>("remove_stale_template_rules", { customTypst, template });
}

export async function uninstallTypstPackage(spec: string): Promise<void> {
  return invoke<void>("uninstall_typst_package", { spec });
}

/** What depends on a package version, for the uninstall confirmation. */
export interface PackageDependents {
  /** Display names of creation rules whose template is this spec. */
  rules: string[];
  /** Notebox-root-relative paths of notes importing this exact spec, capped
   *  for display; `noteTotal` is the full count. */
  notes: string[];
  /** Total notes importing the spec (may exceed `notes.length` when capped). */
  note_total: number;
}

/** Find creation rules and notes that depend on a package version. Read-only;
 *  used to warn the user before an uninstall (warn-and-allow). */
export async function findPackageDependents(
  spec: string,
): Promise<PackageDependents> {
  return invoke<PackageDependents>("find_package_dependents", { spec });
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
}): Promise<ScaffoldInsertResult> {
  return invoke<ScaffoldInsertResult>("prepare_scaffold_insert", {
    scaffoldName: args.scaffoldName,
    currentSource: args.currentSource,
    title: args.title,
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

/** Ensure the user's mycelial stopword file exists and return its path so it
 *  can be opened for editing (via {@link openFileExternally}). */
export async function ensureMycelialStopwordsFile(): Promise<string> {
  return invoke<string>("ensure_mycelial_stopwords_file");
}

/** Rescue a term suppressed by a *built-in* stopword by force-including it via
 *  the notebox dictionary, so it can surface as a concept again. */
export async function rescueMycelialTerm(term: string): Promise<void> {
  return invoke<void>("rescue_mycelial_term", { term });
}

/** Rescue a term the user added to their stopword list by removing that line. */
export async function removeMycelialStopword(term: string): Promise<void> {
  return invoke<void>("remove_mycelial_stopword", { term });
}

/** Notebox-wide Mycelial exclusion rules plus the count of notes they
 *  currently exclude. */
export async function getMycelialExclusions(): Promise<MycelialExclusionInfo> {
  return invoke<MycelialExclusionInfo>("get_mycelial_exclusions");
}

/** Replace the Mycelial exclusion rule list and return the refreshed state. */
export async function setMycelialExclusions(
  rules: string[],
): Promise<MycelialExclusionInfo> {
  return invoke<MycelialExclusionInfo>("set_mycelial_exclusions", { rules });
}

/** Hide an under-developed page from the Growth panel (per-notebox, reversible
 *  via {@link removeMycelialHubExclusion}). */
export async function excludeMycelialHub(path: string): Promise<void> {
  return invoke<void>("exclude_mycelial_hub", { path });
}

/** Un-hide a previously excluded under-developed page. */
export async function removeMycelialHubExclusion(path: string): Promise<void> {
  return invoke<void>("remove_mycelial_hub_exclusion", { path });
}

/** Ensure the hidden-pages list file exists and return its path so it can be
 *  opened for editing (via {@link openFileExternally}) to review or un-hide. */
export async function ensureMycelialHubExclusionsFile(): Promise<string> {
  return invoke<string>("ensure_mycelial_hub_exclusions_file");
}

// ── Spellcheck dictionaries ───────────────────────────────────────────────

/** An installable spellcheck dictionary (bundled or user-installed). */
export interface DictionaryInfo {
  code: string;
  name: string;
  bundled: boolean;
}

/** Raw Hunspell text for a dictionary, to feed to the frontend checker. */
export interface DictionaryData {
  aff: string;
  dic: string;
}

/** List every spellcheck dictionary available to enable. */
export async function listSpellcheckDictionaries(): Promise<DictionaryInfo[]> {
  return invoke<DictionaryInfo[]>("list_spellcheck_dictionaries");
}

/** Load a dictionary's Hunspell .aff/.dic text by code. */
export async function readSpellcheckDictionary(code: string): Promise<DictionaryData> {
  return invoke<DictionaryData>("read_spellcheck_dictionary", { code });
}

/** Ensure and return the user dictionary-install folder path (to reveal it). */
export async function spellcheckDictionaryFolder(): Promise<string> {
  return invoke<string>("spellcheck_dictionary_folder");
}

/** The notebox's personal dictionary words (.inkycap/dictionary.txt). */
export async function listUserDictionary(): Promise<string[]> {
  return invoke<string[]>("list_user_dictionary");
}

/** Add a word to the notebox user dictionary (shared spell + Mycelial rescue). */
export async function addUserDictionaryWord(word: string): Promise<void> {
  return invoke<void>("add_user_dictionary_word", { word });
}

/** Remove a word from the notebox user dictionary. */
export async function removeUserDictionaryWord(word: string): Promise<void> {
  return invoke<void>("remove_user_dictionary_word", { word });
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
export type PdfStandardPreset = "standard" | "pdf-a4" | "pdf-ua1" | "pdf-a2a-ua1";

/// How an export treats review markup (`#suggestion` changes and `#annotation`
/// notes). Mirrors `ReviewMarkupMode::from_opt` in Rust.
export type ReviewMarkupMode = "accept" | "reject" | "keep";

/// What an export copied into the folder beside it (see `LinkedFilesOptions`).
/// Exports return `null` when nothing was copied.
export interface CompanionReport {
  folder: string;
  copied: number;
}

export async function exportNotePdfToFile(
  path: string,
  outputPath: string,
  metadataMode: string = "exclude",
  pdfStandard?: PdfStandardPreset,
  includeBibliography?: boolean,
  reviewMode?: ReviewMarkupMode,
  linkedFiles?: LinkedFilesOptions,
): Promise<CompanionReport | null> {
  return invoke<CompanionReport | null>("export_note_pdf_to_file", {
    path,
    outputPath,
    metadataMode,
    pdfStandard: pdfStandard ?? null,
    includeBibliography: includeBibliography ?? null,
    reviewMode: reviewMode ?? null,
    linkedFiles: linkedFiles ?? null,
  });
}

export async function exportSelfContainedTyp(
  path: string,
  outputPath: string,
  reviewMode?: ReviewMarkupMode,
): Promise<void> {
  return invoke<void>("export_self_contained_typ", {
    path,
    outputPath,
    reviewMode: reviewMode ?? null,
  });
}

export async function exportNoteHtml(
  path: string,
  outputPath: string,
  metadataMode: string = "exclude",
  stripWikilinks: boolean = false,
  includeBibliography?: boolean,
  reviewMode?: ReviewMarkupMode,
  linkedFiles?: LinkedFilesOptions,
): Promise<CompanionReport | null> {
  return invoke<CompanionReport | null>("export_note_html", {
    path,
    outputPath,
    metadataMode,
    stripWikilinks,
    includeBibliography: includeBibliography ?? null,
    reviewMode: reviewMode ?? null,
    linkedFiles: linkedFiles ?? null,
  });
}

/// Number of suggestions and annotations in a note. The export dialog shows its
/// "Review markup" option only when there are some.
export async function countNoteReviewMarkup(path: string): Promise<number> {
  return invoke<number>("count_note_review_markup", { path });
}

export async function exportCollectionNotePdf(
  notePath: string,
  collectionPath: string,
  outputPath: string,
  metadataMode?: string,
  pdfStandard?: PdfStandardPreset,
  includeBibliography?: boolean,
  reviewMode?: ReviewMarkupMode,
  linkedFiles?: LinkedFilesOptions,
): Promise<CompanionReport | null> {
  return invoke<CompanionReport | null>("export_collection_note_pdf", {
    notePath,
    collectionPath,
    outputPath,
    metadataMode: metadataMode ?? null,
    pdfStandard: pdfStandard ?? null,
    includeBibliography: includeBibliography ?? null,
    reviewMode: reviewMode ?? null,
    linkedFiles: linkedFiles ?? null,
  });
}

/// Result of a collection export that writes one file per note. `files` are the
/// paths written; `skippedNotes` failed and were left out; `bypassedCount` were
/// exported with errors kept as plain text (only when asked to bypass errors).
export interface BatchExportResult {
  files: string[];
  skippedNotes: SkippedNote[];
  bypassedCount: number;
  companion: CompanionReport | null;
}

/// A note a batch export left out, and why.
export interface SkippedNote {
  path: string;
  name: string;
  reason: string;
}

/// Export each note of a collection view as its own PDF. `onlyFiles` limits the
/// run to those notes (to retry skipped ones). `bypassErrors` keeps errored
/// markup as plain text instead of skipping the note; it is ignored for
/// archival and accessible PDF formats.
export async function exportCollectionBatchPdf(
  collectionPath: string,
  viewName: string,
  outputDir: string,
  metadataMode?: string,
  pdfStandard?: PdfStandardPreset,
  includeBibliography?: boolean,
  reviewMode?: ReviewMarkupMode,
  onlyFiles?: string[],
  bypassErrors?: boolean,
  linkedFiles?: LinkedFilesOptions,
): Promise<BatchExportResult> {
  return invoke<BatchExportResult>("export_collection_batch_pdf", {
    collectionPath,
    viewName,
    outputDir,
    metadataMode: metadataMode ?? null,
    pdfStandard: pdfStandard ?? null,
    includeBibliography: includeBibliography ?? null,
    reviewMode: reviewMode ?? null,
    onlyFiles: onlyFiles ?? null,
    bypassErrors: bypassErrors ?? null,
    linkedFiles: linkedFiles ?? null,
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

/// Per-export overrides for `export_collection_book_pdf`. Undefined fields fall
/// back to the collection's `book:` block, then to defaults.
export interface BookExportOverrides {
  title?: string | null;
  subtitle?: string | null;
  author?: string | null;
  date?: string | null;
  abstract?: string | null;
  tocDepth?: number;
  injectChapterHeading?: InjectChapterHeading;
  wikilinkMode?: BookWikilinkMode;
  includeTitlePage?: boolean;
  includeOutline?: boolean;
  tocPlacement?: TocPlacement;
  pageNumbering?: BookPageNumbering;
  pdfStandard?: PdfStandardPreset;
  /// `unified` consolidates a single bibliography at the back; `in_place`
  /// keeps each note's own `#bibliography(...)`. Omitted → collection default.
  bibliographyMode?: BibliographyMode;
  /// Review-markup policy applied to every note before it's inlined into the
  /// book. Omitted → keep tracked-change marks.
  reviewMode?: ReviewMarkupMode;
  /// A note name. When set, each chapter holds only the passages that link
  /// to it; notes without one are left out (see `withoutPassages`).
  passagesLinkingTo?: string;
  /// Overrides the collection's saved `export.linked_files`.
  linkedFiles?: LinkedFilesOptions;
}

/// Outcome of a book export. `outputPath` is set when the PDF was written.
/// Otherwise `failingNotes` (note stems) lists the notes that failed, which can
/// be passed back as `excludeNotes`, and `message` is the diagnostic. A failure
/// that excluding notes can't fix is thrown instead. `bypassed` is true when
/// errored markup was kept as plain text.
export interface BookExportResult {
  outputPath: string | null;
  failingNotes: string[];
  message: string | null;
  bypassed: boolean;
  /// Stems of notes left out of a passages-only book for having no passage
  /// linking to the chosen note.
  withoutPassages: string[];
  /// The files copied into the folder beside the book.
  companion: CompanionReport | null;
}

/// `bypassErrors` keeps errored markup as plain text instead of failing; the
/// backend ignores it for archival and accessible PDF formats.
export async function exportCollectionBookPdf(
  collectionPath: string,
  viewName: string,
  outputPath: string,
  overrides?: BookExportOverrides,
  excludeNotes?: string[],
  bypassErrors?: boolean,
): Promise<BookExportResult> {
  return invoke<BookExportResult>("export_collection_book_pdf", {
    collectionPath,
    viewName,
    outputPath,
    overrides: overrides ?? null,
    excludeNotes: excludeNotes ?? null,
    bypassErrors: bypassErrors ?? null,
  });
}

/// One proposed Markdown→Typst fix on a source line (`MdFix` on the Rust side).
export interface MdFix {
  line: number;
  /// Transforms that applied (e.g. "heading", "link+bold").
  kind: string;
  before: string;
  after: string;
}

/// Leftover-Markdown fixes proposed for one file.
export interface FileMdFixes {
  path: string;
  fixes: MdFix[];
}

/// A Typst syntax error in one file (reported, never auto-fixed).
export interface SyntaxIssue {
  line: number;
  column: number;
  message: string;
}

export interface FileSyntaxErrors {
  path: string;
  errors: SyntaxIssue[];
}

/// Result of a notebox-wide audit of `.typ` files for InkyCap compatibility.
/// Mirrors the `TypAuditReport` struct on the Rust side.
export interface TypAuditReport {
  totalScanned: number;
  /// Notebox-relative paths missing the inkycap-notebox `#import`.
  missingImport: string[];
  /// Notebox-relative paths missing a top-level `#note(...)` call.
  missingNote: string[];
  /// Files carrying leftover Markdown markup, with the proposed fixes.
  markdownFixes: FileMdFixes[];
  /// Files with Typst syntax errors (reported for manual repair).
  syntaxErrors: FileSyntaxErrors[];
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

/// True when `path` is a `.typ` note in the open notebox (outside `.inkycap/`,
/// not the documentation notebox) without the InkyCap import line.
export async function noteMissingNoteboxImport(path: string): Promise<boolean> {
  return invoke<boolean>("note_missing_notebox_import", { path });
}

/// Prepend the InkyCap import line to the note at `path` if it's missing.
/// Adds nothing else. Resolves `true` when the file was rewritten.
export async function addNoteboxImport(path: string): Promise<boolean> {
  return invoke<boolean>("add_notebox_import", { path });
}

/// The Markdown fixes the user accepted for one file (rejected ones omitted).
/// Mirrors the Rust `FileMdEdits`.
export interface FileMdEdits {
  path: string;
  fixes: MdFix[];
}

/// Apply the user-accepted Markdown→Typst fixes (content-changing). Only the
/// fixes passed are applied, so the user can reject any they want to keep.
export async function repairMarkdownFiles(edits: FileMdEdits[]): Promise<TypRepairSummary> {
  return invoke<TypRepairSummary>("repair_markdown_files", { edits });
}

/// Write the audit results to a note at the notebox root and return its
/// absolute path.
export async function saveAuditReport(): Promise<string> {
  return invoke<string>("save_audit_report");
}

// ── Notebox name audit ──
//
// Mirrors `src-tauri/src/commands/name_audit.rs`. Reports names that break on
// Windows or macOS and note names that make wikilinks ambiguous. Report only:
// which of two colliding notes keeps its name is the user's call.

/// Sibling entries in one folder whose names differ only in case.
export interface NameCollision {
  /// Notebox-relative folder holding them; empty string for the notebox root.
  folder: string;
  /// The colliding names exactly as they appear on disk.
  names: string[];
}

/// One entry whose name carries characters Windows will not accept.
export interface NameIssue {
  path: string;
  /// The offending characters, space-separated; controls as `U+XXXX`.
  detail: string;
}

/// One note in a duplicate-name group. Carries both path shapes: the report
/// note prints `rel`, the dialog opens a tab with `abs`.
export interface DuplicateNotePath {
  /// Notebox-relative, for display.
  rel: string;
  /// Absolute, for `openTab`.
  abs: string;
}

/// Notes sharing one wikilink name across different folders.
export interface DuplicateNoteName {
  name: string;
  paths: DuplicateNotePath[];
}

export interface NameAuditReport {
  /// Entries visited, files and folders together.
  totalScanned: number;
  caseCollisions: NameCollision[];
  /// Byte-different names that are identical once accents are normalized.
  /// macOS-only: Windows and Linux keep these as separate files.
  normalizationCollisions: NameCollision[];
  reservedNames: string[];
  illegalCharacters: NameIssue[];
  trailingDotsOrSpaces: string[];
  duplicateNoteNames: DuplicateNoteName[];
}

export async function auditNoteboxNames(): Promise<NameAuditReport> {
  return invoke<NameAuditReport>("audit_notebox_names");
}

/// Write the name audit to a note at the notebox root and return its absolute
/// path, so the user can work through findings in a tab with the dialog closed.
export async function saveNameAuditReport(): Promise<string> {
  return invoke<string>("save_name_audit_report");
}


/// Export a collection view as a static HTML site. `bypassErrors` keeps
/// errored markup as plain text instead of leaving the note out.
export async function exportCollectionStaticSite(
  collectionPath: string,
  viewName: string,
  outputDir: string,
  bypassErrors?: boolean,
  linkedFiles?: LinkedFilesOptions,
): Promise<BatchExportResult> {
  return invoke<BatchExportResult>("export_collection_static_site", {
    collectionPath,
    viewName,
    outputDir,
    bypassErrors: bypassErrors ?? null,
    linkedFiles: linkedFiles ?? null,
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
  reviewMode?: ReviewMarkupMode,
  linkedFiles?: LinkedFilesOptions,
): Promise<CompanionReport | null> {
  return invoke<CompanionReport | null>("export_via_pandoc", {
    path,
    outputPath,
    format,
    metadataMode,
    reviewMode: reviewMode ?? null,
    linkedFiles: linkedFiles ?? null,
  });
}

// Typst compile pipeline (Phase 1 — reading mode)

/**
 * Compile a `.typ` note to per-page SVG. `path` may be notebox-relative or
 * absolute; paths outside the notebox are rejected. Warnings can be present on
 * success.
 */
export async function compileTypstSvg(path: string): Promise<TypstCompileResult> {
  return invoke<TypstCompileResult>("compile_typst_svg", { path });
}

export async function compileTypstHtml(path: string): Promise<TypstHtmlResult> {
  return invoke<TypstHtmlResult>("compile_typst_html", { path });
}

/** An HTML compile of part of a note; `truncated` is false when the whole
 *  note was short enough to show as it is. */
export type ExcerptHtmlResult = TypstHtmlResult & { truncated: boolean };

/**
 * Compile only the passages of `path` around its links to `linkedWith` (or its
 * opening passage if there are none), with a paragraph either side. Used by the
 * Journal Scroll.
 */
export async function compileTypstHtmlExcerpt(
  path: string,
  linkedWith: string,
): Promise<ExcerptHtmlResult> {
  return invoke<ExcerptHtmlResult>("compile_typst_html_excerpt", { path, linkedWith });
}

// Bibliography (Phase 6)

export async function getBibliographyEntries(): Promise<BibEntry[]> {
  return invoke<BibEntry[]>("get_bibliography_entries");
}

export async function getFileCitations(path: string): Promise<FileCitation[]> {
  return invoke<FileCitation[]>("get_file_citations", { path });
}

/**
 * The references cited in `path`, as pre-formatted Typst markup in the
 * notebox's citation style, for the clipboard. Empty when it cites nothing.
 */
export async function copyFileBibliography(path: string): Promise<string> {
  return invoke<string>("copy_file_bibliography", { path });
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

/**
 * The clipboard's HTML (or plain text) as Typst markup to insert. `null` when
 * the clipboard is empty.
 */
export async function pasteHtmlAsTypst(): Promise<string | null> {
  return invoke<string | null>("paste_html_as_typst");
}

export interface ImportResult {
  notes_converted: number;
  files_copied: number;
  errors: string[];
  /** LaTeX equations preserved as code blocks because the mitex package
   *  isn't installed. Non-zero → show the user how to render them. */
  math_as_code: number;
}

export type MarkdownDialect = "standard" | "obsidian";

/// A YAML frontmatter key found in the source notebox, with the suggested
/// InkyCap mapping. Field names match the Rust `FrontmatterKeyInfo`.
export interface FrontmatterKeyInfo {
  source_key: string;
  sample_value: string;
  occurrences: number;
  inferred_type: PropertyType;
  suggested_target: string;
  suggested_type: PropertyType;
  target_is_system: boolean;
  target_exists: boolean;
  will_create: boolean;
}

/// One row of the confirmed YAML-to-property mapping. `target_key: null` drops
/// the property; `create` registers a new property of `target_type`.
export interface PropertyMapping {
  source_key: string;
  target_key: string | null;
  target_type: PropertyType;
  create: boolean;
}

/// The distinct YAML frontmatter keys in the source archive or folder, with
/// suggested mappings, for the property-mapping dialog.
export async function scanMarkdownFrontmatter(
  sourcePath: string,
): Promise<FrontmatterKeyInfo[]> {
  return invoke<FrontmatterKeyInfo[]>("scan_markdown_frontmatter", { sourcePath });
}

export async function importMarkdownNotebox(
  sourcePath: string,
  targetPath: string,
  dialect: MarkdownDialect | null = null,
  mappings: PropertyMapping[] | null = null,
): Promise<ImportResult> {
  return invoke<ImportResult>("import_markdown_notebox", {
    sourcePath,
    targetPath,
    dialect,
    mappings,
  });
}

/// The dialect the importer would use by default: "obsidian" if the source has
/// an `.obsidian/` folder, otherwise "standard".
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
  reviewMode?: ReviewMarkupMode,
  linkedFiles?: LinkedFilesOptions,
): Promise<CompanionReport | null> {
  return invoke<CompanionReport | null>("export_note_markdown_to_file", {
    path,
    outputPath,
    unconvertibleMode,
    reviewMode: reviewMode ?? null,
    linkedFiles: linkedFiles ?? null,
  });
}

export async function exportCollectionBatchMarkdown(
  collectionPath: string,
  viewName: string,
  outputDir: string,
  unconvertibleMode: UnconvertibleMode,
  reviewMode?: ReviewMarkupMode,
  linkedFiles?: LinkedFilesOptions,
): Promise<BatchExportResult> {
  return invoke<BatchExportResult>("export_collection_batch_markdown", {
    collectionPath,
    viewName,
    outputDir,
    unconvertibleMode,
    reviewMode: reviewMode ?? null,
    linkedFiles: linkedFiles ?? null,
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

/** Tasks and dated reminders due today, across the whole notebox. */
export async function getTodayAgendaItems(): Promise<AgendaItem[]> {
  return invoke<AgendaItem[]>("get_today_agenda_items");
}

/** The `limit` most recently modified notes, newest first. */
export async function getRecentNotes(limit: number): Promise<RecentNote[]> {
  return invoke<RecentNote[]>("get_recent_notes", { limit });
}

/** Notes that are linked to but not written yet, ordered by when a linking
 *  note last changed, newest first. With `fromPaths`, only links written in
 *  those notes count and every match comes back (`limit` is ignored). */
export async function getUnwrittenNotes(
  limit: number,
  fromPaths?: string[],
): Promise<UnwrittenNote[]> {
  return invoke<UnwrittenNote[]>("get_unwritten_notes", {
    limit,
    fromPaths: fromPaths ?? null,
  });
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

/**
 * Last-run info for backups. Mirrors the Rust `BackupState`; fields are empty
 * or zero before the first backup.
 */
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

/**
 * Ask a running backup to stop. Returns at once; the archive writer stops at
 * its next check. Safe when no backup is running.
 */
export async function cancelBackup(): Promise<void> {
  return invoke<void>("cancel_backup");
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

/**
 * True when a backup password is in the OS keychain. The secret itself is never
 * read for display.
 */
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

/**
 * What to do when a restored file would overwrite an existing one. `skip` (the
 * default) keeps the existing file.
 */
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

/**
 * List an archive's entries. Encrypted entries are flagged; no password is
 * needed to list.
 */
export async function listBackupContents(archivePath: string): Promise<BackupContentEntry[]> {
  return invoke<BackupContentEntry[]>("list_backup_contents", { archivePath });
}

/**
 * Restore selected entries from an archive into `targetRoot`.
 * `passwordOverride` is a password typed for this restore (e.g. for an archive
 * made with an older password); otherwise the keychain password is used.
 */
export async function restoreBackupFiles(
  archivePath: string,
  targetRoot: string,
  entries: string[],
  conflict: RestoreConflictPolicy,
  passwordOverride?: string,
): Promise<RestoreResult[]> {
  return invoke<RestoreResult[]>("restore_backup_files", {
    archivePath,
    targetRoot,
    entries,
    conflict,
    passwordOverride: passwordOverride && passwordOverride.length > 0 ? passwordOverride : null,
  });
}
