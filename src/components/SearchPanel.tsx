// Search panel shown in the left sidebar "search" mode.
//
// State (query, results, options) lives in `stores/search.ts` so it
// survives sidebar mode switches. The user can step over to the file
// tree, bookmarks, or any other mode and come back to find their
// search exactly as they left it. State only resets when the user
// clears the search box.

import { errorText } from "../lib/errors";
import { compareName } from "../lib/sort";
import {
  Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  onCleanup,
  onMount,
} from "solid-js";
import {
  CaseSensitive,
  X,
  Settings2,
  ChevronDown,
  ChevronRight,
  ListChevronsUpDown,
  ListChevronsDownUp,
  LayersPlus,
  Regex,
  MessagesSquare,
  Info,
  Check,
} from "lucide-solid";
import type { SearchResult, AnnotationScope } from "../lib/types";
import { pathEquals } from "../lib/paths";
import { clickOutside } from "../lib/clickOutside";
import * as ipc from "../lib/ipc";
import { useI18n, tPlural } from "../lib/i18n";
import { openTab } from "../stores/tabs";
import { indexReady } from "../stores/notebox";
import {
  searchQuery,
  setSearchQuery,
  searchResults,
  setSearchResults,
  searchResultCount,
  setSearchResultCount,
  searchTotalCount,
  setSearchTotalCount,
  searchOffset,
  setSearchOffset,
  searchError,
  setSearchError,
  caseSensitive,
  setCaseSensitive,
  useRegex,
  setUseRegex,
  annotationScope,
  setAnnotationScope,
  showSettings,
  setShowSettings,
  collapseResults,
  setCollapseResults,
  showMoreContext,
  setShowMoreContext,
  sortMode,
  setSortMode,
  expandOverrides,
  setExpandOverrides,
  showReplace,
  setShowReplace,
  replacement,
  setReplacement,
  replaceResults,
  setReplaceResults,
  resetSearchVolatileState,
  setSearchHighlights,
  type SearchHighlights,
  type SortMode,
} from "../stores/search";

type FilterHint = {
  prefix: string;
  insert: string;
  /** i18n key for the human description, resolved at render. */
  descKey: string;
};

const FILTER_HINTS: FilterHint[] = [
  { prefix: "tag:", insert: "tag:", descKey: "search.filterHint.tag" },
  { prefix: "property:", insert: "property:", descKey: "search.filterHint.property" },
  { prefix: "section:", insert: "section:", descKey: "search.filterHint.section" },
  { prefix: "file:", insert: "file:", descKey: "search.filterHint.file" },
  { prefix: "path:", insert: "path:", descKey: "search.filterHint.path" },
  { prefix: "annotation:", insert: "annotation:", descKey: "search.filterHint.annotation" },
  { prefix: "collection:", insert: "collection:", descKey: "search.filterHint.collection" },
];

/// Informational tips (non-insertable) describing query syntax beyond
/// the filter prefixes. The `label` is a literal syntax token (not
/// translated); `descKey` resolves the human description at render.
const SYNTAX_TIPS: { label: string; descKey: string }[] = [
  { label: "word*", descKey: "search.syntaxTip.truncation" },
  { label: '"…"', descKey: "search.syntaxTip.phrase" },
  { label: "AND OR NOT", descKey: "search.syntaxTip.boolean" },
  { label: "a W/5 b", descKey: "search.syntaxTip.proximity" },
];

const SORT_OPTIONS: { value: SortMode; labelKey: string }[] = [
  { value: "relevance", labelKey: "search.sort.relevance" },
  { value: "name-asc", labelKey: "search.sort.nameAsc" },
  { value: "name-desc", labelKey: "search.sort.nameDesc" },
  { value: "modified-desc", labelKey: "search.sort.modifiedDesc" },
  { value: "modified-asc", labelKey: "search.sort.modifiedAsc" },
  { value: "created-desc", labelKey: "search.sort.createdDesc" },
  { value: "created-asc", labelKey: "search.sort.createdAsc" },
];

const ANNOTATION_SCOPE_OPTIONS: {
  value: AnnotationScope;
  labelKey: string;
  descKey: string;
}[] = [
  { value: "all", labelKey: "search.scope.all", descKey: "search.scope.allDesc" },
  { value: "only", labelKey: "search.scope.only", descKey: "search.scope.onlyDesc" },
  { value: "exclude", labelKey: "search.scope.exclude", descKey: "search.scope.excludeDesc" },
];

const SearchPanel: Component = () => {
  const t = useI18n();
  // UI-only ephemeral state — these don't need to persist across mode
  // switches because they're transient overlays. Loading/showSettings
  // etc. revert to defaults when the panel re-mounts; that matches what
  // a user would expect.
  const [loading, setLoading] = createSignal(false);
  const [replacing, setReplacing] = createSignal(false);
  // showSettings lives in the search store (not here) so the "Search Options"
  // expander stays open across sidebar tab switches — see stores/search.ts.
  const [showTips, setShowTips] = createSignal(false);
  const [showSortMenu, setShowSortMenu] = createSignal(false);
  const [showOverflowMenu, setShowOverflowMenu] = createSignal(false);
  const [showScopeMenu, setShowScopeMenu] = createSignal(false);
  // Trigger buttons, so click-outside dismissal can ignore clicks on the
  // toggle itself (otherwise it would close then immediately reopen).
  let overflowBtnRef: HTMLButtonElement | undefined;
  let sortBtnRef: HTMLButtonElement | undefined;
  let scopeBtnRef: HTMLButtonElement | undefined;
  const [resultContextMenu, setResultContextMenu] = createSignal<
    { x: number; y: number; result: SearchResult } | null
  >(null);

  let searchTimeout: ReturnType<typeof setTimeout> | undefined;
  let inputRef: HTMLInputElement | undefined;

  onCleanup(() => {
    if (searchTimeout) clearTimeout(searchTimeout);
  });

  // Focus the query box. Called on mount (opening the pane from another tab
  // remounts this component) and from the open-search event (so Ctrl+Shift+F
  // refocuses even when the pane is already open). The `autofocus` attribute
  // alone only fires on the first page-load mount — browsers don't re-honour
  // it on later dynamic remounts — which is why focus "only worked the first
  // time". `cursorAtEnd` parks the caret after a pre-filled query (e.g. a
  // property click) instead of selecting it.
  function focusInput(cursorAtEnd = false) {
    queueMicrotask(() => {
      if (!inputRef) return;
      inputRef.focus();
      if (cursorAtEnd) {
        const end = inputRef.value.length;
        inputRef.setSelectionRange(end, end);
      } else {
        inputRef.select();
      }
    });
  }

  onMount(() => {
    // Land the cursor in the box immediately whenever the pane opens.
    focusInput();

    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ query?: string; showReplace?: boolean }>)
        .detail;
      if (detail?.showReplace) setShowReplace(true);
      if (!detail?.query) {
        // Plain open (e.g. Ctrl+Shift+F while already on the search tab):
        // refocus the existing box so the user can start typing.
        focusInput();
        return;
      }
      setSearchQuery(detail.query);
      if (searchTimeout) clearTimeout(searchTimeout);
      // Property-click queries arrive ending in `=` so the user can type
      // a value next; park the cursor there and don't auto-run.
      if (detail.query.endsWith("=")) {
        focusInput(true);
        return;
      }
      focusInput(true);
      executeSearch();
    };
    document.addEventListener("inkycap:open-search", handler);
    onCleanup(() => document.removeEventListener("inkycap:open-search", handler));

    const onDocClick = () => setResultContextMenu(null);
    document.addEventListener("click", onDocClick);
    onCleanup(() => document.removeEventListener("click", onDocClick));

    const onNoteSaved = (e: Event) => {
      if (!searchQuery().trim()) return;
      const savedPath = (e as CustomEvent<{ path?: string }>).detail?.path;
      if (!savedPath) return;
      const current = searchResults();
      const had = current.some((r) => pathEquals(r.path, savedPath));
      if (!had) return;
      const filtered = current.filter((r) => !pathEquals(r.path, savedPath));
      setSearchResults(filtered);
      setSearchResultCount(filtered.length);
    };
    document.addEventListener("inkycap:note-saved", onNoteSaved);
    onCleanup(() => document.removeEventListener("inkycap:note-saved", onNoteSaved));
  });

  // Re-run the active query as soon as background indexing finishes.
  createEffect(() => {
    if (indexReady() && searchQuery().trim()) {
      executeSearch();
    }
  });

  function buildQuery(): string {
    return searchQuery().trim();
  }

  const PAGE_SIZE = 500;

  async function executeSearch(offset?: number) {
    const q = buildQuery();
    // An empty query normally clears results — except in annotations-only
    // mode, where it means "browse every annotation in the notebox".
    if (!q && annotationScope() !== "only") {
      setSearchResults([]);
      setSearchResultCount(0);
      setSearchTotalCount(0);
      setSearchOffset(0);
      setSearchError(null);
      return;
    }
    if (!indexReady()) {
      setSearchResults([]);
      setSearchResultCount(0);
      setSearchTotalCount(0);
      return;
    }

    const off = offset ?? 0;
    setLoading(true);
    setSearchError(null);
    setReplaceResults(null);

    try {
      const resp = await ipc.noteboxSearch(
        q,
        PAGE_SIZE,
        caseSensitive(),
        off,
        useRegex(),
        annotationScope(),
      );
      setSearchResults(resp.results);
      setSearchResultCount(resp.results.length);
      setSearchTotalCount(resp.total_count);
      setSearchOffset(off);
    } catch (e) {
      setSearchError(errorText(e));
      setSearchResults([]);
      setSearchResultCount(0);
      setSearchTotalCount(0);
    } finally {
      setLoading(false);
    }
  }

  function handleInput(value: string) {
    setSearchQuery(value);
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      executeSearch();
    }, 300);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      if (searchTimeout) clearTimeout(searchTimeout);
      executeSearch();
    } else if (e.key === "Escape") {
      setShowTips(false);
    }
  }

  function clearQuery() {
    setSearchQuery("");
    if (searchTimeout) clearTimeout(searchTimeout);
    resetSearchVolatileState();
    // Re-run the now-empty query so the × matches manually deleting the text.
    // executeSearch's empty-query branch clears results in normal mode, but in
    // annotations-only mode an empty query *browses every annotation* — so the
    // × must reissue that browse instead of leaving the list empty.
    executeSearch();
    inputRef?.focus();
  }

  function insertHint(hint: FilterHint) {
    const cur = searchQuery();
    const needsSpace = cur.length > 0 && !cur.endsWith(" ");
    const prefix = (needsSpace ? " " : "") + hint.insert;
    const next = cur + prefix;
    setSearchQuery(next);
    setShowTips(false);
    setTimeout(() => {
      inputRef?.focus();
      inputRef?.setSelectionRange(next.length, next.length);
    }, 0);
  }

  function openResult(result: SearchResult, e?: MouseEvent) {
    const title = result.path.split(/[/\\]/).pop() ?? result.file_name;
    const forceNewTab = !!(e && (e.ctrlKey || e.metaKey));
    // First match-range pinpoints where to land in the file. If the row
    // came from a filter-only result (no real text match), the range is
    // empty/zero-width — leave `match` undefined so the editor doesn't
    // dispatch a no-op selection.
    const first = result.match_ranges[0];
    const hasReal = first && first[1] > first[0];
    const match = hasReal
      ? {
          line: result.line_number,
          charStart: first[0],
          charEnd: first[1],
        }
      : undefined;
    // Highlight *every* match in this file once it opens — not just the clicked
    // line — so a multi-term query (e.g. `journ* AND canad*`) shows all matching
    // portions. Gather all ranges for the path from the current result set.
    const fileRanges: SearchHighlights["ranges"] = [];
    for (const r of searchResults()) {
      if (!pathEquals(r.path, result.path)) continue;
      for (const [s, en] of r.match_ranges) {
        if (en > s) {
          fileRanges.push({ line: r.line_number, charStart: s, charEnd: en });
        }
      }
    }
    setSearchHighlights(
      fileRanges.length > 0 ? { path: result.path, ranges: fileRanges } : null,
    );
    openTab(
      {
        type: "file",
        title,
        path: result.path,
      },
      { forceNewTab, newTabAction: forceNewTab, match },
    );
  }

  function handleResultContext(e: MouseEvent, result: SearchResult) {
    e.preventDefault();
    e.stopPropagation();
    // Clamp inside viewport so the menu is always fully visible.
    const MENU_W = 200;
    const MENU_H = 100;
    const x = Math.min(e.clientX, window.innerWidth - MENU_W - 8);
    const y = Math.min(e.clientY, window.innerHeight - MENU_H - 8);
    setResultContextMenu({ x, y, result });
  }


  /// Ask any open editor tabs to reload the affected files from disk.
  /// Reuses the existing `inkycap:note-property-changed` event that
  /// `TypstEditor` already listens to — its handler does exactly the
  /// reload-from-disk step we need after a search-and-replace write.
  function notifyFilesReloaded(paths: string[]) {
    for (const path of paths) {
      document.dispatchEvent(
        new CustomEvent("inkycap:note-property-changed", { detail: { path } }),
      );
    }
  }

  async function replaceAll() {
    const q = searchQuery().trim();
    const rep = replacement();
    if (!q) return;

    setReplacing(true);
    setLoading(true);
    try {
      const res = await ipc.searchAndReplace(q, rep, undefined, caseSensitive(), useRegex());
      setReplaceResults(res);
      notifyFilesReloaded(res.map((r) => r.path));
      setReplacing(false);
      await executeSearch();
    } catch (e) {
      setSearchError(errorText(e));
    } finally {
      setReplacing(false);
      setLoading(false);
    }
  }

  async function replaceInFile(filePath: string) {
    const q = searchQuery().trim();
    const rep = replacement();
    if (!q) return;
    setReplacing(true);
    try {
      await ipc.searchAndReplace(q, rep, [filePath], caseSensitive(), useRegex());
      notifyFilesReloaded([filePath]);
      setReplacing(false);
      await executeSearch(searchOffset());
    } catch (e) {
      setSearchError(errorText(e));
    } finally {
      setReplacing(false);
    }
  }

  async function bookmarkCurrentSearch() {
    const q = searchQuery().trim();
    if (!q) return;
    setShowOverflowMenu(false);
    try {
      await ipc.addBookmark({ type: "Search", data: { query: q } });
      document.dispatchEvent(new CustomEvent("inkycap:bookmarks-changed"));
    } catch (e) {
      setSearchError(errorText(e));
    }
  }

  async function copyResultsToClipboard() {
    setShowOverflowMenu(false);
    const text = sortedGroups()
      .map((g) => {
        if (collapseResults()) return g.path;
        const lines = g.matches
          .map((m) => `  ${m.line_number}: ${m.line_text}`)
          .join("\n");
        return `${g.path}\n${lines}`;
      })
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      setSearchError(errorText(e));
    }
  }

  function toggleFileExpansion(path: string) {
    const overrides = new Set(expandOverrides());
    if (overrides.has(path)) {
      overrides.delete(path);
    } else {
      overrides.add(path);
    }
    setExpandOverrides(overrides);
  }

  /// True when the file's match list should be visible. A path appears in
  /// `expandOverrides` when the user has explicitly inverted the global
  /// `collapseResults` setting for that file.
  function isFileExpanded(path: string): boolean {
    const overridden = expandOverrides().has(path);
    return collapseResults() ? overridden : !overridden;
  }

  interface GroupedResult {
    path: string;
    file_name: string;
    /** Highlight ranges within `file_name`; same for every match in the
     *  group, so we keep the first result's copy. */
    file_name_ranges: [number, number][];
    matches: SearchResult[];
    modified_time: number;
    created_time: number;
    topScore: number;
  }

  const groupedResults = createMemo((): GroupedResult[] => {
    const groups: GroupedResult[] = [];
    const index = new Map<string, GroupedResult>();
    for (const r of searchResults()) {
      let group = index.get(r.path);
      if (!group) {
        group = {
          path: r.path,
          file_name: r.file_name,
          file_name_ranges: r.file_name_ranges,
          matches: [],
          modified_time: r.modified_time,
          created_time: r.created_time,
          topScore: r.score,
        };
        index.set(r.path, group);
        groups.push(group);
      }
      group.matches.push(r);
      if (r.score > group.topScore) group.topScore = r.score;
    }
    for (const g of groups) {
      g.matches.sort((a, b) => a.line_number - b.line_number);
    }
    return groups;
  });

  // The plain-text core of the query, used to detect an exact filename
  // match. Returns null whenever the query uses any operator (phrase
  // quotes aside, which are unwrapped here) — pinning an exact name only
  // makes sense for a literal query, not a boolean/regex/proximity one.
  const literalQuery = createMemo((): string | null => {
    let q = searchQuery().trim();
    if (!q) return null;
    // A whole-query phrase search ("…") is still a plain literal — unwrap it.
    if (q.length >= 2 && q.startsWith('"') && q.endsWith('"')) {
      q = q.slice(1, -1).trim();
    }
    // Bail on any remaining operator syntax (stray quote, regex, truncation,
    // grouping, boolean, proximity, exclusion, `field:` filter).
    if (
      /["()/*]/.test(q) ||
      /(^|\s)(AND|OR|NOT)(\s|$)/.test(q) ||
      /\b[WN]\/\d+\b/.test(q) ||
      /(^|\s)-\S/.test(q) ||
      /\w+:/.test(q)
    ) {
      return null;
    }
    return q.toLowerCase();
  });

  /** True when the query is the note's filename, verbatim (case-insensitive). */
  function isExactNameMatch(group: GroupedResult): boolean {
    const q = literalQuery();
    if (!q) return false;
    return group.file_name.replace(/\.typ$/i, "").trim().toLowerCase() === q;
  }

  const sortedGroups = createMemo((): GroupedResult[] => {
    const groups = [...groupedResults()];
    const mode = sortMode();
    const cmp = (() => {
      switch (mode) {
        case "name-asc":
          return (a: GroupedResult, b: GroupedResult) =>
            compareName(a.file_name, b.file_name);
        case "name-desc":
          return (a: GroupedResult, b: GroupedResult) =>
            compareName(b.file_name, a.file_name);
        case "modified-desc":
          return (a: GroupedResult, b: GroupedResult) =>
            b.modified_time - a.modified_time;
        case "modified-asc":
          return (a: GroupedResult, b: GroupedResult) =>
            a.modified_time - b.modified_time;
        case "created-desc":
          return (a: GroupedResult, b: GroupedResult) =>
            b.created_time - a.created_time;
        case "created-asc":
          return (a: GroupedResult, b: GroupedResult) =>
            a.created_time - b.created_time;
        case "relevance":
        default:
          return (a: GroupedResult, b: GroupedResult) => b.topScore - a.topScore;
      }
    })();
    groups.sort(cmp);
    // A note whose filename is exactly the query jumps to the top of the
    // Relevance and Filename sorts — the result the user almost certainly
    // wants. Date sorts stay strictly chronological. The sort is stable, so
    // this second pass only lifts the exact match and leaves the order of
    // every other row (and of multiple exact matches) untouched.
    if (mode === "relevance" || mode === "name-asc" || mode === "name-desc") {
      groups.sort(
        (a, b) => Number(isExactNameMatch(b)) - Number(isExactNameMatch(a)),
      );
    }
    return groups;
  });

  function activeSortLabel(): string {
    const opt = SORT_OPTIONS.find((o) => o.value === sortMode());
    return opt ? t(opt.labelKey) : t("sort.label");
  }

  function chooseAnnotationScope(scope: AnnotationScope) {
    setShowScopeMenu(false);
    if (annotationScope() === scope) return;
    setAnnotationScope(scope);
    executeSearch();
  }

  function annotationScopeTitle(): string {
    switch (annotationScope()) {
      case "only":
        return t("search.scopeTitle.only");
      case "exclude":
        return t("search.scopeTitle.exclude");
      default:
        return t("search.scopeTitle.all");
    }
  }

  return (
    <div class="search-panel">
      <div class="search-panel__input-row">
        <div class="search-panel__input-wrap">
          <input
            ref={(el) => (inputRef = el)}
            class="search-panel__input"
            type="text"
            placeholder={t("search.placeholder")}
            value={searchQuery()}
            onInput={(e) => handleInput(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            autofocus
          />
          <Show when={searchQuery().length > 0}>
            <button
              class="search-panel__clear"
              onMouseDown={(e) => {
                e.preventDefault();
                clearQuery();
              }}
              title={t("search.clearSearch")}
              aria-label={t("search.clearSearch")}
            >
              <X size={12} />
            </button>
          </Show>
        </div>
        <button
          class={`icon-btn ${caseSensitive() ? "icon-btn--active" : ""}`}
          onClick={() => {
            setCaseSensitive(!caseSensitive());
            executeSearch();
          }}
          title={t("search.caseSensitive")}
          aria-pressed={caseSensitive()}
        >
          <CaseSensitive size={18} />
        </button>
        <button
          class={`icon-btn ${showSettings() ? "icon-btn--active" : ""}`}
          onClick={() => setShowSettings(!showSettings())}
          title={t("search.options")}
          aria-pressed={showSettings()}
        >
          <Settings2 size={18} />
        </button>
        <button
          class={`icon-btn ${showTips() ? "icon-btn--active" : ""}`}
          onClick={() => setShowTips(!showTips())}
          title={t("search.tips")}
          aria-pressed={showTips()}
        >
          <Info size={18} />
        </button>
      </div>

      <Show when={showSettings()}>
        <div class="search-panel__options-row">
          <button
            class="icon-btn"
            onClick={() => {
              // Per-file overrides invert their meaning when the global
              // flag flips. Clearing them ensures Expand/Collapse acts
              // uniformly: every file lands in the target state, and
              // files already in that state stay put.
              setExpandOverrides(new Set<string>());
              setCollapseResults(!collapseResults());
            }}
            title={collapseResults() ? t("search.expandResults") : t("search.collapseResults")}
            aria-label={collapseResults() ? t("search.expandResults") : t("search.collapseResults")}
          >
            <Show
              when={collapseResults()}
              fallback={<ListChevronsDownUp size={18} />}
            >
              <ListChevronsUpDown size={18} />
            </Show>
          </button>
          <button
            class={`icon-btn ${showMoreContext() ? "icon-btn--active" : ""}`}
            onClick={() => setShowMoreContext(!showMoreContext())}
            title={t("search.showMoreContext")}
            aria-pressed={showMoreContext()}
          >
            <LayersPlus size={18} />
          </button>
          <button
            class={`icon-btn ${useRegex() ? "icon-btn--active" : ""}`}
            onClick={() => {
              setUseRegex(!useRegex());
              executeSearch();
            }}
            title={t("search.useRegex")}
            aria-pressed={useRegex()}
          >
            <Regex size={18} />
          </button>
          <div class="search-panel__scope-menu-wrap">
            <button
              ref={scopeBtnRef}
              class={`icon-btn ${annotationScope() !== "all" ? "icon-btn--active" : ""}`}
              onClick={() => setShowScopeMenu(!showScopeMenu())}
              title={annotationScopeTitle()}
              aria-label={t("search.annotationScope")}
              aria-haspopup="menu"
              aria-expanded={showScopeMenu()}
            >
              <MessagesSquare size={18} />
            </button>
            <Show when={showScopeMenu()}>
              <div
                class="context-menu search-panel__menu-anchored search-panel__menu-anchored--right"
                use:clickOutside={{
                  onDismiss: () => setShowScopeMenu(false),
                  ignore: scopeBtnRef,
                }}
              >
                <For each={ANNOTATION_SCOPE_OPTIONS}>
                  {(opt) => (
                    <button
                      classList={{
                        "context-menu__item": true,
                        "context-menu__item--active":
                          annotationScope() === opt.value,
                      }}
                      onClick={() => chooseAnnotationScope(opt.value)}
                      title={t(opt.descKey)}
                    >
                      <span>{t(opt.labelKey)}</span>
                      <Show when={annotationScope() === opt.value}>
                        <Check size={14} class="context-menu__check" />
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </div>
      </Show>

      <Show when={!searchQuery().trim() && !showTips()}>
        <div class="search-panel__tip">
          {t("search.reminderTip")}{" "}
          <button
            type="button"
            class="inline-link search-panel__tip-link"
            onClick={() => setShowTips(true)}
          >
            {t("search.reminderTipLink")}
          </button>
        </div>
      </Show>

      <Show when={showReplace()}>
        <div class="search-panel__replace-row">
          <input
            class="search-panel__input"
            type="text"
            placeholder={t("search.replaceWith")}
            value={replacement()}
            onInput={(e) => setReplacement(e.currentTarget.value)}
          />
          <button
            class="search-panel__replace-btn"
            onClick={replaceAll}
            title={t("search.replaceAll")}
            disabled={!searchQuery().trim() || loading()}
          >
            {t("search.replaceAll")}
          </button>
          <button
            class="icon-btn"
            onClick={() => {
              setShowReplace(false);
              setReplacement("");
              setReplaceResults(null);
            }}
            title={t("search.closeReplace")}
            aria-label={t("search.closeReplace")}
          >
            <X size={18} />
          </button>
        </div>
      </Show>

      <Show when={showTips()}>
        <div class="search-panel__hints">
          <div class="search-panel__hints-title">{t("search.tipsTitle")}</div>
          <For each={FILTER_HINTS}>
            {(hint) => (
              <button
                class="search-panel__hint"
                onClick={() => insertHint(hint)}
                title={t(hint.descKey)}
              >
                <span class="search-panel__hint-prefix">{hint.prefix}</span>
                <span class="search-panel__hint-desc">{t(hint.descKey)}</span>
              </button>
            )}
          </For>
          <div class="search-panel__hints-divider" />
          <For each={SYNTAX_TIPS}>
            {(tip) => (
              <div class="search-panel__hint search-panel__hint--static">
                <span class="search-panel__hint-prefix">{tip.label}</span>
                <span class="search-panel__hint-desc">{t(tip.descKey)}</span>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={replaceResults()}>
        {(res) => (
          <div class="search-panel__replace-info">
            {tPlural("search.replacedInfo", res().length, {
              files: res().length,
              occurrences: res().reduce((sum, r) => sum + r.replacements, 0),
            })}
          </div>
        )}
      </Show>

      <div class="search-panel__status">
        <Show when={!indexReady()}>
          <span>{t("search.indexing")}</span>
        </Show>
        <Show when={indexReady() && loading()}>
          <span class="search-panel__busy">
            {replacing() ? t("search.replacing") : t("search.searching")}
            <span class="search-panel__dot search-panel__dot--1">.</span>
            <span class="search-panel__dot search-panel__dot--2">.</span>
            <span class="search-panel__dot search-panel__dot--3">.</span>
          </span>
        </Show>
        <Show when={indexReady() && !loading() && searchQuery().trim()}>
          <button
            ref={overflowBtnRef}
            class="search-panel__overflow-btn"
            title={t("search.moreActions")}
            onClick={() => setShowOverflowMenu(!showOverflowMenu())}
          >
            {searchTotalCount() > searchResultCount()
              ? t("search.resultsRange", {
                  from: searchOffset() + 1,
                  to: searchOffset() + searchResultCount(),
                  total: searchTotalCount(),
                })
              : tPlural("search.resultCount", searchResultCount())} {"⌄"}
          </button>
          <Show when={showOverflowMenu()}>
            <div
              class="context-menu search-panel__menu-anchored search-panel__menu-anchored--left"
              use:clickOutside={{
                onDismiss: () => setShowOverflowMenu(false),
                ignore: overflowBtnRef,
              }}
            >
              <button
                class="context-menu__item"
                onClick={copyResultsToClipboard}
              >
                {t("search.copyResults")}
              </button>
              <button
                class="context-menu__item"
                onClick={bookmarkCurrentSearch}
              >
                {t("search.bookmarkSearch")}
              </button>
            </div>
          </Show>
          <button
            ref={sortBtnRef}
            class="search-panel__sort-btn"
            onClick={() => setShowSortMenu(!showSortMenu())}
            title={t("search.sortOrder")}
          >
            {activeSortLabel()} {"⌄"}
          </button>
          <Show when={showSortMenu()}>
            <div
              class="context-menu search-panel__menu-anchored search-panel__menu-anchored--right"
              use:clickOutside={{
                onDismiss: () => setShowSortMenu(false),
                ignore: sortBtnRef,
              }}
            >
              <For each={SORT_OPTIONS}>
                {(opt) => (
                  <button
                    classList={{
                      "context-menu__item": true,
                      "context-menu__item--active": sortMode() === opt.value,
                    }}
                    onClick={() => {
                      setSortMode(opt.value);
                      setShowSortMenu(false);
                    }}
                  >
                    {t(opt.labelKey)}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>

      <Show when={searchTotalCount() > searchResultCount() + searchOffset()  || searchOffset() > 0}>
        <div class="search-panel__pagination">
          <button
            class="search-panel__page-btn"
            disabled={searchOffset() === 0}
            onClick={() => executeSearch(Math.max(0, searchOffset() - PAGE_SIZE))}
          >
            {t("search.previous")}
          </button>
          <button
            class="search-panel__page-btn"
            disabled={searchOffset() + searchResultCount() >= searchTotalCount()}
            onClick={() => executeSearch(searchOffset() + PAGE_SIZE)}
          >
            {t("search.next")}
          </button>
        </div>
      </Show>

      <Show when={searchError()}>
        <div class="search-panel__error">{searchError()}</div>
      </Show>

      <div
        class="search-panel__results"
        onScroll={() => {
          // Tips are a transient reference overlay — dismiss them as soon as
          // the user starts scrolling the results.
          if (showTips()) setShowTips(false);
        }}
      >
        <For each={sortedGroups()}>
          {(group) => {
            const expanded = () => isFileExpanded(group.path);
            return (
              <div class="search-panel__file-group">
                <div class="search-panel__result-file">
                  <button
                    class="search-panel__group-chevron"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFileExpansion(group.path);
                    }}
                    title={expanded() ? t("search.collapse") : t("search.expand")}
                    aria-expanded={expanded()}
                  >
                    <Show when={expanded()} fallback={<ChevronRight size={14} />}>
                      <ChevronDown size={14} />
                    </Show>
                  </button>
                  <span
                    class="search-panel__file-label"
                    onClick={(e) => openResult(group.matches[0], e)}
                  >
                    <HighlightedLine
                      text={group.file_name}
                      ranges={group.file_name_ranges}
                      class="search-panel__file-label-text"
                    />
                  </span>
                  <span class="search-panel__match-count">
                    {group.matches.length}
                  </span>
                  <Show when={showReplace()}>
                    <button
                      class="search-panel__result-replace-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        replaceInFile(group.path);
                      }}
                      title={t("search.replaceInFile")}
                    >
                      {t("search.replace")}
                    </button>
                  </Show>
                </div>
                <Show when={expanded()}>
                  <For each={group.matches}>
                    {(result) => (
                      <ResultLine
                        result={result}
                        showMoreContext={showMoreContext()}
                        onClick={(e) => openResult(result, e)}
                        onContext={(e) => handleResultContext(e, result)}
                      />
                    )}
                  </For>
                </Show>
              </div>
            );
          }}
        </For>
      </div>

      <Show when={resultContextMenu()}>
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
              onClick={() => {
                const r = menu().result;
                setResultContextMenu(null);
                // Synthesize a click-with-modifier so openResult's
                // forceNewTab + match-jump logic stays in one place.
                const fake = new MouseEvent("click", {
                  ctrlKey: true,
                });
                openResult(r, fake);
              }}
            >
              {t("wikilink.menu.openNewTab")}
            </button>
          </div>
        )}
      </Show>
    </div>
  );
};

const ResultLine: Component<{
  result: SearchResult;
  showMoreContext: boolean;
  onClick: (e: MouseEvent) => void;
  onContext: (e: MouseEvent) => void;
}> = (props) => {
  return (
    <div
      classList={{
        "search-panel__result": true,
        "search-panel__result--wide": props.showMoreContext,
      }}
      onClick={(e) => props.onClick(e)}
      onContextMenu={(e) => props.onContext(e)}
    >
      <Show when={props.showMoreContext}>
        <For each={props.result.context_before}>
          {(line) => <div class="search-panel__context-line">{line}</div>}
        </For>
      </Show>
      <div class="search-panel__result-line">
        <span class="search-panel__result-lineno">
          {props.result.line_number}:
        </span>
        <HighlightedLine
          text={props.result.line_text}
          ranges={props.result.match_ranges}
        />
      </div>
      <Show when={props.showMoreContext}>
        <For each={props.result.context_after}>
          {(line) => <div class="search-panel__context-line">{line}</div>}
        </For>
      </Show>
    </div>
  );
};

const HighlightedLine: Component<{
  text: string;
  ranges: [number, number][];
  /** Wrapper class. Defaults to the monospace snippet style; the group
   *  header passes its own so the file name keeps the header font. */
  class?: string;
}> = (props) => {
  const segments = () => {
    const text = props.text;
    const ranges = props.ranges;
    if (ranges.length === 0) return [{ text, highlight: false }];

    // Drop zero-width ranges. Document-level matches (a `tag:`/`path:`
    // filter, or a filename hit) carry a `(0, 0)` placeholder range that
    // marks the line as a match without pointing at a body span; rendering
    // it would paint an empty highlight at the start of the line.
    const sorted = ranges
      .filter(([start, end]) => end > start)
      .sort((a, b) => a[0] - b[0]);
    if (sorted.length === 0) return [{ text, highlight: false }];

    const parts: { text: string; highlight: boolean }[] = [];
    let cursor = 0;

    for (const [start, end] of sorted) {
      if (start > cursor) {
        parts.push({ text: text.slice(cursor, start), highlight: false });
      }
      parts.push({ text: text.slice(start, end), highlight: true });
      cursor = end;
    }
    if (cursor < text.length) {
      parts.push({ text: text.slice(cursor), highlight: false });
    }
    return parts;
  };

  return (
    <span class={props.class ?? "search-panel__result-text"}>
      <For each={segments()}>
        {(seg) => (
          <Show when={seg.highlight} fallback={<span>{seg.text}</span>}>
            <mark class="search-panel__highlight">{seg.text}</mark>
          </Show>
        )}
      </For>
    </span>
  );
};

export default SearchPanel;
