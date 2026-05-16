import {
  Component,
  createEffect,
  createMemo,
  createSignal,
  createResource,
  For,
  Show,
  onCleanup,
} from "solid-js";
import {
  LibraryBig,
  FolderTree,
  Tags,
  Search,
  BookMarked,
  FilePlus2,
  Folder,
  Upload,
  Tag,
  X,
  ChevronRight,
  ChevronDown,
  FileText,
  NotebookTabs,
  Filter,
  ArrowDownNarrowWide,
  ListChevronsUpDown,
  ListChevronsDownUp,
} from "lucide-solid";
import RuleIcon from "./RuleIcon";
import type { CollectionInfo, FileTreeNode, PropertyType } from "../lib/types";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ask, message } from "@tauri-apps/plugin-dialog";
import * as ipc from "../lib/ipc";
import { anchorPanelMenu } from "../lib/uiMenu";
import { settings } from "../stores/settings";
import { noteboxInfo, fileTreeVersion, propertyVersion, bumpPropertyVersion } from "../stores/notebox";
import { openTab, closeTab, tabs, getActiveTab } from "../stores/tabs";
import {
  isEnabled as isScrollEnabled,
  getMode as getScrollMode,
  updateAnchor as updateScrollAnchor,
} from "../stores/journal-scroll";
import {
  PROPERTY_TYPE_OPTIONS,
  propertyTypeLabel,
  reloadPropertyTypes,
  allPropertyTypes,
} from "../stores/propertyTypes";
import SearchPanel from "./SearchPanel";
import BookmarksPanel from "./BookmarksPanel";
import TemplatesPanel from "./TemplatesPanel";
import type { SidebarMode } from "./VerticalToolbar";
import { toastError, toastSuccess } from "../stores/toasts";
import { promptText } from "../stores/prompt";
import { pickFolder } from "../stores/folderPicker";
import { registerCommand, unregisterCommand } from "../lib/command-registry";

interface LeftSidebarProps {
  mode: () => SidebarMode;
  setMode: (m: SidebarMode) => void;
}

const TYPST_EXTS = new Set([".typ"]);
const HIDDEN_NAMES = new Set([".inkycap"]);

function filterTypstFiles(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes
    .filter((n) => !HIDDEN_NAMES.has(n.name))
    .map((n) => {
      if (n.is_dir) {
        const children = n.children ? filterTypstFiles(n.children) : [];
        if (children.length === 0) return null;
        return { ...n, children };
      }
      const ext = n.name.lastIndexOf(".") >= 0 ? n.name.slice(n.name.lastIndexOf(".")) : "";
      return TYPST_EXTS.has(ext) ? n : null;
    })
    .filter((n): n is FileTreeNode => n !== null);
}

type FileSortMode =
  | "name-asc"
  | "name-desc"
  | "modified-desc"
  | "modified-asc"
  | "created-desc"
  | "created-asc";

type ListSortMode = "name-asc" | "name-desc" | "count-desc" | "count-asc";

const FILE_SORT_OPTIONS: { value: FileSortMode; label: string }[] = [
  { value: "name-asc", label: "Name (A to Z)" },
  { value: "name-desc", label: "Name (Z to A)" },
  { value: "modified-desc", label: "Modified (new to old)" },
  { value: "modified-asc", label: "Modified (old to new)" },
  { value: "created-desc", label: "Created (new to old)" },
  { value: "created-asc", label: "Created (old to new)" },
];

const LIST_SORT_OPTIONS: { value: ListSortMode; label: string }[] = [
  { value: "name-asc", label: "Alphabetical (A to Z)" },
  { value: "name-desc", label: "Alphabetical (Z to A)" },
  { value: "count-desc", label: "Quantity (high to low)" },
  { value: "count-asc", label: "Quantity (low to high)" },
];

/// Sort one level of a file tree. The `grouping` parameter controls
/// whether directories cluster before files ("before"), after files
/// ("after"), or interleave with them under the chosen sort ("inline").
/// Recurses into children so the entire subtree honors both settings.
function sortFileTree(
  nodes: FileTreeNode[],
  mode: FileSortMode,
  grouping: "before" | "after" | "inline",
): FileTreeNode[] {
  const cmp = (a: FileTreeNode, b: FileTreeNode): number => {
    if (grouping !== "inline" && a.is_dir !== b.is_dir) {
      return grouping === "before" ? (a.is_dir ? -1 : 1) : (a.is_dir ? 1 : -1);
    }
    switch (mode) {
      case "name-asc":
        return a.name.localeCompare(b.name);
      case "name-desc":
        return b.name.localeCompare(a.name);
      case "modified-desc":
        return b.modified_time - a.modified_time;
      case "modified-asc":
        return a.modified_time - b.modified_time;
      case "created-desc":
        return b.created_time - a.created_time;
      case "created-asc":
        return a.created_time - b.created_time;
    }
  };
  return nodes
    .map((n) => (n.children ? { ...n, children: sortFileTree(n.children, mode, grouping) } : n))
    .sort(cmp);
}

/// Walk a tree and collect the paths of every directory node.
function collectDirPaths(nodes: FileTreeNode[], acc: Set<string> = new Set()): Set<string> {
  for (const n of nodes) {
    if (n.is_dir) {
      acc.add(n.path);
      if (n.children) collectDirPaths(n.children, acc);
    }
  }
  return acc;
}

/// "Library +" glyph for the New Collection button. lucide-solid has no
/// library-plus icon, so this is a local SVG: the lucide `library-big`
/// book spine with a plus mark in place of the second volume. Stroke
/// styling matches lucide (currentColor, width 2, round caps) so it
/// renders identically to the sibling toolbar icons.
function LibraryPlusIcon(props: { size?: number }) {
  return (
    <svg
      width={props.size ?? 18}
      height={props.size ?? 18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect width="8" height="18" x="3" y="3" rx="1" />
      <path d="M7 3v18" />
      <g transform="translate(5.2876713,6.0535492)">
        <path d="m12 7v6" />
        <path d="m9 10h6" />
      </g>
    </svg>
  );
}

const LeftSidebar: Component<LeftSidebarProps> = (props) => {
  const mode = props.mode;
  const setMode = props.setMode;
  const [refreshTick, setRefreshTick] = createSignal(0);
  const [typstOnly, setTypstOnly] = createSignal(true);

  // File tree: sort mode + per-folder expansion state hoisted from the
  // TreeNode component so the Expand All / Collapse All button can flip
  // every folder in one click. Default to all-collapsed (empty set).
  const [fileSortMode, setFileSortMode] = createSignal<FileSortMode>("name-asc");
  const [showFileSortMenu, setShowFileSortMenu] = createSignal(false);
  const [expandedDirs, setExpandedDirs] = createSignal<Set<string>>(new Set());
  const [showNewMenu, setShowNewMenu] = createSignal(false);

  // File tree drag-and-drop: path of the directory (or "" for notebox
  // root) currently hovered as a move target, so the row can highlight.
  const [dragOverDir, setDragOverDir] = createSignal<string | null>(null);

  // Collections: sort mode + inline search filter. Sort reuses the File
  // Tree options (name / modified / created) per product spec — the
  // Tags/Properties "by quantity" options don't apply to collections.
  const [collectionSortMode, setCollectionSortMode] = createSignal<FileSortMode>("name-asc");
  const [showCollectionSortMenu, setShowCollectionSortMenu] = createSignal(false);
  const [showCollectionSearch, setShowCollectionSearch] = createSignal(false);
  const [collectionFilter, setCollectionFilter] = createSignal("");

  // Refs for panel-menu trigger buttons, used by anchorPanelMenu to place
  // each dropdown at fixed viewport coords (escapes left-sidebar's
  // overflow:hidden and flips off-screen positions).
  let fileSortBtnRef: HTMLButtonElement | undefined;
  let tagSortBtnRef: HTMLButtonElement | undefined;
  let propSortBtnRef: HTMLButtonElement | undefined;
  let collectionSortBtnRef: HTMLButtonElement | undefined;
  let newMenuBtnRef: HTMLButtonElement | undefined;

  // Tags / Properties: sort mode + inline search filter. Each pane gets
  // its own state so switching modes doesn't lose the user's filter.
  const [tagSortMode, setTagSortMode] = createSignal<ListSortMode>("name-asc");
  const [showTagSortMenu, setShowTagSortMenu] = createSignal(false);
  const [showTagSearch, setShowTagSearch] = createSignal(false);
  const [tagFilter, setTagFilter] = createSignal("");

  const [propSortMode, setPropSortMode] = createSignal<ListSortMode>("name-asc");
  const [showPropSortMenu, setShowPropSortMenu] = createSignal(false);
  const [showPropSearch, setShowPropSearch] = createSignal(false);
  const [propFilter, setPropFilter] = createSignal("");

  // Context menu state
  const [contextMenu, setContextMenu] = createSignal<{
    x: number;
    y: number;
    collection: CollectionInfo;
  } | null>(null);

  // Rename state
  const [renamingPath, setRenamingPath] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal("");

  const [collections, { refetch: refetchCollections }] = createResource(
    () => ({ info: noteboxInfo(), tick: refreshTick(), version: fileTreeVersion() }),
    async ({ info }) => {
      if (!info) return [];
      return ipc.listCollections();
    },
  );

  const [fileTree, { refetch: refetchFileTree }] = createResource(
    () => ({ info: noteboxInfo(), tick: refreshTick(), version: fileTreeVersion() }),
    async ({ info }) => {
      if (!info) return [];
      return ipc.getFileTree();
    },
  );

  const filteredFileTree = createMemo(() => {
    const tree = fileTree();
    if (!tree) return [];
    const filtered = typstOnly() ? filterTypstFiles(tree) : tree;
    return sortFileTree(filtered, fileSortMode(), settings.appearance.folder_grouping);
  });

  /// Collections, filtered by the inline search box and ordered by the
  /// chosen File-Tree-style sort mode. Date modes fall back gracefully
  /// when a `.collection` file reports a zero (unknown) timestamp.
  const sortedFilteredCollections = createMemo(() => {
    const list = collections() ?? [];
    const q = collectionFilter().trim().toLowerCase();
    const filtered = q
      ? list.filter((c) => c.name.toLowerCase().includes(q))
      : list.slice();
    const mode = collectionSortMode();
    return filtered.sort((a, b) => {
      switch (mode) {
        case "name-asc":
          return a.name.localeCompare(b.name);
        case "name-desc":
          return b.name.localeCompare(a.name);
        case "modified-desc":
          return b.modified_time - a.modified_time;
        case "modified-asc":
          return a.modified_time - b.modified_time;
        case "created-desc":
          return b.created_time - a.created_time;
        case "created-asc":
          return a.created_time - b.created_time;
      }
    });
  });

  function toggleDir(path: string) {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function expandAllDirs() {
    setExpandedDirs(collectDirPaths(filteredFileTree()));
  }

  function collapseAllDirs() {
    setExpandedDirs(new Set<string>());
  }

  /// True when there is at least one directory in the tree and every
  /// directory is currently expanded. Used to flip the toolbar button
  /// between "Expand all" and "Collapse all".
  const allDirsExpanded = createMemo(() => {
    const all = collectDirPaths(filteredFileTree());
    if (all.size === 0) return false;
    const cur = expandedDirs();
    for (const p of all) if (!cur.has(p)) return false;
    return true;
  });

  /// Sort + filter helper shared by Tags and Properties. Both panes use
  /// the same `[name, count]` data shape.
  function sortAndFilterList(
    items: [string, number][],
    mode: ListSortMode,
    filter: string,
  ): [string, number][] {
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? items.filter(([k]) => k.toLowerCase().includes(q))
      : items.slice();
    const cmp = (a: [string, number], b: [string, number]) => {
      switch (mode) {
        case "name-asc":
          return a[0].localeCompare(b[0]);
        case "name-desc":
          return b[0].localeCompare(a[0]);
        case "count-desc":
          return b[1] - a[1] || a[0].localeCompare(b[0]);
        case "count-asc":
          return a[1] - b[1] || a[0].localeCompare(b[0]);
      }
    };
    return filtered.sort(cmp);
  }

  const [noteboxIndex, { refetch: refetchNoteboxIndex }] = createResource(
    () => ({ info: noteboxInfo(), tick: refreshTick(), pv: propertyVersion() }),
    async ({ info }) => {
      if (!info) return null;
      return ipc.getNoteboxIndex();
    },
  );

  // Refetch collections when the metadata editor saves a .collection file
  const onCollectionsChanged = () => refetchCollections();
  document.addEventListener("inkycap:collections-changed", onCollectionsChanged);
  onCleanup(() => document.removeEventListener("inkycap:collections-changed", onCollectionsChanged));

  // Context menu state for tag and property items. Only one is ever open
  // at a time; the sidebar-level click-outside handler closes whichever is.
  type TagMenuState = { x: number; y: number; tag: string };
  type PropMenuState = {
    x: number;
    y: number;
    key: string;
    typeSubmenuOpen: boolean;
    openLeft: boolean;
  };
  const [tagMenu, setTagMenu] = createSignal<TagMenuState | null>(null);
  const [propMenu, setPropMenu] = createSignal<PropMenuState | null>(null);

  // Inline rename state for tags / property keys.
  const [renamingTag, setRenamingTag] = createSignal<string | null>(null);
  const [tagRenameValue, setTagRenameValue] = createSignal("");
  const [renamingProperty, setRenamingProperty] = createSignal<string | null>(null);
  const [propertyRenameValue, setPropertyRenameValue] = createSignal("");

  // "Show in File Tree" reveal support
  const [revealPath, setRevealPath] = createSignal<string | null>(null);

  const onRevealInTree = (e: Event) => {
    const path = (e as CustomEvent<string>).detail;
    if (!path) return;
    setMode("filetree");
    setRevealPath(path);
    // Clear after a tick so scroll-into-view has time to fire
    setTimeout(() => setRevealPath(null), 500);
  };
  document.addEventListener("inkycap:reveal-in-tree", onRevealInTree);
  onCleanup(() => document.removeEventListener("inkycap:reveal-in-tree", onRevealInTree));

  // Other panels (e.g. SearchPanel) bookmark items asynchronously and
  // dispatch this event to make the Bookmarks pane re-query.
  const onBookmarksChanged = () => setRefreshTick((t) => t + 1);
  document.addEventListener("inkycap:bookmarks-changed", onBookmarksChanged);
  onCleanup(() =>
    document.removeEventListener("inkycap:bookmarks-changed", onBookmarksChanged),
  );

  function openSearchFor(query: string) {
    setMode("search");
    document.dispatchEvent(
      new CustomEvent("inkycap:open-search", { detail: { query } }),
    );
  }

  // Approximate menu size. The submenu adds another ~200x220 to the
  // right, but we only need to keep the top-level menu inside the
  // viewport — the submenu reflows naturally once its parent fits.
  const MENU_W = 180;
  const MENU_H = 160;
  function clampMenuPos(x: number, y: number) {
    const maxX = Math.max(8, window.innerWidth - MENU_W - 8);
    const maxY = Math.max(8, window.innerHeight - MENU_H - 8);
    return { x: Math.min(x, maxX), y: Math.min(y, maxY) };
  }

  function handleTagContext(e: MouseEvent, tag: string) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu(null);
    setFileContextMenu(null);
    setPropMenu(null);
    const { x, y } = clampMenuPos(e.clientX, e.clientY);
    setTagMenu({ x, y, tag });
  }

  function handlePropertyContext(e: MouseEvent, key: string) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu(null);
    setFileContextMenu(null);
    setTagMenu(null);
    const { x, y } = clampMenuPos(e.clientX, e.clientY);
    const SUBMENU_W = 180;
    const openLeft = x + MENU_W + SUBMENU_W > window.innerWidth - 8;
    setPropMenu({ x, y, key, typeSubmenuOpen: false, openLeft });
  }

  function startTagRename(tag: string) {
    setTagMenu(null);
    setRenamingTag(tag);
    setTagRenameValue(tag);
  }

  async function commitTagRename() {
    const oldTag = renamingTag();
    const newTag = tagRenameValue().trim();
    setRenamingTag(null);
    if (!oldTag || !newTag || oldTag === newTag) return;

    const existing = noteboxIndex()?.tags.find(([t]) => t === newTag);
    if (existing) {
      const ok = await ask(
        `A tag already exists with the name "${newTag}". Renaming "${oldTag}" will merge tags into "${newTag}". Continue?`,
        { title: "Merge tags", kind: "warning" },
      );
      if (!ok) return;
    }

    try {
      await ipc.renameTag(oldTag, newTag);
      refresh();
      refetchNoteboxIndex();
    } catch (err) {
      toastError("Failed to rename tag", err);
    }
  }

  async function handleDeleteTag(tag: string) {
    setTagMenu(null);
    const ok = await ask(
      `Delete tag "${tag}" from every note that uses it? This cannot be undone.`,
      { title: "Delete tag", kind: "warning" },
    );
    if (!ok) return;
    try {
      await ipc.deleteTag(tag);
      refresh();
      refetchNoteboxIndex();
    } catch (err) {
      toastError("Failed to delete tag", err);
    }
  }

  function startPropertyRename(key: string) {
    setPropMenu(null);
    setRenamingProperty(key);
    setPropertyRenameValue(key);
  }

  async function commitPropertyRename() {
    const oldKey = renamingProperty();
    const newKey = propertyRenameValue().trim();
    setRenamingProperty(null);
    if (!oldKey || !newKey || oldKey === newKey) return;

    const existing = noteboxIndex()?.property_keys.find(([k]) => k === newKey);
    if (existing) {
      const oldType = allPropertyTypes()[oldKey];
      const newType = allPropertyTypes()[newKey];
      const typeConflict = oldType && newType && oldType !== newType;
      const msg = typeConflict
        ? `A property already exists with the name "${newKey}" (type: ${propertyTypeLabel(newType)}). Renaming "${oldKey}" (type: ${propertyTypeLabel(oldType)}) will merge properties into "${newKey}" using the "${propertyTypeLabel(newType)}" type. Values may need manual correction. Continue?`
        : `A property already exists with the name "${newKey}". Renaming "${oldKey}" will merge properties into "${newKey}". Continue?`;
      const ok = await ask(msg, { title: "Merge properties", kind: "warning" });
      if (!ok) return;
    }

    try {
      await ipc.renamePropertyKey(oldKey, newKey);
      await reloadPropertyTypes();
      bumpPropertyVersion();
      refresh();
      refetchNoteboxIndex();
    } catch (err) {
      toastError("Failed to rename property", err);
    }
  }

  async function handleDeleteProperty(key: string) {
    setPropMenu(null);
    const ok = await ask(
      `Delete property "${key}" from every note that uses it? This cannot be undone.`,
      { title: "Delete property", kind: "warning" },
    );
    if (!ok) return;
    try {
      await ipc.deletePropertyKey(key);
      await reloadPropertyTypes();
      bumpPropertyVersion();
      refresh();
      refetchNoteboxIndex();
    } catch (err) {
      toastError("Failed to delete property", err);
    }
  }

  async function setPropertyTypeFor(key: string, ty: PropertyType) {
    setPropMenu(null);
    try {
      await ipc.setPropertyType(key, ty);
      await reloadPropertyTypes();
      refresh();
    } catch (err) {
      toastError("Failed to change property type", err);
    }
  }

  function openCollection(col: CollectionInfo) {
    openTab({
      type: "collection",
      title: col.name,
      path: col.path,
    });
  }

  const BINARY_EXTENSIONS = new Set([
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg",
    "pdf", "zip", "tar", "gz", "7z", "rar",
    "mp3", "wav", "ogg", "flac", "mp4", "webm", "mkv", "avi",
    "woff", "woff2", "ttf", "otf", "eot",
  ]);

  function isBinaryFile(name: string): boolean {
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    return BINARY_EXTENSIONS.has(ext);
  }

  function openFile(node: FileTreeNode, e?: MouseEvent) {
    if (node.is_dir) return;
    const forceNewTab = !!(e && (e.ctrlKey || e.metaKey));
    const isCollection = node.name.toLowerCase().endsWith(".collection");

    // When the active tab is a Journal Scroll in Tree mode, a plain click on
    // a note in the file tree re-anchors the scroll on that note (Tree mode
    // is meant to be steered from the tree) rather than opening it as its
    // own tab. Ctrl/Cmd-click still opens it in a new tab as usual.
    if (!forceNewTab && !isCollection && !isBinaryFile(node.name)) {
      const active = getActiveTab();
      if (
        active &&
        isScrollEnabled(active.id) &&
        getScrollMode(active.id) === "tree"
      ) {
        void updateScrollAnchor(active.id, node.path);
        return;
      }
    }

    if (isCollection) {
      openTab(
        {
          type: "collection",
          title: node.name.replace(/\.collection$/i, ""),
          path: node.path,
        },
        { forceNewTab },
      );
      return;
    }
    if (isBinaryFile(node.name)) {
      ipc.openFileExternally(node.path);
      return;
    }
    openTab(
      { type: "file", title: node.name, path: node.path },
      { forceNewTab },
    );
  }

  function openFileInNewTab(node: FileTreeNode) {
    if (node.is_dir) return;
    if (node.name.toLowerCase().endsWith(".collection")) {
      openTab(
        {
          type: "collection",
          title: node.name.replace(/\.collection$/i, ""),
          path: node.path,
        },
        { forceNewTab: true },
      );
      return;
    }
    openTab(
      { type: "file", title: node.name, path: node.path },
      { forceNewTab: true },
    );
  }

  function refresh() {
    setRefreshTick((t) => t + 1);
  }

  /// MIME type carrying a file-tree node during an intra-sidebar move
  /// drag. Distinct from `application/x-inkycap-notebox-path` (which the
  /// editor consumes to embed a file) so a tree move never registers as
  /// an embed and vice versa.
  const TREE_MOVE_MIME = "application/x-inkycap-tree-move";

  /// Context-menu entry point: open the folder picker, then move the
  /// node into the chosen folder. The picker is notebox-scoped and hides
  /// the node's own subtree (for folders) and current parent, so every
  /// returned destination is a valid, non-trivial move.
  async function moveNodeViaDialog(node: FileTreeNode) {
    setFileContextMenu(null);
    const root = noteboxInfo()?.path ?? "";
    const slash = node.path.lastIndexOf("/");
    const currentParent = slash >= 0 ? node.path.slice(0, slash) : root;
    const dest = await pickFolder({
      title: node.is_dir ? "Move folder to..." : "Move file to...",
      disallowPrefix: node.is_dir ? node.path : undefined,
      currentParent,
    });
    if (dest == null) return;
    const destDir = dest === "" ? root : `${root}/${dest}`;
    moveNode({ path: node.path, is_dir: node.is_dir }, destDir);
  }

  /// Move a dragged file or folder into `destDir` (an absolute path, or
  /// the notebox root). Rejects no-op moves and folder-into-self up front;
  /// the backend rebases relative asset paths and reindexes, and the
  /// file watcher refreshes the tree — `refresh()` is belt-and-braces so
  /// the move shows immediately even if the watcher event is debounced.
  async function moveNode(
    src: { path: string; is_dir: boolean },
    destDir: string,
  ) {
    const root = noteboxInfo()?.path ?? "";
    const slash = src.path.lastIndexOf("/");
    const srcParent = slash >= 0 ? src.path.slice(0, slash) : root;
    if (srcParent === destDir) return; // already in that folder
    if (
      src.is_dir &&
      (destDir === src.path || destDir.startsWith(src.path + "/"))
    ) {
      toastError("Cannot move a folder into itself");
      return;
    }
    const destRel =
      destDir === root || destDir === ""
        ? ""
        : destDir.startsWith(root + "/")
          ? destDir.slice(root.length + 1)
          : destDir;
    try {
      if (src.is_dir) {
        await ipc.moveFolder(src.path, destRel);
      } else {
        await ipc.moveFile(src.path, destRel);
      }
      refresh();
    } catch (e) {
      toastError("Failed to move item", e);
    }
  }

  // ── Collection CRUD ──

  async function createCollection() {
    if (!noteboxInfo()) return;
    const name = await promptText({
      title: "New collection",
      label: "Collection name",
      confirmLabel: "Create",
    });
    if (!name?.trim()) return;
    try {
      const col = await ipc.createCollectionFile(name.trim());
      refresh();
      openCollection(col);
    } catch (e) {
      toastError("Failed to create collection", e);
    }
  }

  async function deleteCollection(col: CollectionInfo) {
    setContextMenu(null);
    const confirmed = await ask(`Delete collection "${col.name}"?`, { title: "Delete collection", kind: "warning" });
    if (!confirmed) return;
    try {
      await ipc.deleteCollectionFile(col.path);
      // Close any open tab for this collection
      const openCollTab = tabs.find(
        (t) => t.type === "collection" && t.path === col.path,
      );
      if (openCollTab) closeTab(openCollTab.id);
      refresh();
    } catch (e) {
      toastError("Failed to delete collection", e);
    }
  }

  function startRename(col: CollectionInfo) {
    setContextMenu(null);
    setRenamingPath(col.path);
    setRenameValue(col.name);
  }

  async function commitRename() {
    const path = renamingPath();
    const newName = renameValue().trim();
    setRenamingPath(null);
    if (!path || !newName) return;
    try {
      await ipc.renameCollectionFile(path, newName);
      refresh();
    } catch (e) {
      toastError("Failed to rename collection", e);
    }
  }

  function handleCollectionContext(e: MouseEvent, col: CollectionInfo) {
    e.preventDefault();
    // clampMenuPos is defined below; forward-reference is fine in JS.
    const { x, y } = clampMenuPos(e.clientX, e.clientY);
    setContextMenu({ x, y, collection: col });
  }

  // ── File tree CRUD ──

  // File tree context menu state
  const [fileContextMenu, setFileContextMenu] = createSignal<{
    x: number;
    y: number;
    node: FileTreeNode;
  } | null>(null);

  // File tree rename state
  const [fileRenamingPath, setFileRenamingPath] = createSignal<string | null>(null);
  const [fileRenameValue, setFileRenameValue] = createSignal("");

  function handleFileContext(e: MouseEvent, node: FileTreeNode) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu(null);
    const { x, y } = clampMenuPos(e.clientX, e.clientY);
    setFileContextMenu({ x, y, node });
  }

  async function createNewFile(parentFolder: string) {
    setFileContextMenu(null);
    let name: string | null;
    if (settings.files.zettelkasten_enabled && settings.files.auto_title_as_zid) {
      try {
        name = await ipc.generateZid();
      } catch (e) {
        toastError("Failed to generate Zettelkasten ID", e);
        return;
      }
    } else {
      name = await promptText({
        title: "New simple file",
        label: "File name",
        confirmLabel: "Create",
      });
      if (!name?.trim()) return;
      name = name.trim();
    }
    try {
      const newPath = await ipc.createFile(name, parentFolder);
      refresh();
      const title = newPath.split(/[/\\]/).pop() ?? name;
      openTab(
        {
          type: "file",
          title,
          path: newPath,
        },
        { forceNewTab: true },
      );
    } catch (e) {
      toastError("Failed to create file", e);
    }
  }

  async function createNewFolder(parentFolder: string) {
    setFileContextMenu(null);
    const name = await promptText({
      title: "New folder",
      label: "Folder name",
      confirmLabel: "Create",
    });
    if (!name?.trim()) return;
    try {
      await ipc.createFolder(name.trim(), parentFolder);
      refresh();
    } catch (e) {
      toastError("Failed to create folder", e);
    }
  }

  function startFileRename(node: FileTreeNode) {
    setFileContextMenu(null);
    setFileRenamingPath(node.path);
    // Show name without extension for files
    const displayName = node.is_dir
      ? node.name
      : node.name.replace(/\.[^.]+$/, "");
    setFileRenameValue(displayName);
  }

  async function commitFileRename() {
    const oldPath = fileRenamingPath();
    const newName = fileRenameValue().trim();
    setFileRenamingPath(null);
    if (!oldPath || !newName) return;

    try {
      const settings = await ipc.getSettings();
      if (settings.files.auto_update_links_on_rename) {
        await ipc.renameAndUpdateLinks(oldPath, newName);
      } else {
        await ipc.renameFile(oldPath, newName);
      }
      refresh();
    } catch (e) {
      toastError("Failed to rename", e);
    }
  }

  async function handleDeleteFile(node: FileTreeNode) {
    setFileContextMenu(null);
    const settings = await ipc.getSettings();
    if (settings.files.confirm_before_delete) {
      const confirmed = await ask(
        `Move "${node.name}" to trash?`,
        { title: "Delete", kind: "warning" },
      );
      if (!confirmed) return;
    }
    try {
      if (node.is_dir) {
        await ipc.deleteFolder(node.path);
      } else {
        await ipc.deleteFile(node.path);
        // Close open tab for this file
        const openFileTab = tabs.find(
          (t) => t.type === "file" && t.path === node.path,
        );
        if (openFileTab) closeTab(openFileTab.id);
      }
      refresh();
    } catch (e) {
      toastError("Failed to delete", e);
    }
  }

  async function createNewNoteAtRoot() {
    const info = noteboxInfo();
    if (!info) return;
    await createNewFile(info.path);
  }

  // Register the "New Simple File" command in the registry. The global
  // dispatcher in keyboard.ts reads its `keybinding` ("Ctrl+N") to fire
  // this same action from a keystroke. Owned here so the local
  // file-tree refresh signal stays consistent with the trigger.
  registerCommand({
    id: "file:new-simple-file",
    title: "New Simple File",
    category: "File",
    keybinding: "Ctrl+N",
    execute: createNewNoteAtRoot,
  });
  onCleanup(() => unregisterCommand("file:new-simple-file"));

  async function createNewFolderAtRoot() {
    setShowNewMenu(false);
    const info = noteboxInfo();
    if (!info) return;
    await createNewFolder(info.path);
  }

  async function uploadIntoNotebox() {
    setShowNewMenu(false);
    try {
      const saved = await ipc.pickAndUploadToAttachments();
      if (saved.length > 0) {
        refresh();
        toastSuccess(
          saved.length === 1
            ? `Uploaded ${saved[0]}`
            : `Uploaded ${saved.length} files`,
        );
      }
    } catch (e) {
      toastError("Failed to upload", e);
    }
  }

  // Close context menus on click outside
  function handleDocClick(e: MouseEvent) {
    setContextMenu(null);
    setFileContextMenu(null);
    setTagMenu(null);
    setPropMenu(null);
    // Solid's delegated stopPropagation doesn't block this sibling
    // document listener, so check the target ourselves.
    const target = e.target as Element | null;
    if (!target?.closest(".left-sidebar__split-btn")) {
      setShowNewMenu(false);
    }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("click", handleDocClick);
    onCleanup(() => document.removeEventListener("click", handleDocClick));
  }

  return (
    <div class="left-sidebar">
      <div class="left-sidebar__mode-bar">
        <button
          class={`left-sidebar__mode-btn ${mode() === "filetree" ? "left-sidebar__mode-btn--active" : ""}`}
          onClick={() => setMode("filetree")}
          title="File Tree"
          aria-label="File Tree"
        >
          <FolderTree size={18} />
        </button>
        <button
          class={`left-sidebar__mode-btn ${mode() === "collections" ? "left-sidebar__mode-btn--active" : ""}`}
          onClick={() => setMode("collections")}
          title="Collections"
          aria-label="Collections"
        >
          <LibraryBig size={18} />
        </button>
        <button
          class={`left-sidebar__mode-btn ${mode() === "tags" ? "left-sidebar__mode-btn--active" : ""}`}
          onClick={() => setMode("tags")}
          title="Tags"
          aria-label="Tags"
        >
          <Tags size={18} />
        </button>
        <button
          class={`left-sidebar__mode-btn ${mode() === "properties" ? "left-sidebar__mode-btn--active" : ""}`}
          onClick={() => setMode("properties")}
          title="Properties"
          aria-label="Properties"
        >
          <NotebookTabs size={18} />
        </button>
        <button
          class={`left-sidebar__mode-btn ${mode() === "bookmarks" ? "left-sidebar__mode-btn--active" : ""}`}
          onClick={() => setMode("bookmarks")}
          title="Bookmarks"
          aria-label="Bookmarks"
        >
          <BookMarked size={18} />
        </button>
        <button
          class={`left-sidebar__mode-btn ${mode() === "search" ? "left-sidebar__mode-btn--active" : ""}`}
          onClick={() => setMode("search")}
          title="Search (Ctrl+Shift+F)"
          aria-label="Search"
        >
          <Search size={18} />
        </button>
      </div>
      <div class="left-sidebar__content">
        <Show when={mode() === "collections"}>
          <div class="left-sidebar__section-header">
            <span>Collections</span>
            <div class="left-sidebar__header-actions">
              <div class="left-sidebar__sort-wrap">
                <button
                  ref={collectionSortBtnRef}
                  class="left-sidebar__icon-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowCollectionSortMenu((v) => !v);
                  }}
                  title="Sort collections"
                  aria-label="Sort collections"
                >
                  <ArrowDownNarrowWide size={18} />
                </button>
                <Show when={showCollectionSortMenu()}>
                  <div
                    class="context-menu"
                    ref={(el) => anchorPanelMenu(collectionSortBtnRef, el)}
                    onMouseLeave={() => setShowCollectionSortMenu(false)}
                  >
                    <For each={FILE_SORT_OPTIONS}>
                      {(opt) => (
                        <button
                          classList={{
                            "context-menu__item": true,
                            "context-menu__item--active":
                              collectionSortMode() === opt.value,
                          }}
                          onClick={() => {
                            setCollectionSortMode(opt.value);
                            setShowCollectionSortMenu(false);
                          }}
                        >
                          {opt.label}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
              <button
                class={`left-sidebar__icon-btn${showCollectionSearch() ? " left-sidebar__icon-btn--active" : ""}`}
                onClick={() => {
                  const next = !showCollectionSearch();
                  setShowCollectionSearch(next);
                  if (!next) setCollectionFilter("");
                }}
                title="Filter collections"
                aria-label="Filter collections"
                aria-pressed={showCollectionSearch()}
              >
                <Search size={14} />
              </button>
              <button
                class="left-sidebar__add-btn"
                onClick={createCollection}
                title="New collection"
                aria-label="New collection"
              >
                <LibraryPlusIcon size={18} />
              </button>
            </div>
          </div>
          <Show when={showCollectionSearch()}>
            <div class="left-sidebar__filter-wrap">
              <input
                class="left-sidebar__filter-input"
                type="text"
                placeholder="Filter collections..."
                value={collectionFilter()}
                onInput={(e) => setCollectionFilter(e.currentTarget.value)}
                autofocus
              />
              <Show when={collectionFilter().length > 0}>
                <button
                  class="left-sidebar__filter-clear"
                  onMouseDown={(e) => { e.preventDefault(); setCollectionFilter(""); }}
                  title="Clear filter"
                  aria-label="Clear filter"
                >
                  <X size={12} />
                </button>
              </Show>
            </div>
          </Show>
          <Show
            when={!collections.loading}
            fallback={<p class="sidebar-hint">Loading...</p>}
          >
            <For
              each={sortedFilteredCollections()}
              fallback={<p class="sidebar-hint">No collections found</p>}
            >
              {(col) => (
                <Show
                  when={renamingPath() === col.path}
                  fallback={
                    <div
                      class="sidebar-item"
                      onClick={() => openCollection(col)}
                      onContextMenu={(e) => handleCollectionContext(e, col)}
                    >
                      <span class="sidebar-item__icon">
                        <RuleIcon iconEmoji={col.icon ?? "lucide:folder-pen"} name={col.name} size={14} />
                      </span>
                      <span class="sidebar-item__label">{col.name}</span>
                      <Show when={col.view_count > 1}>
                        <span class="sidebar-item__badge">{col.view_count}</span>
                      </Show>
                    </div>
                  }
                >
                  <div class="sidebar-item sidebar-item--editing">
                    <input
                      class="sidebar-item__rename-input"
                      type="text"
                      value={renameValue()}
                      onInput={(e) => setRenameValue(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setRenamingPath(null);
                      }}
                      onBlur={commitRename}
                      ref={(el) => setTimeout(() => el.focus(), 0)}
                    />
                  </div>
                </Show>
              )}
            </For>
          </Show>
        </Show>

        <Show when={mode() === "filetree"}>
          <div class="left-sidebar__section-header">
            <span>Files</span>
            <div class="left-sidebar__header-actions">
              <div class="left-sidebar__sort-wrap">
                <button
                  ref={fileSortBtnRef}
                  class="left-sidebar__icon-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowFileSortMenu((v) => !v);
                  }}
                  title="Sort files"
                  aria-label="Sort files"
                >
                  <ArrowDownNarrowWide size={18} />
                </button>
                <Show when={showFileSortMenu()}>
                  <div
                    class="context-menu"
                    ref={(el) => anchorPanelMenu(fileSortBtnRef, el)}
                    onMouseLeave={() => setShowFileSortMenu(false)}
                  >
                    <For each={FILE_SORT_OPTIONS}>
                      {(opt) => (
                        <button
                          classList={{
                            "context-menu__item": true,
                            "context-menu__item--active": fileSortMode() === opt.value,
                          }}
                          onClick={() => {
                            setFileSortMode(opt.value);
                            setShowFileSortMenu(false);
                          }}
                        >
                          {opt.label}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
              <button
                class="left-sidebar__icon-btn"
                onClick={() =>
                  allDirsExpanded() ? collapseAllDirs() : expandAllDirs()
                }
                title={allDirsExpanded() ? "Collapse all folders" : "Expand all folders"}
                aria-label={allDirsExpanded() ? "Collapse all folders" : "Expand all folders"}
              >
                <Show
                  when={allDirsExpanded()}
                  fallback={<ListChevronsUpDown size={18} />}
                >
                  <ListChevronsDownUp size={18} />
                </Show>
              </button>
              <button
                class={`left-sidebar__filter-btn${typstOnly() ? " left-sidebar__filter-btn--active" : ""}`}
                onClick={() => setTypstOnly((v) => !v)}
                title={typstOnly() ? "Showing .typ files only — click to show all" : "Showing all files — click to filter to .typ only"}
                aria-label="Toggle file filter"
              >
                <Filter size={18} />
              </button>
              <div
                class="left-sidebar__split-btn"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  class="left-sidebar__split-btn__main"
                  onClick={createNewNoteAtRoot}
                  title="New simple file (Ctrl+N)"
                  aria-label="New simple file"
                >
                  <FilePlus2 size={14} />
                </button>
                <button
                  ref={newMenuBtnRef}
                  class="left-sidebar__split-btn__caret"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowNewMenu((v) => !v);
                  }}
                  title="More options"
                  aria-label="More create options"
                  aria-haspopup="menu"
                  aria-expanded={showNewMenu()}
                >
                  <ChevronDown size={12} />
                </button>
                <Show when={showNewMenu()}>
                  <div
                    class="context-menu"
                    role="menu"
                    ref={(el) => anchorPanelMenu(newMenuBtnRef, el)}
                  >
                    <button
                      class="context-menu__item context-menu__item--icon"
                      role="menuitem"
                      onClick={createNewFolderAtRoot}
                    >
                      <Folder size={14} />
                      <span>New folder</span>
                    </button>
                    <button
                      class="context-menu__item context-menu__item--icon"
                      role="menuitem"
                      onClick={uploadIntoNotebox}
                    >
                      <Upload size={14} />
                      <span>Upload into notebox</span>
                    </button>
                  </div>
                </Show>
              </div>
            </div>
          </div>
          <Show
            when={!fileTree.loading}
            fallback={<p class="sidebar-hint">Loading...</p>}
          >
            {/* Root drop zone: a drag released outside any folder row
                lands here and moves the item to the notebox root. Rows
                stop propagation on their own drag events, so this only
                fires for the empty space / top-level area. */}
            <div
              classList={{
                "left-sidebar__tree-root": true,
                "left-sidebar__tree-root--drop-target":
                  dragOverDir() === (noteboxInfo()?.path ?? ""),
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer?.types.includes(TREE_MOVE_MIME)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDragOverDir(noteboxInfo()?.path ?? "");
              }}
              onDragLeave={(e) => {
                if (e.currentTarget === e.target) setDragOverDir(null);
              }}
              onDrop={(e) => {
                const raw = e.dataTransfer?.getData(TREE_MOVE_MIME);
                setDragOverDir(null);
                if (!raw) return;
                e.preventDefault();
                try {
                  moveNode(JSON.parse(raw), noteboxInfo()?.path ?? "");
                } catch {
                  /* malformed payload — ignore */
                }
              }}
            >
              <For each={filteredFileTree()}>
                {(node) => (
                  <TreeNode
                    node={node}
                    onOpen={openFile}
                    onContext={handleFileContext}
                    renamingPath={fileRenamingPath()}
                    renameValue={fileRenameValue()}
                    onRenameInput={setFileRenameValue}
                    onRenameCommit={commitFileRename}
                    onRenameCancel={() => setFileRenamingPath(null)}
                    activePath={getActiveTab()?.path ?? null}
                    revealPath={revealPath()}
                    noteboxRoot={noteboxInfo()?.path ?? ""}
                    expandedDirs={expandedDirs}
                    onToggleDir={toggleDir}
                    treeMoveMime={TREE_MOVE_MIME}
                    dragOverDir={dragOverDir}
                    setDragOverDir={setDragOverDir}
                    onMoveNode={moveNode}
                  />
                )}
              </For>
            </div>
          </Show>
        </Show>

        <Show when={mode() === "search"}>
          <SearchPanel />
        </Show>

        <Show when={mode() === "tags"}>
          <div class="left-sidebar__section-header">
            <span>Tags</span>
            <div class="left-sidebar__header-actions">
              <div class="left-sidebar__sort-wrap">
                <button
                  ref={tagSortBtnRef}
                  class="left-sidebar__icon-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowTagSortMenu((v) => !v);
                  }}
                  title="Sort tags"
                  aria-label="Sort tags"
                >
                  <ArrowDownNarrowWide size={18} />
                </button>
                <Show when={showTagSortMenu()}>
                  <div
                    class="context-menu"
                    ref={(el) => anchorPanelMenu(tagSortBtnRef, el)}
                    onMouseLeave={() => setShowTagSortMenu(false)}
                  >
                    <For each={LIST_SORT_OPTIONS}>
                      {(opt) => (
                        <button
                          classList={{
                            "context-menu__item": true,
                            "context-menu__item--active": tagSortMode() === opt.value,
                          }}
                          onClick={() => {
                            setTagSortMode(opt.value);
                            setShowTagSortMenu(false);
                          }}
                        >
                          {opt.label}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
              <button
                class={`left-sidebar__icon-btn${showTagSearch() ? " left-sidebar__icon-btn--active" : ""}`}
                onClick={() => {
                  const next = !showTagSearch();
                  setShowTagSearch(next);
                  if (!next) setTagFilter("");
                }}
                title="Filter tags"
                aria-label="Filter tags"
                aria-pressed={showTagSearch()}
              >
                <Search size={14} />
              </button>
            </div>
          </div>
          <Show when={showTagSearch()}>
            <div class="left-sidebar__filter-wrap">
              <input
                class="left-sidebar__filter-input"
                type="text"
                placeholder="Filter tags..."
                value={tagFilter()}
                onInput={(e) => setTagFilter(e.currentTarget.value)}
                autofocus
              />
              <Show when={tagFilter().length > 0}>
                <button
                  class="left-sidebar__filter-clear"
                  onMouseDown={(e) => { e.preventDefault(); setTagFilter(""); }}
                  title="Clear filter"
                  aria-label="Clear filter"
                >
                  <X size={12} />
                </button>
              </Show>
            </div>
          </Show>
          <Show when={noteboxIndex()} fallback={<p class="sidebar-hint">Loading...</p>}>
            {(idx) => (
              <For
                each={sortAndFilterList(idx().tags, tagSortMode(), tagFilter())}
                fallback={<p class="sidebar-hint">No tags found</p>}
              >
                {([tag, count]) => (
                  <Show
                    when={renamingTag() === tag}
                    fallback={
                      <div
                        class="sidebar-item"
                        onClick={() => openSearchFor(`tag:${tag}`)}
                        onContextMenu={(e) => handleTagContext(e, tag)}
                      >
                        <span class="sidebar-item__icon">
                          <Tag size={14} />
                        </span>
                        <span class="sidebar-item__label">{tag}</span>
                        <span class="notebox-index__count">{count}</span>
                      </div>
                    }
                  >
                    <div class="sidebar-item sidebar-item--editing">
                      <input
                        class="sidebar-item__rename-input"
                        type="text"
                        value={tagRenameValue()}
                        onInput={(e) => setTagRenameValue(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitTagRename();
                          if (e.key === "Escape") setRenamingTag(null);
                        }}
                        onBlur={commitTagRename}
                        ref={(el) => setTimeout(() => el.focus(), 0)}
                      />
                    </div>
                  </Show>
                )}
              </For>
            )}
          </Show>
        </Show>

        <Show when={mode() === "properties"}>
          <div class="left-sidebar__section-header">
            <span>Properties</span>
            <div class="left-sidebar__header-actions">
              <div class="left-sidebar__sort-wrap">
                <button
                  ref={propSortBtnRef}
                  class="left-sidebar__icon-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowPropSortMenu((v) => !v);
                  }}
                  title="Sort properties"
                  aria-label="Sort properties"
                >
                  <ArrowDownNarrowWide size={18} />
                </button>
                <Show when={showPropSortMenu()}>
                  <div
                    class="context-menu"
                    ref={(el) => anchorPanelMenu(propSortBtnRef, el)}
                    onMouseLeave={() => setShowPropSortMenu(false)}
                  >
                    <For each={LIST_SORT_OPTIONS}>
                      {(opt) => (
                        <button
                          classList={{
                            "context-menu__item": true,
                            "context-menu__item--active": propSortMode() === opt.value,
                          }}
                          onClick={() => {
                            setPropSortMode(opt.value);
                            setShowPropSortMenu(false);
                          }}
                        >
                          {opt.label}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
              <button
                class={`left-sidebar__icon-btn${showPropSearch() ? " left-sidebar__icon-btn--active" : ""}`}
                onClick={() => {
                  const next = !showPropSearch();
                  setShowPropSearch(next);
                  if (!next) setPropFilter("");
                }}
                title="Filter properties"
                aria-label="Filter properties"
                aria-pressed={showPropSearch()}
              >
                <Search size={14} />
              </button>
            </div>
          </div>
          <Show when={showPropSearch()}>
            <div class="left-sidebar__filter-wrap">
              <input
                class="left-sidebar__filter-input"
                type="text"
                placeholder="Filter properties..."
                value={propFilter()}
                onInput={(e) => setPropFilter(e.currentTarget.value)}
                autofocus
              />
              <Show when={propFilter().length > 0}>
                <button
                  class="left-sidebar__filter-clear"
                  onMouseDown={(e) => { e.preventDefault(); setPropFilter(""); }}
                  title="Clear filter"
                  aria-label="Clear filter"
                >
                  <X size={12} />
                </button>
              </Show>
            </div>
          </Show>
          <Show when={noteboxIndex()} fallback={<p class="sidebar-hint">Loading...</p>}>
            {(idx) => (
              <For
                each={sortAndFilterList(idx().property_keys, propSortMode(), propFilter())}
                fallback={<p class="sidebar-hint">No properties found</p>}
              >
                {([key, count]) => (
                  <Show
                    when={renamingProperty() === key}
                    fallback={
                      <div
                        class="sidebar-item"
                        onClick={() => openSearchFor(`property:${key}=`)}
                        onContextMenu={(e) => handlePropertyContext(e, key)}
                      >
                        <span class="sidebar-item__label">{key}</span>
                        <span class="notebox-index__count">{count}</span>
                      </div>
                    }
                  >
                    <div class="sidebar-item sidebar-item--editing">
                      <input
                        class="sidebar-item__rename-input"
                        type="text"
                        value={propertyRenameValue()}
                        onInput={(e) => setPropertyRenameValue(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitPropertyRename();
                          if (e.key === "Escape") setRenamingProperty(null);
                        }}
                        onBlur={commitPropertyRename}
                        ref={(el) => setTimeout(() => el.focus(), 0)}
                      />
                    </div>
                  </Show>
                )}
              </For>
            )}
          </Show>
        </Show>

        <Show when={mode() === "bookmarks"}>
          <div class="left-sidebar__section-header">
            <span>Bookmarks</span>
          </div>
          <BookmarksPanel refreshTick={refreshTick()} />
        </Show>

        <Show when={mode() === "templates"}>
          <TemplatesPanel />
        </Show>
      </div>

      {/* Context menu for collections */}
      <Show when={contextMenu()}>
        {(menu) => (
          <div
            class="context-menu"
            style={{
              left: `${menu().x}px`,
              top: `${menu().y}px`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              class="context-menu__item"
              onClick={async () => {
                const col = menu().collection;
                setContextMenu(null);
                try {
                  await ipc.addBookmark({
                    type: "Collection",
                    data: { path: col.path, name: col.name },
                  });
                } catch (e) {
                  console.error("Failed to bookmark:", e);
                }
              }}
            >
              Bookmark
            </button>
            <button
              class="context-menu__item"
              onClick={() => startRename(menu().collection)}
            >
              Rename
            </button>
            <button
              class="context-menu__item context-menu__item--danger"
              onClick={() => deleteCollection(menu().collection)}
            >
              Delete
            </button>
          </div>
        )}
      </Show>

      {/* Context menu for tags */}
      <Show when={tagMenu()}>
        {(menu) => (
          <div
            class="context-menu"
            style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              class="context-menu__item"
              onClick={() => startTagRename(menu().tag)}
            >
              Rename
            </button>
            <button
              class="context-menu__item context-menu__item--danger"
              onClick={() => handleDeleteTag(menu().tag)}
            >
              Delete
            </button>
          </div>
        )}
      </Show>

      {/* Context menu for property keys */}
      <Show when={propMenu()}>
        {(menu) => (
          <div
            class="context-menu"
            style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              class="context-menu__item context-menu__item--submenu"
              onMouseEnter={() =>
                setPropMenu({ ...menu(), typeSubmenuOpen: true })
              }
              onMouseLeave={() =>
                setPropMenu({ ...menu(), typeSubmenuOpen: false })
              }
            >
              Property type
              <span class="context-menu__chevron">{"\u25B8"}</span>
              <Show when={menu().typeSubmenuOpen}>
                <div
                  class={`context-menu context-menu--submenu ${menu().openLeft ? "context-menu--submenu-left" : ""}`}
                >
                  <For each={PROPERTY_TYPE_OPTIONS}>
                    {(ty) => {
                      const current = () => allPropertyTypes()[menu().key] ?? "auto";
                      return (
                        <button
                          class="context-menu__item"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPropertyTypeFor(menu().key, ty);
                          }}
                        >
                          {propertyTypeLabel(ty)}
                          <Show when={current() === ty}>
                            <span class="context-menu__check">{"\u2713"}</span>
                          </Show>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </div>
            <button
              class="context-menu__item"
              onClick={() => startPropertyRename(menu().key)}
            >
              Rename
            </button>
            <button
              class="context-menu__item context-menu__item--danger"
              onClick={() => handleDeleteProperty(menu().key)}
            >
              Delete
            </button>
          </div>
        )}
      </Show>

      {/* Context menu for file tree */}
      <Show when={fileContextMenu()}>
        {(menu) => {
          const node = menu().node;
          // Get folder path for "new file/folder" actions
          const folderPath = node.is_dir ? node.path : node.path.replace(/\/[^/]+$/, "");
          return (
            <div
              class="context-menu"
              style={{
                left: `${menu().x}px`,
                top: `${menu().y}px`,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <Show when={!node.is_dir}>
                <button
                  class="context-menu__item"
                  onClick={() => {
                    setFileContextMenu(null);
                    openFileInNewTab(node);
                  }}
                >
                  Open in new tab
                </button>
                <button
                  class="context-menu__item"
                  onClick={() => {
                    setFileContextMenu(null);
                    const label = `note-${Date.now()}`;
                    const win = new WebviewWindow(label, {
                      url: `index.html?path=${encodeURIComponent(node.path)}`,
                      title: node.name,
                      width: 900,
                      height: 700,
                    });
                    win.once("tauri://error", (e) => {
                      console.error("Failed to open new window:", e);
                    });
                  }}
                >
                  Open in new window
                </button>
                <div class="context-menu__separator" />
              </Show>
              <button
                class="context-menu__item"
                onClick={() => createNewFile(folderPath)}
              >
                New File
              </button>
              <button
                class="context-menu__item"
                onClick={() => createNewFolder(folderPath)}
              >
                New Folder
              </button>
              <Show when={!node.is_dir}>
                <button
                  class="context-menu__item"
                  onClick={async () => {
                    setFileContextMenu(null);
                    try {
                      await ipc.addBookmark({
                        type: "Note",
                        data: {
                          path: node.path,
                          name: node.name.replace(/\.[^.]+$/, ""),
                        },
                      });
                    } catch (e) {
                      console.error("Failed to bookmark:", e);
                    }
                  }}
                >
                  Bookmark
                </button>
              </Show>
              <div class="context-menu__separator" />
              <button
                class="context-menu__item"
                onClick={() => moveNodeViaDialog(node)}
              >
                {node.is_dir ? "Move folder to..." : "Move file to..."}
              </button>
              <button
                class="context-menu__item"
                onClick={() => startFileRename(node)}
              >
                Rename
              </button>
              <button
                class="context-menu__item context-menu__item--danger"
                onClick={() => handleDeleteFile(node)}
              >
                Delete
              </button>
            </div>
          );
        }}
      </Show>
    </div>
  );
};

const TreeNode: Component<{
  node: FileTreeNode;
  onOpen: (node: FileTreeNode, e?: MouseEvent) => void;
  onContext: (e: MouseEvent, node: FileTreeNode) => void;
  renamingPath: string | null;
  renameValue: string;
  onRenameInput: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  activePath: string | null;
  revealPath: string | null;
  noteboxRoot: string;
  /// Hoisted expansion state so the Expand All / Collapse All toolbar
  /// button can flip every folder at once. Each TreeNode reads its own
  /// directory's expanded flag from this set and toggles via the
  /// `onToggleDir` callback.
  expandedDirs: () => Set<string>;
  onToggleDir: (path: string) => void;
  /// Drag-to-move plumbing. `treeMoveMime` is the dataTransfer type that
  /// carries the dragged node; `dragOverDir` / `setDragOverDir` track
  /// which row is the current drop target so it can highlight; and
  /// `onMoveNode` performs the move once a drop lands.
  treeMoveMime: string;
  dragOverDir: () => string | null;
  setDragOverDir: (path: string | null) => void;
  onMoveNode: (
    src: { path: string; is_dir: boolean },
    destDir: string,
  ) => void;
  depth?: number;
}> = (props) => {
  const depth = props.depth ?? 0;
  const expanded = () => props.expandedDirs().has(props.node.path);

  const isRenaming = () => props.renamingPath === props.node.path;
  const isActive = () =>
    !props.node.is_dir && props.activePath === props.node.path;

  /// Folder a drop on this row moves the item into: the folder itself
  /// for a directory row, or the containing folder for a file row.
  const dropDest = () => {
    if (props.node.is_dir) return props.node.path;
    const slash = props.node.path.lastIndexOf("/");
    return slash >= 0 ? props.node.path.slice(0, slash) : props.noteboxRoot;
  };
  const isDropTarget = () => props.dragOverDir() === props.node.path;

  // Auto-expand directory if it's an ancestor of the reveal target
  const isAncestorOfReveal = () => {
    const rp = props.revealPath;
    return props.node.is_dir && rp != null && rp.startsWith(props.node.path + "/");
  };

  // When revealPath changes and this dir is an ancestor, expand it.
  // Toggles through the hoisted setter so the parent's set stays in sync.
  createEffect(() => {
    if (isAncestorOfReveal() && !expanded()) {
      props.onToggleDir(props.node.path);
    }
  });

  let itemRef: HTMLDivElement | undefined;

  // Scroll into view when this node is the reveal target
  createEffect(() => {
    if (props.revealPath === props.node.path && itemRef) {
      itemRef.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });

  return (
    <div>
      <Show
        when={isRenaming()}
        fallback={
          <div
            ref={itemRef}
            classList={{
              "sidebar-item": true,
              "sidebar-item--dir": props.node.is_dir,
              "sidebar-item--active": isActive(),
              "sidebar-item--drop-target": isDropTarget(),
            }}
            style={{ "padding-left": `${depth * 16 + 8}px` }}
            draggable={true}
            onDragStart={(e) => {
              // Intra-sidebar move payload — files and folders alike.
              e.dataTransfer!.setData(
                props.treeMoveMime,
                JSON.stringify({
                  path: props.node.path,
                  is_dir: props.node.is_dir,
                }),
              );
              if (props.node.is_dir) {
                e.dataTransfer!.effectAllowed = "move";
              } else {
                // Files can also be dropped into the editor to embed
                // them, which reads this notebox-relative-path payload.
                const rel = props.node.path.startsWith(props.noteboxRoot + "/")
                  ? props.node.path.slice(props.noteboxRoot.length + 1)
                  : props.node.name;
                e.dataTransfer!.setData("application/x-inkycap-notebox-path", rel);
                e.dataTransfer!.effectAllowed = "copyMove";
              }
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer?.types.includes(props.treeMoveMime)) return;
              // Claim this drag: preventDefault enables the drop, and
              // stopPropagation keeps the root drop zone from also
              // registering as the target.
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "move";
              props.setDragOverDir(props.node.path);
            }}
            onDragLeave={(e) => {
              if (
                e.currentTarget === e.target &&
                props.dragOverDir() === props.node.path
              ) {
                props.setDragOverDir(null);
              }
            }}
            onDrop={(e) => {
              const raw = e.dataTransfer?.getData(props.treeMoveMime);
              props.setDragOverDir(null);
              if (!raw) return;
              e.preventDefault();
              e.stopPropagation();
              try {
                props.onMoveNode(JSON.parse(raw), dropDest());
              } catch {
                /* malformed payload — ignore */
              }
            }}
            onClick={(e) => {
              if (props.node.is_dir) {
                props.onToggleDir(props.node.path);
              } else {
                props.onOpen(props.node, e);
              }
            }}
            onContextMenu={(e) => props.onContext(e, props.node)}
          >
            <span class="sidebar-item__icon">
              {props.node.is_dir ? (
                expanded() ? (
                  <ChevronDown size={14} />
                ) : (
                  <ChevronRight size={14} />
                )
              ) : (
                <FileText size={14} />
              )}
            </span>
            <span class="sidebar-item__label">{
              props.node.is_dir || settings.files.show_file_extensions
                ? props.node.name
                : props.node.name.replace(/\.[^.]+$/, "")
            }</span>
          </div>
        }
      >
        <div
          class="sidebar-item sidebar-item--editing"
          style={{ "padding-left": `${depth * 16 + 8}px` }}
        >
          <input
            class="sidebar-item__rename-input"
            type="text"
            value={props.renameValue}
            onInput={(e) => props.onRenameInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") props.onRenameCommit();
              if (e.key === "Escape") props.onRenameCancel();
            }}
            onBlur={props.onRenameCommit}
            ref={(el) => setTimeout(() => el.focus(), 0)}
          />
        </div>
      </Show>
      <Show when={expanded() && props.node.children}>
        <For each={props.node.children}>
          {(child) => (
            <TreeNode
              node={child}
              onOpen={props.onOpen}
              onContext={props.onContext}
              renamingPath={props.renamingPath}
              renameValue={props.renameValue}
              onRenameInput={props.onRenameInput}
              onRenameCommit={props.onRenameCommit}
              onRenameCancel={props.onRenameCancel}
              activePath={props.activePath}
              revealPath={props.revealPath}
              noteboxRoot={props.noteboxRoot}
              expandedDirs={props.expandedDirs}
              onToggleDir={props.onToggleDir}
              treeMoveMime={props.treeMoveMime}
              dragOverDir={props.dragOverDir}
              setDragOverDir={props.setDragOverDir}
              onMoveNode={props.onMoveNode}
              depth={depth + 1}
            />
          )}
        </For>
      </Show>
    </div>
  );
};

export default LeftSidebar;
