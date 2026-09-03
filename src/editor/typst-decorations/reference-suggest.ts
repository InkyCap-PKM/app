import { EditorView, ViewPlugin, type ViewUpdate, keymap } from "@codemirror/view";
import { type Extension, Prec } from "@codemirror/state";
import { substringMatch } from "../../lib/fuzzy";
import { positionPopupAtAnchor } from "./popup-position";
import * as ipc from "../../lib/ipc";
import { t } from "../../lib/i18n";
import type { BibEntry } from "../../lib/types";
import { scanDocumentLabels, type DocLabel, type LabelKind } from "./document-labels";
import { canReferenceWithAt, documentNumbersHeadings, linkReference } from "./reference-form";

// The `@` popup. In Typst `@` is the *universal reference* operator — it points
// at any `<label>` (heading, figure, equation, table) as well as bibliography
// entries; a citation is just one kind of reference target. So this popup lists
// citations first (the common academic action, and the historical behaviour),
// then the document's labelled targets grouped by kind.
//
// What gets inserted depends on whether `@name` would actually compile. Typst's
// `ref` renders the target's *number*, so a label on prose has nothing to show
// and errors with "cannot reference text". Those rows insert the equivalent
// `#link(<name>)[…]` instead, with the placeholder wording selected, and the
// row's muted secondary shows which form it will write. Headings follow the
// same rule: `@` while the document numbers them, a link while it doesn't
// (turning numbering on is the "Heading numbering" palette command's job, not
// this popup's). The rules live in [reference-form.ts](./reference-form.ts).

interface SuggestState {
  active: boolean;
  from: number;
  query: string;
}

const EMPTY: SuggestState = { active: false, from: 0, query: "" };

/** A single selectable row: a bibliography citation or a document label. */
type RefItem =
  | { type: "citation"; entry: BibEntry }
  | { type: "label"; label: DocLabel; form: InsertForm };

/** Which cross-reference syntax a label row writes. */
type InsertForm = "ref" | "link";

let popup: HTMLElement | null = null;
let selectedIndex = 0;
let currentState: SuggestState = EMPTY;
let filteredItems: RefItem[] = [];
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

function updatePreview(item: RefItem | undefined) {
  const el = getPreview();
  // Only citations carry rich metadata worth previewing; labels are
  // self-describing through their group + display text.
  if (!item || item.type !== "citation") {
    el.style.display = "none";
    getPopup().classList.remove("has-preview");
    return;
  }
  const entry = item.entry;

  el.innerHTML = "";

  const authors = entry.authors.length > 3
    ? entry.authors.slice(0, 3).join(", ") + " et al."
    : entry.authors.length > 0
      ? entry.authors.join(", ")
      : t("refSuggest.unknownAuthor");
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

/**
 * The `@` position of the live citation search, or null when no search popup is
 * open. The visual editor consults this to keep its citation/reference pill from
 * forming over a `@…` that is still being searched (e.g. `@einstein relativity`
 * mid-typing) — the span should read as plain editable text until the writer
 * commits a choice. The `@` offset is stable for a session's lifetime, so a
 * containment check against it is immune to the one-frame lag between a
 * keystroke and the popup's deferred redraw.
 */
export function activeReferenceSearchAt(): number | null {
  return isPopupVisible() && currentState.active ? currentState.from : null;
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

// A citation search is allowed to span spaces — most titles and author names
// contain them ("Smith & Jones 2020"), and the search text is matched against
// `key + title + authors`. But an unbounded query would let the popup trail
// through a whole paragraph, so the query is bounded: a leading space ("@ " is
// a literal at-sign, never a search) is rejected, and the query is capped in
// length and word count. Whether the writer has *stopped* searching and started
// prose is decided at match time, not here — when no candidate matches every
// typed word, `showPopup` closes the popup (see its zero-results branch).
const QUERY_MAX_CHARS = 48;
const QUERY_MAX_WORDS = 6;

/** Whitespace-separated, non-empty search terms in a query. */
function queryTokens(query: string): string[] {
  return query.split(/\s+/).filter((tok) => tok.length > 0);
}

/**
 * Score a candidate's search text against a possibly multi-word `@` query.
 * Every whitespace-separated token must appear as a contiguous, case-insensitive
 * *substring* of the text (AND); the score is the sum of per-token scores.
 *
 * Substring — not scattered-subsequence — matching is deliberate: a citation
 * search is a "find the words I typed" filter (the same behaviour as the
 * wikilink and sidebar filters), so `move` should match titles *containing*
 * "move", not "**m**assive **o**bjects gra**v**itational **e**ffects". Returns
 * null when any token misses — the signal, on a multi-word query, that the
 * writer has typed past the citation into prose. An empty query matches
 * everything at score 0 (source order preserved).
 */
export function scoreReferenceQuery(query: string, text: string): number | null {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return 0;
  let total = 0;
  for (const token of tokens) {
    const m = substringMatch(token, text);
    if (!m) return null;
    total += m.score;
  }
  return total;
}

function detectReferenceContext(view: EditorView): SuggestState {
  const { from: cursor } = view.state.selection.main;
  const line = view.state.doc.lineAt(cursor);
  const textBefore = view.state.doc.sliceString(line.from, cursor);

  const atIdx = textBefore.lastIndexOf("@");
  if (atIdx < 0) return EMPTY;

  const query = textBefore.slice(atIdx + 1);
  if (/^\s/.test(query)) return EMPTY;
  if (query.length > QUERY_MAX_CHARS) return EMPTY;
  if (queryTokens(query).length > QUERY_MAX_WORDS) return EMPTY;

  // Typst (and the backend's `extract_citations`) treat `@key` as a reference
  // wherever it appears — including right after a letter, digit, or a previous
  // reference's last character (`@a@b`, `word@key`). The only `@` that is *not*
  // a reference is an escaped one: a `\` before the `@` is `\@`, a literal
  // at-sign. Skipping it keeps us in step with the backend, and avoids the
  // failure mode where an `@` lands just after a line's hidden trailing
  // soft-break `\` — treating that as a reference would insert `\@key`, escaping
  // it and making the `\` render visibly.
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

/** Search text a query is fuzzy-matched against for each item type. */
function searchText(item: RefItem): string {
  if (item.type === "citation") {
    const e = item.entry;
    return `${e.key} ${e.title} ${e.authors.join(" ")} ${e.year ?? ""}`;
  }
  const l = item.label;
  return `${l.name} ${l.display}`;
}

/** Localized header for a group; bibliography is keyed separately. */
function groupTitle(kind: LabelKind): string {
  switch (kind) {
    case "heading": return t("common.headings");
    case "figure": return t("refSuggest.groupFigures");
    case "equation": return t("refSuggest.groupEquations");
    case "table": return t("refSuggest.groupTables");
    default: return t("common.labels");
  }
}

// Render order of label groups beneath the bibliography group.
const LABEL_KIND_ORDER: LabelKind[] = ["heading", "figure", "equation", "table", "label"];

interface RenderGroup {
  title: string;
  items: RefItem[];
}

/**
 * Build the ordered, filtered groups: bibliography first, then label kinds.
 * Each group's items are fuzzy-scored and sorted; an empty query keeps source
 * order (citations as returned, labels as scanned).
 */
export function buildGroups(
  entries: BibEntry[],
  labels: DocLabel[],
  query: string,
  headingsNumbered: boolean,
): RenderGroup[] {
  const score = (item: RefItem): number | null => scoreReferenceQuery(query, searchText(item));
  const collect = (items: RefItem[]): RefItem[] => {
    const scored: { item: RefItem; score: number }[] = [];
    for (const item of items) {
      const s = score(item);
      if (s !== null) scored.push({ item, score: s });
    }
    if (query !== "") scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.item);
  };

  const groups: RenderGroup[] = [];

  const citations = collect(entries.map((entry) => ({ type: "citation", entry }) as RefItem));
  if (citations.length > 0) {
    groups.push({ title: t("refSuggest.groupBibliography"), items: citations.slice(0, 30) });
  }

  for (const kind of LABEL_KIND_ORDER) {
    const form: InsertForm = canReferenceWithAt(kind, headingsNumbered) ? "ref" : "link";
    const ofKind = labels
      .filter((l) => l.kind === kind)
      .map((label) => ({ type: "label", label, form }) as RefItem);
    const matched = collect(ofKind);
    if (matched.length > 0) {
      groups.push({ title: groupTitle(kind), items: matched.slice(0, 30) });
    }
  }

  return groups;
}

async function showPopup(view: EditorView, state: SuggestState) {
  const el = getPopup();
  currentState = state;

  const entries = await getEntries();
  const labels = scanDocumentLabels(view.state);

  if (entries.length === 0 && labels.length === 0) {
    el.innerHTML = "";
    el.classList.remove("has-preview");
    const empty = document.createElement("div");
    empty.className = "wikilink-suggest__empty";
    empty.textContent = t("refSuggest.empty");
    el.appendChild(empty);
    getPreview().style.display = "none";
    positionPopup(view, state, el);
    return;
  }

  const groups = buildGroups(
    entries,
    labels,
    state.query,
    documentNumbersHeadings(view.state.doc.toString()),
  );
  filteredItems = groups.flatMap((g) => g.items);

  if (filteredItems.length === 0) {
    // A multi-word query that matches nothing means the writer has typed past
    // the citation into ordinary prose ("@note this is just text") — close
    // silently rather than nag with a "no results" box. A single-token miss
    // ("@zzz", no space yet) is still an active search the writer may be mid-
    // typing or about to correct, so the box stays up.
    if (/\s/.test(state.query)) {
      hidePopup();
      return;
    }
    el.innerHTML = "";
    el.classList.remove("has-preview");
    const empty = document.createElement("div");
    empty.className = "wikilink-suggest__empty";
    empty.textContent = t("refSuggest.noResults");
    el.appendChild(empty);
    getPreview().style.display = "none";
    positionPopup(view, state, el);
    return;
  }

  selectedIndex = 0;
  el.innerHTML = "";

  let flatIndex = 0;
  for (const group of groups) {
    const header = document.createElement("div");
    header.className = "wikilink-suggest__group";
    header.textContent = group.title;
    el.appendChild(header);

    for (const item of group.items) {
      el.appendChild(renderRow(view, state, item, flatIndex));
      flatIndex++;
    }
  }

  positionPopup(view, state, el);
  updatePreview(filteredItems[0]);
}

function renderRow(view: EditorView, state: SuggestState, item: RefItem, index: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "wikilink-suggest__item";
  if (index === 0) row.classList.add("is-selected");

  const nameSpan = document.createElement("span");
  nameSpan.className = "wikilink-suggest__name";

  const metaSpan = document.createElement("span");
  metaSpan.className = "wikilink-suggest__folder";

  if (item.type === "citation") {
    const entry = item.entry;
    nameSpan.textContent = entry.title.length > 60 ? entry.title.slice(0, 57) + "..." : entry.title;
    const authors = formatAuthors(entry.authors);
    const year = entry.year ?? "";
    metaSpan.textContent = `${authors}${year ? ` (${year})` : ""}`;
  } else {
    // Show the readable display (heading text, or the label name) up front and
    // the markup that will be inserted as the muted secondary — so a row that
    // writes a link instead of an `@` reference says so before it is picked.
    nameSpan.textContent = item.label.display;
    metaSpan.textContent =
      item.form === "ref" ? `@${item.label.name}` : `#link(<${item.label.name}>)`;
  }

  row.appendChild(nameSpan);
  row.appendChild(metaSpan);

  row.addEventListener("mousedown", (e) => {
    e.preventDefault();
    acceptItem(view, state, item);
  });
  return row;
}

function positionPopup(view: EditorView, state: SuggestState, el: HTMLElement) {
  const coords = view.coordsAtPos(state.from);
  if (coords) {
    positionPopupAtAnchor(el, coords);
  } else {
    el.style.display = "block";
  }
}

function acceptItem(view: EditorView, state: SuggestState, item: RefItem) {
  const cursor = view.state.selection.main.from;
  // A prose label has no number for `@` to render, so it is inserted as a link
  // whose display text starts out as the label name and lands selected, ready
  // to be typed over.
  const link =
    item.type === "label" && item.form === "link"
      ? linkReference(item.label.name, item.label.display || item.label.name)
      : null;
  const insert = link ? link.text : `@${itemName(item)}`;
  const selection = link
    ? { anchor: state.from + link.displayFrom, head: state.from + link.displayTo }
    : { anchor: state.from + insert.length };
  // Set suppression *before* dispatch: the dispatch synchronously runs the
  // tracker's `update`, which would otherwise re-detect the `@key` context and
  // requeue the popup. With the range already set, that update closes the popup
  // instead of reopening it — so a single Enter both inserts and dismisses.
  suppressedRange = { from: state.from, to: state.from + insert.length };
  view.dispatch({
    changes: { from: state.from, to: cursor, insert },
    selection,
  });
  hidePopup();
}

/** The name that `@…` inserts for a given item. */
function itemName(item: RefItem): string {
  return item.type === "citation" ? item.entry.key : item.label.name;
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
    // inserted the reference and hidden the popup — reopening it and forcing
    // the user to press Enter a second time to dismiss it.
    private pendingFrame = 0;

    constructor(view: EditorView) {
      this.state = detectReferenceContext(view);
    }

    update(update: ViewUpdate) {
      if (!update.docChanged && !update.selectionSet) return;
      this.state = detectReferenceContext(update.view);

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

export const referenceSuggest: Extension = [suggestKeyHandler, suggestTracker];
