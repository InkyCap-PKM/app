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
  ContributorCatalogs,
  SortRule,
  FilterGroup,
  NoteboxIndex,
  UserSettings,
  ExternalToolResult,
  NoteboxSettings,
  SearchResult,
  SearchResponse,
  ReplaceResult,
  CreationRule,
  CreationResult,
  Bookmark,
  BookmarkKind,
  MycelialData,
  PropertyType,
  AgendaItem,
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
 * Resolve (seeding on first use) the bundled "InkyCap Documentation" system
 * notebox. Returns its root path plus the landing note to open first, so the
 * caller can boot the window straight onto the manual's home page.
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
 * List every notebox currently open across all windows. A notebox is exclusive
 * to one window, so the UI uses this to disable / focus already-open noteboxes.
 */
export async function listOpenNoteboxes(): Promise<OpenNoteboxWindow[]> {
  return invoke<OpenNoteboxWindow[]>("list_open_noteboxes");
}

/**
 * Validate a folder the user wants to add to their notebox list. Rejects (with
 * a descriptive error) a folder already in the list, or one nested inside /
 * containing another notebox. Resolves when the folder is a valid choice.
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

/** True when `path` is an empty directory or doesn't exist yet — i.e. a valid,
 *  non-destructive destination for "Clone from remote". An existing notebox
 *  always contains `.inkycap/`, so this also returns false for one. */
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

/** Set (or clear, with `null`) a note's document-level recurrence rule
 *  (`#note(recurrence: …)`). Written as a Typst dict via the round-trip-safe
 *  rewriter, separate from the generic property path. */
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
  context_before: string[];
  context_after: string[];
  modified_time: number;
  created_time: number;
  /** The mentioning note's `#note(zid:)`, or null when absent. */
  zid?: string | null;
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

/** Run a registered external tool (the external-tool bridge). Resolves the
 *  executable server-side by `toolId`; `inputText` is piped to its stdin and
 *  `selection`/`filePath` feed the argument placeholders. Returns the tool's
 *  stdout plus its configured output disposition. */
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

export async function generateZid(): Promise<string> {
  return invoke<string>("generate_zid");
}

// ─────────────────────────── Git collaboration ─────────────────────────────
// Phase 4 review surface. Setup writes the notebox's `NoteboxGitConfig`;
// fetch/consolidate/push drive the one-review-surface loop. All git work runs
// on a blocking task in the backend.

/** Turn the open notebox into a collaborative git repo (init-or-adopt, write
 *  `.gitignore`, set `origin`, save the optional sign-in username + password and
 *  commit identity) and persist its remote/branch (per-machine, in local.json).
 *  Re-running adopts the existing repo. */
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

/** Reconnect collaboration for a notebox that is already a git repo with an
 *  `origin` remote but lost (or never wrote) its collaboration config. Reads the
 *  remote + branch from the repo and persists them — no user input. */
export async function gitReconnectCollaboration(): Promise<GitSetupResult> {
  return invoke<GitSetupResult>("git_reconnect_collaboration");
}

/** Current git status for the open notebox, or `null` when it is not
 *  collaborative or not yet a repo. */
export async function gitStatus(): Promise<GitStatusSummary | null> {
  return invoke<GitStatusSummary | null>("git_status");
}

/** The files an export/sync would carry to collaborators — the working tree
 *  changed since the last share. Empty when nothing is pending or the notebox
 *  is not a repo. */
export async function gitChangesToShare(): Promise<GitDigestEntry[]> {
  return invoke<GitDigestEntry[]>("git_changes_to_share");
}

/** The notebox's notes that still have unresolved `#suggestion(...)` tracked
 *  changes awaiting an accept/reject decision. Empty when nothing is
 *  outstanding or the notebox is not collaborative. */
export async function gitUnresolvedChanges(): Promise<GitUnresolvedEntry[]> {
  return invoke<GitUnresolvedEntry[]>("git_unresolved_changes");
}

/** The notes the most recent sync changed, relative to the recorded pre-sync
 *  baseline, each flagged whether the merge took theirs. Drives the merge-first
 *  "Changes since last sync" review list + indicator. Empty when nothing has
 *  been synced yet or the last sync changed nothing locally. */
export async function gitChangesSinceSync(): Promise<GitSinceSyncEntry[]> {
  return invoke<GitSinceSyncEntry[]>("git_changes_since_sync");
}

/** One note's hunk-level diff against its pre-sync baseline — the per-note
 *  review surface. Compares the baseline blob with the live working text, so a
 *  reverted hunk drops from the next diff. */
export async function gitNoteSyncDiff(path: string): Promise<GitSyncNoteDiff> {
  return invoke<GitSyncNoteDiff>("git_note_sync_diff", { path });
}

/** Revert a single hunk of a note to its pre-sync baseline, identified by its
 *  current-side line range (from `gitNoteSyncDiff`). Throws (BadRequest) when
 *  the range no longer matches a hunk — the caller should refetch the diff. */
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

/** Stop collaborating: drop the notebox's git config. With `deleteHistory`,
 *  also remove the `.git` directory (the version history) to reclaim disk space
 *  — irreversible. Stored credentials are left intact either way. */
export async function gitDisableCollaboration(deleteHistory: boolean): Promise<void> {
  return invoke<void>("git_disable_collaboration", { deleteHistory });
}

/** Clone a collaborative notebox from a git remote into `dest` (a collaborator
 *  joining in-app). Saves the optional sign-in username + password first.
 *  Returns the cloned notebox path; the caller registers + opens it. */
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

/** Sync the notebox: pull + merge incoming changes, then push. On a conflict
 *  the result is `paused` — resolve the staged conflict notes, then finalize. */
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

// ── Phase 7: offline package handoff (server-less collaboration) ──
// Export the open notebox's whole git history to a single file; the recipient
// imports it as a new notebox or reconciles it into one they already have.

/** Set up the open notebox for server-less collaboration (no remote) — version
 *  history + package export/import without a hosted git server. Counterpart to
 *  `gitSetupCollaboration`; persists a git config with an empty remote. */
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

/** Import a received package into the open notebox, reconciling its history
 *  with ours through the same merge as Sync (no push). On a conflict the result
 *  is `paused` — resolve the staged notes, then finalize with `push = false`. */
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

/** Set whether the open notebox bundles its Typst packages when sharing.
 *  Enabling vendors current packages immediately; returns what was bundled and
 *  any specs that couldn't be located. */
export async function gitSetBundlePackages(
  enabled: boolean,
): Promise<GitBundlePackagesResult> {
  return invoke<GitBundlePackagesResult>("git_set_bundle_packages", { enabled });
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

/** One file chosen in {@link pickFilesForImport}: its path and whether it's a
 *  markdown source (so the UI can offer "convert to Typst?" only for those). */
export interface PickedImportFile {
  path: string;
  is_markdown: boolean;
}

/**
 * Open a native multi-file picker and return the chosen files' paths plus a
 * markdown flag — WITHOUT copying anything. Each path is authorized for a
 * follow-up {@link copyPathToAttachments} (keep) or {@link importMarkdownFile}
 * (convert) call. Empty array if the user cancelled. Backs "Copy into notebox",
 * which asks per-operation whether to convert markdown to Typst.
 */
export async function pickFilesForImport(): Promise<PickedImportFile[]> {
  return invoke<PickedImportFile[]>("pick_files_for_import");
}

/**
 * Convert a markdown file (by absolute path) into a `.typ` note at the notebox
 * root, returning the new note's notebox-relative path. The path must have been
 * authorized by a recent OS drag-drop or {@link pickFilesForImport}.
 */
export async function importMarkdownFile(sourcePath: string): Promise<string> {
  return invoke<string>("import_markdown_file", { sourcePath });
}

/**
 * Convert markdown bytes (base64 UTF-8) into a `.typ` note at the notebox root,
 * returning its notebox-relative path. The bytes-only sibling of
 * {@link importMarkdownFile} for the Windows HTML5 drag-drop path.
 */
export async function importMarkdownText(
  filename: string,
  contentBase64: string,
): Promise<string> {
  return invoke<string>("import_markdown_text", { filename, contentBase64 });
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

export interface IndexStats {
  file_count: number;
  collection_count: number;
  property_keys: string[];
}

/**
 * User-initiated "Rebuild cache": discard this notebox's persisted caches and
 * rebuild every index (links, tags/properties, search, Mycelial corpus) from
 * disk. Re-parses the whole notebox, so it can take seconds-to-minutes on a
 * large one — drive a busy state off the returned promise. The backend emits
 * the same refresh events as a notebox open, so other panels update on
 * completion.
 */
export async function rebuildNoteboxIndexes(): Promise<IndexStats> {
  return invoke<IndexStats>("rebuild_notebox_indexes");
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

/**
 * Read the native clipboard (file references or raw image bytes), copy
 * the content into the notebox attachment folder, and return the
 * notebox-relative paths to insert. Used by the paste handler when the
 * webview's clipboardData yields nothing — the WebKitGTK case on Linux.
 */
export async function pasteClipboardToAttachments(): Promise<string[]> {
  return invoke<string[]>("paste_clipboard_to_attachments");
}

/**
 * Read a notebox media file's bytes as an ArrayBuffer. Backs `#video`/`#audio`
 * playback via a `blob:` URL — WebKitGTK doesn't reliably stream media through
 * the asset protocol, so we load the bytes and wrap them in a blob instead.
 * `path` is a notebox-root-absolute path (e.g. `/Assets/clip.mp4`).
 */
export async function readMediaBytes(path: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("read_media_bytes", { target: path });
}

/**
 * Read an embedded image's bytes as an ArrayBuffer. Backs the visual editor's
 * `#image` widgets via a `blob:` URL — the asset protocol fails for images on
 * Windows (the canonicalized `\\?\` path is denied by the scope glob), so the
 * blob path renders reliably on every OS. `path` accepts the same forms as
 * {@link resolveEmbedPath} (notebox-root-absolute, relative, or bare filename).
 */
export async function readEmbedBytes(path: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("read_embed_bytes", { target: path });
}

export async function showInExplorer(path: string): Promise<void> {
  return invoke<void>("show_in_explorer", { path });
}

export async function openFileExternally(path: string): Promise<void> {
  return invoke<void>("open_file_externally", { path });
}

/**
 * Open an external URL (http(s), mailto, or a custom app scheme such as
 * zotero:// / obsidian://) in the OS default handler. Dangerous and
 * `file:` schemes are refused by the backend.
 */
export async function openUrlExternally(url: string): Promise<void> {
  return invoke<void>("open_url_externally", { url });
}

/**
 * Read a bundled third-party licence notices file (Settings → Sources). `kind`
 * is validated against a fixed allowlist on the backend, so it can never be an
 * arbitrary path.
 */
export async function readThirdPartyNotices(kind: "rust" | "js"): Promise<string> {
  return invoke<string>("read_third_party_notices", { kind });
}

/** The running app's version string, e.g. `26.6.1`. */
export async function appVersion(): Promise<string> {
  return invoke<string>("app_version");
}

/** The newest release on Codeberg, as returned by `check_latest_release`. */
export interface LatestRelease {
  /** Version with any leading `v` stripped, e.g. `26.6.10`. */
  version: string;
  /** Release page URL to open in the browser. */
  url: string;
  /** Release notes (may be empty). */
  notes: string;
  /** Whether this is a pre-release (beta) build. */
  isPrerelease: boolean;
}

/** Ask the backend for the latest release from Codeberg's API. With
 *  `includeBeta`, pre-releases are considered; otherwise stable only. The
 *  caller compares `version` against `appVersion()`. Throws on network failure. */
export async function checkLatestRelease(includeBeta: boolean): Promise<LatestRelease> {
  return invoke<LatestRelease>("check_latest_release", { includeBeta });
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
  /** True for the system scaffolds (new-note, daily-note), which must not
   *  offer a delete affordance. Always false for non-scaffold entries. */
  builtin: boolean;
}

export async function listScaffoldEntries(): Promise<TemplateEntry[]> {
  return invoke<TemplateEntry[]>("list_scaffold_entries");
}

/**
 * Delete a user-created scaffold (moved to the OS trash, recoverable). The
 * backend refuses to delete the system scaffolds; the panel hides their delete
 * button so this only fires for user scaffolds.
 */
export async function deleteScaffold(scaffoldName: string): Promise<void> {
  return invoke<void>("delete_scaffold", { scaffoldName });
}

/**
 * Create a new scaffold file, returning its absolute path. When `content` is
 * omitted the backend seeds the file with the starter template (see
 * {@link getScaffoldStarter}); when supplied, it's written verbatim. Passing
 * the edited content here keeps create+write atomic in a single command.
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

/** The apply show-rule (`#show: <fn>.with(…)`) read from an installed template
 *  package's starter scaffold, to drop into a collection's Custom Typst. When
 *  `collectionPath` is given, the rule's `bibliography("…")` is pointed at the
 *  collection's auto-generated hidden bib. Returns null when the spec isn't an
 *  installed template or has no such rule. */
export async function getTemplateStarter(
  spec: string,
  collectionPath?: string,
): Promise<string | null> {
  return invoke<string | null>("get_template_starter", { spec, collectionPath });
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

/// How an export should treat the collaboration review layer (inline
/// `#suggestion` tracked changes plus `#annotation` notes). Mirrors
/// `ReviewMarkupMode::from_opt` on the Rust side.
export type ReviewMarkupMode = "accept" | "reject" | "keep";

export async function exportNotePdfToFile(
  path: string,
  outputPath: string,
  metadataMode: string = "exclude",
  pdfStandard?: PdfStandardPreset,
  includeBibliography?: boolean,
  reviewMode?: ReviewMarkupMode,
): Promise<void> {
  return invoke<void>("export_note_pdf_to_file", {
    path,
    outputPath,
    metadataMode,
    pdfStandard: pdfStandard ?? null,
    includeBibliography: includeBibliography ?? null,
    reviewMode: reviewMode ?? null,
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
): Promise<void> {
  return invoke<void>("export_note_html", {
    path,
    outputPath,
    metadataMode,
    stripWikilinks,
    includeBibliography: includeBibliography ?? null,
    reviewMode: reviewMode ?? null,
  });
}

/// Count of collaboration review-markup constructs in a note (suggestions +
/// annotations). Drives whether the export dialog shows its "Review markup"
/// control.
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
): Promise<void> {
  return invoke<void>("export_collection_note_pdf", {
    notePath,
    collectionPath,
    outputPath,
    metadataMode: metadataMode ?? null,
    pdfStandard: pdfStandard ?? null,
    includeBibliography: includeBibliography ?? null,
    reviewMode: reviewMode ?? null,
  });
}

export async function exportCollectionBatchPdf(
  collectionPath: string,
  viewName: string,
  outputDir: string,
  metadataMode?: string,
  pdfStandard?: PdfStandardPreset,
  includeBibliography?: boolean,
  reviewMode?: ReviewMarkupMode,
): Promise<string[]> {
  return invoke<string[]>("export_collection_batch_pdf", {
    collectionPath,
    viewName,
    outputDir,
    metadataMode: metadataMode ?? null,
    pdfStandard: pdfStandard ?? null,
    includeBibliography: includeBibliography ?? null,
    reviewMode: reviewMode ?? null,
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
}

/// Outcome of a book export. `outputPath` is set when the PDF was written.
/// Otherwise `failingNotes` (note stems) lists the notes that failed to
/// compile — the caller can re-export passing them as `excludeNotes` to omit
/// them — and `message` is the human-readable diagnostic. A failure no
/// exclusion could fix is thrown as an error instead of returned here.
export interface BookExportResult {
  outputPath: string | null;
  failingNotes: string[];
  message: string | null;
}

export async function exportCollectionBookPdf(
  collectionPath: string,
  viewName: string,
  outputPath: string,
  overrides?: BookExportOverrides,
  excludeNotes?: string[],
): Promise<BookExportResult> {
  return invoke<BookExportResult>("export_collection_book_pdf", {
    collectionPath,
    viewName,
    outputPath,
    overrides: overrides ?? null,
    excludeNotes: excludeNotes ?? null,
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

/// The Markdown fixes the user accepted for one file — a subset of that file's
/// audited `fixes` (rejected changes are omitted). Mirrors the Rust
/// `FileMdEdits`.
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
/// absolute path, so the user can open it and work through the findings while
/// editing files in other tabs.
export async function saveAuditReport(): Promise<string> {
  return invoke<string>("save_audit_report");
}

/// Result of a static-site export. `files` are the artifacts written;
/// `skippedNotes` lists notes that couldn't be compiled (as "name: reason")
/// and were left out, so the caller can tell the user what to fix. A run
/// where every note fails rejects instead.
export interface StaticSiteExportResult {
  files: string[];
  skippedNotes: string[];
}

export async function exportCollectionStaticSite(
  collectionPath: string,
  viewName: string,
  outputDir: string,
): Promise<StaticSiteExportResult> {
  return invoke<StaticSiteExportResult>("export_collection_static_site", {
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
  reviewMode?: ReviewMarkupMode,
): Promise<void> {
  return invoke<void>("export_via_pandoc", {
    path,
    outputPath,
    format,
    metadataMode,
    reviewMode: reviewMode ?? null,
  });
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

/** Render the references cited in `path` as static, pre-formatted Typst markup
 *  (in the notebox's citation style) for placing on the clipboard. Returns an
 *  empty string when the file cites nothing. */
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

export interface ImportResult {
  notes_converted: number;
  files_copied: number;
  errors: string[];
  /** LaTeX equations preserved as code blocks because the mitex package
   *  isn't installed. Non-zero → show the user how to render them. */
  math_as_code: number;
}

export type MarkdownDialect = "standard" | "obsidian";

/// One distinct YAML frontmatter key found across the source notebox, with
/// the import dialog's suggested InkyCap mapping. Field names mirror the
/// Rust `FrontmatterKeyInfo` (snake_case) so no remapping is needed.
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

/// One row of the user's confirmed YAML→property mapping sent back to the
/// importer. `target_key: null` excludes the property; `create` marks a new
/// property whose `target_type` should be registered.
export interface PropertyMapping {
  source_key: string;
  target_key: string | null;
  target_type: PropertyType;
  create: boolean;
}

/// Scan every markdown file's YAML frontmatter in the source archive (or
/// directory) and report the distinct keys with suggested mappings. Drives
/// the property-mapping dialog shown before the import runs.
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
  reviewMode?: ReviewMarkupMode,
): Promise<void> {
  return invoke<void>("export_note_markdown_to_file", {
    path,
    outputPath,
    unconvertibleMode,
    reviewMode: reviewMode ?? null,
  });
}

export async function exportCollectionBatchMarkdown(
  collectionPath: string,
  viewName: string,
  outputDir: string,
  unconvertibleMode: UnconvertibleMode,
  reviewMode?: ReviewMarkupMode,
): Promise<string[]> {
  return invoke<string[]>("export_collection_batch_markdown", {
    collectionPath,
    viewName,
    outputDir,
    unconvertibleMode,
    reviewMode: reviewMode ?? null,
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

/** Cooperatively cancel a backup that's currently in flight. Returns
 *  immediately; the actual abort happens at the next cancel-poll
 *  inside the archive writer (between file entries or 64KiB chunks).
 *  Safe to call when no backup is running. */
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

/** Pull selected entries out of an archive into `targetRoot`.
 *
 *  Pass `passwordOverride` when the user typed a password specifically
 *  for this restore (e.g. the archive predates the current keychain
 *  password and needs the older one). Leave it undefined to fall back
 *  to whatever the OS keychain holds — the historical behaviour and
 *  what most restores want. */
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
