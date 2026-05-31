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
import { useI18n } from "../lib/i18n";

interface QuickOpenProps {
  visible: boolean;
  onClose: () => void;
}

interface ScoredEntry {
  entry: FileEntry;
  match: FuzzyMatch;
}

/** Rows rendered initially, and added each time the user scrolls (or arrows)
 *  near the bottom. The full result set is never capped — this only bounds how
 *  many rows live in the DOM at once, so a notebox of thousands of notes stays
 *  responsive while the user can still scroll through every match. */
const PAGE_SIZE = 50;

/** A note's name as shown to the user — without the `.typ` extension. */
function displayName(name: string): string {
  return name.replace(/\.typ$/i, "");
}

/** Rows the Page Up/Down keys jump by. */
const PAGE_JUMP = 10;

const QuickOpen: Component<QuickOpenProps> = (props) => {
  const t = useI18n();
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  // How many of the (uncapped) results are currently rendered. Grows as the
  // user scrolls or arrows toward the end; reset to one page on every query.
  const [visibleCount, setVisibleCount] = createSignal(PAGE_SIZE);
  let resultsEl: HTMLDivElement | undefined;

  // Keep the selected row visible as the selection moves past either edge of
  // the scroll viewport. `block: "nearest"` scrolls the minimum amount. We
  // track the query (to snap back to the top on a new search) but deliberately
  // NOT the window size — growing it by scrolling must not yank the view back
  // to the selected row. `moveSelection` grows the window before setting the
  // index, so the target row is already rendered when this runs.
  createEffect(() => {
    const idx = selectedIndex();
    query(); // re-run on a new search so row 0 scrolls into view
    (resultsEl?.children[idx] as HTMLElement | undefined)?.scrollIntoView({
      block: "nearest",
    });
  });

  // Full, uncapped result set. Empty query → all notes most-recently-edited
  // first; non-empty query → fuzzy matches ordered by score.
  const results = createMemo((): ScoredEntry[] => {
    const q = query().trim();
    const files = fileList();

    if (q.length === 0) {
      // Browse mode: newest edits at the top, oldest at the bottom. A stable
      // tiebreak on name keeps notes with identical mtimes in a steady order.
      return files
        .slice()
        .sort(
          (a, b) =>
            b.modified_time - a.modified_time ||
            a.name.localeCompare(b.name),
        )
        .map((entry) => ({ entry, match: { score: 0, ranges: [] } }));
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

    // Primary: fuzzy score. Tiebreak by recency so equally-good matches list
    // the more recently edited note first.
    scored.sort(
      (a, b) =>
        b.match.score - a.match.score ||
        b.entry.modified_time - a.entry.modified_time,
    );
    // A file whose name (sans extension) is exactly the query jumps to the
    // top — the result the user almost certainly meant. The sort is stable,
    // so this only lifts the exact match; fuzzy order is otherwise kept.
    const ql = q.toLowerCase();
    const stem = (n: string) => displayName(n).trim().toLowerCase();
    scored.sort(
      (a, b) =>
        Number(stem(b.entry.name) === ql) - Number(stem(a.entry.name) === ql),
    );
    return scored;
  });

  // Only the first `visibleCount` rows are rendered; the rest load on demand.
  const visible = createMemo(() => results().slice(0, visibleCount()));

  // Move the selection, clamped to the full result set, and ensure the target
  // row is within the rendered window so it can scroll into view.
  function moveSelection(target: number) {
    const total = results().length;
    if (total === 0) return;
    const idx = Math.max(0, Math.min(target, total - 1));
    if (idx >= visibleCount()) {
      setVisibleCount(Math.min(total, idx + 1));
    }
    setSelectedIndex(idx);
  }

  // Reveal another page as the user scrolls near the bottom of the list.
  function onResultsScroll() {
    if (!resultsEl) return;
    const remaining =
      resultsEl.scrollHeight - resultsEl.scrollTop - resultsEl.clientHeight;
    if (remaining < 200 && visibleCount() < results().length) {
      setVisibleCount((c) => Math.min(results().length, c + PAGE_SIZE));
    }
  }

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
      moveSelection(selectedIndex() + 1);
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSelection(selectedIndex() - 1);
      return;
    }

    if (e.key === "PageDown") {
      e.preventDefault();
      moveSelection(selectedIndex() + PAGE_JUMP);
      return;
    }

    if (e.key === "PageUp") {
      e.preventDefault();
      moveSelection(selectedIndex() - PAGE_JUMP);
      return;
    }

    if (e.key === "Home") {
      e.preventDefault();
      moveSelection(0);
      return;
    }

    if (e.key === "End") {
      e.preventDefault();
      moveSelection(list.length - 1);
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
            placeholder={t("quickOpen.placeholder")}
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setSelectedIndex(0);
              setVisibleCount(PAGE_SIZE);
            }}
            onKeyDown={handleKeyDown}
            ref={(el) => setTimeout(() => el.focus(), 0)}
          />
          <div
            class="quick-open__results"
            ref={resultsEl}
            onScroll={onResultsScroll}
          >
            <For each={visible()}>
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
              <div class="quick-open__empty">{t("quickOpen.noMatching")}</div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default QuickOpen;
