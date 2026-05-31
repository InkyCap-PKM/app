import { errorText } from "../lib/errors";
import { Component, createSignal, createResource, createMemo, For, Show } from "solid-js";
import type { BibEntry } from "../lib/types";
import * as ipc from "../lib/ipc";
import { fuzzyMatch } from "../lib/fuzzy";
import { activeEditorView } from "../stores/editor";

interface CitationPickerProps {
  visible: boolean;
  onClose: () => void;
  onSelect?: (entry: BibEntry) => void;
  placeholder?: string;
  /** Optional pre-filter applied before searching. Used by the
   * "import note text" picker to restrict the list to entries that
   * actually have notes attached. */
  filter?: (entry: BibEntry) => boolean;
}

const PAGE_SIZE = 50;

const CitationPicker: Component<CitationPickerProps> = (props) => {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [visibleCount, setVisibleCount] = createSignal(PAGE_SIZE);
  const [loadError, setLoadError] = createSignal<string | null>(null);

  const [entries] = createResource(
    () => props.visible,
    async (visible) => {
      if (!visible) return [];
      setLoadError(null);
      try {
        return await ipc.getBibliographyEntries();
      } catch (err) {
        console.error("Failed to load bibliography entries:", err);
        setLoadError(errorText(err));
        return [];
      }
    },
  );

  const filteredEntries = createMemo(() => {
    const all = entries() ?? [];
    const f = props.filter;
    return f ? all.filter(f) : all;
  });

  const allResults = createMemo(() => {
    const all = filteredEntries();
    const q = query().trim().toLowerCase();
    if (q.length === 0) return all;

    const scored: { entry: BibEntry; score: number }[] = [];
    for (const entry of all) {
      const searchText = `${entry.key} ${entry.title} ${entry.authors.join(" ")} ${entry.year ?? ""}`;
      const m = fuzzyMatch(q, searchText);
      if (m) {
        scored.push({ entry, score: m.score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.entry);
  });

  const results = createMemo(() => allResults().slice(0, visibleCount()));

  function handleScroll(e: Event) {
    const el = e.target as HTMLElement;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 50) {
      if (visibleCount() < allResults().length) {
        setVisibleCount((n) => n + PAGE_SIZE);
      }
    }
  }

  function handleSelect(entry: BibEntry) {
    if (props.onSelect) {
      setQuery("");
      setSelectedIndex(0);
      setVisibleCount(PAGE_SIZE);
      props.onSelect(entry);
      return;
    }
    const handle = activeEditorView();
    if (!handle) return;
    const view = handle.view;
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: `@${entry.key}` },
      selection: { anchor: from + entry.key.length + 1 },
    });
    view.focus();
    close();
  }

  function close() {
    setQuery("");
    setSelectedIndex(0);
    setVisibleCount(PAGE_SIZE);
    props.onClose();
  }

  function handleKeyDown(e: KeyboardEvent) {
    const list = results();

    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.min(selectedIndex() + 1, list.length - 1);
      setSelectedIndex(next);
      if (next >= visibleCount() - 5 && visibleCount() < allResults().length) {
        setVisibleCount((n) => n + PAGE_SIZE);
      }
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const item = list[selectedIndex()];
      if (item) handleSelect(item);
      return;
    }
  }

  function formatAuthors(authors: string[]): string {
    if (authors.length === 0) return "";
    if (authors.length <= 2) return authors.join(" & ");
    return `${authors[0]} et al.`;
  }

  function statusMessage(): string {
    if (entries.loading) return "Loading bibliography…";
    if (loadError()) return `Error: ${loadError()}`;
    const all = entries();
    if (!all || all.length === 0) return "No bibliography configured. Check Settings › Citations.";
    if (props.filter && filteredEntries().length === 0) {
      return "No references with notes attached.";
    }
    if (query().trim() && results().length === 0) return "No matching entries";
    return "";
  }

  return (
    <Show when={props.visible}>
      <div class="cmd-palette__overlay" onClick={close}>
        <div class="cmd-palette" onClick={(e) => e.stopPropagation()}>
          <input
            class="cmd-palette__input"
            type="text"
            placeholder={props.placeholder ?? "Search citations by key, title, or author..."}
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setSelectedIndex(0);
              setVisibleCount(PAGE_SIZE);
            }}
            onKeyDown={handleKeyDown}
            ref={(el) => setTimeout(() => el.focus(), 0)}
          />
          <div class="cmd-palette__results" onScroll={handleScroll}>
            <For each={results()}>
              {(entry, index) => (
                <div
                  class={`cmd-palette__result citation-picker__entry ${index() === selectedIndex() ? "cmd-palette__result--selected" : ""}`}
                  onClick={() => handleSelect(entry)}
                  onMouseEnter={() => setSelectedIndex(index())}
                >
                  <Show when={entry.title}>
                    <span class="citation-picker__title">{entry.title}</span>
                  </Show>
                  <div class="citation-picker__detail">
                    <Show when={entry.authors.length > 0 || entry.year}>
                      <span class="citation-picker__meta">
                        {formatAuthors(entry.authors)}
                        <Show when={entry.year}>{" "}({entry.year})</Show>
                      </span>
                    </Show>
                    <span class="citation-picker__key">@{entry.key}</span>
                  </div>
                </div>
              )}
            </For>
            <Show when={results().length === 0}>
              <div class="cmd-palette__empty">{statusMessage()}</div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default CitationPicker;
