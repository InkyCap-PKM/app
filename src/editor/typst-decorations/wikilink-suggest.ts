import { EditorView, ViewPlugin, type ViewUpdate, keymap } from "@codemirror/view";
import { type ChangeSpec, type Extension, Prec } from "@codemirror/state";
import { fileList } from "../../stores/filelist";
import { fuzzyMatch } from "../../lib/fuzzy";
import * as ipc from "../../lib/ipc";

type SuggestMode = "note" | "heading";

interface SuggestState {
  active: boolean;
  /** Start of the form being edited (the `[[` for bracket form, the `#`
   *  of `#wikilink(` for func form). Used as the replacement anchor. */
  from: number;
  /** End of the form being edited. For func form, the offset just after
   *  the closing `)`; left undefined for bracket form, where acceptItem
   *  computes the end from cursor + trailing `]]`. */
  to?: number;
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

// Match `#wikilink("name")` or `#wikilink("name", display: "...")` or
// `#wikilink("name", label: "...")`. Group 1 = note name, group 2 = optional
// second-arg key (display | label), group 3 = optional second-arg value.
const WIKILINK_CALL_RE = /#wikilink\("([^"]*)"(?:,\s*(\w+):\s*"([^"]*)")?\)/g;

/** Detect whether the cursor sits inside an editable wikilink quoted arg
 *  (the `"name"` or the `"label"` value) and, if so, return the picker
 *  state for that position. Returns EMPTY otherwise.
 *
 *  This piggy-backs on the autoExpand-on-cursor behaviour: when the cursor
 *  is on a wikilink line the visual decorations drop to raw source, so the
 *  call text we're scanning is actually present in the document. */
function detectFuncWikilinkContext(text: string, lineFrom: number, cursorInLine: number): SuggestState {
  WIKILINK_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_CALL_RE.exec(text)) !== null) {
    const callStart = m.index;
    const callEnd = m.index + m[0].length;
    if (cursorInLine < callStart || cursorInLine > callEnd) continue;

    // Locate the first quoted arg (note name).
    const firstOpen = text.indexOf('"', callStart);
    const firstClose = firstOpen >= 0 ? text.indexOf('"', firstOpen + 1) : -1;
    if (firstOpen < 0 || firstClose < 0) return EMPTY;

    if (cursorInLine > firstOpen && cursorInLine <= firstClose) {
      return {
        active: true,
        from: lineFrom + callStart,
        to: lineFrom + callEnd,
        query: text.substring(firstOpen + 1, cursorInLine),
        mode: "note",
        noteName: "",
      };
    }

    // Optional second arg — only `label:` is editable through the picker
    // (`display:` is a free-form override the user types directly).
    if (m[2] === "label") {
      const secondOpen = text.indexOf('"', firstClose + 1);
      const secondClose = secondOpen >= 0 ? text.indexOf('"', secondOpen + 1) : -1;
      if (secondOpen >= 0 && secondClose >= 0
          && cursorInLine > secondOpen && cursorInLine <= secondClose) {
        return {
          active: true,
          from: lineFrom + callStart,
          to: lineFrom + callEnd,
          query: text.substring(secondOpen + 1, cursorInLine),
          mode: "heading",
          noteName: m[1],
        };
      }
    }

    // Cursor is inside the call but not inside an editable arg — don't
    // trigger the picker (avoids it firing when the user clicks on
    // `display:` keyword text or whitespace).
    return EMPTY;
  }
  return EMPTY;
}

function detectWikilinkContext(view: EditorView): SuggestState {
  const { from: cursor } = view.state.selection.main;
  const line = view.state.doc.lineAt(cursor);
  const lineText = view.state.doc.sliceString(line.from, line.to);
  const cursorInLine = cursor - line.from;

  // Bracket form: `[[…|]]` typed by the user (no closing `]` between `[[`
  // and the cursor).
  const textBefore = lineText.slice(0, cursorInLine);
  const bracketIdx = textBefore.lastIndexOf("[[");
  if (bracketIdx >= 0) {
    const afterBrackets = textBefore.slice(bracketIdx + 2);
    if (!afterBrackets.includes("]")) {
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
  }

  // Func form: cursor inside an existing `#wikilink("…")` call's quoted arg.
  return detectFuncWikilinkContext(lineText, line.from, cursorInLine);
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
  let replaceTo: number;
  if (state.to !== undefined) {
    // Func form: replace the entire `#wikilink(...)` call.
    replaceTo = state.to;
  } else {
    // Bracket form: extend through any literal `]]` the user already typed.
    const cursor = view.state.selection.main.from;
    const afterCursor = view.state.doc.sliceString(cursor, Math.min(cursor + 2, view.state.doc.length));
    const trailingBrackets = afterCursor.startsWith("]]") ? 2 : afterCursor.startsWith("]") ? 1 : 0;
    replaceTo = cursor + trailingBrackets;
  }

  let insert: string;
  if (state.mode === "heading") {
    insert = `#wikilink("${state.noteName}", label: "${item.name}")`;
  } else {
    insert = `#wikilink("${item.name}")`;
  }

  view.dispatch({
    changes: { from: state.from, to: replaceTo, insert } as ChangeSpec,
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
      if (!item) return true;
      // In bracket form note mode, Tab autocompletes the note name in
      // place so the user can keep typing (`::heading`) to drill into a
      // heading without having to spell the whole note name first. For
      // every other case (heading mode, "create new" item, func form),
      // fall back to Enter-style commit.
      const state = currentSuggestState;
      const isBracketNoteCompletion = state.mode === "note"
        && state.to === undefined
        && !item.isCreate;
      if (!isBracketNoteCompletion) {
        acceptItem(view, state, item);
        return true;
      }
      const queryFrom = state.from + 2; // skip `[[`
      const queryTo = queryFrom + state.query.length;
      view.dispatch({
        changes: { from: queryFrom, to: queryTo, insert: item.name } as ChangeSpec,
        selection: { anchor: queryFrom + item.name.length },
      });
      // The tracker's selectionSet/docChanged update will re-detect the
      // bracket context with the now-complete name and refresh the popup.
      return true;
    },
  },
  {
    key: "Escape",
    run: (view) => {
      if (!isPopupVisible()) return false;
      // Bracket-form heading dismissal (typed `Foo::` then escaped):
      // finalize without a label so we don't leave stray `[[Foo::]]`.
      // Func-form needs no fixup — the source is already a valid call.
      if (currentSuggestState.mode === "heading" && currentSuggestState.to === undefined) {
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
