import { EditorView, ViewPlugin, type ViewUpdate, keymap } from "@codemirror/view";
import { type ChangeSpec, type Extension, Prec } from "@codemirror/state";
import { fileList } from "../../stores/filelist";
import { fuzzyMatch } from "../../lib/fuzzy";
import * as ipc from "../../lib/ipc";

type SuggestMode = "note" | "heading";

interface SuggestState {
  active: boolean;
  from: number;
  query: string;
  mode: SuggestMode;
  noteName: string;
}

const EMPTY: SuggestState = { active: false, from: 0, query: "", mode: "note", noteName: "" };

let popup: HTMLElement | null = null;
let selectedIndex = 0;
let currentSuggestState: SuggestState = EMPTY;

interface SuggestItem {
  name: string;
  isCreate: boolean;
}

let filteredItems: SuggestItem[] = [];

function getPopup(): HTMLElement {
  if (!popup) {
    popup = document.createElement("div");
    popup.className = "wikilink-suggest";
    popup.style.display = "none";
    document.body.appendChild(popup);
  }
  return popup;
}

function hidePopup() {
  const el = getPopup();
  el.style.display = "none";
  el.innerHTML = "";
  filteredItems = [];
  selectedIndex = 0;
  currentSuggestState = EMPTY;
}

function isPopupVisible(): boolean {
  return !!popup && popup.style.display !== "none";
}

function detectWikilinkContext(view: EditorView): SuggestState {
  const { from: cursor } = view.state.selection.main;
  const line = view.state.doc.lineAt(cursor);
  const textBefore = view.state.doc.sliceString(line.from, cursor);

  const bracketIdx = textBefore.lastIndexOf("[[");
  if (bracketIdx < 0) return EMPTY;

  const afterBrackets = textBefore.slice(bracketIdx + 2);
  if (afterBrackets.includes("]")) return EMPTY;

  const sepIdx = afterBrackets.indexOf("::");
  if (sepIdx >= 0) {
    return {
      active: true,
      from: line.from + bracketIdx,
      query: afterBrackets.substring(sepIdx + 2),
      mode: "heading",
      noteName: afterBrackets.substring(0, sepIdx),
    };
  }

  return {
    active: true,
    from: line.from + bracketIdx,
    query: afterBrackets,
    mode: "note",
    noteName: "",
  };
}

function resolveNotePath(name: string): string | null {
  const notes = fileList();
  const entry = notes.find((e) => {
    const n = e.name.replace(/\.(typ|md)$/, "");
    return n.toLowerCase() === name.toLowerCase();
  });
  return entry?.path ?? null;
}

async function showPopup(view: EditorView, state: SuggestState) {
  const el = getPopup();
  currentSuggestState = state;

  if (state.mode === "heading") {
    const path = resolveNotePath(state.noteName);
    if (!path) {
      hidePopup();
      return;
    }

    let headings: ipc.HeadingInfo[] = [];
    try {
      headings = await ipc.getNoteHeadings(path);
    } catch {
      hidePopup();
      return;
    }

    const query = state.query.toLowerCase();
    const matched = headings
      .filter((h) => query === "" || h.text.toLowerCase().includes(query))
      .slice(0, 20);

    filteredItems = matched.map((h) => ({
      name: h.text,
      isCreate: false,
    }));

    if (filteredItems.length === 0) {
      el.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "wikilink-suggest__empty";
      empty.textContent = query ? "No matching headings" : "No headings in this note";
      el.appendChild(empty);
      positionPopup(view, state, el);
      return;
    }
  } else {
    const notes = fileList();
    const query = state.query;

    const scored: { name: string; score: number }[] = [];
    for (const entry of notes) {
      if (!entry.name.endsWith(".typ") && !entry.name.endsWith(".md")) continue;
      const name = entry.name.replace(/\.(typ|md)$/, "");
      if (query === "") {
        scored.push({ name, score: 0 });
      } else {
        const m = fuzzyMatch(query, name);
        if (m) scored.push({ name, score: m.score });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    filteredItems = scored.slice(0, 20).map((s) => ({ name: s.name, isCreate: false }));

    const hasExactMatch = filteredItems.some(
      (item) => item.name.toLowerCase() === query.toLowerCase(),
    );
    if (query.length > 0 && !hasExactMatch) {
      filteredItems.push({ name: query, isCreate: true });
    }
  }

  if (filteredItems.length === 0) {
    hidePopup();
    return;
  }

  selectedIndex = 0;
  el.innerHTML = "";

  for (let i = 0; i < filteredItems.length; i++) {
    const item = filteredItems[i];
    const row = document.createElement("div");
    row.className = "wikilink-suggest__item";
    if (item.isCreate) row.classList.add("wikilink-suggest__item--create");
    if (i === 0) row.classList.add("is-selected");

    if (state.mode === "heading") {
      row.textContent = item.name;
    } else {
      row.textContent = item.isCreate ? `Create: ${item.name}` : item.name;
    }

    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      acceptItem(view, state, item);
    });
    el.appendChild(row);
  }

  positionPopup(view, state, el);
}

function positionPopup(view: EditorView, state: SuggestState, el: HTMLElement) {
  const coords = view.coordsAtPos(state.from + 2);
  if (coords) {
    el.style.left = `${coords.left}px`;
    el.style.top = `${coords.bottom + 4}px`;
  }
  el.style.display = "block";
}

function acceptItem(view: EditorView, state: SuggestState, item: SuggestItem) {
  const cursor = view.state.selection.main.from;
  const afterCursor = view.state.doc.sliceString(cursor, Math.min(cursor + 2, view.state.doc.length));
  const trailingBrackets = afterCursor.startsWith("]]") ? 2 : afterCursor.startsWith("]") ? 1 : 0;

  if (state.mode === "note" && !item.isCreate) {
    const insertText = item.name + "::";
    view.dispatch({
      changes: { from: state.from + 2, to: cursor + trailingBrackets, insert: insertText } as ChangeSpec,
      selection: { anchor: state.from + 2 + insertText.length },
    });
    return;
  }

  let insert: string;
  if (state.mode === "heading") {
    insert = `#wikilink("${state.noteName}", label: "${item.name}")`;
  } else {
    insert = `#wikilink("${item.name}")`;
  }

  view.dispatch({
    changes: { from: state.from, to: cursor + trailingBrackets, insert } as ChangeSpec,
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
}

const wikilinkBracketHandler = EditorView.inputHandler.of((view, from, _to, text) => {
  if (text !== "[") return false;
  if (from === 0 || view.state.doc.sliceString(from - 1, from) !== "[") return false;

  const after = view.state.doc.sliceString(from, from + 1);
  const deleteTo = after === "]" ? from + 1 : from;

  view.dispatch({
    changes: { from, to: deleteTo, insert: "[" },
    selection: { anchor: from + 1 },
  });
  return true;
});

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
      if (item) acceptItem(view, currentSuggestState, item);
      return true;
    },
  },
  {
    key: "Tab",
    run: (view) => {
      if (!isPopupVisible()) return false;
      const item = filteredItems[selectedIndex];
      if (item) acceptItem(view, currentSuggestState, item);
      return true;
    },
  },
  {
    key: "Escape",
    run: (view) => {
      if (!isPopupVisible()) return false;
      if (currentSuggestState.mode === "heading") {
        const state = currentSuggestState;
        const cursor = view.state.selection.main.from;
        const afterCursor = view.state.doc.sliceString(cursor, Math.min(cursor + 2, view.state.doc.length));
        const trailingBrackets = afterCursor.startsWith("]]") ? 2 : afterCursor.startsWith("]") ? 1 : 0;
        const insert = `#wikilink("${state.noteName}")`;
        view.dispatch({
          changes: { from: state.from, to: cursor + trailingBrackets, insert } as ChangeSpec,
          selection: { anchor: state.from + insert.length },
        });
      }
      hidePopup();
      return true;
    },
  },
]));

const suggestTracker = ViewPlugin.fromClass(
  class {
    private state: SuggestState = EMPTY;

    constructor(view: EditorView) {
      this.state = detectWikilinkContext(view);
    }

    update(update: ViewUpdate) {
      if (!update.docChanged && !update.selectionSet) return;
      this.state = detectWikilinkContext(update.view);

      if (this.state.active) {
        const view = update.view;
        const state = this.state;
        requestAnimationFrame(() => showPopup(view, state));
      } else {
        hidePopup();
      }
    }

    destroy() {
      hidePopup();
    }
  },
);

export const wikilinkSuggest: Extension = [wikilinkBracketHandler, suggestKeyHandler, suggestTracker];
