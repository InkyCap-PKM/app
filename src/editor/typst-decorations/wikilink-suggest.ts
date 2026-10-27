import { EditorView, ViewPlugin, type ViewUpdate, keymap } from "@codemirror/view";
import { MapMode, StateEffect, StateField, type ChangeSpec, type EditorState, type Extension, Prec } from "@codemirror/state";
import { fileList } from "../../stores/filelist";
import { aliases } from "../../stores/aliases";
import { wikilinkScore } from "./wikilink-match";
import { positionPopupAtAnchor } from "./popup-position";
import { inVerbatimLineContext } from "./keymaps";
import { scopeRangeField } from "./cell-scope";
import { typstStringEscape } from "../../lib/typst";
import { t } from "../../lib/i18n";
import * as ipc from "../../lib/ipc";

type SuggestMode = "note" | "heading";

interface SuggestState {
  active: boolean;
  /** Start of the form being edited (the `[[` for bracket form, the `#`
   *  of `#wikilink(` for func form). Used as the replacement anchor. */
  from: number;
  /**
   * End of the form being edited: just after `)` for the function form;
   * undefined for the bracket form, where acceptItem works it out.
   */
  to?: number;
  query: string;
  mode: SuggestMode;
  noteName: string;
}

const EMPTY: SuggestState = { active: false, from: 0, query: "", mode: "note", noteName: "" };

let popup: HTMLElement | null = null;
let selectedIndex = 0;
let currentSuggestState: SuggestState = EMPTY;

/** In heading mode, which kind of anchor a row points at — headings are shown
 *  indented by level, labels by the words they tag. */
type TargetKind = "heading" | "label";

interface SuggestItem {
  name: string;
  /** Set in heading mode only. */
  targetKind?: TargetKind;
  /**
   * Absolute note path, to tell apart notes with the same name in different
   * folders.
   */
  notePath?: string;
  label?: string;
  level?: number;
  isCreate: boolean;
  /** Display text override (from alias match). When set, acceptItem
   *  emits `display: "..."` so the link shows the alias text. */
  displayText?: string;
  /** Description shown below the name (e.g. "via alias" hint). */
  subtitle?: string;
}

let filteredItems: SuggestItem[] = [];

/**
 * Rows as shown: one untitled section for notes, one per anchor kind for
 * headings. Keyboard selection uses the flat `filteredItems`.
 */
interface SuggestSection {
  /** Group header shown above the section; omitted for a single unlabelled run. */
  title?: string;
  items: SuggestItem[];
}

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

// `#wikilink("name")`, optionally with `display:` or `label:`. Groups: name,
// second argument's key, its value.
const WIKILINK_CALL_RE = /#wikilink\("([^"]*)"(?:,\s*(\w+):\s*"([^"]*)")?\)/g;

/**
 * If the cursor is inside a wikilink's quoted name or label, the picker state
 * for that spot; otherwise EMPTY. The cursor's line shows raw source in the
 * visual editor, so the call text is there to scan.
 */
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
      const argContent = text.substring(firstOpen + 1, cursorInLine);
      // `::` in the name switches to heading mode, as `[[Note::heading]]` does;
      // choosing a heading rewrites the call to `#wikilink("Name", label: "…")`.
      const sep = argContent.indexOf("::");
      if (sep >= 0) {
        return {
          active: true,
          from: lineFrom + callStart,
          to: lineFrom + callEnd,
          query: argContent.substring(sep + 2),
          mode: "heading",
          noteName: argContent.substring(0, sep),
        };
      }
      return {
        active: true,
        from: lineFrom + callStart,
        to: lineFrom + callEnd,
        query: argContent,
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

    // Inside the call but not in an editable argument (e.g. on `display:`): no
    // picker.
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
  // A `[[` inside inline raw is literal text (e.g. a callout explaining the
  // shortcut), so no picker.
  if (bracketIdx >= 0 && !inVerbatimLineContext(view.state, line.from + bracketIdx + 1)) {
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
  let sections: SuggestSection[] = [];

  if (state.mode === "heading") {
    const path = resolveNotePath(state.noteName);
    if (!path) {
      hidePopup();
      return;
    }

    // Both kinds of anchor in the target note: headings and labels on prose,
    // figures and equations.
    let headings: ipc.HeadingInfo[] = [];
    let noteLabels: ipc.LabelInfo[] = [];
    try {
      [headings, noteLabels] = await Promise.all([
        ipc.getNoteHeadings(path),
        ipc.getNoteLabels(path),
      ]);
    } catch {
      hidePopup();
      return;
    }

    const query = state.query.toLowerCase();
    const headingItems: SuggestItem[] = headings
      .filter((h) => query === "" || h.text.toLowerCase().includes(query))
      .slice(0, 20)
      .map((h) => ({
        name: h.text,
        targetKind: "heading",
        label: h.label ?? undefined,
        level: h.level,
        isCreate: false,
      }));

    const labelItems: SuggestItem[] = noteLabels
      .filter((l) =>
        query === "" ||
        l.name.toLowerCase().includes(query) ||
        l.context.toLowerCase().includes(query))
      .slice(0, 20)
      .map((l) => ({
        // Lead with the words the label tags; the label name follows as the
        // muted second line, and is the whole row when there are no such words.
        name: l.context || l.name,
        targetKind: "label",
        label: l.name,
        subtitle: l.context ? l.name : undefined,
        isCreate: false,
      }));

    // Headers only earn their space when both kinds are present; a note with
    // headings alone looks exactly as it did before labels were offered.
    const bothKinds = headingItems.length > 0 && labelItems.length > 0;
    sections = [
      { title: bothKinds ? t("common.headings") : undefined, items: headingItems },
      { title: bothKinds ? t("common.labels") : undefined, items: labelItems },
    ].filter((section) => section.items.length > 0);
    filteredItems = sections.flatMap((section) => section.items);

    if (filteredItems.length === 0) {
      el.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "wikilink-suggest__empty";
      empty.textContent = query
        ? t("wikilink.suggest.noMatchingAnchors")
        : t("wikilink.suggest.noAnchors");
      el.appendChild(empty);
      positionPopup(view, state, el);
      return;
    }
  } else {
    const notes = fileList();
    const query = state.query;

    // Score file-name matches, keeping `notePath` to dedupe against aliases
    // (two notes can share a name).
    const scored: {
      name: string;
      notePath: string;
      score: number;
      displayText?: string;
      subtitle?: string;
    }[] = [];
    for (const entry of notes) {
      if (!entry.name.endsWith(".typ") && !entry.name.endsWith(".md")) continue;
      const name = entry.name.replace(/\.(typ|md)$/, "");
      if (query === "") {
        scored.push({ name, notePath: entry.path, score: 0 });
      } else {
        const s = wikilinkScore(query, name);
        if (s !== null) scored.push({ name, notePath: entry.path, score: s });
      }
    }

    // Score alias matches — dedup against filename matches by note path
    // so same-stemmed notes in different folders stay distinct.
    const seenPaths = new Set(scored.map((s) => s.notePath));
    for (const entry of aliases()) {
      const aliasSubtitle = t("wikilink.suggest.alias_hint", { alias: entry.alias });
      if (query === "") {
        if (seenPaths.has(entry.note_path)) continue;
        scored.push({
          name: entry.note_name,
          notePath: entry.note_path,
          score: -1,
          displayText: entry.alias,
          subtitle: aliasSubtitle,
        });
      } else {
        const s = wikilinkScore(query, entry.alias);
        if (s !== null) {
          // If the same note already matched by filename, skip the alias
          // unless the alias match scores higher
          const existingIdx = scored.findIndex(
            (item) => item.notePath === entry.note_path && !item.displayText,
          );
          if (existingIdx >= 0 && scored[existingIdx].score >= s) continue;
          scored.push({
            name: entry.note_name,
            notePath: entry.note_path,
            score: s,
            displayText: entry.alias,
            subtitle: aliasSubtitle,
          });
        }
      }
    }

    scored.sort((a, b) => b.score - a.score);

    filteredItems = scored.slice(0, 20).map((s) => ({
      name: s.name,
      notePath: s.notePath,
      isCreate: false,
      displayText: s.displayText,
      subtitle: s.subtitle,
    }));

    const hasExactMatch = filteredItems.some(
      (item) => item.name.toLowerCase() === query.toLowerCase(),
    );
    if (query.length > 0 && !hasExactMatch) {
      filteredItems.push({ name: query, isCreate: true });
    }
    sections = [{ items: filteredItems }];
  }

  if (filteredItems.length === 0) {
    hidePopup();
    return;
  }

  selectedIndex = 0;
  el.innerHTML = "";

  let flatIndex = 0;
  for (const section of sections) {
    if (section.title) {
      const header = document.createElement("div");
      header.className = "wikilink-suggest__group";
      header.textContent = section.title;
      el.appendChild(header);
    }
    for (const item of section.items) {
      el.appendChild(renderRow(view, state, item, flatIndex));
      flatIndex++;
    }
  }

  // Hints for `::` (link to a heading) and Tab (fills in `::`), one per line.
  const footer = document.createElement("div");
  footer.className = "wikilink-suggest__footer";
  const hintKeys = state.mode === "heading"
    ? ["wikilink.suggest.hint_heading"]
    : ["wikilink.suggest.hint_note", "wikilink.suggest.hint_tab"];
  for (const key of hintKeys) {
    const line = document.createElement("div");
    line.className = "wikilink-suggest__hint-line";
    line.textContent = t(key);
    footer.appendChild(line);
  }
  el.appendChild(footer);

  positionPopup(view, state, el);
}

/** One selectable row. Headings indent by level; labels lead with the words
 *  they tag and carry their label name as the muted secondary line. */
function renderRow(
  view: EditorView,
  state: SuggestState,
  item: SuggestItem,
  index: number,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "wikilink-suggest__item";
  if (item.isCreate) row.classList.add("wikilink-suggest__item--create");
  if (index === 0) row.classList.add("is-selected");

  if (state.mode === "heading" && item.targetKind === "heading") {
    const indent = item.level && item.level > 1 ? " ".repeat(item.level - 1) : "";
    row.textContent = `${indent}${item.name}`;
  } else if (item.isCreate) {
    row.textContent = t("wikilink.suggest.create", { name: item.name });
  } else {
    const nameSpan = document.createElement("span");
    nameSpan.textContent = item.name;
    row.appendChild(nameSpan);
    if (item.subtitle) {
      const hint = document.createElement("span");
      hint.className = "wikilink-suggest__alias-hint";
      hint.textContent = item.subtitle;
      row.appendChild(hint);
    }
  }

  row.addEventListener("mousedown", (e) => {
    e.preventDefault();
    acceptItem(view, state, item);
  });
  return row;
}

function positionPopup(view: EditorView, state: SuggestState, el: HTMLElement) {
  const coords = view.coordsAtPos(state.from + 2);
  if (coords) {
    positionPopupAtAnchor(el, coords);
  } else {
    el.style.display = "block";
  }
}

async function acceptItem(view: EditorView, state: SuggestState, item: SuggestItem) {
  let replaceTo: number;
  if (state.to !== undefined) {
    replaceTo = state.to;
  } else {
    const cursor = view.state.selection.main.from;
    replaceTo = cursor + parkedCloserCount(view.state, cursor);
  }

  let insert: string;
  if (state.mode === "heading") {
    let label = item.label;
    // A heading may have no label yet; writing one into the target note makes
    // the link stable. A label row is already an anchor.
    if (!label && item.targetKind !== "label") {
      const path = resolveNotePath(state.noteName);
      if (path) {
        try {
          label = await ipc.ensureHeadingLabel(path, item.name) ?? undefined;
        } catch { /* fall through to text */ }
      }
    }
    const labelVal = label ?? item.name;
    insert = `#wikilink("${typstStringEscape(state.noteName)}", label: "${typstStringEscape(labelVal)}")`;
  } else {
    const displayArg = item.displayText
      ? `, display: "${typstStringEscape(item.displayText)}"`
      : "";
    insert = `#wikilink("${typstStringEscape(item.name)}"${displayArg})`;
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

/**
 * A `[` typed on the last keystroke. `close` is where auto-pairing put its `]`,
 * or null if nothing was paired.
 */
interface TypedBracket {
  open: number;
  close: number | null;
}

/**
 * The `[` from the last keystroke, so the `[[` shorthand only forms from two
 * consecutive keystrokes. In the text, a caret inside `#quote(block: true)[|]`
 * looks exactly like a half-typed `[[|]`; reading only the text, the shorthand
 * took over the quote's bracket and its completion removed the quote's `]`.
 * Anything other than typing `[` clears this.
 */
const typedOpenBracket = StateField.define<TypedBracket | null>({
  create: () => null,
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value;
    if (!tr.isUserEvent("input.type")) return null;
    let open: number | null = null;
    let close: number | null = null;
    let onlyBrackets = true;
    tr.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
      const typed = inserted.toString();
      // A replacement is a paste or an overtype, not a keystroke adding a
      // bracket. Insertions only.
      if (fromA !== toA) { onlyBrackets = false; return; }
      if (open === null && (typed === "[" || typed === "[]")) {
        open = fromB;
        // Auto-pairing inserts the closer in the same change as the opener.
        if (typed === "[]") close = fromB + 1;
      } else if (open !== null && close === null && typed === "]") {
        // Wrapping a selection inserts the two halves as separate changes.
        close = fromB;
      } else {
        onlyBrackets = false;
      }
    });
    return onlyBrackets && open !== null ? { open, close } : null;
  },
});

/** Records where the `[[` shorthand just parked its own closing brackets. */
const setParkedClosers = StateEffect.define<{ from: number; to: number } | null>();

/**
 * The two `]` the `[[` shorthand placed after the caret. A `]` in the text
 * could belong to a surrounding block, so the shorthand records its own and
 * only those are consumed. The range follows the name being typed and is
 * cleared if the brackets are deleted.
 */
const parkedClosers = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setParkedClosers)) return effect.value;
    if (!value || !tr.docChanged) return value;
    const from = tr.changes.mapPos(value.from, 1, MapMode.TrackDel);
    const to = tr.changes.mapPos(value.to, 1, MapMode.TrackDel);
    return from === null || to === null || to <= from ? null : { from, to };
  },
});

/**
 * How many `]` at `pos` the wikilink flow placed itself and may fold into the
 * `#wikilink(...)` call. Zero for brackets already in the note.
 */
function parkedCloserCount(state: EditorState, pos: number): number {
  const parked = state.field(parkedClosers, false) ?? null;
  if (!parked || pos < parked.from || pos >= parked.to) return 0;
  const count = parked.to - pos;
  return state.doc.sliceString(pos, pos + count) === "]".repeat(count) ? count : 0;
}

// The `[[` shorthand: the second `[` produces `[[|]]`, keeping brackets
// balanced while the name is typed (otherwise the parser pairs a surrounding
// block's or table cell's `]` with it and the block breaks). The closers are
// recorded in `parkedClosers` and folded into the `#wikilink(...)` call at the
// end.
//
// High precedence, so this runs before `closeBrackets()` pairs the second `[`
// itself.
const wikilinkBracketHandler = Prec.high(EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== "[") return false;
  if (from === 0 || view.state.doc.sliceString(from - 1, from) !== "[") return false;
  // In a cell editor the character before the cell is the cell's own `[`.
  const scope = view.state.field(scopeRangeField, false);
  if (scope && from - 1 < scope.from) return false;

  // Only a `[` typed on the last keystroke starts the shorthand, not one
  // already in the note (such as a block's content bracket).
  const typed = view.state.field(typedOpenBracket, false) ?? null;
  if (!typed || typed.open !== from - 1) return false;
  // Whether the `]` at the caret is the one auto-pairing added for that `[`.
  // If it isn't, it is the note's own and must be left alone.
  const autoClosed = typed.close === from;

  // With a selection, the first `[` made `[sel]` and kept `sel` selected, with
  // the paired `]` at `to`. The second `[` must make `[[sel]]`, with the caret
  // after `sel` so the picker searches for it.
  if (from !== to) {
    const closer = view.state.doc.sliceString(to, to + 1) === "]" ? to + 1 : to;
    view.dispatch({
      changes: [
        { from, to: from, insert: "[" },
        { from: closer, to: closer, insert: "]" },
      ],
      // `to` shifts +1 from the inner `[` inserted before the selection, so the
      // caret lands immediately after `sel`, before the `]]`.
      selection: { anchor: to + 1 },
      effects: setParkedClosers.of({ from: to + 1, to: to + 3 }),
    });
    return true;
  }

  // Keep the `]` auto-pairing added for the first `[` and add its twin, or
  // add both when nothing was paired, giving `[[|]]` either way.
  const closer = autoClosed ? "]" : "]]";
  view.dispatch({
    changes: [
      { from, to: from, insert: "[" },
      { from: autoClosed ? from + 1 : from, insert: closer },
    ],
    selection: { anchor: from + 1 },
    effects: setParkedClosers.of({ from: from + 1, to: from + 3 }),
  });
  return true;
}));

/**
 * A typed `]` that doesn't finish a link steps over a closer the shorthand
 * placed at the caret, as auto-pairing does with its own `]`.
 */
function stepOverParkedCloser(view: EditorView, from: number): boolean {
  if (parkedCloserCount(view.state, from) === 0) return false;
  view.dispatch({ selection: { anchor: from + 1 } });
  return true;
}

// Typing the closing `]]` of `[[Name]]` (or `[[Note::Heading]]`) turns it into
// a `#wikilink(...)` call, as if the matching row or "Create new page" were
// chosen. Fires on the second `]`, consuming it.
const wikilinkCloseHandler = Prec.high(EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== "]") return false;
  if (from !== to) return false;

  const line = view.state.doc.lineAt(from);
  const before = view.state.doc.sliceString(line.from, from);
  // Only act on the second `]`: the first closing bracket must already sit
  // immediately before the cursor.
  if (!before.endsWith("]")) return stepOverParkedCloser(view, from);

  const inner = before.slice(0, -1);
  const openIdx = inner.lastIndexOf("[[");
  if (openIdx < 0) return stepOverParkedCloser(view, from);

  const content = inner.slice(openIdx + 2);
  // A stray `[` or `]` inside means this isn't the clean `[[Name]]` shorthand;
  // an empty body is nothing to link. Leave those as literal text.
  if (content.trim() === "" || content.includes("[") || content.includes("]")) return stepOverParkedCloser(view, from);
  // A `[[` inside an inline raw span (`` `[[` ``) is literal documentation text,
  // not a link shortcut — mirror the guard in detectWikilinkContext.
  if (inVerbatimLineContext(view.state, line.from + openIdx + 1)) return stepOverParkedCloser(view, from);

  const fromPos = line.from + openIdx;
  // Consumes `[[content]` and the typed `]` is dropped. Brackets the shorthand
  // parked after the caret go with it; a `]` the note itself contains stays.
  const replaceTo = from + parkedCloserCount(view.state, from);

  const sepIdx = content.indexOf("::");
  const headingText = sepIdx >= 0 ? content.slice(sepIdx + 2) : "";
  if (sepIdx >= 0 && headingText.trim() !== "") {
    // Heading form: `[[Note::Heading]]` → `#wikilink("Note", label: "…")`,
    // resolving the heading's stable label asynchronously (mirrors acceptItem).
    const noteName = content.slice(0, sepIdx);
    void (async () => {
      let label: string | undefined;
      const path = resolveNotePath(noteName);
      if (path) {
        try {
          label = (await ipc.ensureHeadingLabel(path, headingText)) ?? undefined;
        } catch { /* fall through to the heading text */ }
      }
      const labelVal = label ?? headingText;
      const insert = `#wikilink("${typstStringEscape(noteName)}", label: "${typstStringEscape(labelVal)}")`;
      view.dispatch({
        changes: { from: fromPos, to: replaceTo, insert } as ChangeSpec,
        selection: { anchor: fromPos + insert.length },
      });
      hidePopup();
    })();
    return true;
  }

  // Plain note form (`[[Name]]`, or `[[Note::]]` with no heading typed yet).
  const noteName = sepIdx >= 0 ? content.slice(0, sepIdx) : content;
  const insert = `#wikilink("${typstStringEscape(noteName)}")`;
  view.dispatch({
    changes: { from: fromPos, to: replaceTo, insert } as ChangeSpec,
    selection: { anchor: fromPos + insert.length },
  });
  hidePopup();
  return true;
}));

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
      // Tab drills into heading mode: `::` in bracket form, `label: ""` in
      // function form. In heading mode, or on "create new", it commits like
      // Enter.
      const state = currentSuggestState;
      if (state.mode !== "note" || item.isCreate) {
        acceptItem(view, state, item);
        return true;
      }
      if (state.to === undefined) {
        // Bracket form: complete note name and append `::`
        const queryFrom = state.from + 2;
        const queryTo = queryFrom + state.query.length;
        const insertText = item.name + "::";
        view.dispatch({
          changes: { from: queryFrom, to: queryTo, insert: insertText } as ChangeSpec,
          selection: { anchor: queryFrom + insertText.length },
        });
      } else {
        // Func form: rewrite call to include label arg with cursor inside
        const insert = `#wikilink("${typstStringEscape(item.name)}", label: "")`;
        view.dispatch({
          changes: { from: state.from, to: state.to, insert } as ChangeSpec,
          selection: { anchor: state.from + insert.length - 2 },
        });
      }
      return true;
    },
  },
  {
    key: "Escape",
    run: (view) => {
      if (!isPopupVisible()) return false;
      // Escaping bracket-form heading mode (after `Foo::`): finish without a
      // label so no `[[Foo::]]` is left. The function form is already valid.
      if (currentSuggestState.mode === "heading" && currentSuggestState.to === undefined) {
        const state = currentSuggestState;
        const cursor = view.state.selection.main.from;
        const insert = `#wikilink("${typstStringEscape(state.noteName)}")`;
        view.dispatch({
          changes: { from: state.from, to: cursor + parkedCloserCount(view.state, cursor), insert } as ChangeSpec,
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

export const wikilinkSuggest: Extension = [typedOpenBracket, parkedClosers, wikilinkBracketHandler, wikilinkCloseHandler, suggestKeyHandler, suggestTracker];
