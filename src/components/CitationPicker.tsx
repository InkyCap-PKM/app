import { Component, createSignal, createResource, createMemo, For, Show } from "solid-js";
import type { BibEntry } from "../lib/types";
import * as ipc from "../lib/ipc";
import { fuzzyMatch } from "../lib/fuzzy";
import { activeEditorView } from "../stores/editor";

interface CitationPickerProps {
  visible: boolean;
  onClose: () => void;
}

const MAX_RESULTS = 50;

const CitationPicker: Component<CitationPickerProps> = (props) => {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);

  const [entries] = createResource(
    () => props.visible,
    async (visible) => {
      if (!visible) return [];
      try {
        return await ipc.getBibliographyEntries();
      } catch (err) {
        console.error("Failed to load bibliography entries:", err);
        throw err;
      }
    },
  );

  const results = createMemo(() => {
    const all = entries() ?? [];
    const q = query().trim().toLowerCase();
    if (q.length === 0) return all.slice(0, MAX_RESULTS);

    const scored: { entry: BibEntry; score: number }[] = [];
    for (const entry of all) {
      const searchText = `${entry.key} ${entry.title} ${entry.authors.join(" ")} ${entry.year ?? ""}`;
      const m = fuzzyMatch(q, searchText);
      if (m) {
        scored.push({ entry, score: m.score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map((s) => s.entry);
  });

  function insertCitation(key: string) {
    const handle = activeEditorView();
    if (!handle) return;
    const view = handle.view;
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: `@${key}` },
      selection: { anchor: from + key.length + 1 },
    });
    view.focus();
    close();
  }

  function close() {
    setQuery("");
    setSelectedIndex(0);
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
      setSelectedIndex((i) => Math.min(i + 1, list.length - 1));
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
      if (item) insertCitation(item.key);
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
    if (entries.error) return `Error: ${entries.error}`;
    const all = entries();
    if (!all || all.length === 0) return "No bibliography configured. Check Settings › Citations.";
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
            placeholder="Search citations by key, title, or author..."
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            ref={(el) => setTimeout(() => el.focus(), 0)}
          />
          <div class="cmd-palette__results">
            <For each={results()}>
              {(entry, index) => (
                <div
                  class={`cmd-palette__result ${index() === selectedIndex() ? "cmd-palette__result--selected" : ""}`}
                  onClick={() => insertCitation(entry.key)}
                  onMouseEnter={() => setSelectedIndex(index())}
                >
                  <span class="citation-picker__key">@{entry.key}</span>
                  <span class="citation-picker__info">
                    <Show when={entry.title}>
                      <span class="citation-picker__title">{entry.title}</span>
                    </Show>
                    <Show when={entry.authors.length > 0 || entry.year}>
                      <span class="citation-picker__meta">
                        {formatAuthors(entry.authors)}
                        <Show when={entry.year}>{" "}({entry.year})</Show>
                      </span>
                    </Show>
                  </span>
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
