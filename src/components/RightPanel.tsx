// Right panel: tabbed view with Properties, Outline, and Links
// for the active file.

import { Component, createEffect, createMemo, createResource, createSignal, For, Show, onCleanup, onMount, untrack } from "solid-js";
import { getActiveTab, openTab, closeTab } from "../stores/tabs";
import {
  contextNotes,
  hoveredGraphNode,
  setHoveredContextNote,
} from "../stores/mycelial";
import type { LinkInfo, PropertyType, PropertyValue } from "../lib/types";
import { normalizePath } from "../lib/paths";
import * as ipc from "../lib/ipc";
import type { OutboundLink, PotentialLink } from "../lib/ipc";
import type { SearchResult } from "../lib/types";
import { indexReady, bumpPropertyVersion } from "../stores/notebox";
import { moveActiveFileInteractive } from "../lib/move-file";
import { deleteActiveFileInteractive } from "../lib/delete-file";
import { createOverflowWatcher } from "../lib/overflow";
import {
  PROPERTY_TYPE_OPTIONS,
  propertyTypeLabel,
  propertyTypeIcon,
  reloadPropertyTypes,
  propertyType as getPropertyType,
  inferPropertyType,
} from "../stores/propertyTypes";
import PropertyEditor from "./PropertyEditor";
import OutlinePanel from "./OutlinePanel";
import AnnotationsPanel from "./AnnotationsPanel";
import {
  noteAnnotations,
  rescanAnnotations,
} from "../editor/typst-decorations/annotation-tracker";
import { changesSinceSync } from "../stores/git";
import ScrollContextPanel from "./ScrollContextPanel";
import {
  isEnabled as isScrollEnabled,
  getScrollDirection,
  scrollToAnchor,
  toggleScrollDirection,
} from "../stores/journal-scroll";
import { useI18n } from "../lib/i18n";
import {
  EllipsisVertical,
  NotebookTabs,
  TableOfContents,
  Link,
  Quote,
  Newspaper,
  Anchor,
  CalendarArrowDown,
  CalendarArrowUp,
  ArrowDownNarrowWide,
  ListChevronsUpDown,
  ListChevronsDownUp,
  LayersPlus,
  Search,
  X,
  ChevronDown,
  ChevronRight,
  MessagesSquare,
  Settings2,
  Ligature,
  Waypoints,
  Filter,
} from "lucide-solid";
import { Dynamic } from "solid-js/web";
import ReferencesPanel from "./ReferencesPanel";
import CollectionSettings from "./CollectionSettings";
import MycelialFilteringPanel from "./MycelialFilteringPanel";
import { rightPanelContributions, rightPanelContribution } from "./right-panel-registry";
import { Dropdown } from "./Dropdown";
import { toastError } from "../stores/toasts";
import { promptText } from "../stores/prompt";
import {
  rightPanelTab,
  setRightPanelTab,
  type RightPanelTab,
  collectionPanelTab,
  setCollectionPanelTab,
  type CollectionPanelTab,
} from "../stores/layout";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { anchorPanelMenu } from "../lib/uiMenu";
import { clickOutside } from "../lib/clickOutside";
import { activeEditorView } from "../stores/editor";
import { openEditorFind, openEditorReplace } from "../editor/search-panel";
import {
  LINKS_SORT_OPTIONS,
  linksSortMode,
  setLinksSortMode,
  linksCollapsePreviews,
  setLinksCollapsePreviews,
  linksExpandOverrides,
  toggleLinksPreviewOverride,
  linksShowMoreContext,
  setLinksShowMoreContext,
  linksShowFilter,
  setLinksShowFilter,
  linksFilterQuery,
  setLinksFilterQuery,
  linksSectionExpanded,
  setLinksSectionExpanded,
  type LinksSortMode,
  type LinksSection,
} from "../stores/linksPanel";

const KNOWN_FIELDS_ORDERED = [
  "title", "aliases", "description", "tags", "date", "due",
  "task", "disposition", "source", "zid", "collection",
];
const KNOWN_FIELDS = new Set(KNOWN_FIELDS_ORDERED);

const KNOWN_FIELD_TYPES: Record<string, PropertyType> = {
  title: "text",
  aliases: "list",
  description: "text",
  tags: "list",
  date: "date",
  due: "date",
  task: "checkbox",
  disposition: "list",
  source: "text",
  zid: "number",
  collection: "list",
};

function defaultForType(ty: PropertyType): PropertyValue {
  switch (ty) {
    case "checkbox": return false;
    case "number": return 0;
    case "list": return [];
    case "date":
    case "datetime":
    case "text":
    default:
      return "";
  }
}

function defaultForKey(key: string): PropertyValue {
  const knownType = KNOWN_FIELD_TYPES[key];
  if (knownType) return defaultForType(knownType);
  return "";
}

/** Extended link info with multi-line context for the Links pane. */
interface BacklinkWithContext extends LinkInfo {
  line?: string;
  context_before?: string[];
  context_after?: string[];
}

const RightPanel: Component = () => {
  const t = useI18n();
  const activePanel = rightPanelTab;
  const setActivePanel = (tab: RightPanelTab) => setRightPanelTab(tab);

  // Edge-shadow cue when the tab bar is too narrow to show every tab (the user
  // widens the panel to reveal them — see createOverflowWatcher).
  const tabsOverflow = createOverflowWatcher();

  // The Scroll Context tab only exists while Journal Scroll is on. When the
  // user turns scroll off (or switches to a non-scroll tab), revert the right
  // panel to whatever tab they had focused before — otherwise the panel keeps
  // showing the now-orphaned scroll-context pane until manually changed.
  let prevScrollOn = false;
  let tabBeforeScroll: RightPanelTab = "outline";
  createEffect(() => {
    const t = activeFileTab();
    const scrollOn = !!(t && isScrollEnabled(t.id));
    if (scrollOn && !prevScrollOn) {
      // Entering scroll: remember the prior tab, then focus Scroll Context.
      if (activePanel() !== "scroll-context") tabBeforeScroll = activePanel();
      setActivePanel("scroll-context");
    } else if (!scrollOn && prevScrollOn) {
      if (activePanel() === "scroll-context") setActivePanel(tabBeforeScroll);
    }
    prevScrollOn = scrollOn;
  });

  // Keep the active note's change list populated even when the Changes pane is
  // collapsed, so the toolbar tab's attention badge can flag pending decisions.
  // The pane runs the same scan when open; this covers tab switches / file opens
  // while it's closed. Idempotent, and only re-runs when the active editor
  // changes (not per keystroke), so it's cheap.
  createEffect(() => {
    rescanAnnotations(activeEditorView()?.view);
  });

  // Tracked changes (suggestions) in the active note still awaiting an
  // accept/reject decision — plain comments don't count. Drives the badge on
  // the Changes & History tab.
  const pendingDecisions = createMemo(
    () => noteAnnotations().filter((a) => a.kind !== "annotation").length,
  );

  // The open note carries incoming changes the last sync folded in (merge-first
  // review) — also lights the Changes & History tab badge so the user notices
  // there's something to review/revert without opening the pane.
  const noteHasIncoming = createMemo(() => {
    const tab = getActiveTab();
    const path = tab?.type === "file" ? tab.path : undefined;
    if (!path) return false;
    const target = normalizePath(path);
    return changesSinceSync().some((e) => normalizePath(e.path) === target);
  });

  // Mycelial-view sub-tab: the graph-context list vs the Concept Filtering
  // pane. Local (session-scoped) — defaults to context on each panel mount.
  const [mycelialPanelTab, setMycelialPanelTab] =
    createSignal<"context" | "filtering">("context");

  const [addingProp, setAddingProp] = createSignal(false);
  const [newPropKey, setNewPropKey] = createSignal("");
  const [newPropType, setNewPropType] = createSignal<PropertyType>("text");
  const [allPropKeys, setAllPropKeys] = createSignal<string[]>([]);
  const [addPropHighlight, setAddPropHighlight] = createSignal(0);

  // Per-row context menu state. Anchored to a DOM element so the menu
  // opens below the clicked type button without needing global mouse
  // coordinates. `openLeft` flips the Property type submenu to the
  // left side of the parent menu when there isn't room for it on the
  // right — the ⋮ button in the right panel sits close to the window
  // edge, so a normally-rightward submenu overflows off-screen.
  const [rowMenu, setRowMenu] = createSignal<{
    key: string;
    // Distance from the viewport's right edge, so the menu's right edge
    // stays flush under the kebab button it opened from (the button lives
    // at the property row's right edge). Anchoring by `right` keeps the
    // menu connected to its trigger regardless of the menu's own width.
    right: number;
    y: number;
    typeSubmenuOpen: boolean;
    openLeft: boolean;
  } | null>(null);

  function closeRowMenu() {
    setRowMenu(null);
  }

  const activeFileTab = () => {
    const tab = getActiveTab();
    return tab?.type === "file" ? tab : undefined;
  };

  // Contributed right-panel tab (plugin / manifest query-view) whose id is the
  // current active panel, if any. Built-in ids resolve to undefined, so the
  // built-in panes render exactly as before when nothing is contributed.
  const activeContributed = () => rightPanelContribution(activePanel());
  // Contributed tabs whose `when` gate currently passes — file-scoped, shown in
  // the same tab group as Properties/Links/etc.
  const visibleContributions = () =>
    rightPanelContributions().filter((c) => !c.when || c.when());

  const activeCollectionTab = () => {
    const tab = getActiveTab();
    return tab?.type === "collection" ? tab : undefined;
  };

  /** True when the open file is a scaffold template. Scaffold property values
   *  are routinely `{{var}}` placeholders, so the property editors relax their
   *  typed pickers (date/checkbox) to raw text entry here — see PropertyEditor. */
  const activeFileIsScaffold = () => {
    const t = activeFileTab();
    return !!t && normalizePath(t.path).includes("/.inkycap/scaffolds/");
  };

  /// The collection's file stem (basename minus extension) — the membership
  /// name the backend uses (`collection_membership_name`) and what
  /// CollectionTable derives, so the package filename / default import folder
  /// match across surfaces.
  const collectionStem = (path: string): string => {
    const base = path.split(/[\\/]/).pop() ?? path;
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(0, dot) : base;
  };

  /** True when the active tab is currently in Journal Scroll mode. */
  const activeTabScrollOn = () => {
    const t = activeFileTab();
    return !!(t && isScrollEnabled(t.id));
  };

  const [metadata, { refetch: refetchMetadata }] = createResource(
    () => activeFileTab()?.path,
    async (path) => {
      if (!path) return undefined;
      try {
        return await ipc.getFileMetadata(path);
      } catch {
        return undefined;
      }
    },
  );

  // Source-order list of property keys so the right panel renders rows in
  // whatever order the user has set inside the file's #note(...) — without
  // this we'd snap rows back to KNOWN_FIELDS_ORDERED on every drag/drop.
  const [propertyOrder, { refetch: refetchPropertyOrder }] = createResource(
    () => activeFileTab()?.path,
    async (path) => {
      if (!path) return [] as string[];
      try {
        return await ipc.getPropertyOrder(path);
      } catch {
        return [] as string[];
      }
    },
  );

  // Drag/drop state. `draggingKey` is the row being dragged; `dragOverKey`
  // identifies the hovered drop target; `dropPosition` says whether the
  // drop indicator sits above or below the target row.
  const [draggingKey, setDraggingKey] = createSignal<string | null>(null);
  const [dragOverKey, setDragOverKey] = createSignal<string | null>(null);
  const [dropPosition, setDropPosition] = createSignal<"before" | "after">("before");

  function sortedPropertyEntries(): [string, PropertyValue][] {
    const meta = metadata();
    if (!meta) return [];
    const entries = Object.entries(meta.properties).filter(
      ([k]) => !k.startsWith("file."),
    );
    const order = propertyOrder() ?? [];
    if (order.length === 0) {
      // Fallback default sort: known-fields canonical order, then alpha.
      return entries.sort(([a], [b]) => {
        const ai = KNOWN_FIELDS_ORDERED.indexOf(a);
        const bi = KNOWN_FIELDS_ORDERED.indexOf(b);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return a.localeCompare(b);
      });
    }
    const orderIdx = new Map(order.map((k, i) => [k, i]));
    return entries.sort(([a], [b]) => {
      const ai = orderIdx.has(a) ? orderIdx.get(a)! : Infinity;
      const bi = orderIdx.has(b) ? orderIdx.get(b)! : Infinity;
      if (ai !== bi) return ai - bi;
      return a.localeCompare(b);
    });
  }

  async function commitReorder(newOrder: string[]) {
    const tab = activeFileTab();
    if (!tab) return;
    try {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 200);
        document.dispatchEvent(
          new CustomEvent("inkycap:flush-editor", {
            detail: { path: tab.path, done: () => { clearTimeout(timeout); resolve(); } },
          }),
        );
      });
      await ipc.reorderProperties(tab.path, newOrder);
      await refetchPropertyOrder();
      await refetchMetadata();
      bumpPropertyVersion();
      document.dispatchEvent(
        new CustomEvent("inkycap:note-property-changed", { detail: { path: tab.path } }),
      );
    } catch (err) {
      toastError(t("rightPanel.toast.reorderFailed"), err);
    }
  }

  function handleDragStart(e: DragEvent, key: string) {
    setDraggingKey(key);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      // Some browsers require non-empty data for drag to fire correctly.
      e.dataTransfer.setData("text/plain", key);
    }
  }

  function handleDragEnd() {
    setDraggingKey(null);
    setDragOverKey(null);
  }

  function handleDragOver(e: DragEvent, key: string) {
    if (!draggingKey() || draggingKey() === key) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    setDropPosition(e.clientY < midpoint ? "before" : "after");
    setDragOverKey(key);
  }

  function handleDrop(e: DragEvent, targetKey: string) {
    e.preventDefault();
    const src = draggingKey();
    setDragOverKey(null);
    setDraggingKey(null);
    if (!src || src === targetKey) return;
    const entries = sortedPropertyEntries().map(([k]) => k);
    const without = entries.filter((k) => k !== src);
    const targetIdx = without.indexOf(targetKey);
    if (targetIdx === -1) return;
    const insertAt = dropPosition() === "before" ? targetIdx : targetIdx + 1;
    const next = [...without.slice(0, insertAt), src, ...without.slice(insertAt)];
    commitReorder(next);
  }

  // Refetch metadata and link data when the active note (or any other
  // note in the notebox) gets reindexed. The two events distinguish where
  // the change originated:
  //   • `inkycap:note-saved` — the editor in this window finished auto-
  //     saving the active note. writeFileContent waits for the backend
  //     reindex before resolving, so by the time this fires the indices
  //     are up to date.
  //   • `notebox:index-updated` (Tauri event) — the file watcher detected
  //     an external change (drag-drop, external editor, sync) and
  //     reindexed in the background. The payload's `path` is the file
  //     that changed; we refresh links unconditionally because:
  //       – inbound: another note's edit may have added/removed a link
  //         pointing at this one
  //       – outbound: a newly-appeared note may now satisfy one of our
  //         previously unresolved wikilink targets
  //       – potential: a new note may have appeared whose body mentions
  //         this note's name
  //
  // The earlier bug — Links pane wouldn't refresh after dropping .typ
  // files into the notebox, or after typing a new wikilink — was a missing
  // `refetchBacklinks/refetchForwardLinks` here plus no listener for
  // `notebox:index-updated` at all.
  const refreshAllLinks = () => {
    refetchBacklinks();
    refetchForwardLinks();
    refetchPotentialLinks();
  };
  const onNoteSaved = () => {
    setTimeout(() => {
      refetchMetadata();
      refetchPropertyOrder();
      refreshAllLinks();
    }, 150);
  };
  document.addEventListener("inkycap:note-saved", onNoteSaved);
  onCleanup(() => document.removeEventListener("inkycap:note-saved", onNoteSaved));

  let indexUpdatedUnlisten: UnlistenFn | null = null;
  onMount(async () => {
    indexUpdatedUnlisten = await listen("notebox:index-updated", () => {
      refetchMetadata();
      refreshAllLinks();
    });
  });
  onCleanup(() => indexUpdatedUnlisten?.());

  const [backlinks, { refetch: refetchBacklinks }] = createResource(
    () => activeFileTab()?.path,
    async (path): Promise<BacklinkWithContext[]> => {
      if (!path) return [];
      try {
        const links = await ipc.getBacklinks(path);
        // Deduplicate by path — a note may link to us multiple times
        const seen = new Set<string>();
        const unique = links.filter((link) => {
          if (seen.has(link.path)) return false;
          seen.add(link.path);
          return true;
        });
        return await Promise.all(
          unique.map(async (link) => {
            try {
              const ctx = await ipc.getBacklinkContext(link.path, path);
              if (ctx) {
                return {
                  ...link,
                  line: ctx.line,
                  context_before: ctx.context_before,
                  context_after: ctx.context_after,
                };
              }
              return { ...link };
            } catch {
              return { ...link };
            }
          }),
        );
      } catch {
        return [];
      }
    },
  );

  const [forwardLinks, { refetch: refetchForwardLinks }] = createResource(
    () => activeFileTab()?.path,
    async (path): Promise<OutboundLink[]> => {
      if (!path) return [];
      try {
        return await ipc.getOutboundLinks(path);
      } catch {
        return [];
      }
    },
  );

  const [potentialLinks, { refetch: refetchPotentialLinks }] = createResource(
    () => activeFileTab()?.path,
    async (path): Promise<PotentialLink[]> => {
      if (!path) return [];
      try {
        return await ipc.getPotentialLinks(path);
      } catch {
        return [];
      }
    },
  );

  // When the background index build finishes, refetch link data so that
  // the Links tab populates without the user having to switch tabs.
  createEffect(() => {
    if (indexReady() && activeFileTab()) {
      refetchBacklinks();
      refetchForwardLinks();
      refetchPotentialLinks();
    }
  });

  // ── Links pane: sort + filter helpers ────────────────────────────────
  /// Sort comparator parameterized over the Links pane's sort mode.
  /// Mirrors the file tree's behaviour so name / modified / created sort
  /// directions feel identical between the two surfaces. Unresolved
  /// outbound entries (path = "", mtime/ctime = 0) sort to the end of
  /// time-based orderings instead of pretending to be ancient.
  function compareByMode<
    T extends { name: string; modified_time: number; created_time: number },
  >(a: T, b: T, mode: LinksSortMode): number {
    switch (mode) {
      case "name-asc":
        return a.name.localeCompare(b.name);
      case "name-desc":
        return b.name.localeCompare(a.name);
      case "modified-desc":
        return cmpEpoch(b.modified_time, a.modified_time) || a.name.localeCompare(b.name);
      case "modified-asc":
        return cmpEpoch(a.modified_time, b.modified_time) || a.name.localeCompare(b.name);
      case "created-desc":
        return cmpEpoch(b.created_time, a.created_time) || a.name.localeCompare(b.name);
      case "created-asc":
        return cmpEpoch(a.created_time, b.created_time) || a.name.localeCompare(b.name);
    }
  }

  /// Compare two epoch seconds with 0 always sorting last, regardless of
  /// direction. 0 means "stat unavailable" (unresolved wikilink or
  /// freshly-deleted file) and should not pile up at the top of a
  /// descending sort or the bottom of an ascending one.
  function cmpEpoch(a: number, b: number): number {
    if (a === 0 && b === 0) return 0;
    if (a === 0) return 1;
    if (b === 0) return -1;
    return a - b;
  }

  // Debounce the filter input so each keystroke doesn't fire a notebox_search
  // IPC. 250ms feels responsive and matches the SearchPanel's cadence.
  const [debouncedFilterQuery, setDebouncedFilterQuery] = createSignal(
    linksFilterQuery(),
  );
  let filterDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const q = linksFilterQuery();
    if (filterDebounceTimer) clearTimeout(filterDebounceTimer);
    filterDebounceTimer = setTimeout(() => setDebouncedFilterQuery(q), 250);
  });
  onCleanup(() => {
    if (filterDebounceTimer) clearTimeout(filterDebounceTimer);
  });

  /// Run the same notebox search the left-panel uses (boolean operators,
  /// phrase quotes, tag:/file:/path:/section:/property: filters, /regex/
  /// literals) and surface the result rows so the Links pane can filter
  /// its sections to "links whose target file matches this query". The
  /// search itself isn't scoped — the search engine has one inverted
  /// index — but the *filter* is, because we only intersect hits with
  /// the link lists we already have. Empty query short-circuits with no
  /// IPC. A failure (parse error, index not ready) returns `[]` so the
  /// pane falls back to showing no matches rather than blowing up.
  const [filterMatches] = createResource(
    () => ({ q: debouncedFilterQuery().trim(), ready: indexReady() }),
    async ({ q, ready }): Promise<SearchResult[] | null> => {
      if (!q || !ready) return null;
      try {
        const resp = await ipc.noteboxSearch(q, 1000, false);
        return resp.results;
      } catch {
        return [];
      }
    },
  );

  /// Map link path → matching SearchResult, scoped to current sections.
  /// Built once per query so the three sort memos don't each iterate the
  /// full match list. Returns `null` when no filter is active, which
  /// short-circuits to "show everything" in filterByQuery.
  const filterMatchMap = createMemo<Map<string, SearchResult> | null>(() => {
    const matches = filterMatches();
    if (matches === null || matches === undefined) return null;
    const map = new Map<string, SearchResult>();
    for (const m of matches) {
      // Keep the first hit per file — line_number / line_text already
      // identifies the most relevant occurrence (search engine ranks
      // matches before returning).
      if (!map.has(m.path)) map.set(m.path, m);
    }
    return map;
  });

  function filterByQuery<T extends { path: string }>(items: T[]): T[] {
    const map = filterMatchMap();
    if (map === null) return items;
    return items.filter((it) => it.path && map.has(it.path));
  }

  /// Match line + surrounding context for a given link path under the
  /// current filter. Returns undefined when no filter is active so the
  /// caller falls back to the section's native preview line
  /// (backlink context, potential-link match).
  function searchMatchFor(path: string): SearchResult | undefined {
    const map = filterMatchMap();
    if (!map) return undefined;
    return map.get(path);
  }

  /// True when a filter query is active. Used to swap the section's
  /// native preview line for the search-match line on rows that matched
  /// the query, so the user sees *where* the file matched their search.
  const filterActive = createMemo(() => filterMatchMap() !== null);

  const sortedBacklinks = createMemo(() => {
    const list = backlinks() ?? [];
    return filterByQuery([...list]).sort((a, b) => compareByMode(a, b, linksSortMode()));
  });

  const sortedForwardLinks = createMemo(() => {
    const list = forwardLinks() ?? [];
    return filterByQuery([...list]).sort((a, b) => compareByMode(a, b, linksSortMode()));
  });

  // Potential Links are deliberately left outside the search filter's
  // scope — the section's job is to surface notes the user *hasn't* yet
  // linked to, and search-filtering it down to the active query would
  // hide exactly the candidates the user might want to discover. The
  // sort still applies (it's a display setting, not a scoping filter).
  const sortedPotentialLinks = createMemo(() => {
    const list = potentialLinks() ?? [];
    return [...list].sort((a, b) => compareByMode(a, b, linksSortMode()));
  });

  function toggleLinksSection(section: LinksSection) {
    setLinksSectionExpanded(section, !linksSectionExpanded()[section]);
  }

  /// Per-row preview visibility — the global `collapsePreviews` flag is
  /// the default and `linksExpandOverrides` carries the user's
  /// "I want to peek at this one" exceptions. Mirrors SearchPanel's
  /// `isFileExpanded` so the two panes behave identically.
  function isPreviewExpanded(section: LinksSection, path: string): boolean {
    const overridden = linksExpandOverrides().has(`${section}::${path}`);
    return linksCollapsePreviews() ? overridden : !overridden;
  }

  /// Preview lines for sections covered by the search filter
  /// (Inbound, Outbound). When a search filter is active and matched
  /// this row, the search hit wins so the user sees *where* their query
  /// matched. Otherwise we fall back to the section's native preview
  /// (the backlink context line for Inbound; nothing for Outbound since
  /// it has no stored preview).
  function rowPreview(
    link: {
      path: string;
      line?: string;
      context_before?: string[];
      context_after?: string[];
    },
  ): { line: string; before: string[]; after: string[] } | undefined {
    if (filterActive()) {
      const m = searchMatchFor(link.path);
      if (m) {
        return {
          line: m.line_text,
          before: m.context_before ?? [],
          after: m.context_after ?? [],
        };
      }
      return undefined;
    }
    return nativePreview(link);
  }

  /// Preview lines for sections that are *not* in scope of the search
  /// filter (Potential Links). Always shows the section's own preview,
  /// regardless of filter state — search-substituting the line here
  /// would be misleading since the row itself was chosen by potential-
  /// link logic, not by the user's query.
  function nativePreview(link: {
    line?: string;
    context_before?: string[];
    context_after?: string[];
  }): { line: string; before: string[]; after: string[] } | undefined {
    if (!link.line) return undefined;
    return {
      line: link.line,
      before: link.context_before ?? [],
      after: link.context_after ?? [],
    };
  }

  // Sort menu anchor and visibility (mirrors the SearchPanel pattern).
  const [showLinksSortMenu, setShowLinksSortMenu] = createSignal(false);
  let linksSortBtnRef: HTMLButtonElement | undefined;
  let linksFilterInputRef: HTMLInputElement | undefined;

  function activeLinksSortLabel(): string {
    const opt = LINKS_SORT_OPTIONS.find((o) => o.value === linksSortMode());
    return opt ? t(opt.labelKey) : t("sort.label");
  }

  function openLinkedFile(link: { path: string; name: string }, e?: MouseEvent) {
    if (!link.path) return;
    const forceNewTab = !!(e && (e.ctrlKey || e.metaKey));
    openTab(
      { type: "file", title: link.name, path: link.path },
      { forceNewTab, newTabAction: forceNewTab },
    );
  }

  // Per-row context menu state for the Links pane. Mirrors the file
  // tree's "Open in new tab / Open in new window" affordance. We don't
  // currently surface notebox-mutation actions on links (no rename, no
  // delete) because deleting from a navigation list is too easy to do
  // by accident — those belong on the file tree where the source of
  // truth lives.
  const [linkRowMenu, setLinkRowMenu] = createSignal<
    { x: number; y: number; path: string; name: string } | null
  >(null);
  let cleanupLinkRowMenu: (() => void) | undefined;

  function openLinkRowMenu(e: MouseEvent, path: string, name: string) {
    e.preventDefault();
    e.stopPropagation();
    if (!path) return;
    if (cleanupLinkRowMenu) {
      cleanupLinkRowMenu();
      cleanupLinkRowMenu = undefined;
    }
    const MENU_W = 200;
    const MENU_H = 80;
    const x = Math.min(e.clientX, window.innerWidth - MENU_W - 8);
    const y = Math.min(e.clientY, window.innerHeight - MENU_H - 8);
    setLinkRowMenu({ x, y, path, name });
    setTimeout(() => {
      const onDocClick = () => {
        setLinkRowMenu(null);
        document.removeEventListener("click", onDocClick);
        cleanupLinkRowMenu = undefined;
      };
      document.addEventListener("click", onDocClick);
      cleanupLinkRowMenu = () => {
        document.removeEventListener("click", onDocClick);
      };
    }, 0);
  }


  async function createUnresolvedNote(target: string) {
    try {
      const path = await ipc.createNote(target, "", undefined);
      openTab({ type: "file", title: target, path }, { forceNewTab: true });
    } catch (e) {
      toastError(t("rightPanel.toast.createNoteFailed"), e);
    }
  }

  async function handlePropertySave(key: string, value: PropertyValue) {
    const tab = activeFileTab();
    if (!tab) return;

    try {
      // Flush any pending editor save so the disk is up-to-date before
      // the backend reads and rewrites the file.
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 200);
        document.dispatchEvent(
          new CustomEvent("inkycap:flush-editor", {
            detail: { path: tab.path, done: () => { clearTimeout(timeout); resolve(); } },
          }),
        );
      });

      await ipc.updateProperty(tab.path, key, value);
      await refetchMetadata();
      await refetchPropertyOrder();
      bumpPropertyVersion();
      document.dispatchEvent(
        new CustomEvent("inkycap:note-property-changed", { detail: { path: tab.path } }),
      );
    } catch (err) {
      toastError(t("rightPanel.toast.updatePropFailed"), err);
    }
  }

  async function handleRemoveProperty(key: string) {
    const tab = activeFileTab();
    if (!tab) return;
    closeRowMenu();
    try {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 200);
        document.dispatchEvent(
          new CustomEvent("inkycap:flush-editor", {
            detail: { path: tab.path, done: () => { clearTimeout(timeout); resolve(); } },
          }),
        );
      });
      await ipc.removePropertyFromFile(tab.path, key);
      await refetchMetadata();
      await refetchPropertyOrder();
      bumpPropertyVersion();
      document.dispatchEvent(
        new CustomEvent("inkycap:note-property-changed", { detail: { path: tab.path } }),
      );
    } catch (err) {
      toastError(t("rightPanel.toast.removePropFailed"), err);
    }
  }

  async function handleSetRowPropertyType(key: string, ty: PropertyType) {
    closeRowMenu();
    try {
      await ipc.setPropertyType(key, ty);
      await reloadPropertyTypes();
      refetchMetadata();
    } catch (err) {
      toastError(t("rightPanel.toast.setTypeFailed"), err);
    }
  }

  let cleanupRowMenu: (() => void) | undefined;

  function openRowMenu(e: MouseEvent, key: string) {
    e.preventDefault();
    e.stopPropagation();
    if (cleanupRowMenu) {
      cleanupRowMenu();
      cleanupRowMenu = undefined;
    }
    if (rowMenu()) {
      closeRowMenu();
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const MENU_H = 120;
    const SUBMENU_W = 180;
    // Right-align the menu under the kebab button so it reads as attached
    // to its trigger rather than floating mid-panel.
    const right = Math.max(8, window.innerWidth - rect.right);
    let y = rect.bottom + 4;
    if (y + MENU_H > window.innerHeight - 8) {
      y = Math.max(8, rect.top - MENU_H - 4);
    }
    // The type submenu would normally open to the right; near the panel's
    // right edge there's no room, so flip it left.
    const openLeft = rect.right + SUBMENU_W > window.innerWidth - 8;
    setRowMenu({ key, right, y, typeSubmenuOpen: false, openLeft });
    setTimeout(() => {
      const onDocClick = () => {
        closeRowMenu();
        document.removeEventListener("click", onDocClick);
        cleanupRowMenu = undefined;
      };
      document.addEventListener("click", onDocClick);
      cleanupRowMenu = () => {
        document.removeEventListener("click", onDocClick);
      };
    }, 0);
  }

  async function handleAddProperty(forcedKey?: string) {
    const key = (forcedKey ?? newPropKey()).trim();
    if (!key) return;
    const ty = newPropType();
    const knownType = KNOWN_FIELD_TYPES[key];
    const registryType = getPropertyType(key);
    const effectiveType = knownType ?? (registryType !== "auto" ? registryType : ty);
    const defaultValue = defaultForType(effectiveType);
    if (!knownType && registryType === "auto" && ty !== "auto") {
      try {
        await ipc.setPropertyType(key, ty);
        await reloadPropertyTypes();
      } catch (err) {
        toastError(t("rightPanel.toast.setTypeFailed"), err);
      }
    }
    handlePropertySave(key, defaultValue);
    setNewPropKey("");
    setNewPropType("text");
    setAddingProp(false);
  }

  // Suggestions for the add-property input: known keys (canonical order)
  // plus any custom keys, filtered by the current draft and excluding
  // properties already present on the active note.
  function addPropSuggestions(): string[] {
    const current = metadata()?.properties ?? {};
    const draft = newPropKey().trim().toLowerCase();
    const universe = allPropKeys().filter((k) => !(k in current));
    if (!draft) return universe;
    return universe.filter((k) => k.toLowerCase().includes(draft));
  }

  function handleAddKeyDown(e: KeyboardEvent) {
    const suggestions = addPropSuggestions();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (suggestions.length === 0) return;
      setAddPropHighlight((i) => Math.min(suggestions.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (suggestions.length === 0) return;
      setAddPropHighlight((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const idx = addPropHighlight();
      if (suggestions.length > 0 && idx >= 0 && idx < suggestions.length) {
        pickSuggestion(suggestions[idx]);
      } else {
        handleAddProperty();
      }
      return;
    }
    if (e.key === "Escape") {
      setAddingProp(false);
      setNewPropKey("");
      setNewPropType("text");
      setAddPropHighlight(0);
    }
  }

  function onNewPropKeyInput(value: string) {
    setNewPropKey(value);
    setAddPropHighlight(0);
    // Auto-select type from registry when the user picks an existing key
    const registryType = getPropertyType(value.trim());
    if (registryType !== "auto") {
      setNewPropType(registryType);
    }
  }

  // Picking a suggestion (click or Enter on highlight) commits the add
  // immediately — no second Enter required.
  function pickSuggestion(key: string) {
    setNewPropKey(key);
    setAddPropHighlight(0);
    handleAddProperty(key);
  }

  async function loadPropertyKeysForAutocomplete() {
    try {
      const keys = await ipc.getAllPropertyKeys();
      const filtered = keys.filter((k) => !k.startsWith("file."));
      // Always include standard properties (in canonical order) plus any custom ones
      const custom = filtered.filter((k) => !KNOWN_FIELDS.has(k)).sort();
      setAllPropKeys([...KNOWN_FIELDS_ORDERED, ...custom]);
    } catch {
      setAllPropKeys([...KNOWN_FIELDS_ORDERED]);
    }
  }

  // ── Hamburger menu ────────────────────────────────────
  const [fileMenu, setFileMenu] = createSignal<{ x: number; y: number } | null>(null);
  let cleanupFileMenu: (() => void) | undefined;

  function openFileMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (cleanupFileMenu) {
      cleanupFileMenu();
      cleanupFileMenu = undefined;
    }
    if (fileMenu()) {
      setFileMenu(null);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setFileMenu({ x: rect.left, y: rect.bottom + 4 });
    setTimeout(() => {
      const onDocClick = () => {
        setFileMenu(null);
        document.removeEventListener("click", onDocClick);
        cleanupFileMenu = undefined;
      };
      document.addEventListener("click", onDocClick);
      cleanupFileMenu = () => {
        document.removeEventListener("click", onDocClick);
      };
    }, 0);
  }

  async function menuRename() {
    setFileMenu(null);
    const tab = activeFileTab();
    if (!tab) return;
    const oldName = tab.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
    const newName = await promptText({
      title: t("rightPanel.renameTitle"),
      label: t("rightPanel.renameLabel"),
      initialValue: oldName,
      confirmLabel: t("common.rename"),
    });
    if (!newName || newName === oldName) return;
    try {
      const newPath = await ipc.renameAndUpdateLinks(tab.path, newName);
      closeTab(tab.id);
      openTab({ type: "file", title: newName, path: newPath }, { forceNewTab: true });
    } catch (err) {
      toastError(t("statusBar.renameFailed"), err);
    }
  }

  async function menuMoveFile() {
    setFileMenu(null);
    await moveActiveFileInteractive();
  }

  async function menuBookmark() {
    setFileMenu(null);
    const tab = activeFileTab();
    if (!tab) return;
    try {
      const name = tab.title.replace(/\.[^.]+$/, "");
      await ipc.addBookmark({ type: "Note", data: { path: tab.path, name } });
    } catch (err) {
      toastError(t("rightPanel.toast.bookmarkFailed"), err);
    }
  }

  function menuExport() {
    setFileMenu(null);
    const tab = activeFileTab();
    if (!tab) return;
    document.dispatchEvent(
      new CustomEvent("inkycap:export-dialog", { detail: { path: tab.path } }),
    );
  }

  function menuFind() {
    setFileMenu(null);
    const handle = activeEditorView();
    if (handle) openEditorFind(handle.view);
  }

  function menuReplace() {
    setFileMenu(null);
    const handle = activeEditorView();
    if (handle) openEditorReplace(handle.view);
  }

  async function menuShowInExplorer() {
    setFileMenu(null);
    const tab = activeFileTab();
    if (!tab) return;
    try {
      await ipc.showInExplorer(tab.path);
    } catch (err) {
      toastError(t("rightPanel.toast.showExplorerFailed"), err);
    }
  }

  function menuShowInFileTree() {
    setFileMenu(null);
    const tab = activeFileTab();
    if (!tab) return;
    document.dispatchEvent(
      new CustomEvent("inkycap:reveal-in-tree", { detail: tab.path }),
    );
  }

  async function menuDelete() {
    setFileMenu(null);
    await deleteActiveFileInteractive();
  }

  return (
    <div class="right-panel" data-focus-region="right-panel">
      {/* Tab bar — always visible so the collapse toggle is accessible */}
      <div
        class="right-panel__tabs"
        ref={tabsOverflow.ref}
        data-overflow={tabsOverflow.overflowing() ? "true" : undefined}
        data-panel-tablist
      >
        <Show when={activeFileTab()}>
          {/* In Journal Scroll the right panel is wholly owned by the scroll
              context — the file-scoped tabs (File actions, Outline,
              Properties, Links, References) all operate on a single "current
              file" that the scroll view doesn't have. Rather than disable
              them one by one, suppress the whole tab row (mirroring how the
              Mycelial View hides the panel tabs) and leave only a
              non-interactive marker so the panel still reads as "Scroll
              context". */}
          <Show
            when={!activeTabScrollOn()}
            fallback={
              <>
                <div
                  class="right-panel__tab right-panel__tab--indicator"
                  title={t("rightPanel.scrollContextIndicator")}
                  aria-label={t("rightPanel.scrollContext")}
                >
                  <Newspaper size={18} />
                </div>
                {/* The Journal Scroll's own controls — date direction and
                    return-to-anchor — live here beside the Scroll Context
                    indicator rather than on the editor-header pill. */}
                <Show when={activeFileTab()}>
                  {(tab) => (
                    <>
                      <button
                        class="right-panel__tab"
                        onClick={() => void toggleScrollDirection(tab().id)}
                        title={
                          getScrollDirection(tab().id) === "desc"
                            ? t("journalScroll.direction.recentFirst")
                            : t("journalScroll.direction.oldestFirst")
                        }
                        aria-label={
                          getScrollDirection(tab().id) === "desc"
                            ? t("journalScroll.direction.recentFirst")
                            : t("journalScroll.direction.oldestFirst")
                        }
                      >
                        {getScrollDirection(tab().id) === "desc" ? (
                          <CalendarArrowUp size={18} />
                        ) : (
                          <CalendarArrowDown size={18} />
                        )}
                      </button>
                      <button
                        class="right-panel__tab"
                        onClick={() => scrollToAnchor(tab().id)}
                        title={t("journalScroll.anchor.return")}
                        aria-label={t("journalScroll.anchor.return")}
                      >
                        <Anchor size={18} />
                      </button>
                    </>
                  )}
                </Show>
              </>
            }
          >
            {/* File actions (rename/move/delete) act on a single note. */}
            <button
              class="right-panel__tab"
              onClick={openFileMenu}
              title={t("rightPanel.fileActions")}
              aria-label={t("rightPanel.fileActions")}
            >
              <EllipsisVertical size={18} />
            </button>
            <button
              class={`right-panel__tab${activePanel() === "outline" ? " right-panel__tab--active" : ""}`}
              onClick={() => setActivePanel("outline")}
              title={t("outlinePanel.title")}
              aria-label={t("outlinePanel.title")}
            >
              <TableOfContents size={18} />
            </button>
            <button
              class={`right-panel__tab${activePanel() === "properties" ? " right-panel__tab--active" : ""}`}
              onClick={() => setActivePanel("properties")}
              title={t("rightPanel.tab.properties")}
              aria-label={t("rightPanel.tab.properties")}
            >
              <NotebookTabs size={18} />
            </button>
            <button
              class={`right-panel__tab${activePanel() === "links" ? " right-panel__tab--active" : ""}`}
              onClick={() => setActivePanel("links")}
              title={t("rightPanel.tab.links")}
              aria-label={t("rightPanel.tab.links")}
            >
              <Link size={18} />
            </button>
            <button
              class={`right-panel__tab${activePanel() === "references" ? " right-panel__tab--active" : ""}`}
              onClick={() => setActivePanel("references")}
              title={t("rightPanel.tab.references")}
              aria-label={t("rightPanel.tab.references")}
            >
              <Quote size={18} />
            </button>
            {/* Changes & History — always available for a file note. A dot
                badge flags when the note has tracked changes still awaiting an
                accept/reject decision, so the user knows to open the pane. */}
            <button
              class={`right-panel__tab${activePanel() === "annotations" ? " right-panel__tab--active" : ""}`}
              onClick={() => setActivePanel("annotations")}
              title={
                pendingDecisions() > 0
                  ? t("annotations.pendingTitle", { n: pendingDecisions() })
                  : t("annotations.paneTitle")
              }
              aria-label={
                pendingDecisions() > 0
                  ? t("annotations.pendingTitle", { n: pendingDecisions() })
                  : t("annotations.paneTitle")
              }
            >
              <span class="right-panel__tab-badge-wrap">
                <MessagesSquare size={18} />
                <Show when={pendingDecisions() > 0 || noteHasIncoming()}>
                  <span class="right-panel__tab-badge" aria-hidden="true" />
                </Show>
              </span>
            </button>
            {/* Contributed tabs (plugins / manifest query-views). Renders
                nothing when the registry is empty, so the built-in tab row is
                unchanged by default. */}
            <For each={visibleContributions()}>
              {(c) => (
                <button
                  class={`right-panel__tab${activePanel() === c.id ? " right-panel__tab--active" : ""}`}
                  onClick={() => setActivePanel(c.id)}
                  title={c.label}
                  aria-label={c.label}
                >
                  <Dynamic component={c.icon} size={18} />
                </button>
              )}
            </For>
          </Show>
        </Show>

        {/* Collection-view tabs — the right-panel counterpart of the file-note
            tabs, using the same button interface. Shown when a collection tab
            is active (not while reviewing a note, which opens a file tab). */}
        <Show when={activeCollectionTab()}>
          {(() => {
            const collTab = (
              tab: CollectionPanelTab,
              label: string,
              icon: Component<{ size?: number }>,
            ) => (
              <button
                class={`right-panel__tab${collectionPanelTab() === tab ? " right-panel__tab--active" : ""}`}
                onClick={() => setCollectionPanelTab(tab)}
                title={label}
                aria-label={label}
              >
                <Dynamic component={icon} size={18} />
              </button>
            );
            return (
              <>
                {collTab("characteristics", t("rightPanel.coll.characteristics"), Settings2)}
                {collTab("style", t("collection.style.overrides"), Ligature)}
                {collTab("book", t("rightPanel.coll.book"), NotebookTabs)}
              </>
            );
          })()}
        </Show>

        {/* Mycelial-view tabs — Linked Context (the default graph-context pane)
            and Concept Filtering (suppressed terms + the stopword editor). */}
        <Show when={!activeFileTab() && getActiveTab()?.type === "mycelial"}>
          <button
            class={`right-panel__tab${mycelialPanelTab() === "context" ? " right-panel__tab--active" : ""}`}
            onClick={() => setMycelialPanelTab("context")}
            title={t("rightPanel.mycelial.context")}
            aria-label={t("rightPanel.mycelial.context")}
          >
            <Waypoints size={18} />
          </button>
          <button
            class={`right-panel__tab${mycelialPanelTab() === "filtering" ? " right-panel__tab--active" : ""}`}
            onClick={() => setMycelialPanelTab("filtering")}
            title={t("rightPanel.mycelial.filtering")}
            aria-label={t("rightPanel.mycelial.filtering")}
          >
            <Filter size={18} />
          </button>
        </Show>
      </div>

      {/* Annotations tab content — its own fill container so the pane can pin
          its insert toolbar to the bottom while the list scrolls. The file-tab
          block below yields when this is active. */}
      <Show when={activePanel() === "annotations" && activeFileTab()}>
        <div class="right-panel__tab-content right-panel__tab-content--fill">
          <AnnotationsPanel />
        </div>
      </Show>

      {/* Concept Filtering pane — suppressed terms + stopword editor. */}
      <Show when={!activeFileTab() && getActiveTab()?.type === "mycelial" && mycelialPanelTab() === "filtering"}>
        <div class="right-panel__tab-content">
          <MycelialFilteringPanel />
        </div>
      </Show>

      {/* Mycelial context notes — shown when a mycelial tab is active */}
      <Show when={!activeFileTab() && getActiveTab()?.type === "mycelial" && mycelialPanelTab() === "context"}>
        {(() => {
          const [contextFilter, setContextFilter] = createSignal("");
          const [contextSort, setContextSort] = createSignal<"name" | "connections">("connections");
          const [expandedContext, setExpandedContext] = createSignal<Set<string>>(new Set());

          const sortedFiltered = createMemo(() => {
            const filter = contextFilter().toLowerCase();
            let notes = contextNotes();
            if (filter) {
              notes = notes.filter((n) => n.name.toLowerCase().includes(filter));
            }
            return [...notes].sort((a, b) => {
              if (contextSort() === "connections") {
                return b.linkedInnerIds.length - a.linkedInnerIds.length;
              }
              return a.name.localeCompare(b.name);
            });
          });

          function toggleExpanded(path: string) {
            setExpandedContext((prev) => {
              const next = new Set(prev);
              if (next.has(path)) next.delete(path);
              else next.add(path);
              return next;
            });
          }

          function isHighlighted(note: { path: string; linkedInnerIds: string[] }): boolean {
            const hovered = hoveredGraphNode();
            if (!hovered) return false;
            return note.linkedInnerIds.includes(hovered);
          }

          function innerNodeName(id: string): string {
            return id.startsWith("emergent:")
              ? id.slice(9)
              : id.replace(/\.typ$/, "").split("/").pop() ?? id;
          }

          return (
            <div class="right-panel__tab-content">
              <div class="right-panel__section">
                <div class="right-panel__section-header">
                  <span>{t("rightPanel.linkedContext")}</span>
                  <span class="right-panel__count">{contextNotes().length}</span>
                </div>
                <div class="mycelial-context__controls">
                  <div class="mycelial-context__filter-wrap">
                    <input
                      class="mycelial-context__filter"
                      type="text"
                      placeholder={t("annotations.filterPlaceholder")}
                      value={contextFilter()}
                      onInput={(e) => setContextFilter(e.currentTarget.value)}
                    />
                    <Show when={contextFilter().length > 0}>
                      <button
                        class="mycelial-context__filter-clear"
                        onMouseDown={(e) => { e.preventDefault(); setContextFilter(""); }}
                        title={t("references.clearFilter")}
                        aria-label={t("references.clearFilter")}
                      >
                        <X size={12} />
                      </button>
                    </Show>
                  </div>
                  <Dropdown<"name" | "connections">
                    class="dropdown--sm"
                    value={contextSort()}
                    options={[
                      { value: "connections", label: t("rightPanel.sortContext.byConnections") },
                      { value: "name", label: t("rightPanel.sortContext.byName") },
                    ]}
                    onChange={setContextSort}
                    ariaLabel={t("rightPanel.sortContextAria")}
                  />
                </div>
                <Show
                  when={sortedFiltered().length > 0}
                  fallback={<p class="sidebar-hint">{t("rightPanel.noContextNotes")}</p>}
                >
                  <div class="search-panel__results">
                    <For each={sortedFiltered()}>
                      {(note) => {
                        const expanded = () => expandedContext().has(note.path);
                        return (
                          <div class="search-panel__file-group">
                            <div
                              class="search-panel__result-file"
                              classList={{
                                "mycelial-context__item--highlighted":
                                  isHighlighted(note),
                              }}
                              onMouseEnter={() => setHoveredContextNote(note.path)}
                              onMouseLeave={() => setHoveredContextNote(null)}
                            >
                              <Show
                                when={note.linkedInnerIds.length > 0}
                                fallback={
                                  <span class="mycelial-context__chevron-spacer" />
                                }
                              >
                                <button
                                  class="search-panel__group-chevron"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleExpanded(note.path);
                                  }}
                                  title={expanded() ? t("search.collapse") : t("search.expand")}
                                  aria-expanded={expanded()}
                                >
                                  <Show
                                    when={expanded()}
                                    fallback={<ChevronRight size={14} />}
                                  >
                                    <ChevronDown size={14} />
                                  </Show>
                                </button>
                              </Show>
                              <span
                                class="search-panel__file-label"
                                onClick={() =>
                                  openTab(
                                    { type: "file", title: note.name, path: note.path },
                                    { forceNewTab: true },
                                  )
                                }
                              >
                                {note.name}
                              </span>
                              <Show when={note.linkedInnerIds.length > 0}>
                                <span class="search-panel__match-count">
                                  {note.linkedInnerIds.length}
                                </span>
                              </Show>
                            </div>
                            <Show when={expanded()}>
                              <For each={note.linkedInnerIds}>
                                {(innerId) => (
                                  <div class="search-panel__result">
                                    <span class="search-panel__result-line">
                                      → {innerNodeName(innerId)}
                                    </span>
                                  </div>
                                )}
                              </For>
                            </Show>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              </div>
            </div>
          );
        })()}
      </Show>

      {/* Collection Settings — the right-panel surface for a Collection View
          (Characteristics / Style Overrides / Book Metadata, selected via the
          collection tab bar above). Shown when a collection tab is active. */}
      <Show when={activeCollectionTab()}>
        {(tab) => (
          <div class="right-panel__tab-content">
            <CollectionSettings
              collectionPath={tab().path}
              collectionName={collectionStem(tab().path)}
              tab={collectionPanelTab()}
            />
          </div>
        )}
      </Show>

      <Show
        when={
          activeFileTab() &&
          activePanel() !== "annotations"
        }
        fallback={
          <Show
            when={
              getActiveTab()?.type !== "mycelial" &&
              getActiveTab()?.type !== "collection" &&
              activePanel() !== "annotations"
            }
          >
            <p class="sidebar-hint">{t("rightPanel.noFileSelected")}</p>
          </Show>
        }
      >

        <div class="right-panel__tab-content">
          {/* Contributed pane (plugin / manifest query-view). Renders only when
              its tab is the active panel; built-in ids never match, so the
              built-in panes below are unaffected. */}
          <Show when={activeContributed()}>
            {(c) => <Dynamic component={c().component} />}
          </Show>
          {/* Properties tab */}
          <Show when={activePanel() === "properties"}>
            <div class="right-panel__section">
              <div class="right-panel__section-header">
                <span>{t("rightPanel.properties")}</span>
                {/* Reserved for future per-pane actions to keep the header
                    bar visually aligned with the left sidebar's pattern. */}
                <div class="right-panel__header-actions" />
              </div>
              <Show when={metadata()}>
                {(meta) => (
                  <div class="properties-list">
                    <For each={sortedPropertyEntries()}>
                      {([key, value]) => {
                        const ty = () => {
                          const declared = getPropertyType(key);
                          if (declared !== "auto") return declared;
                          // Untyped key: resolve to a concrete type (system
                          // default, else inferred from the value) so the row
                          // never shows the ambiguous "Automatic".
                          return KNOWN_FIELD_TYPES[key] ?? inferPropertyType(value);
                        };
                        const isDragging = () => draggingKey() === key;
                        const dropAbove = () =>
                          dragOverKey() === key && dropPosition() === "before";
                        const dropBelow = () =>
                          dragOverKey() === key && dropPosition() === "after";
                        return (
                          <div
                            class={
                              `property-row${KNOWN_FIELDS.has(key) ? " property-row--system" : ""}` +
                              `${isDragging() ? " property-row--dragging" : ""}` +
                              `${dropAbove() ? " property-row--drop-above" : ""}` +
                              `${dropBelow() ? " property-row--drop-below" : ""}`
                            }
                            onDragOver={(e) => handleDragOver(e, key)}
                            onDrop={(e) => handleDrop(e, key)}
                            onDragLeave={() => {
                              if (dragOverKey() === key) setDragOverKey(null);
                            }}
                          >
                            <div class="property-row__name">
                              <span
                                class="property-row__icon property-row__drag-handle"
                                title={t("rightPanel.propTypeDragTitle", { type: propertyTypeLabel(ty()) })}
                                draggable={true}
                                onDragStart={(e) => handleDragStart(e, key)}
                                onDragEnd={handleDragEnd}
                              >
                                <Dynamic component={propertyTypeIcon(ty())} size={14} />
                              </span>
                              <span class="property-row__key">{key}</span>
                            </div>
                            <div class="property-row__value-cell">
                              <PropertyEditor
                                propKey={key}
                                value={value}
                                onSave={handlePropertySave}
                                typeHint={ty()}
                                scaffoldContext={activeFileIsScaffold()}
                              />
                            </div>
                            <button
                              class="property-row__type-btn"
                              title={t("rightPanel.propertyOptions")}
                              onClick={(e) => openRowMenu(e, key)}
                            >
                              {"\u22EE"}
                            </button>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                )}
              </Show>

              <Show
                when={addingProp()}
                fallback={
                  <button
                    class="right-panel__add-btn"
                    onClick={() => { loadPropertyKeysForAutocomplete(); setAddingProp(true); }}
                  >
                    {t("rightPanel.addProperty")}
                  </button>
                }
              >
                <div class="right-panel__add-form">
                  <input
                    class="property-editor__input"
                    type="text"
                    placeholder={t("rightPanel.addPropertyPlaceholder")}
                    value={newPropKey()}
                    onInput={(e) => onNewPropKeyInput(e.currentTarget.value)}
                    onKeyDown={handleAddKeyDown}
                    onBlur={() => setTimeout(() => setAddPropHighlight(-1), 100)}
                    ref={(el) => setTimeout(() => el.focus(), 0)}
                  />
                  <Show when={addPropSuggestions().length > 0}>
                    <div class="add-prop-suggestions">
                      <For each={addPropSuggestions()}>
                        {(key, idx) => (
                          <button
                            type="button"
                            class={`add-prop-suggestions__item${addPropHighlight() === idx() ? " add-prop-suggestions__item--active" : ""}`}
                            onMouseDown={(e) => {
                              // mousedown so the click commits before the
                              // input's blur handler clears highlight state.
                              e.preventDefault();
                              pickSuggestion(key);
                            }}
                            onMouseEnter={() => setAddPropHighlight(idx())}
                          >
                            <span class="add-prop-suggestions__icon">
                              <Dynamic
                                component={propertyTypeIcon(
                                  KNOWN_FIELD_TYPES[key] ?? getPropertyType(key),
                                )}
                                size={12}
                              />
                            </span>
                            <span>{key}</span>
                            <Show when={KNOWN_FIELDS.has(key)}>
                              <span class="add-prop-suggestions__badge">{t("rightPanel.systemBadge")}</span>
                            </Show>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={!KNOWN_FIELDS.has(newPropKey().trim()) && getPropertyType(newPropKey().trim()) === "auto"}>
                    <Dropdown<PropertyType>
                      class="dropdown--block"
                      value={newPropType()}
                      options={PROPERTY_TYPE_OPTIONS.filter(
                        (t) => t !== "auto",
                      ).map((ty) => ({
                        value: ty,
                        label: propertyTypeLabel(ty),
                      }))}
                      onChange={setNewPropType}
                      ariaLabel={t("rightPanel.newPropertyType")}
                    />
                  </Show>
                </div>
              </Show>
            </div>
          </Show>

          {/* Outline tab */}
          <Show when={activePanel() === "outline"}>
            <OutlinePanel />
          </Show>

          {/* Links tab */}
          <Show when={activePanel() === "links"}>
            <Show when={!indexReady()}>
              <p class="sidebar-hint">{t("search.indexing")}</p>
            </Show>

            {/* Toolbar: Sort, Expand/Collapse, More Context, Filter.
                Mirrors the Search panel's button cluster so users coming
                from the left sidebar see the same icons doing the same
                things. Sort is the file-tree sort (filetree-style options),
                Expand/Collapse and More Context act on per-link previews,
                Filter is a name substring filter applied to all sections. */}
            <div class="right-panel__links-toolbar">
              <button
                ref={linksSortBtnRef}
                class="right-panel__icon-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowLinksSortMenu((v) => !v);
                }}
                title={t("rightPanel.sortLinksTitle", { label: activeLinksSortLabel() })}
                aria-label={t("rightPanel.sortLinks")}
                aria-haspopup="menu"
                aria-expanded={showLinksSortMenu()}
              >
                <ArrowDownNarrowWide size={18} />
              </button>
              <Show when={showLinksSortMenu()}>
                {/* Same .context-menu + anchorPanelMenu pattern as the
                    file-tree sort dropdown so the menu sizes to its
                    content (instead of inheriting the narrow right-panel
                    column) and floats above the panel chrome. Wrapper
                    classes / extra positioning rules would only fork the
                    behaviour from the left-side equivalent. */}
                <div
                  class="context-menu"
                  ref={(el) => anchorPanelMenu(linksSortBtnRef, el)}
                  use:clickOutside={{
                    onDismiss: () => setShowLinksSortMenu(false),
                    ignore: linksSortBtnRef,
                  }}
                >
                  <For each={LINKS_SORT_OPTIONS}>
                    {(opt) => (
                      <button
                        classList={{
                          "context-menu__item": true,
                          "context-menu__item--active":
                            linksSortMode() === opt.value,
                        }}
                        onClick={() => {
                          setLinksSortMode(opt.value);
                          setShowLinksSortMenu(false);
                        }}
                      >
                        {t(opt.labelKey)}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <button
                class="right-panel__icon-btn"
                onClick={() => setLinksCollapsePreviews(!linksCollapsePreviews())}
                title={
                  linksCollapsePreviews()
                    ? t("rightPanel.expandPreviews")
                    : t("rightPanel.collapsePreviews")
                }
                aria-label={
                  linksCollapsePreviews()
                    ? t("rightPanel.expandPreviews")
                    : t("rightPanel.collapsePreviews")
                }
              >
                <Show
                  when={linksCollapsePreviews()}
                  fallback={<ListChevronsDownUp size={18} />}
                >
                  <ListChevronsUpDown size={18} />
                </Show>
              </button>
              <button
                class={`right-panel__icon-btn${linksShowMoreContext() ? " right-panel__icon-btn--active" : ""}`}
                onClick={() => setLinksShowMoreContext(!linksShowMoreContext())}
                title={t("search.showMoreContext")}
                aria-pressed={linksShowMoreContext()}
              >
                <LayersPlus size={18} />
              </button>
              <button
                class={`right-panel__icon-btn${linksShowFilter() ? " right-panel__icon-btn--active" : ""}`}
                onClick={() => {
                  const next = !linksShowFilter();
                  setLinksShowFilter(next);
                  if (next) {
                    setTimeout(() => linksFilterInputRef?.focus(), 0);
                  }
                }}
                title={t("rightPanel.filterLinksByName")}
                aria-pressed={linksShowFilter()}
              >
                <Search size={18} />
              </button>
            </div>

            <Show when={linksShowFilter()}>
              <div class="right-panel__links-filter-wrap">
                <input
                  ref={(el) => (linksFilterInputRef = el)}
                  class="right-panel__links-filter-input"
                  type="text"
                  placeholder={t("rightPanel.searchWithinLinks")}
                  title={t("rightPanel.searchWithinLinksTitle")}
                  value={linksFilterQuery()}
                  onInput={(e) => setLinksFilterQuery(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      if (linksFilterQuery()) {
                        setLinksFilterQuery("");
                      } else {
                        setLinksShowFilter(false);
                      }
                    }
                  }}
                />
                <Show when={linksFilterQuery().length > 0}>
                  <button
                    class="right-panel__links-filter-clear"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setLinksFilterQuery("");
                      linksFilterInputRef?.focus();
                    }}
                    title={t("references.clearFilter")}
                    aria-label={t("references.clearFilter")}
                  >
                    <X size={12} />
                  </button>
                </Show>
              </div>
            </Show>

            {/* Inbound Links section (formerly "Backlinks") */}
            <div class="right-panel__section">
              <div
                class="right-panel__section-header right-panel__section-header--clickable"
                onClick={() => toggleLinksSection("inbound")}
                role="button"
                tabindex="0"
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleLinksSection("inbound");
                  }
                }}
                aria-expanded={linksSectionExpanded().inbound}
              >
                <span>
                  {t("rightPanel.inboundLinks")}
                  <Show when={sortedBacklinks().length}>
                    <span class="right-panel__count">
                      {" "}({sortedBacklinks().length})
                    </span>
                  </Show>
                </span>
                <div class="right-panel__header-actions">
                  <Show
                    when={linksSectionExpanded().inbound}
                    fallback={<ChevronRight size={14} class="right-panel__section-chevron" />}
                  >
                    <ChevronDown size={14} class="right-panel__section-chevron" />
                  </Show>
                </div>
              </div>
              <Show when={linksSectionExpanded().inbound}>
                <For each={sortedBacklinks()}>
                  {(link) => {
                    const expanded = () => isPreviewExpanded("inbound", link.path);
                    const preview = () => rowPreview(link);
                    return (
                      <div>
                        <div
                          class="sidebar-item"
                          onClick={(e) => openLinkedFile(link, e)}
                          onContextMenu={(e) =>
                            openLinkRowMenu(e, link.path, link.name)
                          }
                          onDblClick={() =>
                            toggleLinksPreviewOverride(`inbound::${link.path}`)
                          }
                          title={t("rightPanel.rowTitle.full")}
                        >
                          <span class="sidebar-item__icon" innerHTML={`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2H4.5a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V5.5L9.5 2z"/><polyline points="9.5 2 9.5 5.5 13 5.5"/></svg>`} />
                          <span class="sidebar-item__label">{link.name}</span>
                        </div>
                        <Show when={expanded() && preview()}>
                          {(p) => (
                            <>
                              <Show when={linksShowMoreContext() && p().before.length}>
                                <For each={p().before}>
                                  {(l) => <div class="link-context link-context--ctx">{l}</div>}
                                </For>
                              </Show>
                              <div class="link-context link-context--match">{p().line}</div>
                              <Show when={linksShowMoreContext() && p().after.length}>
                                <For each={p().after}>
                                  {(l) => <div class="link-context link-context--ctx">{l}</div>}
                                </For>
                              </Show>
                            </>
                          )}
                        </Show>
                      </div>
                    );
                  }}
                </For>
                <Show when={sortedBacklinks().length === 0}>
                  <p class="sidebar-hint">
                    {linksFilterQuery().trim()
                      ? t("rightPanel.noMatchingInbound")
                      : t("rightPanel.noInbound")}
                  </p>
                </Show>
              </Show>
            </div>

            {/* Outbound Links section (formerly "Forward links") */}
            <div class="right-panel__section">
              <div
                class="right-panel__section-header right-panel__section-header--clickable"
                onClick={() => toggleLinksSection("outbound")}
                role="button"
                tabindex="0"
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleLinksSection("outbound");
                  }
                }}
                aria-expanded={linksSectionExpanded().outbound}
              >
                <span>
                  {t("rightPanel.outboundLinks")}
                  <Show when={sortedForwardLinks().length}>
                    <span class="right-panel__count">
                      {" "}({sortedForwardLinks().length})
                    </span>
                  </Show>
                </span>
                <div class="right-panel__header-actions">
                  <Show
                    when={linksSectionExpanded().outbound}
                    fallback={<ChevronRight size={14} class="right-panel__section-chevron" />}
                  >
                    <ChevronDown size={14} class="right-panel__section-chevron" />
                  </Show>
                </div>
              </div>
              <Show when={linksSectionExpanded().outbound}>
                <For each={sortedForwardLinks()}>
                  {(link) => {
                    // Outbound rows have no native preview line, so this
                    // only shows anything when a search filter matched.
                    // The cm-typst-search-match-line styling makes the
                    // line read as a search hit, not as a stored
                    // backlink quote.
                    const expanded = () => isPreviewExpanded("outbound", link.path);
                    const preview = () => rowPreview(link);
                    return (
                      <div class={link.resolved ? "" : "link--unresolved"}>
                        <div
                          class="sidebar-item"
                          onClick={(e) =>
                            link.resolved
                              ? openLinkedFile(link, e)
                              : createUnresolvedNote(link.target)
                          }
                          onContextMenu={(e) => {
                            if (link.resolved) openLinkRowMenu(e, link.path, link.name);
                          }}
                          onDblClick={() => {
                            if (link.resolved && filterActive()) {
                              toggleLinksPreviewOverride(`outbound::${link.path}`);
                            }
                          }}
                          title={
                            link.resolved
                              ? t("rightPanel.rowTitle.resolved")
                              : t("rightPanel.rowTitle.unresolved")
                          }
                        >
                          <span class="sidebar-item__icon" innerHTML={link.resolved
                            ? `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2H4.5a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V5.5L9.5 2z"/><polyline points="9.5 2 9.5 5.5 13 5.5"/></svg>`
                            : `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2H4.5a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V5.5L9.5 2z" stroke-dasharray="2.5 2"/><polyline points="9.5 2 9.5 5.5 13 5.5" stroke-dasharray="2.5 2"/></svg>`
                          } />
                          <span class="sidebar-item__label">{link.name}</span>
                          <Show when={!link.resolved}>
                            <button
                              class="link__create-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                createUnresolvedNote(link.target);
                              }}
                            >
                              {t("rightPanel.create")}
                            </button>
                          </Show>
                        </div>
                        <Show when={expanded() && preview()}>
                          {(p) => (
                            <>
                              <Show when={linksShowMoreContext() && p().before.length}>
                                <For each={p().before}>
                                  {(l) => <div class="link-context link-context--ctx">{l}</div>}
                                </For>
                              </Show>
                              <div class="link-context link-context--match">{p().line}</div>
                              <Show when={linksShowMoreContext() && p().after.length}>
                                <For each={p().after}>
                                  {(l) => <div class="link-context link-context--ctx">{l}</div>}
                                </For>
                              </Show>
                            </>
                          )}
                        </Show>
                      </div>
                    );
                  }}
                </For>
                <Show when={sortedForwardLinks().length === 0}>
                  <p class="sidebar-hint">
                    {linksFilterQuery().trim()
                      ? t("rightPanel.noMatchingOutbound")
                      : t("rightPanel.noOutbound")}
                  </p>
                </Show>
              </Show>
            </div>

            {/* Potential Links \u2014 files mentioning this note's name without
                an actual wikilink, surfaced so the user can spot missed
                link opportunities. */}
            <div class="right-panel__section">
              <div
                class="right-panel__section-header right-panel__section-header--clickable"
                onClick={() => toggleLinksSection("potential")}
                role="button"
                tabindex="0"
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleLinksSection("potential");
                  }
                }}
                aria-expanded={linksSectionExpanded().potential}
              >
                <span>
                  {t("rightPanel.possibleWikilinks")}
                  <Show when={sortedPotentialLinks().length}>
                    <span class="right-panel__count">
                      {" "}({sortedPotentialLinks().length})
                    </span>
                  </Show>
                </span>
                <div class="right-panel__header-actions">
                  <Show
                    when={linksSectionExpanded().potential}
                    fallback={<ChevronRight size={14} class="right-panel__section-chevron" />}
                  >
                    <ChevronDown size={14} class="right-panel__section-chevron" />
                  </Show>
                </div>
              </div>
              <Show when={linksSectionExpanded().potential}>
                <For each={sortedPotentialLinks()}>
                  {(link) => {
                    const expanded = () => isPreviewExpanded("potential", link.path);
                    const preview = () => nativePreview(link);
                    return (
                      <div>
                        <div
                          class="sidebar-item"
                          onClick={(e) => openLinkedFile(link, e)}
                          onContextMenu={(e) =>
                            openLinkRowMenu(e, link.path, link.name)
                          }
                          onDblClick={() =>
                            toggleLinksPreviewOverride(`potential::${link.path}`)
                          }
                          title={t("rightPanel.rowTitle.full")}
                        >
                          <span class="sidebar-item__icon" innerHTML={`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2H4.5a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V5.5L9.5 2z"/><polyline points="9.5 2 9.5 5.5 13 5.5"/></svg>`} />
                          <span class="sidebar-item__label">{link.name}</span>
                        </div>
                        <Show when={expanded() && preview()}>
                          {(p) => (
                            <>
                              <Show when={linksShowMoreContext() && p().before.length}>
                                <For each={p().before}>
                                  {(l) => <div class="link-context link-context--ctx">{l}</div>}
                                </For>
                              </Show>
                              <div class="link-context link-context--match">{p().line}</div>
                              <Show when={linksShowMoreContext() && p().after.length}>
                                <For each={p().after}>
                                  {(l) => <div class="link-context link-context--ctx">{l}</div>}
                                </For>
                              </Show>
                            </>
                          )}
                        </Show>
                      </div>
                    );
                  }}
                </For>
                <Show when={sortedPotentialLinks().length === 0}>
                  <p class="sidebar-hint">{t("rightPanel.noPossibleWikilinks")}</p>
                </Show>
              </Show>
            </div>
          </Show>

          {/* References tab */}
          <Show when={activePanel() === "references"}>
            <ReferencesPanel />
          </Show>

          {/* Scroll Context tab — only meaningful when Journal Scroll is on
              for the active tab; the pane is gated on the scroll state, not
              just the selected tab, so it can never render orphaned. */}
          <Show
            when={(() => {
              const tab = activeFileTab();
              return (
                activePanel() === "scroll-context" &&
                tab &&
                isScrollEnabled(tab.id)
              );
            })()}
          >
            {(() => {
              const tab = activeFileTab();
              return tab ? <ScrollContextPanel tabId={tab.id} /> : null;
            })()}
          </Show>
        </div>
      </Show>

      {/* File actions hamburger menu */}
      <Show when={fileMenu()}>
        {(menu) => (
          <div
            class="context-menu"
            style={{ left: `${menu().x}px`, top: `${menu().y}px`, position: "fixed" }}
            onClick={(e) => e.stopPropagation()}
          >
            <button class="context-menu__item" onClick={menuRename}>
              {t("rightPanel.menu.rename")}
            </button>
            <button class="context-menu__item" onClick={menuMoveFile}>
              {t("rightPanel.menu.move")}
            </button>
            <button class="context-menu__item" onClick={menuBookmark}>
              {t("rightPanel.menu.bookmark")}
            </button>
            <div class="context-menu__separator" />
            <button class="context-menu__item" onClick={menuExport}>
              {t("rightPanel.menu.export")}
            </button>
            <div class="context-menu__separator" />
            <button class="context-menu__item" onClick={menuFind}>
              {t("rightPanel.menu.find")}
            </button>
            <button class="context-menu__item" onClick={menuReplace}>
              {t("rightPanel.menu.replace")}
            </button>
            <div class="context-menu__separator" />
            <button class="context-menu__item" onClick={menuShowInFileTree}>
              {t("rightPanel.menu.showInTree")}
            </button>
            <button class="context-menu__item" onClick={menuShowInExplorer}>
              {t("rightPanel.menu.showInExplorer")}
            </button>
            <div class="context-menu__separator" />
            <button class="context-menu__item context-menu__item--danger" onClick={menuDelete}>
              {t("rightPanel.menu.delete")}
            </button>
          </div>
        )}
      </Show>

      <Show when={linkRowMenu()}>
        {(menu) => (
          <div
            class="context-menu"
            style={{ left: `${menu().x}px`, top: `${menu().y}px`, position: "fixed" }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              class="context-menu__item"
              onClick={() => {
                const m = menu();
                setLinkRowMenu(null);
                openTab(
                  { type: "file", title: m.name, path: m.path },
                  { forceNewTab: true, newTabAction: true },
                );
              }}
            >
              {t("wikilink.menu.openNewTab")}
            </button>
          </div>
        )}
      </Show>

      <Show when={rowMenu()}>
        {(menu) => (
          <div
            class="context-menu"
            style={{ right: `${menu().right}px`, top: `${menu().y}px`, position: "fixed" }}
            onClick={(e) => e.stopPropagation()}
          >
            <Show when={!KNOWN_FIELDS.has(menu().key)}>
              <div
                class="context-menu__item context-menu__item--submenu"
                onMouseEnter={() =>
                  setRowMenu({ ...menu(), typeSubmenuOpen: true })
                }
                onMouseLeave={() =>
                  setRowMenu({ ...menu(), typeSubmenuOpen: false })
                }
              >
                {t("rightPanel.propertyType")}
                <span class="context-menu__chevron">{"\u25B8"}</span>
                <Show when={menu().typeSubmenuOpen}>
                  <div
                    class={`context-menu context-menu--submenu ${menu().openLeft ? "context-menu--submenu-left" : ""}`}
                  >
                    <For each={PROPERTY_TYPE_OPTIONS}>
                      {(ty) => (
                        <button
                          class="context-menu__item"
                          onClick={() => handleSetRowPropertyType(menu().key, ty)}
                        >
                          {propertyTypeLabel(ty)}
                          <Show when={getPropertyType(menu().key) === ty}>
                            <span class="context-menu__check">{"\u2713"}</span>
                          </Show>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>
            <button
              class="context-menu__item context-menu__item--danger"
              onClick={() => handleRemoveProperty(menu().key)}
            >
              {t("common.remove")}
            </button>
          </div>
        )}
      </Show>
    </div>
  );
};

export default RightPanel;
