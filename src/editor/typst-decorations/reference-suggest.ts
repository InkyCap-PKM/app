import { EditorView, ViewPlugin, type ViewUpdate, keymap } from "@codemirror/view";
import { type Extension, Prec } from "@codemirror/state";
import { substringMatch } from "../../lib/fuzzy";
import { positionPopupAtAnchor } from "./popup-position";
import * as ipc from "../../lib/ipc";
import { t } from "../../lib/i18n";
import type { BibEntry } from "../../lib/types";
import { scanDocumentLabels, type DocLabel, type LabelKind } from "./document-labels";
import {
  canReferenceWithAt,
  documentNumbersHeadings,
  isEmailLikeAt,
  linkReference,
} from "./reference-form";
import { escapeAts, inMarkupAt, linkEmail } from "./address-markup";

// The `@` popup. In Typst `@` refers to any `<label>` (heading, figure, equation,
// table) as well as bibliography entries, so the popup lists citations first,
// then the document's labels by kind.
//
// What is inserted depends on whether `@name` compiles. `ref` shows the target's
// number, so a label on prose errors with "cannot reference text"; those rows
// insert `#link(<name>)[…]` instead, with the placeholder text selected, and the
// row says which form it writes. Headings get `@` while the document numbers them
// and a link otherwise. The rules are in
// [reference-form.ts](./reference-form.ts).
//
// An `@` straight after a word (`results@smith2020`, `athena@inkycap.org`) may be
// a citation set against the text or an email address, so the popup opens there
// too. It always ends with *E-mail address* (after a word only), which makes a
// `mailto:` link, and *Plain text*, which escapes the `@`. Neither is selected by
// default; with no matches nothing is selected and Enter passes through, and the
// word is classified when it ends (see url-typing.ts).

interface SuggestState {
  active: boolean;
  from: number;
  query: string;
}

const EMPTY: SuggestState = { active: false, from: 0, query: "" };

/** A single selectable row: a bibliography citation, a document label, or one
 *  of the rows that write the `@` as something other than a reference. */
type RefItem =
  | { type: "citation"; entry: BibEntry }
  | { type: "label"; label: DocLabel; form: InsertForm }
  | { type: "email" }
  | { type: "plain" };

/** The local part of an email address just before its `@`. */
const EMAIL_LOCAL_PART = /[A-Za-z0-9._+-]+$/;

/** Which cross-reference syntax a label row writes. */
type InsertForm = "ref" | "link";

let popup: HTMLElement | null = null;
let selectedIndex = 0;
let currentState: SuggestState = EMPTY;
let filteredItems: RefItem[] = [];
let cachedEntries: BibEntry[] | null = null;
let cacheTime = 0;
const CACHE_TTL = 30_000;

// After accepting, keep the popup closed until the cursor leaves the inserted
// range (by position, not time, which misfires for slow renders or fast
// typists).
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
 * The `@` position of the open citation search, or null. The visual editor uses
 * it to keep a pill from forming over an `@…` still being searched (e.g.
 * `@einstein relativity`). The offset doesn't change during a search, so it
 * isn't affected by the popup's one-frame delay.
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

// A citation search may contain spaces ("Smith & Jones 2020"); it matches `key
// + title + authors`. To keep it from running through a paragraph, a leading
// space ("@ ") isn't a search and the query is capped in length and words. When
// no candidate matches every word, `showPopup` closes the popup.
const QUERY_MAX_CHARS = 48;
const QUERY_MAX_WORDS = 6;

/** Whitespace-separated, non-empty search terms in a query. */
function queryTokens(query: string): string[] {
  return query.split(/\s+/).filter((tok) => tok.length > 0);
}

/**
 * Score a candidate against an `@` query: every word must appear as a
 * case-insensitive substring (AND), and the score sums the words' scores.
 * Substrings rather than scattered letters, like the wikilink and sidebar
 * filters, so `move` matches titles containing "move". Null when any word
 * misses, which on a multi-word query means the writer has moved on to prose. An
 * empty query matches everything at 0.
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

  // Not a search: an escaped `\@` (also avoids inserting `\@key` after a hidden
  // soft break, which would show the backslash), or an `@` after an email-style
  // character (`athena@inkycap.org`), as in the visual editor and compiler. See
  // `isEmailLikeAt`.
  const charBefore = atIdx > 0 ? textBefore[atIdx - 1] : "";
  if (charBefore === "\\") return EMPTY;
  // After a word the popup offers citation and email, but only in markup, not
  // inside a `#link("…")` string.
  if (isEmailLikeAt(charBefore) && !inMarkupAt(view.state, line.from + atIdx)) return EMPTY;

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
  if (item.type === "label") return `${item.label.name} ${item.label.display}`;
  return "";
}

/**
 * Rows that write the `@` as something else: an email link (after a word,
 * before any space) and plain text.
 */
function nonReferenceItems(view: EditorView, state: SuggestState): RefItem[] {
  const charBefore = state.from > 0 ? view.state.doc.sliceString(state.from - 1, state.from) : "";
  const canBeEmail = isEmailLikeAt(charBefore) && !/\s/.test(state.query);
  return canBeEmail ? [{ type: "email" }, { type: "plain" }] : [{ type: "plain" }];
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
 * The groups in order, bibliography then label kinds, each scored and sorted.
 * An empty query keeps source order.
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

  const groups = buildGroups(
    entries,
    labels,
    state.query,
    documentNumbersHeadings(view.state.doc.toString()),
  );
  const matches = groups.flatMap((g) => g.items);

  // A multi-word query with no match means the writer is typing prose; close
  // quietly. A single word with no match ("@zzz") is still a search in
  // progress, so the box stays.
  if (matches.length === 0 && /\s/.test(state.query)) {
    hidePopup();
    return;
  }

  const others = nonReferenceItems(view, state);
  filteredItems = [...matches, ...others];
  // The non-reference rows are only ever picked on purpose: with no match,
  // nothing is selected and Enter passes through to the editor.
  selectedIndex = matches.length > 0 ? 0 : -1;
  el.innerHTML = "";
  el.classList.remove("has-preview");

  if (matches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "wikilink-suggest__empty";
    empty.textContent =
      entries.length === 0 && labels.length === 0 ? t("refSuggest.empty") : t("refSuggest.noResults");
    el.appendChild(empty);
  }

  let flatIndex = 0;
  const renderGroup = (title: string, items: RefItem[]) => {
    const header = document.createElement("div");
    header.className = "wikilink-suggest__group";
    header.textContent = title;
    el.appendChild(header);
    for (const item of items) {
      el.appendChild(renderRow(view, state, item, flatIndex));
      flatIndex++;
    }
  };
  for (const group of groups) renderGroup(group.title, group.items);
  renderGroup(t("refSuggest.groupNotReference"), others);

  positionPopup(view, state, el);
  updatePreview(filteredItems[selectedIndex]);
}

function renderRow(view: EditorView, state: SuggestState, item: RefItem, index: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "wikilink-suggest__item";
  if (index === selectedIndex) row.classList.add("is-selected");

  const nameSpan = document.createElement("span");
  nameSpan.className = "wikilink-suggest__name";

  const metaSpan = document.createElement("span");
  metaSpan.className = "wikilink-suggest__folder";

  if (item.type === "email") {
    nameSpan.textContent = t("refSuggest.asEmail");
    metaSpan.textContent = "mailto:";
  } else if (item.type === "plain") {
    nameSpan.textContent = t("refSuggest.asPlainText");
    metaSpan.textContent = "\\@";
  } else if (item.type === "citation") {
    const entry = item.entry;
    nameSpan.textContent = entry.title.length > 60 ? entry.title.slice(0, 57) + "..." : entry.title;
    const authors = formatAuthors(entry.authors);
    const year = entry.year ?? "";
    metaSpan.textContent = `${authors}${year ? ` (${year})` : ""}`;
  } else {
    // The display text first, with the markup to be inserted as the secondary,
    // so a row that writes a link says so.
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
  if (item.type === "email" || item.type === "plain") {
    acceptNonReference(view, state, item.type, cursor);
    return;
  }
  // A prose label has no number, so insert a link with the label name as its
  // text, selected so it can be typed over.
  const link =
    item.type === "label" && item.form === "link"
      ? linkReference(item.label.name, item.label.display || item.label.name)
      : null;
  const insert = link ? link.text : `@${itemName(item)}`;
  const selection = link
    ? { anchor: state.from + link.displayFrom, head: state.from + link.displayTo }
    : { anchor: state.from + insert.length };
  // Set suppression before dispatching: the dispatch runs the tracker's
  // `update` synchronously, which would otherwise reopen the popup. One Enter
  // inserts and closes.
  suppressedRange = { from: state.from, to: state.from + insert.length };
  view.dispatch({
    changes: { from: state.from, to: cursor, insert },
    selection,
  });
  hidePopup();
}

/**
 * Write the `@` at `state.from` as an email address (a `mailto:` link of what
 * is typed so far, caret at its end) or as plain text (`\@`, caret unmoved).
 */
function acceptNonReference(
  view: EditorView,
  state: SuggestState,
  kind: "email" | "plain",
  cursor: number,
) {
  hidePopup();
  if (kind === "plain") {
    escapeAts(view, [state.from], { caretAfter: cursor + 1 });
    return;
  }
  const line = view.state.doc.lineAt(state.from);
  const local = EMAIL_LOCAL_PART.exec(view.state.doc.sliceString(line.from, state.from));
  if (!local) return;
  linkEmail(
    view,
    { from: state.from - local[0].length, to: cursor, at: state.from },
    { caretInAddress: true },
  );
}

/** The name that `@…` inserts for a given item. */
function itemName(item: RefItem): string {
  if (item.type === "citation") return item.entry.key;
  if (item.type === "label") return item.label.name;
  return "";
}

function updateSelection(delta: number) {
  const el = getPopup();
  const items = el.querySelectorAll(".wikilink-suggest__item");
  if (items.length === 0) return;

  items[selectedIndex]?.classList.remove("is-selected");
  const n = filteredItems.length;
  selectedIndex = selectedIndex < 0
    ? (delta > 0 ? 0 : n - 1)
    : (selectedIndex + delta + n) % n;
  items[selectedIndex]?.classList.add("is-selected");
  (items[selectedIndex] as HTMLElement)?.scrollIntoView({ block: "nearest" });
  updatePreview(filteredItems[selectedIndex]);
}

/** Accept the selected row. With none selected, the popup closes and the key
 *  goes on to the editor. */
function acceptSelected(view: EditorView): boolean {
  if (!isPopupVisible()) return false;
  const item = filteredItems[selectedIndex];
  if (!item) {
    hidePopup();
    return false;
  }
  acceptItem(view, currentState, item);
  return true;
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
    run: (view) => acceptSelected(view),
  },
  {
    key: "Tab",
    run: (view) => acceptSelected(view),
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
    // The pending `showPopup` frame, so a later update can cancel it; otherwise
    // the frame from the last keystroke before Enter would reopen the popup
    // after the insert.
    private pendingFrame = 0;

    constructor(view: EditorView) {
      this.state = detectReferenceContext(view);
    }

    update(update: ViewUpdate) {
      if (!update.docChanged && !update.selectionSet) return;
      this.state = detectReferenceContext(update.view);

      // Clear suppression once the cursor leaves the inserted range.
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
