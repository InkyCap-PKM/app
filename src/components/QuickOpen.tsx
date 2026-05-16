// Quick-open command palette (Ctrl+O).
// Fuzzy searches the notebox file list and opens the selected file.

import { Component, createSignal, createMemo, For, Show } from "solid-js";
import { fileList, type FileEntry } from "../stores/filelist";
import { fuzzyMatch, type FuzzyMatch } from "../lib/fuzzy";
import { openTab } from "../stores/tabs";

interface QuickOpenProps {
  visible: boolean;
  onClose: () => void;
}

interface ScoredEntry {
  entry: FileEntry;
  match: FuzzyMatch;
}

const MAX_RESULTS = 20;

const QuickOpen: Component<QuickOpenProps> = (props) => {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);

  // Fuzzy match results, sorted by score descending
  const results = createMemo((): ScoredEntry[] => {
    const q = query().trim();
    const files = fileList();

    if (q.length === 0) {
      // Show recent or all files (first N)
      return files.slice(0, MAX_RESULTS).map((entry) => ({
        entry,
        match: { score: 0, ranges: [] },
      }));
    }

    const scored: ScoredEntry[] = [];
    for (const entry of files) {
      const m = fuzzyMatch(q, entry.name);
      if (m) {
        scored.push({ entry, match: m });
      }
    }

    scored.sort((a, b) => b.match.score - a.match.score);
    return scored.slice(0, MAX_RESULTS);
  });

  function selectFile(entry: FileEntry) {
    openTab({
      type: "file",
      title: entry.name.replace(/\.[^.]+$/, ""),
      path: entry.path,
    });
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
      const idx = selectedIndex();
      if (list[idx]) {
        selectFile(list[idx].entry);
      }
      return;
    }
  }

  /** Render a filename with matched characters highlighted. */
  function HighlightedName(props: { name: string; ranges: [number, number][] }) {
    if (props.ranges.length === 0) return <>{props.name}</>;

    const parts: { text: string; highlight: boolean }[] = [];
    let pos = 0;

    for (const [start, end] of props.ranges) {
      if (start > pos) {
        parts.push({ text: props.name.slice(pos, start), highlight: false });
      }
      parts.push({ text: props.name.slice(start, end), highlight: true });
      pos = end;
    }

    if (pos < props.name.length) {
      parts.push({ text: props.name.slice(pos), highlight: false });
    }

    return (
      <>
        <For each={parts}>
          {(part) =>
            part.highlight ? (
              <span class="quick-open__highlight">{part.text}</span>
            ) : (
              <>{part.text}</>
            )
          }
        </For>
      </>
    );
  }

  return (
    <Show when={props.visible}>
      <div class="quick-open__overlay" onClick={close}>
        <div class="quick-open" onClick={(e) => e.stopPropagation()}>
          <input
            class="quick-open__input"
            type="text"
            placeholder="Search files..."
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            ref={(el) => setTimeout(() => el.focus(), 0)}
          />
          <div class="quick-open__results">
            <For each={results()}>
              {(item, index) => (
                <div
                  class={`quick-open__result ${index() === selectedIndex() ? "quick-open__result--selected" : ""}`}
                  onClick={() => selectFile(item.entry)}
                  onMouseEnter={() => setSelectedIndex(index())}
                >
                  <span class="quick-open__result-name">
                    <HighlightedName
                      name={item.entry.name}
                      ranges={item.match.ranges}
                    />
                  </span>
                  <Show when={item.entry.folder}>
                    <span class="quick-open__result-folder">
                      {item.entry.folder}
                    </span>
                  </Show>
                </div>
              )}
            </For>
            <Show when={results().length === 0 && query().trim().length > 0}>
              <div class="quick-open__empty">No matching files</div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default QuickOpen;
