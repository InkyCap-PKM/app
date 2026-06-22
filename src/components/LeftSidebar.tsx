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
import { Dynamic } from "solid-js/web";
import { sidebarContributions } from "./sidebar-registry";
import {
  LibraryBig,
  FolderTree,
  Tags,
  Search,
  BookMarked,
  FilePlus2,
  Folder,
  Download,
  Tag,
  X,
  ChevronRight,
  ChevronDown,
  NotebookTabs,
  ArrowDownNarrowWide,
  ListChevronsUpDown,
  ListChevronsDownUp,
  Calendar,
} from "lucide-solid";
import RuleIcon from "./RuleIcon";
import { LibraryPlusIcon } from "./icons";
import type { CollectionInfo, FileTreeNode, PropertyType } from "../lib/types";
import * as ipc from "../lib/ipc";
import { pathEquals, pathStartsWith } from "../lib/paths";
import { isLinux } from "../lib/platform";
import { attachListNav } from "../lib/list-nav";
import { anchorPanelMenu } from "../lib/uiMenu";
import { clickOutside } from "../lib/clickOutside";
import { createOverflowWatcher } from "../lib/overflow";
import { compareZid } from "../lib/sort";
import { settings, updateSetting, noteboxSettings } from "../stores/settings";
import type { FileSortMode } from "../lib/types";
import { noteboxInfo, noteboxUiKey, fileTreeVersion, propertyVersion, bumpPropertyVersion } from "../stores/notebox";
import { openTab, openCreatedNote, closeTab, tabs, getActiveTab } from "../stores/tabs";
import {
  isEnabled as isScrollEnabled,
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
import GitCollaborationPanel from "./GitCollaborationPanel";
import AgendaPanel from "./AgendaPanel";
import HelpPanel from "./HelpPanel";
import type { SidebarMode } from "./VerticalToolbar";
import { toastError, toastSuccess } from "../stores/toasts";
import { promptText, promptConfirm } from "../stores/prompt";
import { pickFolder } from "../stores/folderPicker";
import { triggerCreationRule, creationRules } from "../stores/creation-rules";
import { useI18n } from "../lib/i18n";
import { askMarkdownImport } from "../lib/markdown-import-prompt";

interface LeftSidebarProps {
  mode: () => SidebarMode;
  setMode: (m: SidebarMode) => void;
}

const HIDDEN_NAMES = new Set([".inkycap"]);

/// A `.typ` note — the file kind InkyCap edits in its own editor.
function isNoteFile(name: string): boolean {
  return name.toLowerCase().endsWith(".typ");
}

/// A `.collection` document — also opened in-app, in the collection view.
function isCollectionFile(name: string): boolean {
  return name.toLowerCase().endsWith(".collection");
}

/// Files InkyCap opens in one of its own editors. Everything else
/// (images, PDFs, `.bib`, data files) is shown in the tree so users can
/// see and link to attachments, but is opened with the OS default app
/// and visually de-emphasized.
function isAppEditable(name: string): boolean {
  return isNoteFile(name) || isCollectionFile(name);
}

/// Strip InkyCap's internal directories but keep everything else: every
/// folder — including empty ones the user just created — and every file,
/// regardless of extension. Typst can reference an asset from anywhere in
/// the notebox, so hiding non-`.typ` files risks hiding a compile
/// dependency; they are de-emphasized in the UI instead.
/// Stable DOM id for a file-tree row, used by the tree container's
/// `aria-activedescendant` (keyboard navigation). Paths can contain spaces and
/// slashes, so encode them into an id-safe token.
function treeItemId(path: string): string {
  return `tree-item-${encodeURIComponent(path)}`;
}


function visibleFileTree(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes
    .filter((n) => !HIDDEN_NAMES.has(n.name))
    .map((n) =>
      n.is_dir
        ? { ...n, children: n.children ? visibleFileTree(n.children) : [] }
        : n,
    );
}

type ListSortMode = "name-asc" | "name-desc" | "count-desc" | "count-asc";

// `labelKey` (resolved at the render site). The file-tree modes share the
// `sort.*` vocabulary with the links panel; the tag/property list uses its own
// alphabetical/quantity wording. See en.json.
const FILE_SORT_OPTIONS: { value: FileSortMode; labelKey: string }[] = [
  { value: "name-asc", labelKey: "sort.name.asc" },
  { value: "name-desc", labelKey: "sort.name.desc" },
  { value: "modified-desc", labelKey: "sort.modified.desc" },
  { value: "modified-asc", labelKey: "sort.modified.asc" },
  { value: "created-desc", labelKey: "sort.created.desc" },
  { value: "created-asc", labelKey: "sort.created.asc" },
];

// The file tree adds zid (Zettelkasten id) ordering on top of the shared
// options. Collections reuse FILE_SORT_OPTIONS without it — a `.collection`
// file has no zid, so offering the mode there would be a dead choice.
const FILE_TREE_SORT_OPTIONS: { value: FileSortMode; labelKey: string }[] = [
  ...FILE_SORT_OPTIONS,
  { value: "zid-asc", labelKey: "sort.zid.asc" },
  { value: "zid-desc", labelKey: "sort.zid.desc" },
];

const LIST_SORT_OPTIONS: { value: ListSortMode; labelKey: string }[] = [
  { value: "name-asc", labelKey: "sort.alpha.asc" },
  { value: "name-desc", labelKey: "sort.alpha.desc" },
  { value: "count-desc", labelKey: "sort.quantity.desc" },
  { value: "count-asc", labelKey: "sort.quantity.asc" },
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
      case "zid-asc":
      case "zid-desc": {
        const c = compareZid(a.zid, b.zid, mode === "zid-asc" ? "asc" : "desc");
        return c !== 0 ? c : a.name.localeCompare(b.name);
      }
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

const LeftSidebar: Component<LeftSidebarProps> = (props) => {
  const t = useI18n();
  const mode = props.mode;
  const setMode = props.setMode;
  const [refreshTick, setRefreshTick] = createSignal(0);

  // Edge-shadow cue when the mode bar is too narrow to show every button (the
  // user widens the sidebar to reveal them — see createOverflowWatcher).
  const modeOverflow = createOverflowWatcher();

  // File tree: sort mode + per-folder expansion state hoisted from the
  // TreeNode component so the Expand All / Collapse All button can flip
  // every folder in one click. Default to all-collapsed (empty set).
  // File-tree sort is a user-global preference (persisted across launches),
  // so it lives in `settings.appearance.file_tree_sort` rather than a
  // per-mount signal. The getter/setter shape is kept identical to a
  // createSignal so the dropdown's existing callsites need no change.
  const fileSortMode = (): FileSortMode => settings.appearance.file_tree_sort;
  const setFileSortMode = (value: FileSortMode) =>
    updateSetting("appearance", "file_tree_sort", value);
  const [showFileSortMenu, setShowFileSortMenu] = createSignal(false);
  const [expandedDirs, setExpandedDirs] = createSignal<Set<string>>(new Set());
  const [showNewMenu, setShowNewMenu] = createSignal(false);

  // File tree drag-and-drop: path of the directory (or "" for notebox
  // root) currently hovered as a move target, so the destination folder
  // can highlight. `draggingPath` is the row being dragged, so it can dim
  // in place.
  const [dragOverDir, setDragOverDir] = createSignal<string | null>(null);
  const [draggingPath, setDraggingPath] = createSignal<string | null>(null);

  // Drag ghost: a real DOM chip that follows the cursor. We don't use the
  // native `setDragImage` — WebKitGTK rasterizes it at CSS (1×) resolution and
  // the compositor upscales it by the device-pixel-ratio, so on a HiDPI screen
  // it's both blurry and oversized. A live element renders at native
  // resolution (crisp) and is fully styleable; the source `dragstart`
  // suppresses the native image and hands us the label + start point.
  let dragGhostEl: HTMLDivElement | null = null;
  const onGhostDragOver = (e: DragEvent) => {
    if (dragGhostEl) {
      dragGhostEl.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 10}px)`;
    }
  };
  const startDragGhost = (label: string, x: number, y: number) => {
    removeDragGhost();
    const el = document.createElement("div");
    el.className = "tree-drag-ghost";
    el.textContent = label;
    el.style.transform = `translate(${x + 12}px, ${y + 10}px)`;
    document.body.appendChild(el);
    dragGhostEl = el;
    // Capture phase: rows call stopPropagation in their own dragover, so a
    // bubble-phase document listener would never fire while over the tree.
    document.addEventListener("dragover", onGhostDragOver, true);
  };
  const removeDragGhost = () => {
    document.removeEventListener("dragover", onGhostDragOver, true);
    dragGhostEl?.remove();
    dragGhostEl = null;
  };

  // Tear down all drag state (dim, target highlight, auto-scroll, ghost) when
  // a drag ends. Listen for BOTH `drop` and `dragend`, in the capture phase:
  //  - On a successful move, `moveItems` refreshes the tree and unmounts the
  //    source row, so its `dragend` may never fire — but `drop` fires first.
  //  - `dragend` covers cancels (Escape, release outside any target), where
  //    there is no `drop`.
  //  - Capture phase, because rows call stopPropagation in their own drag
  //    handlers, which would hide a bubble-phase document listener.
  const endDrag = () => {
    setDraggingPath(null);
    setDragOverDir(null);
    stopAutoScroll();
    removeDragGhost();
  };
  document.addEventListener("drop", endDrag, true);
  document.addEventListener("dragend", endDrag, true);
  onCleanup(() => {
    document.removeEventListener("drop", endDrag, true);
    document.removeEventListener("dragend", endDrag, true);
    removeDragGhost();
  });

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
    const filtered = visibleFileTree(tree);
    return sortFileTree(filtered, fileSortMode(), noteboxSettings.files.folder_grouping);
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
        case "zid-asc":
        case "zid-desc":
          // Collections have no zid; the collection dropdown never offers
          // these modes, but the shared FileSortMode type requires them.
          return a.name.localeCompare(b.name);
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

  function setDirExpanded(path: string, expanded: boolean) {
    setExpandedDirs((prev) => {
      if (prev.has(path) === expanded) return prev;
      const next = new Set(prev);
      if (expanded) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  // ── File-tree keyboard navigation (ARIA tree pattern) ──────────────
  // The tree root is a single Tab stop (role="tree"); arrow keys move a
  // keyboard cursor (`focusedTreePath`) through the visible rows via
  // `aria-activedescendant`, instead of every row being its own Tab stop.
  const [focusedTreePath, setFocusedTreePath] = createSignal<string | null>(null);

  /// Visible rows in display order (depth-first, honouring expanded dirs),
  /// each carrying its parent path (so Left-arrow can climb to the parent)
  /// and its depth (for indent + windowed render). This flat list is the
  /// single source of truth for both keyboard navigation and the virtualized
  /// render — a recursive component tree on a multi-thousand-note notebox
  /// would mount thousands of live rows; the windowed render below mounts
  /// only the visible slice.
  type FlatRow = { node: FileTreeNode; parentPath: string | null; depth: number };
  const flatRows = createMemo<FlatRow[]>(() => {
    const out: FlatRow[] = [];
    const walk = (nodes: FileTreeNode[], parentPath: string | null, depth: number) => {
      for (const node of nodes) {
        out.push({ node, parentPath, depth });
        if (node.is_dir && expandedDirs().has(node.path) && node.children) {
          walk(node.children, node.path, depth + 1);
        }
      }
    };
    walk(filteredFileTree(), null, 0);
    return out;
  });

  // --- File-tree virtualization (fixed-height windowing) ---
  // Rows are uniform-height `.sidebar-item`s, so a flat windowed list keeps
  // the DOM bounded regardless of notebox size. The scroll container is the
  // shared `.left-sidebar__content` (the Files header sits above the tree),
  // so the window is derived from how far the tree has scrolled past that
  // container's top edge — measured by rects, which needs no CSS change and
  // doesn't disturb the other sidebar modes that share the same scroller.
  const TREE_OVERSCAN = 8; // rows rendered beyond the viewport on each side
  const [rowHeight, setRowHeight] = createSignal(28); // measured from a live row
  const [treeScrolledPast, setTreeScrolledPast] = createSignal(0); // px of tree above the viewport top
  const [treeViewportH, setTreeViewportH] = createSignal(0);

  let treeRootEl: HTMLDivElement | undefined;
  let treeScrollEl: HTMLElement | null = null;
  let detachTreeScroll: (() => void) | undefined;

  const measureRowHeight = () => {
    const row = treeRootEl?.querySelector<HTMLElement>(".sidebar-item");
    const h = row?.offsetHeight ?? 0;
    if (h > 0 && h !== rowHeight()) setRowHeight(h);
  };

  const recomputeTreeWindow = () => {
    if (!treeRootEl || !treeScrollEl) return;
    const cr = treeScrollEl.getBoundingClientRect();
    const tr = treeRootEl.getBoundingClientRect();
    // How far the top of the tree content has scrolled above the scroll
    // container's top edge (0 while the Files header is still in view).
    setTreeScrolledPast(Math.max(0, cr.top - tr.top));
    setTreeViewportH(treeScrollEl.clientHeight);
  };

  // --- Drag auto-scroll ---
  // WebKitGTK (Linux) doesn't auto-scroll an overflow container when a drag
  // nears its edge, so drive it manually: while a tree-move drag hovers within
  // `DRAG_EDGE` px of the scroller's top/bottom, step the scroll each frame.
  // The dragover listener is attached in the CAPTURE phase on the scroller so
  // it still fires when a row's own dragover calls stopPropagation.
  //
  // WKWebView (macOS) and WebView2 (Windows) auto-scroll natively, so the
  // manual loop is gated to Linux — running both would double the edge speed.
  // (The windowing still tracks native scrolling fine: its own `scroll`
  // listener recomputes the visible slice regardless of what drives the scroll.)
  const MANUAL_DRAG_AUTOSCROLL = isLinux();
  const DRAG_EDGE = 40; // px from an edge that triggers auto-scroll
  const DRAG_SCROLL_SPEED = 14; // px per frame at the very edge
  let autoScrollVel = 0;
  let autoScrollRAF = 0;

  const stepAutoScroll = () => {
    if (autoScrollVel !== 0 && treeScrollEl) {
      treeScrollEl.scrollTop += autoScrollVel;
      recomputeTreeWindow();
      autoScrollRAF = requestAnimationFrame(stepAutoScroll);
    } else {
      autoScrollRAF = 0;
    }
  };

  const stopAutoScroll = () => {
    autoScrollVel = 0;
    if (autoScrollRAF) {
      cancelAnimationFrame(autoScrollRAF);
      autoScrollRAF = 0;
    }
  };

  const onTreeDragOverCapture = (e: DragEvent) => {
    if (!treeScrollEl || !e.dataTransfer?.types.includes(TREE_MOVE_MIME)) {
      stopAutoScroll();
      return;
    }
    const r = treeScrollEl.getBoundingClientRect();
    const topDist = e.clientY - r.top;
    const botDist = r.bottom - e.clientY;
    if (topDist < DRAG_EDGE) {
      // Ramp speed up as the pointer gets closer to the edge.
      autoScrollVel = -DRAG_SCROLL_SPEED * (1 - Math.max(0, topDist) / DRAG_EDGE);
    } else if (botDist < DRAG_EDGE) {
      autoScrollVel = DRAG_SCROLL_SPEED * (1 - Math.max(0, botDist) / DRAG_EDGE);
    } else {
      autoScrollVel = 0;
    }
    if (autoScrollVel !== 0 && autoScrollRAF === 0) {
      autoScrollRAF = requestAnimationFrame(stepAutoScroll);
    }
  };

  // Attached as the tree-root `ref`. Wires scroll/resize tracking to the
  // shared content scroller and takes the first row-height measurement.
  // Re-runs on every filetree-mode mount, so it tears down any prior wiring
  // first; the component-level onCleanup covers final unmount.
  //
  // Solid fires `ref` before the element is connected to the document, so
  // `closest()` can't see the scroll container yet — resolve it (and attach
  // listeners) after mount via rAF, otherwise the window stays frozen at the
  // first screenful and the tree never scrolls.
  const initTreeViewport = (el: HTMLDivElement) => {
    detachTreeScroll?.();
    treeRootEl = el;
    requestAnimationFrame(() => {
      const scrollEl = el.closest<HTMLElement>(".left-sidebar__content");
      if (!scrollEl) return;
      treeScrollEl = scrollEl;
      const onScroll = () => recomputeTreeWindow();
      scrollEl.addEventListener("scroll", onScroll, { passive: true });
      // Only Linux needs the manual edge auto-scroll (see MANUAL_DRAG_AUTOSCROLL).
      if (MANUAL_DRAG_AUTOSCROLL) {
        scrollEl.addEventListener("dragover", onTreeDragOverCapture, true);
      }
      const ro = new ResizeObserver(() => {
        recomputeTreeWindow();
        measureRowHeight();
      });
      ro.observe(scrollEl);
      measureRowHeight();
      recomputeTreeWindow();
      detachTreeScroll = () => {
        scrollEl.removeEventListener("scroll", onScroll);
        scrollEl.removeEventListener("dragover", onTreeDragOverCapture, true);
        stopAutoScroll();
        ro.disconnect();
      };
    });
  };
  onCleanup(() => detachTreeScroll?.());

  // Re-measure when the UI font size changes (row height tracks it).
  createEffect(() => {
    settings.editor.font_size;
    if (treeRootEl) requestAnimationFrame(measureRowHeight);
  });

  const treeWindow = createMemo(() => {
    const rh = rowHeight() || 28;
    const total = flatRows().length;
    const start = Math.max(0, Math.floor(treeScrolledPast() / rh) - TREE_OVERSCAN);
    const count = Math.ceil((treeViewportH() || 0) / rh) + TREE_OVERSCAN * 2;
    return { start, end: Math.min(total, start + count) };
  });
  const windowedRows = createMemo(() => {
    const { start, end } = treeWindow();
    return flatRows().slice(start, end);
  });

  // Scroll the row at `idx` (in `flatRows`) minimally into view. Index-based
  // so it works even when the target row isn't currently mounted.
  function scrollTreeRowIntoView(idx: number) {
    if (!treeScrollEl || !treeRootEl || idx < 0) return;
    const cr = treeScrollEl.getBoundingClientRect();
    const tr = treeRootEl.getBoundingClientRect();
    const rh = rowHeight() || 28;
    // Top of the tree content in the scroller's scroll coordinates.
    const treeTop = treeScrollEl.scrollTop + (tr.top - cr.top);
    const rowTop = treeTop + idx * rh;
    const rowBottom = rowTop + rh;
    const viewTop = treeScrollEl.scrollTop;
    const viewBottom = viewTop + treeScrollEl.clientHeight;
    if (rowTop < viewTop) treeScrollEl.scrollTop = rowTop;
    else if (rowBottom > viewBottom) treeScrollEl.scrollTop = rowBottom - treeScrollEl.clientHeight;
  }

  /// Dir paths in the tree that are ancestors of `path` (for reveal: a
  /// collapsed ancestor isn't mounted, so expansion can't be driven from the
  /// row component — it's computed here against the full tree instead).
  function ancestorDirsOf(path: string): string[] {
    const acc: string[] = [];
    const walk = (nodes: FileTreeNode[]) => {
      for (const n of nodes) {
        if (n.is_dir && !pathEquals(path, n.path) && pathStartsWith(path, n.path)) {
          acc.push(n.path);
          if (n.children) walk(n.children);
        }
      }
    };
    walk(filteredFileTree());
    return acc;
  }

  function focusTreeRow(path: string | null) {
    setFocusedTreePath(path);
    if (path) {
      requestAnimationFrame(() => {
        const idx = flatRows().findIndex((r) => pathEquals(r.node.path, path));
        scrollTreeRowIntoView(idx);
      });
    }
  }

  function onTreeKeyDown(e: KeyboardEvent) {
    // A row's inline rename input lives inside the tree; let it own its keys.
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const rows = flatRows();
    if (rows.length === 0) return;

    // Resolve the current cursor; fall back to the open file (if visible),
    // then the first row, so the very first keypress has somewhere to start.
    let idx = rows.findIndex((r) => pathEquals(r.node.path, focusedTreePath()));
    if (idx < 0) {
      const activePath = getActiveTab()?.path ?? null;
      idx = activePath ? rows.findIndex((r) => pathEquals(r.node.path, activePath)) : -1;
      if (idx < 0) idx = 0;
    }
    const cur = rows[idx];

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusTreeRow(rows[Math.min(idx + 1, rows.length - 1)].node.path);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusTreeRow(rows[Math.max(idx - 1, 0)].node.path);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (cur.node.is_dir) {
          if (!expandedDirs().has(cur.node.path)) setDirExpanded(cur.node.path, true);
          else if (cur.node.children?.length) focusTreeRow(cur.node.children[0].path);
        }
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (cur.node.is_dir && expandedDirs().has(cur.node.path)) {
          setDirExpanded(cur.node.path, false);
        } else if (cur.parentPath) {
          focusTreeRow(cur.parentPath);
        }
        break;
      case "Home":
        e.preventDefault();
        focusTreeRow(rows[0].node.path);
        break;
      case "End":
        e.preventDefault();
        focusTreeRow(rows[rows.length - 1].node.path);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (cur.node.is_dir) toggleDir(cur.node.path);
        else openFile(cur.node);
        break;
    }
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

  // System property keys (`title`, `tags`, …) are load-bearing built-ins
  // that can't be renamed — the sidebar hides the rename action for them
  // (the backend also rejects it). The set is static, so fetch it once.
  const [systemPropertyKeys] = createResource(async () => {
    try {
      return new Set(await ipc.getSystemPropertyKeys());
    } catch {
      return new Set<string>();
    }
  });
  const isSystemProperty = (key: string) =>
    systemPropertyKeys()?.has(key) ?? false;

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

  // Reveal a path: expand its (possibly collapsed, thus unmounted) ancestor
  // folders, then scroll its row into view by index. Driven here rather than
  // from the row component because in the windowed list an off-screen target
  // — and any collapsed ancestor — has no mounted component to react.
  createEffect(() => {
    const rp = revealPath();
    if (!rp) return;
    const ancestors = ancestorDirsOf(rp);
    if (ancestors.length > 0) {
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const p of ancestors) if (!next.has(p)) { next.add(p); changed = true; }
        return changed ? next : prev;
      });
    }
    // After expansion has flowed into `flatRows`, locate and scroll to the
    // row. When reveal also switched the sidebar into filetree mode, the
    // tree-root (and thus `treeScrollEl`) may not be wired yet this frame —
    // retry a few frames until the scroller is ready.
    const scrollWhenReady = (tries: number) => {
      if (!treeScrollEl && tries < 6) {
        requestAnimationFrame(() => scrollWhenReady(tries + 1));
        return;
      }
      const idx = flatRows().findIndex((r) => pathEquals(r.node.path, rp));
      if (idx >= 0) scrollTreeRowIntoView(idx);
    };
    requestAnimationFrame(() => scrollWhenReady(0));
  });

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

    const existing = noteboxIndex()?.tags.find(([tg]) => tg === newTag);
    if (existing) {
      const ok = await promptConfirm({
        title: t("leftSidebar.mergeTagsTitle"),
        message: t("leftSidebar.mergeTagsBody", { newTag, oldTag }),
        cancelLabel: t("common.cancel"),
      });
      if (!ok) return;
    }

    try {
      await ipc.renameTag(oldTag, newTag);
      refresh();
      refetchNoteboxIndex();
    } catch (err) {
      toastError(t("leftSidebar.renameTagFailed"), err);
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
        ? t("leftSidebar.mergePropsBodyType", {
            newKey,
            oldKey,
            newType: propertyTypeLabel(newType),
            oldType: propertyTypeLabel(oldType),
          })
        : t("leftSidebar.mergePropsBody", { newKey, oldKey });
      const ok = await promptConfirm({
        title: t("leftSidebar.mergePropsTitle"),
        message: msg,
        cancelLabel: t("common.cancel"),
      });
      if (!ok) return;
    }

    try {
      await ipc.renamePropertyKey(oldKey, newKey);
      await reloadPropertyTypes();
      bumpPropertyVersion();
      refresh();
      refetchNoteboxIndex();
    } catch (err) {
      toastError(t("leftSidebar.renamePropFailed"), err);
    }
  }

  async function handleDeleteProperty(key: string) {
    setPropMenu(null);
    const ok = await promptConfirm({
      title: t("leftSidebar.deletePropTitle"),
      message: t("leftSidebar.deletePropBody", { key }),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    try {
      await ipc.deletePropertyKey(key);
      await reloadPropertyTypes();
      bumpPropertyVersion();
      refresh();
      refetchNoteboxIndex();
    } catch (err) {
      toastError(t("leftSidebar.deletePropFailed"), err);
    }
  }

  async function setPropertyTypeFor(key: string, ty: PropertyType) {
    setPropMenu(null);
    try {
      await ipc.setPropertyType(key, ty);
      await reloadPropertyTypes();
      refresh();
    } catch (err) {
      toastError(t("leftSidebar.changeTypeFailed"), err);
    }
  }

  function openCollection(col: CollectionInfo) {
    openTab({
      type: "collection",
      title: col.name,
      path: col.path,
    });
  }

  function openFile(node: FileTreeNode, e?: MouseEvent) {
    if (node.is_dir) return;
    const forceNewTab = !!(e && (e.ctrlKey || e.metaKey));
    const isCollection = node.name.toLowerCase().endsWith(".collection");

    // When the active tab is a Journal Scroll, a plain click on a note in
    // the file tree re-anchors the scroll on that note. Both halves must
    // happen together: the tab is repointed (so its title follows the
    // clicked note) AND the scroll's anchor is moved (so the feed
    // re-centres). Doing only one leaves the tab title and the feed
    // disagreeing. Ctrl/Cmd-click still opens the note in its own tab.
    if (!forceNewTab && !isCollection && isNoteFile(node.name)) {
      const active = getActiveTab();
      if (active && isScrollEnabled(active.id)) {
        openTab(
          { type: "file", title: node.name, path: node.path },
          { forceNewTab: false },
        );
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
        { forceNewTab, newTabAction: forceNewTab },
      );
      return;
    }
    // Non-`.typ` files (images, PDFs, `.bib`, data files) aren't edited
    // in-app — hand them to the OS default application.
    if (!isNoteFile(node.name)) {
      ipc.openFileExternally(node.path);
      return;
    }
    // If the note is currently serving as a Journal Scroll's anchor, the
    // tab holding that scroll shares this note's path — a plain openTab
    // would match it and re-focus the scroll instead of opening the note.
    // `allowDuplicate` forces a distinct, regular editor tab in that case.
    const hasScrollTabForPath = tabs.some(
      (t) => pathEquals(t.path, node.path) && isScrollEnabled(t.id),
    );
    openTab(
      { type: "file", title: node.name, path: node.path },
      {
        forceNewTab,
        newTabAction: forceNewTab,
        allowDuplicate: hasScrollTabForPath,
      },
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
        { forceNewTab: true, newTabAction: true },
      );
      return;
    }
    if (!isNoteFile(node.name)) {
      ipc.openFileExternally(node.path);
      return;
    }
    openTab(
      { type: "file", title: node.name, path: node.path },
      { forceNewTab: true, newTabAction: true },
    );
  }

  function refresh() {
    setRefreshTick((t) => t + 1);
  }

  /// Handle a click on a file-tree row: folders toggle expansion, files
  /// open. A Ctrl/Cmd-click on a file opens it in a new tab — `openFile`
  /// reads the modifier off the event and sets `forceNewTab`.
  function handleNodeClick(node: FileTreeNode, e: MouseEvent) {
    // Keep the keyboard cursor in step with clicks, so arrowing after a click
    // continues from the row that was clicked.
    setFocusedTreePath(node.path);
    if (node.is_dir) {
      toggleDir(node.path);
    } else {
      openFile(node, e);
    }
  }

  /// The items a drag starting on `node` should carry — just the row
  /// itself. (`moveItems` and the drop payload stay array-shaped so a
  /// future multi-item drag could slot in without reworking them.)
  function dragItemsFor(
    node: FileTreeNode,
  ): { path: string; is_dir: boolean }[] {
    return [{ path: node.path, is_dir: node.is_dir }];
  }

  /// MIME type carrying a file-tree node during an intra-sidebar move
  /// drag. Distinct from `application/x-inkycap-notebox-path` (which the
  /// editor consumes to embed a file) so a tree move never registers as
  /// an embed and vice versa.
  const TREE_MOVE_MIME = "application/x-inkycap-tree-move";

  /// Context-menu entry point for a single node: open the folder picker,
  /// then move the node into the chosen folder. The picker is notebox-
  /// scoped and hides the node's own subtree (for folders) and current
  /// parent, so every returned destination is a valid, non-trivial move.
  async function moveNodeViaDialog(node: FileTreeNode) {
    setFileContextMenu(null);
    const root = noteboxInfo()?.path ?? "";
    const slash = node.path.lastIndexOf("/");
    const currentParent = slash >= 0 ? node.path.slice(0, slash) : root;
    const dest = await pickFolder({
      title: node.is_dir ? t("leftSidebar.moveFolder") : t("leftSidebar.moveFile"),
      disallowPrefix: node.is_dir ? node.path : undefined,
      currentParent,
    });
    if (dest == null) return;
    const destDir = dest === "" ? root : `${root}/${dest}`;
    moveItems([{ path: node.path, is_dir: node.is_dir }], destDir);
  }

  /// Move one or more dragged files or folders into `destDir`
  /// (an absolute path, or the notebox root). Each item is checked for a
  /// no-op move and folder-into-self; the backend rebases relative asset
  /// paths and reindexes, and the file watcher refreshes the tree —
  /// `refresh()` is belt-and-braces so the move shows immediately even if
  /// the watcher event is debounced.
  async function moveItems(
    items: { path: string; is_dir: boolean }[],
    destDir: string,
  ) {
    const root = noteboxInfo()?.path ?? "";
    const destRel =
      destDir === root || destDir === ""
        ? ""
        : destDir.startsWith(root + "/")
          ? destDir.slice(root.length + 1)
          : destDir;
    let moved = false;
    for (const src of items) {
      const slash = src.path.lastIndexOf("/");
      const srcParent = slash >= 0 ? src.path.slice(0, slash) : root;
      if (srcParent === destDir) continue; // already in that folder
      if (
        src.is_dir &&
        (destDir === src.path || destDir.startsWith(src.path + "/"))
      ) {
        toastError(t("leftSidebar.moveIntoSelf"));
        continue;
      }
      try {
        if (src.is_dir) {
          await ipc.moveFolder(src.path, destRel);
        } else {
          await ipc.moveFile(src.path, destRel);
        }
        moved = true;
      } catch (e) {
        toastError(t("leftSidebar.moveItemFailed"), e);
      }
    }
    if (moved) {
      refresh();
    }
  }

  // ── Collection CRUD ──

  async function createCollection() {
    if (!noteboxInfo()) return;
    const name = await promptText({
      title: t("leftSidebar.newCollectionTitle"),
      label: t("leftSidebar.collectionNameLabel"),
      confirmLabel: t("common.create"),
    });
    if (!name?.trim()) return;
    try {
      const col = await ipc.createCollectionFile(name.trim());
      refresh();
      openCollection(col);
    } catch (e) {
      toastError(t("leftSidebar.createCollectionFailed"), e);
    }
  }

  async function deleteCollection(col: CollectionInfo) {
    setContextMenu(null);
    const confirmed = await promptConfirm({
      title: t("leftSidebar.deleteCollectionTitle"),
      message: t("leftSidebar.deleteCollectionBody", { name: col.name }),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
    });
    if (!confirmed) return;
    try {
      await ipc.deleteCollectionFile(col.path);
      // Close any open tab for this collection
      const openCollTab = tabs.find(
        (t) => t.type === "collection" && pathEquals(t.path, col.path),
      );
      if (openCollTab) closeTab(openCollTab.id);
      refresh();
    } catch (e) {
      toastError(t("leftSidebar.deleteCollectionFailed"), e);
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
      toastError(t("leftSidebar.renameCollectionFailed"), e);
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
    // Keep the keyboard cursor on the row the menu acts on.
    setFocusedTreePath(node.path);
    const { x, y } = clampMenuPos(e.clientX, e.clientY);
    setFileContextMenu({ x, y, node });
  }

  /**
   * Create a new note via the built-in `new-note` creation rule.
   *
   * `targetFolder`, when provided, is the absolute path of the folder
   * that should host the new note (used by the file-tree context menu
   * "New File" entry). It's converted to a notebox-root-relative path
   * and passed to the rule as an override. When omitted, the rule's own
   * folder logic (and the user's "New note location" preference) apply
   * — that's the path used by the file tree's New Note icon button and
   * the global Ctrl+N hotkey.
   */
  async function createNewNote(targetFolder?: string) {
    setFileContextMenu(null);
    const info = noteboxInfo();
    if (!info) return;
    let folderOverride: string | undefined;
    if (targetFolder && targetFolder !== info.path) {
      const rootWithSep = info.path.endsWith("/") ? info.path : `${info.path}/`;
      folderOverride = targetFolder.startsWith(rootWithSep)
        ? targetFolder.slice(rootWithSep.length)
        : targetFolder;
    } else if (targetFolder === info.path) {
      folderOverride = "";
    }
    try {
      const result = await triggerCreationRule("new-note", {
        targetFolder: folderOverride,
      });
      if (!result) return;
      refresh();
      const title = result.path.split(/[/\\]/).pop() ?? t("leftSidebar.newNoteFallback");
      openCreatedNote(
        { type: "file", title, path: result.path },
        { cursorOffset: result.cursor_offset ?? undefined },
      );
    } catch (e) {
      toastError(t("rightPanel.toast.createNoteFailed"), e);
    }
  }

  async function createNewFolder(parentFolder: string) {
    setFileContextMenu(null);
    const name = await promptText({
      title: t("leftSidebar.newFolderTitle"),
      label: t("leftSidebar.folderNameLabel"),
      confirmLabel: t("common.create"),
    });
    if (!name?.trim()) return;
    try {
      await ipc.createFolder(name.trim(), parentFolder);
      refresh();
    } catch (e) {
      toastError(t("leftSidebar.createFolderFailed"), e);
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
      toastError(t("leftSidebar.renameFailed"), e);
    }
  }

  /// Delete one or more files/folders, after a single confirmation that
  /// names the item (or counts them). The array signature is kept so a
  /// drop or future multi-item gesture can delete several at once.
  async function deleteItems(items: { path: string; is_dir: boolean }[]) {
    setFileContextMenu(null);
    if (items.length === 0) return;
    const settings = await ipc.getSettings();
    if (settings.files.confirm_before_delete) {
      const message =
        items.length === 1
          ? t("leftSidebar.deleteOneBody", { name: items[0].path.split("/").pop() ?? "" })
          : t("leftSidebar.deleteManyBody", { count: items.length });
      const confirmed = await promptConfirm({
        title: t("leftSidebar.deleteTitle"),
        message,
        confirmLabel: t("common.delete"),
        cancelLabel: t("common.cancel"),
      });
      if (!confirmed) return;
    }
    let deleted = false;
    for (const item of items) {
      try {
        if (item.is_dir) {
          await ipc.deleteFolder(item.path);
        } else {
          await ipc.deleteFile(item.path);
          // Close any open tab for this file.
          const openFileTab = tabs.find(
            (t) => t.type === "file" && pathEquals(t.path, item.path),
          );
          if (openFileTab) closeTab(openFileTab.id);
        }
        deleted = true;
      } catch (e) {
        toastError(t("leftSidebar.deleteFailed"), e);
      }
    }
    if (deleted) {
      refresh();
    }
  }

  async function createNewFolderAtRoot() {
    setShowNewMenu(false);
    const info = noteboxInfo();
    if (!info) return;
    await createNewFolder(info.path);
  }

  async function uploadIntoNotebox() {
    setShowNewMenu(false);
    try {
      const picked = await ipc.pickFilesForImport();
      if (picked.length === 0) return; // cancelled

      // Markdown files are notes, not attachments. If any were selected, ask
      // once whether to convert them to Typst or keep them as-is.
      const mdFiles = picked.filter((f) => f.is_markdown);
      let convertMarkdown = false;
      if (mdFiles.length > 0) {
        const names = mdFiles.map((f) => f.path.split(/[/\\]/).pop() ?? f.path);
        const choice = await askMarkdownImport(names);
        if (choice === "cancel") return;
        convertMarkdown = choice === "convert";
      }

      let attachments = 0;
      let notes = 0;
      let lastName = "";
      for (const file of picked) {
        if (file.is_markdown && convertMarkdown) {
          const rel = await ipc.importMarkdownFile(file.path);
          notes += 1;
          lastName = rel.split(/[/\\]/).pop() ?? rel;
        } else {
          const rel = await ipc.copyPathToAttachments(file.path);
          attachments += 1;
          lastName = rel;
        }
      }

      refresh();
      // Summarize: prefer the note phrasing when notes were imported, else the
      // attachment phrasing. (A mixed selection reports the note count, since
      // that's the gesture's headline outcome.)
      if (notes > 0) {
        toastSuccess(
          notes === 1
            ? t("leftSidebar.importedNoteOne", { name: lastName })
            : t("leftSidebar.importedNoteMany", { count: notes }),
        );
      } else if (attachments > 0) {
        toastSuccess(
          attachments === 1
            ? t("leftSidebar.uploadedOne", { name: lastName })
            : t("leftSidebar.uploadedMany", { count: attachments }),
        );
      }
    } catch (e) {
      toastError(t("leftSidebar.uploadFailed"), e);
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
    <div class="left-sidebar" data-focus-region="sidebar">
      <div
        class="left-sidebar__mode-bar"
        ref={modeOverflow.ref}
        data-overflow={modeOverflow.overflowing() ? "true" : undefined}
        data-panel-tablist
      >
        <button
          class={`left-sidebar__mode-btn ${mode() === "filetree" ? "left-sidebar__mode-btn--active" : ""}`}
          onClick={() => setMode("filetree")}
          title={t("leftSidebar.fileTree")}
          aria-label={t("leftSidebar.fileTree")}
        >
          <FolderTree size={18} />
        </button>
        <button
          class={`left-sidebar__mode-btn ${mode() === "collections" ? "left-sidebar__mode-btn--active" : ""}`}
          onClick={() => setMode("collections")}
          title={t("leftSidebar.collections")}
          aria-label={t("leftSidebar.collections")}
        >
          <LibraryBig size={18} />
        </button>
        <button
          class={`left-sidebar__mode-btn ${mode() === "agenda" ? "left-sidebar__mode-btn--active" : ""}`}
          onClick={() => setMode("agenda")}
          title={t("leftSidebar.agenda")}
          aria-label={t("leftSidebar.agenda")}
        >
          <Calendar size={18} />
        </button>
        <button
          class={`left-sidebar__mode-btn ${mode() === "properties" ? "left-sidebar__mode-btn--active" : ""}`}
          onClick={() => setMode("properties")}
          title={t("leftSidebar.properties")}
          aria-label={t("leftSidebar.properties")}
        >
          <NotebookTabs size={18} />
        </button>
        <button
          class={`left-sidebar__mode-btn ${mode() === "tags" ? "left-sidebar__mode-btn--active" : ""}`}
          onClick={() => setMode("tags")}
          title={t("leftSidebar.tags")}
          aria-label={t("leftSidebar.tags")}
        >
          <Tags size={18} />
        </button>
        <button
          class={`left-sidebar__mode-btn ${mode() === "bookmarks" ? "left-sidebar__mode-btn--active" : ""}`}
          onClick={() => setMode("bookmarks")}
          title={t("leftSidebar.bookmarks")}
          aria-label={t("leftSidebar.bookmarks")}
        >
          <BookMarked size={18} />
        </button>
      </div>
      <div class="left-sidebar__content">
        <Show when={mode() === "collections"}>
          <div class="left-sidebar__section-header">
            <span>{t("leftSidebar.collections")}</span>
            <div class="left-sidebar__header-actions">
              <div class="left-sidebar__sort-wrap">
                <button
                  ref={collectionSortBtnRef}
                  class="left-sidebar__icon-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowCollectionSortMenu((v) => !v);
                  }}
                  title={t("leftSidebar.sortCollections")}
                  aria-label={t("leftSidebar.sortCollections")}
                >
                  <ArrowDownNarrowWide size={18} />
                </button>
                <Show when={showCollectionSortMenu()}>
                  <div
                    class="context-menu"
                    ref={(el) => anchorPanelMenu(collectionSortBtnRef, el)}
                    use:clickOutside={{
                      onDismiss: () => setShowCollectionSortMenu(false),
                      ignore: collectionSortBtnRef,
                    }}
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
                          {t(opt.labelKey)}
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
                title={t("leftSidebar.filterCollections")}
                aria-label={t("leftSidebar.filterCollections")}
                aria-pressed={showCollectionSearch()}
              >
                <Search size={14} />
              </button>
              <button
                class="pane-action-btn left-sidebar__add-btn"
                onClick={createCollection}
                title={t("leftSidebar.newCollection")}
                aria-label={t("leftSidebar.newCollection")}
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
                placeholder={t("leftSidebar.filterCollectionsPlaceholder")}
                value={collectionFilter()}
                onInput={(e) => setCollectionFilter(e.currentTarget.value)}
                autofocus
              />
              <Show when={collectionFilter().length > 0}>
                <button
                  class="left-sidebar__filter-clear"
                  onMouseDown={(e) => { e.preventDefault(); setCollectionFilter(""); }}
                  title={t("references.clearFilter")}
                  aria-label={t("references.clearFilter")}
                >
                  <X size={12} />
                </button>
              </Show>
            </div>
          </Show>
          <Show
            when={!collections.loading}
            fallback={<p class="sidebar-hint">{t("common.loading")}</p>}
          >
            <For
              each={sortedFilteredCollections()}
              fallback={<p class="sidebar-hint">{t("leftSidebar.noCollections")}</p>}
            >
              {(col) => (
                <Show
                  when={renamingPath() === col.path}
                  fallback={
                    <div
                      classList={{
                        "sidebar-item": true,
                        // Highlight the collection whose tab is currently active,
                        // mirroring how the file tree marks the open file.
                        "sidebar-item--active":
                          getActiveTab()?.type === "collection" &&
                          pathEquals(getActiveTab()?.path, col.path),
                      }}
                      onClick={() => openCollection(col)}
                      onContextMenu={(e) => handleCollectionContext(e, col)}
                    >
                      <span class="sidebar-item__icon">
                        <RuleIcon iconEmoji={col.icon ?? "lucide:folder-pen"} name={col.name} size={14} />
                      </span>
                      <span class="sidebar-item__label">{col.name}</span>
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

        <Show when={mode() === "agenda"}>
          <AgendaPanel refreshTick={refreshTick()} />
        </Show>

        <Show when={mode() === "filetree"}>
          <div class="left-sidebar__section-header">
            <span>{t("leftSidebar.files")}</span>
            <div class="left-sidebar__header-actions">
              <div class="left-sidebar__sort-wrap">
                <button
                  ref={fileSortBtnRef}
                  class="left-sidebar__icon-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowFileSortMenu((v) => !v);
                  }}
                  title={t("leftSidebar.sortFiles")}
                  aria-label={t("leftSidebar.sortFiles")}
                >
                  <ArrowDownNarrowWide size={18} />
                </button>
                <Show when={showFileSortMenu()}>
                  <div
                    class="context-menu"
                    ref={(el) => anchorPanelMenu(fileSortBtnRef, el)}
                    use:clickOutside={{
                      onDismiss: () => setShowFileSortMenu(false),
                      ignore: fileSortBtnRef,
                    }}
                  >
                    <For each={FILE_TREE_SORT_OPTIONS}>
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
                          {t(opt.labelKey)}
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
                title={allDirsExpanded() ? t("leftSidebar.collapseAllFolders") : t("leftSidebar.expandAllFolders")}
                aria-label={allDirsExpanded() ? t("leftSidebar.collapseAllFolders") : t("leftSidebar.expandAllFolders")}
              >
                <Show
                  when={allDirsExpanded()}
                  fallback={<ListChevronsUpDown size={18} />}
                >
                  <ListChevronsDownUp size={18} />
                </Show>
              </button>
              <div
                class="left-sidebar__split-btn"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  class="left-sidebar__split-btn__main"
                  onClick={() => createNewNote()}
                  title={(() => {
                    const rule = creationRules().find((r) => r.id === "new-note");
                    const hotkey = rule?.hotkey ?? "Ctrl+N";
                    return t("leftSidebar.newNoteTitle", { hotkey });
                  })()}
                  aria-label={t("leftSidebar.newNote")}
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
                  title={t("leftSidebar.moreOptions")}
                  aria-label={t("leftSidebar.moreCreateOptions")}
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
                      <span>{t("leftSidebar.newFolder")}</span>
                    </button>
                    <button
                      class="context-menu__item context-menu__item--icon"
                      role="menuitem"
                      onClick={uploadIntoNotebox}
                    >
                      <Download size={14} />
                      <span>{t("leftSidebar.copyIntoNotebox")}</span>
                    </button>
                  </div>
                </Show>
              </div>
            </div>
          </div>
          <Show
            // Only show the loading hint on the very first load. Solid keeps
            // the resolved tree available during a refetch (e.g. after a move),
            // so gating on "have we any data yet" keeps the tree on screen and
            // avoids a jarring flash to the loading state after each drop.
            when={fileTree() !== undefined}
            fallback={<p class="sidebar-hint">{t("common.loading")}</p>}
          >
            {/* Root drop zone: a drag released outside any folder row
                lands here and moves the item to the notebox root. Rows
                stop propagation on their own drag events, so this only
                fires for the empty space / top-level area. */}
            <div
              ref={initTreeViewport}
              classList={{
                "left-sidebar__tree-root": true,
                "left-sidebar__tree-root--drop-target":
                  dragOverDir() === (noteboxInfo()?.path ?? ""),
              }}
              // One Tab stop for the whole tree (ARIA tree pattern); arrow keys
              // move `focusedTreePath`. `data-focus-entry` makes F6 land here.
              tabindex={0}
              role="tree"
              data-focus-entry
              aria-label={t("leftSidebar.fileTree")}
              aria-activedescendant={
                focusedTreePath() ? treeItemId(focusedTreePath()!) : undefined
              }
              onKeyDown={onTreeKeyDown}
              onFocus={() => {
                if (focusedTreePath()) return;
                const rows = flatRows();
                if (rows.length === 0) return;
                const activePath = getActiveTab()?.path ?? null;
                const start = activePath && rows.some((r) => pathEquals(r.node.path, activePath))
                  ? activePath
                  : rows[0].node.path;
                focusTreeRow(start);
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
                  moveItems(JSON.parse(raw), noteboxInfo()?.path ?? "");
                } catch {
                  /* malformed payload — ignore */
                }
              }}
            >
              {/* Windowed render: a full-height spacer preserves the scrollbar
                  while only the visible row slice is mounted, translated to its
                  position. Descendants are already separate flat rows, so each
                  TreeNode renders just itself (indented by depth) — no recursion. */}
              <div
                style={{
                  height: `${flatRows().length * (rowHeight() || 28)}px`,
                  position: "relative",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${treeWindow().start * (rowHeight() || 28)}px)`,
                  }}
                >
                  <For each={windowedRows()}>
                    {(row) => (
                      <TreeNode
                        node={row.node}
                        depth={row.depth}
                        focusedPath={focusedTreePath}
                        onNodeClick={handleNodeClick}
                        onAuxOpen={openFileInNewTab}
                        onContext={handleFileContext}
                        renamingPath={fileRenamingPath()}
                        renameValue={fileRenameValue()}
                        onRenameInput={setFileRenameValue}
                        onRenameCommit={commitFileRename}
                        onRenameCancel={() => setFileRenamingPath(null)}
                        activePath={getActiveTab()?.path ?? null}
                        noteboxRoot={noteboxInfo()?.path ?? ""}
                        expandedDirs={expandedDirs}
                        onToggleDir={toggleDir}
                        treeMoveMime={TREE_MOVE_MIME}
                        dragItems={dragItemsFor}
                        dragOverDir={dragOverDir}
                        setDragOverDir={setDragOverDir}
                        draggingPath={draggingPath}
                        setDraggingPath={setDraggingPath}
                        onStartDragGhost={startDragGhost}
                        onMoveItems={moveItems}
                      />
                    )}
                  </For>
                </div>
              </div>
            </div>
          </Show>
        </Show>

        <Show when={mode() === "search"}>
          <SearchPanel />
        </Show>

        <Show when={mode() === "tags"}>
          <div class="left-sidebar__section-header">
            <span>{t("leftSidebar.tags")}</span>
            <div class="left-sidebar__header-actions">
              <div class="left-sidebar__sort-wrap">
                <button
                  ref={tagSortBtnRef}
                  class="left-sidebar__icon-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowTagSortMenu((v) => !v);
                  }}
                  title={t("leftSidebar.sortTags")}
                  aria-label={t("leftSidebar.sortTags")}
                >
                  <ArrowDownNarrowWide size={18} />
                </button>
                <Show when={showTagSortMenu()}>
                  <div
                    class="context-menu"
                    ref={(el) => anchorPanelMenu(tagSortBtnRef, el)}
                    use:clickOutside={{
                      onDismiss: () => setShowTagSortMenu(false),
                      ignore: tagSortBtnRef,
                    }}
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
                          {t(opt.labelKey)}
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
                title={t("leftSidebar.filterTags")}
                aria-label={t("leftSidebar.filterTags")}
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
                placeholder={t("leftSidebar.filterTagsPlaceholder")}
                value={tagFilter()}
                onInput={(e) => setTagFilter(e.currentTarget.value)}
                autofocus
              />
              <Show when={tagFilter().length > 0}>
                <button
                  class="left-sidebar__filter-clear"
                  onMouseDown={(e) => { e.preventDefault(); setTagFilter(""); }}
                  title={t("references.clearFilter")}
                  aria-label={t("references.clearFilter")}
                >
                  <X size={12} />
                </button>
              </Show>
            </div>
          </Show>
          <div class="left-sidebar__tag-list" ref={attachListNav} aria-label={t("leftSidebar.tags")}>
          <Show when={noteboxIndex()} fallback={<p class="sidebar-hint">{t("common.loading")}</p>}>
            {(idx) => (
              <For
                each={sortAndFilterList(idx().tags, tagSortMode(), tagFilter())}
                fallback={<p class="sidebar-hint">{t("leftSidebar.noTags")}</p>}
              >
                {([tag, count]) => (
                  <Show
                    when={renamingTag() === tag}
                    fallback={
                      <div
                        data-list-item
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
          </div>
        </Show>

        <Show when={mode() === "properties"}>
          <div class="left-sidebar__section-header">
            <span>{t("leftSidebar.properties")}</span>
            <div class="left-sidebar__header-actions">
              <div class="left-sidebar__sort-wrap">
                <button
                  ref={propSortBtnRef}
                  class="left-sidebar__icon-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowPropSortMenu((v) => !v);
                  }}
                  title={t("leftSidebar.sortProperties")}
                  aria-label={t("leftSidebar.sortProperties")}
                >
                  <ArrowDownNarrowWide size={18} />
                </button>
                <Show when={showPropSortMenu()}>
                  <div
                    class="context-menu"
                    ref={(el) => anchorPanelMenu(propSortBtnRef, el)}
                    use:clickOutside={{
                      onDismiss: () => setShowPropSortMenu(false),
                      ignore: propSortBtnRef,
                    }}
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
                          {t(opt.labelKey)}
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
                title={t("leftSidebar.filterProperties")}
                aria-label={t("leftSidebar.filterProperties")}
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
                placeholder={t("leftSidebar.filterPropertiesPlaceholder")}
                value={propFilter()}
                onInput={(e) => setPropFilter(e.currentTarget.value)}
                autofocus
              />
              <Show when={propFilter().length > 0}>
                <button
                  class="left-sidebar__filter-clear"
                  onMouseDown={(e) => { e.preventDefault(); setPropFilter(""); }}
                  title={t("references.clearFilter")}
                  aria-label={t("references.clearFilter")}
                >
                  <X size={12} />
                </button>
              </Show>
            </div>
          </Show>
          <Show when={noteboxIndex()} fallback={<p class="sidebar-hint">{t("common.loading")}</p>}>
            {(idx) => (
              <For
                each={sortAndFilterList(idx().property_keys, propSortMode(), propFilter())}
                fallback={<p class="sidebar-hint">{t("leftSidebar.noProperties")}</p>}
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
            <span>{t("leftSidebar.bookmarks")}</span>
          </div>
          <BookmarksPanel refreshTick={refreshTick()} />
        </Show>

        <Show when={mode() === "templates"}>
          <TemplatesPanel />
        </Show>

        <Show when={mode() === "collaboration"}>
          {/* Remount on notebox switch so the setup/manage forms (which seed
              their fields from the notebox's git config + identity at mount)
              re-seed from the current notebox. Keyed on `noteboxUiKey`, which
              bumps *after* the new notebox's settings load — keying on the path
              would remount against the previous notebox's still-loaded settings. */}
          <Show when={`nb-${noteboxUiKey()}`} keyed>
            {(_key: string) => <GitCollaborationPanel />}
          </Show>
        </Show>

        <Show when={mode() === "help"}>
          <HelpPanel />
        </Show>

        {/* Contributed sidebar panes (plugins / manifest query-views). Each
            renders only when its mode is active; built-in mode ids never match
            a contributed id, so the built-in panes above are unaffected. When
            the registry is empty this renders nothing. */}
        <For each={sidebarContributions()}>
          {(c) => (
            <Show when={mode() === c.id}>
              <Dynamic component={c.component} />
            </Show>
          )}
        </For>
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
              {t("leftSidebar.bookmark")}
            </button>
            <button
              class="context-menu__item"
              onClick={() => startRename(menu().collection)}
            >
              {t("common.rename")}
            </button>
            <button
              class="context-menu__item context-menu__item--danger"
              onClick={() => deleteCollection(menu().collection)}
            >
              {t("common.delete")}
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
              {t("common.rename")}
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
              {t("rightPanel.propertyType")}
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
            <Show when={!isSystemProperty(menu().key)}>
              <button
                class="context-menu__item"
                onClick={() => startPropertyRename(menu().key)}
              >
                {t("common.rename")}
              </button>
            </Show>
            <button
              class="context-menu__item context-menu__item--danger"
              onClick={() => handleDeleteProperty(menu().key)}
            >
              {t("common.delete")}
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
              <Show when={!node.is_dir && isAppEditable(node.name)}>
                <button
                  class="context-menu__item"
                  onClick={() => {
                    setFileContextMenu(null);
                    openFileInNewTab(node);
                  }}
                >
                  {t("wikilink.menu.openNewTab")}
                </button>
                <div class="context-menu__separator" />
              </Show>
              <button
                class="context-menu__item"
                onClick={() => createNewNote(folderPath)}
              >
                {t("leftSidebar.menuNewNote")}
              </button>
              <button
                class="context-menu__item"
                onClick={() => createNewFolder(folderPath)}
              >
                {t("leftSidebar.menuNewFolder")}
              </button>
              <Show when={!node.is_dir && isNoteFile(node.name)}>
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
                  {t("leftSidebar.bookmark")}
                </button>
              </Show>
              <div class="context-menu__separator" />
              <button
                class="context-menu__item"
                onClick={() => moveNodeViaDialog(node)}
              >
                {node.is_dir ? t("leftSidebar.moveFolder") : t("leftSidebar.moveFile")}
              </button>
              <button
                class="context-menu__item"
                onClick={() => startFileRename(node)}
              >
                {t("common.rename")}
              </button>
              <button
                class="context-menu__item context-menu__item--danger"
                onClick={() =>
                  deleteItems([{ path: node.path, is_dir: node.is_dir }])
                }
              >
                {t("common.delete")}
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
  /// Path of the keyboard cursor (ARIA tree navigation). The row whose path
  /// matches gets the `--kbd-focus` style and is the `aria-activedescendant`.
  focusedPath: () => string | null;
  /// Click handler: a plain click opens the file / toggles the folder; a
  /// Ctrl/Cmd-click on a file opens it in a new tab.
  onNodeClick: (node: FileTreeNode, e: MouseEvent) => void;
  /// Middle-click (scroll-wheel) on a file: open it in a new background tab,
  /// matching the collection table and agenda list.
  onAuxOpen: (node: FileTreeNode) => void;
  onContext: (e: MouseEvent, node: FileTreeNode) => void;
  renamingPath: string | null;
  renameValue: string;
  onRenameInput: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  activePath: string | null;
  noteboxRoot: string;
  /// Hoisted expansion state so the Expand All / Collapse All toolbar
  /// button can flip every folder at once. Each TreeNode reads its own
  /// directory's expanded flag from this set and toggles via the
  /// `onToggleDir` callback.
  expandedDirs: () => Set<string>;
  onToggleDir: (path: string) => void;
  /// Drag-to-move plumbing. `treeMoveMime` is the dataTransfer type that
  /// carries the dragged node; `dragItems` resolves a row to the items a
  /// drag should carry; `dragOverDir` / `setDragOverDir` track which row
  /// is the current drop target so it can highlight; and `onMoveItems`
  /// performs the move once a drop lands.
  treeMoveMime: string;
  dragItems: (node: FileTreeNode) => { path: string; is_dir: boolean }[];
  dragOverDir: () => string | null;
  setDragOverDir: (path: string | null) => void;
  /// Path of the row currently being dragged (dims it in place).
  draggingPath: () => string | null;
  setDraggingPath: (path: string | null) => void;
  /// Spawn the cursor-following drag-ghost chip (the native drag image is
  /// suppressed because WebKitGTK renders it blurry/oversized on HiDPI).
  onStartDragGhost: (label: string, clientX: number, clientY: number) => void;
  onMoveItems: (
    items: { path: string; is_dir: boolean }[],
    destDir: string,
  ) => void;
  depth?: number;
}> = (props) => {
  const depth = props.depth ?? 0;
  const expanded = () => props.expandedDirs().has(props.node.path);

  const isRenaming = () => props.renamingPath === props.node.path;
  const isActive = () =>
    !props.node.is_dir && pathEquals(props.activePath, props.node.path);

  /// Folder a drop on this row moves the item into: the folder itself
  /// for a directory row, or the containing folder for a file row.
  const dropDest = () => {
    if (props.node.is_dir) return props.node.path;
    const slash = props.node.path.lastIndexOf("/");
    return slash >= 0 ? props.node.path.slice(0, slash) : props.noteboxRoot;
  };
  const isDropTarget = () => props.dragOverDir() === props.node.path;
  // Reveal (auto-expand ancestors + scroll into view) is driven from the
  // parent against the flat list, since a collapsed/off-screen target has no
  // mounted row to react here.

  return (
    <div>
      <Show
        when={isRenaming()}
        fallback={
          <div
            id={treeItemId(props.node.path)}
            role="treeitem"
            aria-selected={isActive() || undefined}
            aria-expanded={props.node.is_dir ? expanded() : undefined}
            classList={{
              "sidebar-item": true,
              "sidebar-item--dir": props.node.is_dir,
              "sidebar-item--non-note":
                !props.node.is_dir && !isAppEditable(props.node.name),
              "sidebar-item--active": isActive(),
              "sidebar-item--kbd-focus": props.focusedPath() === props.node.path,
              "sidebar-item--drop-target": isDropTarget(),
              "sidebar-item--dragging": props.draggingPath() === props.node.path,
            }}
            style={{ "padding-left": `${depth * 16 + 8}px` }}
            draggable={true}
            onDragStart={(e) => {
              // Intra-sidebar move payload — the dragged file/folder.
              const items = props.dragItems(props.node);
              e.dataTransfer!.setData(
                props.treeMoveMime,
                JSON.stringify(items),
              );
              if (!props.node.is_dir) {
                // A file can also be dropped into the editor to embed it,
                // which reads this notebox-relative-path payload.
                const rel = props.node.path.startsWith(props.noteboxRoot + "/")
                  ? props.node.path.slice(props.noteboxRoot.length + 1)
                  : props.node.name;
                e.dataTransfer!.setData("application/x-inkycap-notebox-path", rel);
                e.dataTransfer!.effectAllowed = "copyMove";
              } else {
                e.dataTransfer!.effectAllowed = "move";
              }
              // Suppress WebKitGTK's native drag image (a blurry, oversized
              // snapshot of the row) and drive a crisp DOM chip that follows
              // the cursor instead — see `startDragGhost`. The suppressor must
              // be a 1×1 transparent element that is ATTACHED to the document:
              // a detached element aborts the drag in WebKitGTK. It's removed
              // on the next tick, once the browser has taken the image.
              const blank = document.createElement("canvas");
              blank.width = blank.height = 1;
              blank.style.cssText = "position:fixed;top:-10px;left:-10px;opacity:0";
              document.body.appendChild(blank);
              e.dataTransfer!.setDragImage(blank, 0, 0);
              setTimeout(() => blank.remove(), 0);
              props.onStartDragGhost(props.node.name, e.clientX, e.clientY);
              // Dim the source row in place.
              props.setDraggingPath(props.node.path);
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer?.types.includes(props.treeMoveMime)) return;
              // Claim this drag: preventDefault enables the drop, and
              // stopPropagation keeps the root drop zone from also
              // registering as the target.
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "move";
              // Highlight the folder the item will actually land in — the
              // folder itself for a directory row, the containing folder for
              // a file row — so the indicator shows the real destination.
              props.setDragOverDir(dropDest());
            }}
            onDragLeave={(e) => {
              if (
                e.currentTarget === e.target &&
                props.dragOverDir() === dropDest()
              ) {
                props.setDragOverDir(null);
              }
            }}
            onDrop={(e) => {
              const raw = e.dataTransfer?.getData(props.treeMoveMime);
              props.setDragOverDir(null);
              props.setDraggingPath(null);
              if (!raw) return;
              e.preventDefault();
              e.stopPropagation();
              try {
                props.onMoveItems(JSON.parse(raw), dropDest());
              } catch {
                /* malformed payload — ignore */
              }
            }}
            onClick={(e) => props.onNodeClick(props.node, e)}
            onAuxClick={(e) => {
              if (e.button !== 1 || props.node.is_dir) return; // middle-click on a file → new tab
              e.preventDefault();
              props.onAuxOpen(props.node);
            }}
            onContextMenu={(e) => props.onContext(e, props.node)}
          >
            <span
              class="sidebar-item__icon"
              classList={{ "sidebar-item__icon--placeholder": !props.node.is_dir }}
              aria-hidden={!props.node.is_dir || undefined}
            >
              {props.node.is_dir &&
                (expanded() ? (
                  <ChevronDown size={14} />
                ) : (
                  <ChevronRight size={14} />
                ))}
            </span>
            <span
              class="sidebar-item__label"
              // Non-note files are de-emphasized; when the user has
              // extension display off, the hover title surfaces the full
              // filename so it's clear *why* the row is dimmed.
              title={
                isAppEditable(props.node.name) ? undefined : props.node.name
              }
            >{
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
    </div>
  );
};

export default LeftSidebar;
