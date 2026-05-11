// Search panel shown in the left sidebar "search" mode.
//
// State (query, results, options) lives in `stores/search.ts` so it
// survives sidebar mode switches. The user can step over to the file
// tree, bookmarks, or any other mode and come back to find their
// search exactly as they left it. State only resets when the user
// clears the search box.

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
  Replace,
  CaseSensitive,
  X,
  Settings2,
  ChevronDown,
  ChevronRight,
} from "lucide-solid";
import type { SearchResult } from "../lib/types";
import * as ipc from "../lib/ipc";
import { openTab } from "../stores/tabs";
import { indexReady } from "../stores/vault";
import {
  searchQuery,
  setSearchQuery,
  searchResults,
  setSearchResults,
  searchResultCount,
  setSearchResultCount,
  searchError,
  setSearchError,
  caseSensitive,
  setCaseSensitive,
  useRegex,
  setUseRegex,
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
  type SortMode,
} from "../stores/search";

type FilterHint = {
  prefix: string;
  insert: string;
  description: string;
};

const FILTER_HINTS: FilterHint[] = [
  { prefix: "tag:", insert: "tag:", description: "search by tag" },
  {
    prefix: "property:",
    insert: "property:",
    description: "match a note property. Use property:key=value",
  },
  {
    prefix: "section:",
    insert: "section:",
    description: "match files with a heading based on its <value>",
  },
  { prefix: "file:", insert: "file:", description: "match by file name" },
  { prefix: "path:", insert: "path:", description: "match by the file path" },
];

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "relevance", label: "Relevance" },
  { value: "name-asc", label: "File name (A to Z)" },
  { value: "name-desc", label: "File name (Z to A)" },
  { value: "modified-desc", label: "Modified time (new to old)" },
  { value: "modified-asc", label: "Modified time (old to new)" },
  { value: "created-desc", label: "Created time (new to old)" },
  { value: "created-asc", label: "Created time (old to new)" },
];

const SearchPanel: Component = () => {
  // UI-only ephemeral state — these don't need to persist across mode
  // switches because they're transient overlays. Loading/showSettings
  // etc. revert to defaults when the panel re-mounts; that matches what
  // a user would expect.
  const [loading, setLoading] = createSignal(false);
  const [showSettings, setShowSettings] = createSignal(false);
  const [showHints, setShowHints] = createSignal(false);
  const [showSortMenu, setShowSortMenu] = createSignal(false);
  const [showOverflowMenu, setShowOverflowMenu] = createSignal(false);
  const [resultContextMenu, setResultContextMenu] = createSignal<
    { x: number; y: number; result: SearchResult } | null
  >(null);

  let searchTimeout: ReturnType<typeof setTimeout> | undefined;
  let inputRef: HTMLInputElement | undefined;

  onCleanup(() => {
    if (searchTimeout) clearTimeout(searchTimeout);
  });

  onMount(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ query?: string }>).detail;
      if (!detail?.query) return;
      setSearchQuery(detail.query);
      if (searchTimeout) clearTimeout(searchTimeout);
      // Property-click queries arrive ending in `=` so the user can type
      // a value next; park the cursor there and don't auto-run.
      if (detail.query.endsWith("=")) {
        setTimeout(() => {
          inputRef?.focus();
          inputRef?.setSelectionRange(detail.query!.length, detail.query!.length);
        }, 0);
        return;
      }
      executeSearch();
    };
    document.addEventListener("inkycap:open-search", handler);
    onCleanup(() => document.removeEventListener("inkycap:open-search", handler));

    const onDocClick = () => setResultContextMenu(null);
    document.addEventListener("click", onDocClick);
    onCleanup(() => document.removeEventListener("click", onDocClick));
  });

  // Re-run the active query as soon as background indexing finishes.
  createEffect(() => {
    if (indexReady() && searchQuery().trim()) {
      executeSearch();
    }
  });

  function buildQuery(): string {
    let q = searchQuery().trim();
    if (!q) return "";
    if (useRegex()) q = `/${q}/`;
    return q;
  }

  async function executeSearch() {
    const q = buildQuery();
    if (!q) {
      setSearchResults([]);
      setSearchResultCount(0);
      setSearchError(null);
      return;
    }
    if (!indexReady()) {
      setSearchResults([]);
      setSearchResultCount(0);
      return;
    }

    setLoading(true);
    setSearchError(null);
    setReplaceResults(null);

    try {
      const res = await ipc.vaultSearch(q, 500, caseSensitive());
      setSearchResults(res);
      setSearchResultCount(res.length);
    } catch (e) {
      setSearchError(String(e));
      setSearchResults([]);
      setSearchResultCount(0);
    } finally {
      setLoading(false);
    }
  }

  function handleInput(value: string) {
    setSearchQuery(value);
    setShowHints(false);
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
      setShowHints(false);
    }
  }

  function clearQuery() {
    setSearchQuery("");
    resetSearchVolatileState();
    if (searchTimeout) clearTimeout(searchTimeout);
    inputRef?.focus();
  }

  function insertHint(hint: FilterHint) {
    const cur = searchQuery();
    const needsSpace = cur.length > 0 && !cur.endsWith(" ");
    const prefix = (needsSpace ? " " : "") + hint.insert;
    const next = cur + prefix;
    setSearchQuery(next);
    setShowHints(false);
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
    openTab(
      {
        type: "file",
        title,
        path: result.path,
      },
      { forceNewTab, match },
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

  function openInNewWindow(result: SearchResult) {
    setResultContextMenu(null);
    // Lazy-import keeps the WebviewWindow API out of the SearchPanel
    // bundle when the user never hits this code path.
    import("@tauri-apps/api/webviewWindow")
      .then(({ WebviewWindow }) => {
        const label = `note-${Date.now()}`;
        const title = result.path.split(/[/\\]/).pop() ?? result.file_name;
        const win = new WebviewWindow(label, {
          url: `index.html?path=${encodeURIComponent(result.path)}`,
          title,
          width: 900,
          height: 700,
        });
        win.once("tauri://error", (err) => {
          console.error("Failed to open new window:", err);
        });
      })
      .catch((err) => console.error("Failed to load WebviewWindow:", err));
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

    setLoading(true);
    try {
      const filePaths = [...new Set(searchResults().map((r) => r.path))];
      const res = await ipc.searchAndReplace(q, rep, filePaths, caseSensitive());
      setReplaceResults(res);
      notifyFilesReloaded(res.map((r) => r.path));
      await executeSearch();
    } catch (e) {
      setSearchError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function replaceInFile(filePath: string) {
    const q = searchQuery().trim();
    const rep = replacement();
    if (!q) return;
    try {
      await ipc.searchAndReplace(q, rep, [filePath], caseSensitive());
      notifyFilesReloaded([filePath]);
      await executeSearch();
    } catch (e) {
      setSearchError(String(e));
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
      setSearchError(String(e));
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
      setSearchError(String(e));
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

  const sortedGroups = createMemo((): GroupedResult[] => {
    const groups = [...groupedResults()];
    const mode = sortMode();
    const cmp = (() => {
      switch (mode) {
        case "name-asc":
          return (a: GroupedResult, b: GroupedResult) =>
            a.file_name.localeCompare(b.file_name);
        case "name-desc":
          return (a: GroupedResult, b: GroupedResult) =>
            b.file_name.localeCompare(a.file_name);
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
    return groups;
  });

  function activeSortLabel(): string {
    return SORT_OPTIONS.find((o) => o.value === sortMode())?.label ?? "Sort";
  }

  return (
    <div class="search-panel">
      <div class="search-panel__input-row">
        <div class="search-panel__input-wrap">
          <input
            ref={(el) => (inputRef = el)}
            class="search-panel__input"
            type="text"
            placeholder="Search vault..."
            value={searchQuery()}
            onInput={(e) => handleInput(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => {
              if (!searchQuery().trim()) setShowHints(true);
            }}
            onBlur={() => {
              setTimeout(() => setShowHints(false), 150);
            }}
            autofocus
          />
          <Show when={searchQuery().length > 0}>
            <button
              class="search-panel__clear"
              onMouseDown={(e) => {
                e.preventDefault();
                clearQuery();
              }}
              title="Clear search"
              aria-label="Clear search"
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
          title="Case sensitive"
          aria-pressed={caseSensitive()}
        >
          <CaseSensitive size={16} />
        </button>
        <button
          class={`icon-btn ${showSettings() ? "icon-btn--active" : ""}`}
          onClick={() => setShowSettings(!showSettings())}
          title="Search options"
          aria-pressed={showSettings()}
        >
          <Settings2 size={16} />
        </button>
        <button
          class={`icon-btn ${showReplace() ? "icon-btn--active" : ""}`}
          onClick={() => setShowReplace(!showReplace())}
          title="Toggle replace"
          aria-pressed={showReplace()}
        >
          <Replace size={16} />
        </button>
      </div>

      <Show when={showHints()}>
        <div class="search-panel__hints" onMouseDown={(e) => e.preventDefault()}>
          <div class="search-panel__hints-title">Search options</div>
          <For each={FILTER_HINTS}>
            {(hint) => (
              <button
                class="search-panel__hint"
                onClick={() => insertHint(hint)}
                title={hint.description}
              >
                <span class="search-panel__hint-prefix">{hint.prefix}</span>
                <span class="search-panel__hint-desc">{hint.description}</span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={showSettings()}>
        <div class="search-panel__settings">
          <label class="search-panel__setting">
            <span>Collapse results</span>
            <input
              type="checkbox"
              checked={collapseResults()}
              onChange={(e) => setCollapseResults(e.currentTarget.checked)}
            />
          </label>
          <label class="search-panel__setting">
            <span>Show more context</span>
            <input
              type="checkbox"
              checked={showMoreContext()}
              onChange={(e) => setShowMoreContext(e.currentTarget.checked)}
            />
          </label>
          <label class="search-panel__setting">
            <span>Use regex</span>
            <input
              type="checkbox"
              checked={useRegex()}
              onChange={(e) => {
                setUseRegex(e.currentTarget.checked);
                executeSearch();
              }}
            />
          </label>
        </div>
      </Show>

      <Show when={showReplace()}>
        <div class="search-panel__replace-row">
          <input
            class="search-panel__input"
            type="text"
            placeholder="Replace with..."
            value={replacement()}
            onInput={(e) => setReplacement(e.currentTarget.value)}
          />
          <button
            class="search-panel__replace-btn"
            onClick={replaceAll}
            title="Replace all"
            disabled={!searchQuery().trim() || loading()}
          >
            All
          </button>
        </div>
      </Show>

      <Show when={replaceResults()}>
        {(res) => (
          <div class="search-panel__replace-info">
            Replaced in {res().length} file{res().length !== 1 ? "s" : ""}
            ({res().reduce((sum, r) => sum + r.replacements, 0)} occurrences)
          </div>
        )}
      </Show>

      <div class="search-panel__status">
        <Show when={!indexReady()}>
          <span>{"Indexing vault…"}</span>
        </Show>
        <Show when={indexReady() && loading()}>
          <span>Searching...</span>
        </Show>
        <Show when={indexReady() && !loading() && searchQuery().trim()}>
          <span class="search-panel__status-count">
            {searchResultCount()} match{searchResultCount() !== 1 ? "es" : ""}
          </span>
          <button
            class="search-panel__overflow-btn"
            title="More actions"
            onClick={() => setShowOverflowMenu(!showOverflowMenu())}
          >
            {"…"}
          </button>
          <Show when={showOverflowMenu()}>
            <div
              class="context-menu search-panel__menu-anchored search-panel__menu-anchored--left"
              onMouseLeave={() => setShowOverflowMenu(false)}
            >
              <button
                class="context-menu__item"
                onClick={copyResultsToClipboard}
              >
                Copy search results
              </button>
              <button
                class="context-menu__item"
                onClick={bookmarkCurrentSearch}
              >
                Bookmark&hellip;
              </button>
            </div>
          </Show>
          <button
            class="search-panel__sort-btn"
            onClick={() => setShowSortMenu(!showSortMenu())}
            title="Sort order"
          >
            {activeSortLabel()} {"⌄"}
          </button>
          <Show when={showSortMenu()}>
            <div
              class="context-menu search-panel__menu-anchored search-panel__menu-anchored--right"
              onMouseLeave={() => setShowSortMenu(false)}
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
                    {opt.label}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>

      <Show when={searchError()}>
        <div class="search-panel__error">{searchError()}</div>
      </Show>

      <div class="search-panel__results">
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
                    title={expanded() ? "Collapse" : "Expand"}
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
                    {group.file_name}
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
                      title="Replace in this file"
                    >
                      Replace
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
              Open in new tab
            </button>
            <button
              class="context-menu__item"
              onClick={() => openInNewWindow(menu().result)}
            >
              Open in new window
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
}> = (props) => {
  const segments = () => {
    const text = props.text;
    const ranges = props.ranges;
    if (ranges.length === 0) return [{ text, highlight: false }];

    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
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
    <span class="search-panel__result-text">
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
