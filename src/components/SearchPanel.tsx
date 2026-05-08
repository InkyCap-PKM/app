// Search panel shown in the left sidebar "search" mode.
// Supports full-text vault search, case-sensitive toggle, regex toggle,
// and search-and-replace functionality.

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
import type { SearchResult, ReplaceResult } from "../lib/types";
import * as ipc from "../lib/ipc";
import { openTab } from "../stores/tabs";
import { indexReady } from "../stores/vault";

const SearchPanel: Component = () => {
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<SearchResult[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [resultCount, setResultCount] = createSignal(0);

  // Replace state
  const [showReplace, setShowReplace] = createSignal(false);
  const [replacement, setReplacement] = createSignal("");
  const [replaceResults, setReplaceResults] = createSignal<ReplaceResult[] | null>(null);

  // Search options
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [useRegex, setUseRegex] = createSignal(false);

  let searchTimeout: ReturnType<typeof setTimeout> | undefined;

  onCleanup(() => {
    if (searchTimeout) clearTimeout(searchTimeout);
  });

  // External query requests — the Tags and Properties panes dispatch
  // `inkycap:open-search` with `{ detail: { query } }` when the user
  // clicks an item. Populate the box and run the search immediately so
  // the filter is visible and pre-applied.
  onMount(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ query?: string }>).detail;
      if (!detail?.query) return;
      setQuery(detail.query);
      if (searchTimeout) clearTimeout(searchTimeout);
      executeSearch();
    };
    document.addEventListener("inkycap:open-search", handler);
    onCleanup(() => document.removeEventListener("inkycap:open-search", handler));
  });

  // Re-run the active query as soon as background indexing finishes, so
  // anyone who started typing during indexing sees results without having
  // to touch the search box again.
  createEffect(() => {
    if (indexReady() && query().trim()) {
      executeSearch();
    }
  });

  function buildQuery(): string {
    let q = query().trim();
    if (!q) return "";

    // Wrap in regex syntax if regex mode is on
    if (useRegex()) {
      q = `/${q}/`;
    }

    return q;
  }

  async function executeSearch() {
    const q = buildQuery();
    if (!q) {
      setResults([]);
      setResultCount(0);
      setError(null);
      return;
    }

    // The search engine isn't built yet — defer until `indexReady` flips,
    // at which point the createEffect below will re-trigger this function.
    if (!indexReady()) {
      setResults([]);
      setResultCount(0);
      return;
    }

    setLoading(true);
    setError(null);
    setReplaceResults(null);

    try {
      const res = await ipc.vaultSearch(q, 200);
      setResults(res);
      setResultCount(res.length);
    } catch (e) {
      setError(String(e));
      setResults([]);
      setResultCount(0);
    } finally {
      setLoading(false);
    }
  }

  function handleInput(value: string) {
    setQuery(value);
    // Debounce search
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      executeSearch();
    }, 300);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      if (searchTimeout) clearTimeout(searchTimeout);
      executeSearch();
    }
  }

  function openResult(result: SearchResult) {
    // result.file_name is the stem; the canonical path carries the actual
    // extension, so prefer its basename for the tab title.
    const title = result.path.split(/[/\\]/).pop() ?? result.file_name;
    openTab({
      type: "file",
      title,
      path: result.path,
    });
  }

  async function replaceAll() {
    const q = query().trim();
    const rep = replacement();
    if (!q) return;

    setLoading(true);
    try {
      const filePaths = results().map((r) => r.path);
      const res = await ipc.searchAndReplace(q, rep, filePaths, caseSensitive());
      setReplaceResults(res);
      // Re-run search to show updated results
      await executeSearch();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function replaceInFile(filePath: string) {
    const q = query().trim();
    const rep = replacement();
    if (!q) return;

    try {
      await ipc.searchAndReplace(q, rep, [filePath], caseSensitive());
      // Re-run search
      await executeSearch();
    } catch (e) {
      setError(String(e));
    }
  }

  interface GroupedResult {
    path: string;
    file_name: string;
    matches: SearchResult[];
  }

  const groupedResults = createMemo((): GroupedResult[] => {
    const groups: GroupedResult[] = [];
    const index = new Map<string, GroupedResult>();
    for (const r of results()) {
      let group = index.get(r.path);
      if (!group) {
        group = { path: r.path, file_name: r.file_name, matches: [] };
        index.set(r.path, group);
        groups.push(group);
      }
      group.matches.push(r);
    }
    return groups;
  });

  return (
    <div class="search-panel">
      <div class="search-panel__input-row">
        <input
          class="search-panel__input"
          type="text"
          placeholder="Search vault..."
          value={query()}
          onInput={(e) => handleInput(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          autofocus
        />
        <button
          class={`search-panel__toggle ${caseSensitive() ? "search-panel__toggle--active" : ""}`}
          onClick={() => {
            setCaseSensitive(!caseSensitive());
            executeSearch();
          }}
          title="Case sensitive"
        >
          Aa
        </button>
        <button
          class={`search-panel__toggle ${useRegex() ? "search-panel__toggle--active" : ""}`}
          onClick={() => {
            setUseRegex(!useRegex());
            executeSearch();
          }}
          title="Use regex"
        >
          .*
        </button>
        <button
          class={`search-panel__toggle ${showReplace() ? "search-panel__toggle--active" : ""}`}
          onClick={() => setShowReplace(!showReplace())}
          title="Toggle replace"
        >
          &#x21C4;
        </button>
      </div>

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
            disabled={!query().trim() || loading()}
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
          <span>{"Indexing vault\u2026"}</span>
        </Show>
        <Show when={indexReady() && loading()}>
          <span>Searching...</span>
        </Show>
        <Show when={indexReady() && !loading() && query().trim()}>
          <span>{resultCount()} result{resultCount() !== 1 ? "s" : ""}</span>
        </Show>
      </div>

      <Show when={error()}>
        <div class="search-panel__error">{error()}</div>
      </Show>

      <div class="search-panel__results">
        <For each={groupedResults()}>
          {(group) => (
            <div class="search-panel__file-group">
              <div class="search-panel__result-file" onClick={() => openResult(group.matches[0])}>
                {group.file_name}
                <span class="search-panel__match-count">{group.matches.length}</span>
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
              <For each={group.matches}>
                {(result) => (
                  <div class="search-panel__result" onClick={() => openResult(result)}>
                    <div class="search-panel__result-line">
                      <span class="search-panel__result-lineno">
                        {result.line_number}:
                      </span>
                      <HighlightedLine
                        text={result.line_text}
                        ranges={result.match_ranges}
                      />
                    </div>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};

/// Render a line of text with match ranges highlighted.
const HighlightedLine: Component<{
  text: string;
  ranges: [number, number][];
}> = (props) => {
  const segments = () => {
    const text = props.text;
    const ranges = props.ranges;
    if (ranges.length === 0) return [{ text, highlight: false }];

    // Sort ranges by start position
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
