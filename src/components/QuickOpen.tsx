// Quick-open command palette (Ctrl+O).
// Fuzzy searches the notebox's notes by file name, `title`, and `zid`, and
// opens the selected one.

import {
  Component,
  createSignal,
  createMemo,
  createEffect,
  For,
  Show,
  on,
} from "solid-js";
import { fileList, type FileEntry } from "../stores/filelist";
import {
  fuzzyMatch,
  substringMatch,
  compareMatchKinds,
  type FuzzyMatch,
} from "../lib/fuzzy";
import { getNoteIdentifiers, type NoteIdentifiers } from "../lib/ipc";
import { normalizePath } from "../lib/paths";
import { compareName } from "../lib/sort";
import { openTab } from "../stores/tabs";
import { useI18n } from "../lib/i18n";
import { createHoverGuard } from "../lib/picker-hover";

interface QuickOpenProps {
  visible: boolean;
  onClose: () => void;
}

/** Which part of a note the query matched. */
type MatchField = "name" | "title" | "zid";

/** Name matches list ahead of title and zid matches of the same kind. */
const FIELD_RANK: Record<MatchField, number> = { name: 0, title: 1, zid: 1 };

interface ScoredEntry {
  entry: FileEntry;
  match: FuzzyMatch;
  field: MatchField;
  /** The text that matched; `match.ranges` index into it. */
  text: string;
}

/** Best first: match kind, then field (name before title/zid), then score. */
function compareScored(a: ScoredEntry, b: ScoredEntry): number {
  return (
    compareMatchKinds(a.match, b.match) ||
    FIELD_RANK[a.field] - FIELD_RANK[b.field] ||
    b.match.score - a.match.score
  );
}

/**
 * The best way `query` matches a note, or null if nothing does. The title
 * matches loosely like the name; the zid only as an unbroken run, since
 * loose matching of digits would hit nearly every timestamp-style zid. A
 * title or zid identical to the name is skipped so it doesn't repeat.
 */
function matchNote(
  query: string,
  entry: FileEntry,
  ids: NoteIdentifiers | undefined,
): ScoredEntry | null {
  const name = displayName(entry.name);
  const candidates: ScoredEntry[] = [];
  const add = (field: MatchField, text: string, match: FuzzyMatch | null) => {
    if (match) candidates.push({ entry, match, field, text });
  };

  add("name", name, fuzzyMatch(query, name));
  if (ids?.title && ids.title !== name) {
    add("title", ids.title, fuzzyMatch(query, ids.title));
  }
  if (ids?.zid && ids.zid !== name) {
    add("zid", ids.zid, substringMatch(query, ids.zid));
  }
  return candidates.sort(compareScored)[0] ?? null;
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
  const hover = createHoverGuard();

  // Each note's title and zid, keyed by normalized path. Fetched fresh from
  // the backend's in-memory index every time the picker opens (so it is never
  // stale) and dropped when it closes.
  const [identifiers, setIdentifiers] = createSignal(
    new Map<string, NoteIdentifiers>(),
  );
  createEffect(
    on(
      () => props.visible,
      (visible) => {
        if (!visible) {
          setIdentifiers(new Map());
          return;
        }
        getNoteIdentifiers()
          .then((list) =>
            setIdentifiers(new Map(list.map((i) => [normalizePath(i.path), i]))),
          )
          .catch(console.error);
      },
    ),
  );

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
            compareName(a.name, b.name),
        )
        .map((entry) => ({
          entry,
          match: { score: 0, ranges: [], kind: "substring" as const },
          field: "name" as const,
          text: displayName(entry.name),
        }));
    }

    // Names are matched (and later displayed) without the `.typ` suffix, so it
    // neither shows in the list nor catches fuzzy highlights.
    const ids = identifiers();
    const scored: ScoredEntry[] = [];
    for (const entry of files) {
      const m = matchNote(q, entry, ids.get(normalizePath(entry.path)));
      if (m) scored.push(m);
    }

    // Kind first: text that spells the query out in order beats text that
    // merely has those letters sprinkled through it, and text that *is* the
    // query tops both. Tiebreak by recency so equally-good matches list the
    // more recently edited note first.
    scored.sort(
      (a, b) =>
        compareScored(a, b) || b.entry.modified_time - a.entry.modified_time,
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

  /** Render a name, title, or zid with matched characters highlighted. */
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
                  onMouseMove={(e) => hover.move(e, () => setSelectedIndex(index()))}
                >
                  <span class="quick-open__result-name">
                    <HighlightedName
                      name={displayName(item.entry.name)}
                      ranges={item.field === "name" ? item.match.ranges : []}
                    />
                  </span>
                  <Show when={item.entry.folder}>
                    <span class="quick-open__result-folder">
                      {item.entry.folder}
                    </span>
                  </Show>
                  <Show when={item.field !== "name"}>
                    <span class="quick-open__result-matched-field">
                      <span class="badge">
                        {item.field === "title"
                          ? t("quickOpen.matchedTitle")
                          : t("quickOpen.matchedZid")}
                      </span>
                      <span>
                        <HighlightedName
                          name={item.text}
                          ranges={item.match.ranges}
                        />
                      </span>
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
