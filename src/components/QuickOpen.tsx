// Quick-open command palette (Ctrl+O).
// Fuzzy searches the notebox file list and opens the selected file.

import {
  Component,
  createSignal,
  createMemo,
  createEffect,
  For,
  Show,
} from "solid-js";
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

/** A note's name as shown to the user — without the `.typ` extension. */
function displayName(name: string): string {
  return name.replace(/\.typ$/i, "");
}

/** Rows the Page Up/Down keys jump by. */
const PAGE_JUMP = 10;

const QuickOpen: Component<QuickOpenProps> = (props) => {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let resultsEl: HTMLDivElement | undefined;

  // Keep the selected row visible as the selection moves past either edge
  // of the scroll viewport. `block: "nearest"` scrolls the minimum amount.
  createEffect(() => {
    const idx = selectedIndex();
    results(); // re-run when the result set changes, not only the index
    (resultsEl?.children[idx] as HTMLElement | undefined)?.scrollIntoView({
      block: "nearest",
    });
  });

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

    // Match (and later display) against the extension-less name, so the
    // `.typ` suffix neither shows in the list nor catches fuzzy highlights.
    const scored: ScoredEntry[] = [];
    for (const entry of files) {
      const m = fuzzyMatch(q, displayName(entry.name));
      if (m) {
        scored.push({ entry, match: m });
      }
    }

    scored.sort((a, b) => b.match.score - a.match.score);
    // A file whose name (sans extension) is exactly the query jumps to the
    // top — the result the user almost certainly meant. The sort is stable,
    // so this only lifts the exact match; fuzzy order is otherwise kept.
    const ql = q.toLowerCase();
    const stem = (n: string) => displayName(n).trim().toLowerCase();
    scored.sort(
      (a, b) =>
        Number(stem(b.entry.name) === ql) - Number(stem(a.entry.name) === ql),
    );
    return scored.slice(0, MAX_RESULTS);
  });

  function selectFile(entry: FileEntry) {
    openTab({
      type: "file",
      title: displayName(entry.name),
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

    if (e.key === "PageDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + PAGE_JUMP, list.length - 1));
      return;
    }

    if (e.key === "PageUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - PAGE_JUMP, 0));
      return;
    }

    if (e.key === "Home") {
      e.preventDefault();
      setSelectedIndex(0);
      return;
    }

    if (e.key === "End") {
      e.preventDefault();
      setSelectedIndex(list.length - 1);
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
          <div class="quick-open__results" ref={resultsEl}>
            <For each={results()}>
              {(item, index) => (
                <div
                  class={`quick-open__result ${index() === selectedIndex() ? "quick-open__result--selected" : ""}`}
                  onClick={() => selectFile(item.entry)}
                  onMouseEnter={() => setSelectedIndex(index())}
                >
                  <span class="quick-open__result-name">
                    <HighlightedName
                      name={displayName(item.entry.name)}
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
