import { EditorView, ViewPlugin, type ViewUpdate, keymap } from "@codemirror/view";
import { type Extension, Prec } from "@codemirror/state";
import { fuzzyMatch } from "../../lib/fuzzy";
import * as ipc from "../../lib/ipc";
import type { BibEntry } from "../../lib/types";

interface SuggestState {
  active: boolean;
  from: number;
  query: string;
}

const EMPTY: SuggestState = { active: false, from: 0, query: "" };

let popup: HTMLElement | null = null;
let selectedIndex = 0;
let currentState: SuggestState = EMPTY;
let filteredItems: BibEntry[] = [];
let cachedEntries: BibEntry[] | null = null;
let cacheTime = 0;
const CACHE_TTL = 30_000;

// After accepting a suggestion, suppress the popup until the cursor leaves
// the just-inserted range. Time-based suppression mis-fires on slow renders
// (popup re-opens) and fast typists (popup stays gone). Position-based gives
// the right answer regardless of timing.
let suppressedRange: { from: number; to: number } | null = null;

let preview: HTMLElement | null = null;

function getPopup(): HTMLElement {
  if (!popup) {
    popup = document.createElement("div");
    popup.className = "wikilink-suggest";
    popup.style.display = "none";
    document.body.appendChild(popup);
  }
  return popup;
}

function getPreview(): HTMLElement {
  if (!preview) {
    preview = document.createElement("div");
    preview.className = "citation-suggest-preview";
    preview.style.display = "none";
    document.body.appendChild(preview);
  }
  return preview;
}

function updatePreview(entry: BibEntry | undefined) {
  const el = getPreview();
  if (!entry) { el.style.display = "none"; return; }

  el.innerHTML = "";

  const authors = entry.authors.length > 3
    ? entry.authors.slice(0, 3).join(", ") + " et al."
    : entry.authors.length > 0
      ? entry.authors.join(", ")
      : "Unknown author";
  const authorsEl = document.createElement("div");
  authorsEl.className = "citation-suggest-preview__authors";
  authorsEl.textContent = authors;
  el.appendChild(authorsEl);

  if (entry.year) {
    const yearEl = document.createElement("div");
    yearEl.className = "citation-suggest-preview__year";
    yearEl.textContent = `(${entry.year})`;
    el.appendChild(yearEl);
  }

  const titleEl = document.createElement("div");
  titleEl.className = "citation-suggest-preview__title";
  titleEl.textContent = entry.title;
  el.appendChild(titleEl);

  if (entry.entry_type) {
    const typeEl = document.createElement("div");
    typeEl.className = "citation-suggest-preview__type";
    typeEl.textContent = entry.entry_type;
    el.appendChild(typeEl);
  }

  const popupEl = getPopup();
  const rect = popupEl.getBoundingClientRect();
  el.style.position = "fixed";
  el.style.top = `${rect.top}px`;
  el.style.left = `${rect.right - 1}px`;
  el.style.display = "block";
  popupEl.classList.add("has-preview");
}

function hidePopup() {
  const el = getPopup();
  el.style.display = "none";
  el.innerHTML = "";
  el.classList.remove("has-preview");
  const prev = getPreview();
  prev.style.display = "none";
  prev.innerHTML = "";
  filteredItems = [];
  selectedIndex = 0;
  currentState = EMPTY;
}

function isPopupVisible(): boolean {
  return !!popup && popup.style.display !== "none";
}

async function getEntries(): Promise<BibEntry[]> {
  if (cachedEntries && Date.now() - cacheTime < CACHE_TTL) return cachedEntries;
  try {
    cachedEntries = await ipc.getBibliographyEntries();
    cacheTime = Date.now();
  } catch {
    cachedEntries = [];
  }
  return cachedEntries;
}

function detectCitationContext(view: EditorView): SuggestState {
  const { from: cursor } = view.state.selection.main;
  const line = view.state.doc.lineAt(cursor);
  const textBefore = view.state.doc.sliceString(line.from, cursor);

  const atIdx = textBefore.lastIndexOf("@");
  if (atIdx < 0) return EMPTY;

  const query = textBefore.slice(atIdx + 1);
  if (/\s/.test(query)) return EMPTY;

  // Typst (and the backend's `extract_citations`) treat `@key` as a citation
  // wherever it appears — including right after a letter, digit, or a previous
  // citation's last character (`@a@b`, `word@key`). The only `@` that is *not*
  // a citation is an escaped one: a `\` before the `@` is `\@`, a literal
  // at-sign. Skipping it keeps us in step with the backend, and avoids the
  // failure mode where an `@` lands just after a line's hidden trailing
  // soft-break `\` — treating that as a citation would insert `\@key`, escaping
  // the citation and making the `\` render visibly.
  const charBefore = atIdx > 0 ? textBefore[atIdx - 1] : " ";
  if (charBefore === "\\") return EMPTY;

  return { active: true, from: line.from + atIdx, query };
}

function formatAuthors(authors: string[]): string {
  if (authors.length === 0) return "";
  if (authors.length === 1) return authors[0];
  if (authors.length === 2) return `${authors[0]} & ${authors[1]}`;
  return `${authors[0]} et al.`;
}

async function showPopup(view: EditorView, state: SuggestState) {
  const el = getPopup();
  currentState = state;

  const entries = await getEntries();
  if (entries.length === 0) {
    el.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "wikilink-suggest__empty";
    empty.textContent = "No bibliography entries found";
    el.appendChild(empty);
    positionPopup(view, state, el);
    return;
  }

  const query = state.query;
  const scored: { entry: BibEntry; score: number }[] = [];
  for (const entry of entries) {
    if (query === "") {
      scored.push({ entry, score: 0 });
    } else {
      const searchText = `${entry.key} ${entry.title} ${entry.authors.join(" ")}`;
      const m = fuzzyMatch(query, searchText);
      if (m) scored.push({ entry, score: m.score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  filteredItems = scored.slice(0, 30).map((s) => s.entry);

  if (filteredItems.length === 0) {
    el.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "wikilink-suggest__empty";
    empty.textContent = "No matching references";
    el.appendChild(empty);
    positionPopup(view, state, el);
    return;
  }

  selectedIndex = 0;
  el.innerHTML = "";

  for (let i = 0; i < filteredItems.length; i++) {
    const entry = filteredItems[i];
    const row = document.createElement("div");
    row.className = "wikilink-suggest__item";
    if (i === 0) row.classList.add("is-selected");

    const titleSpan = document.createElement("span");
    titleSpan.className = "wikilink-suggest__name";
    const titleShort = entry.title.length > 60
      ? entry.title.slice(0, 57) + "..."
      : entry.title;
    titleSpan.textContent = titleShort;

    const authorSpan = document.createElement("span");
    authorSpan.className = "wikilink-suggest__folder";
    const authors = formatAuthors(entry.authors);
    const year = entry.year ?? "";
    authorSpan.textContent = `${authors}${year ? ` (${year})` : ""}`;

    row.appendChild(titleSpan);
    row.appendChild(authorSpan);

    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      acceptItem(view, state, entry);
    });
    el.appendChild(row);
  }

  positionPopup(view, state, el);
  updatePreview(filteredItems[0]);
}

function positionPopup(view: EditorView, state: SuggestState, el: HTMLElement) {
  const coords = view.coordsAtPos(state.from);
  if (coords) {
    el.style.left = `${coords.left}px`;
    el.style.top = `${coords.bottom + 4}px`;
  }
  el.style.display = "block";
}

function acceptItem(view: EditorView, state: SuggestState, entry: BibEntry) {
  const cursor = view.state.selection.main.from;
  const insert = `@${entry.key}`;
  // Set suppression *before* dispatch: the dispatch synchronously runs the
  // tracker's `update`, which would otherwise re-detect the `@key` context and
  // requeue the popup. With the range already set, that update closes the popup
  // instead of reopening it — so a single Enter both inserts and dismisses.
  suppressedRange = { from: state.from, to: state.from + insert.length };
  view.dispatch({
    changes: { from: state.from, to: cursor, insert },
    selection: { anchor: state.from + insert.length },
  });
  hidePopup();
}

function updateSelection(delta: number) {
  const el = getPopup();
  const items = el.querySelectorAll(".wikilink-suggest__item");
  if (items.length === 0) return;

  items[selectedIndex]?.classList.remove("is-selected");
  selectedIndex = (selectedIndex + delta + filteredItems.length) % filteredItems.length;
  items[selectedIndex]?.classList.add("is-selected");
  (items[selectedIndex] as HTMLElement)?.scrollIntoView({ block: "nearest" });
  updatePreview(filteredItems[selectedIndex]);
}

const suggestKeyHandler = Prec.highest(keymap.of([
  {
    key: "ArrowDown",
    run: () => { if (!isPopupVisible()) return false; updateSelection(1); return true; },
  },
  {
    key: "ArrowUp",
    run: () => { if (!isPopupVisible()) return false; updateSelection(-1); return true; },
  },
  {
    key: "Enter",
    run: (view) => {
      if (!isPopupVisible()) return false;
      const item = filteredItems[selectedIndex];
      if (item) acceptItem(view, currentState, item);
      return true;
    },
  },
  {
    key: "Tab",
    run: (view) => {
      if (!isPopupVisible()) return false;
      const item = filteredItems[selectedIndex];
      if (item) acceptItem(view, currentState, item);
      return true;
    },
  },
  {
    key: "Escape",
    run: () => {
      if (!isPopupVisible()) return false;
      hidePopup();
      return true;
    },
  },
]));

const suggestTracker = ViewPlugin.fromClass(
  class {
    private state: SuggestState = EMPTY;
    // Handle of the deferred `showPopup` so a later update can cancel it. The
    // popup is opened on the next animation frame (to coalesce bursts of
    // keystrokes); without cancellation, the frame scheduled by the final
    // keystroke before Enter would fire *after* `acceptItem` has already
    // inserted the citation and hidden the popup — reopening it and forcing
    // the user to press Enter a second time to dismiss it.
    private pendingFrame = 0;

    constructor(view: EditorView) {
      this.state = detectCitationContext(view);
    }

    update(update: ViewUpdate) {
      if (!update.docChanged && !update.selectionSet) return;
      this.state = detectCitationContext(update.view);

      // Clear post-accept suppression once the cursor moves outside the
      // inserted range — that's the unambiguous signal that the user is
      // back to free-form editing.
      if (suppressedRange) {
        const head = update.view.state.selection.main.head;
        if (head < suppressedRange.from || head > suppressedRange.to) {
          suppressedRange = null;
        }
      }

      // Drop any frame queued by an earlier update; this update supersedes it.
      if (this.pendingFrame) {
        cancelAnimationFrame(this.pendingFrame);
        this.pendingFrame = 0;
      }

      if (this.state.active && !suppressedRange) {
        const view = update.view;
        const state = this.state;
        this.pendingFrame = requestAnimationFrame(() => {
          this.pendingFrame = 0;
          // Re-check at frame time: an intervening accept may have set
          // `suppressedRange`, in which case the popup must stay closed.
          if (suppressedRange) return;
          showPopup(view, state);
        });
      } else {
        hidePopup();
      }
    }

    destroy() {
      if (this.pendingFrame) cancelAnimationFrame(this.pendingFrame);
      hidePopup();
    }
  },
);

/** Synchronous read of the cached bibliography keys. Returns an empty
 *  set before the first fetch completes (~30 s TTL cache). */
export function getCachedBibKeys(): Set<string> {
  if (!cachedEntries) {
    // Kick off a background fetch so the next call has data.
    void getEntries();
    return new Set();
  }
  return new Set(cachedEntries.map((e) => e.key));
}

export const citationSuggest: Extension = [suggestKeyHandler, suggestTracker];
