import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type ChangeSpec, type Extension } from "@codemirror/state";
import { expandFunc } from "./effects";
import { pickAndInsertAttachments } from "../../lib/attachment-insert";

interface PaletteItem {
  label: string;
  category: string;
  insert: string;
  cursorOffset?: number;
  /** When set, accepting the item runs the attachment picker instead of
   *  inserting the `insert` template. The picker copies the selected
   *  file(s) into `settings.files.attachment_folder` and emits
   *  `#image("/...")` / `#embed("/...")` with a notebox-root-absolute path.
   *  See CLAUDE.md's portable-paths principle. */
  pickAttachment?: "image" | "embed";
  /** Inline typing shortcut shown at the right edge of the row, when
   *  one exists. Purely informational — the actual trigger lives in
   *  auto-pair-typst.ts, markdown-shortcuts.ts, wikilink-suggest.ts,
   *  or is direct Typst syntax. */
  shortcut?: string;
  /** When true, dispatch `expandFunc` for the inserted call so the
   *  visual editor leaves its source brackets exposed for editing
   *  rather than collapsing into a block widget. Required for any
   *  call that the visual plugin replaces wholesale (callout, block
   *  quote, etc.) — without it, the cursor lands at the widget's
   *  edge and keystrokes appear outside the call body. Same trick the
   *  markdown shortcut for `> ` already uses. */
  expandOnInsert?: boolean;
}

const PALETTE_ITEMS: PaletteItem[] = [
  { label: "Bold", category: "Format", insert: '*${sel}*', cursorOffset: 1, shortcut: "*…*" },
  { label: "Italic", category: "Format", insert: '_${sel}_', cursorOffset: 1, shortcut: "_…_" },
  { label: "Strikethrough", category: "Format", insert: '#strike[${sel}]', cursorOffset: 8 },
  { label: "Highlight", category: "Format", insert: '#highlight[${sel}]', cursorOffset: 11 },
  { label: "Underline", category: "Format", insert: '#underline[${sel}]', cursorOffset: 11 },
  { label: "Overline", category: "Format", insert: '#overline[${sel}]', cursorOffset: 10 },
  { label: "Subscript", category: "Format", insert: '#sub[${sel}]', cursorOffset: 5 },
  { label: "Superscript", category: "Format", insert: '#super[${sel}]', cursorOffset: 7 },
  { label: "Inline code", category: "Format", insert: '`${sel}`', cursorOffset: 1, shortcut: "`…`" },
  { label: "Inline math", category: "Format", insert: '$${sel}$', cursorOffset: 1, shortcut: "$…$" },

  { label: "Heading 1", category: "Structure", insert: '= ', cursorOffset: 2, shortcut: "= " },
  { label: "Heading 2", category: "Structure", insert: '== ', cursorOffset: 3, shortcut: "== " },
  { label: "Heading 3", category: "Structure", insert: '=== ', cursorOffset: 4, shortcut: "=== " },
  { label: "Heading 4", category: "Structure", insert: '==== ', cursorOffset: 5, shortcut: "==== " },
  { label: "Heading 5", category: "Structure", insert: '===== ', cursorOffset: 6, shortcut: "===== " },
  { label: "Heading 6", category: "Structure", insert: '====== ', cursorOffset: 7, shortcut: "====== " },
  { label: "Bullet list", category: "Structure", insert: '- ', cursorOffset: 2, shortcut: "- " },
  { label: "Ordered list", category: "Structure", insert: '+ ', cursorOffset: 2, shortcut: "+ " },
  { label: "Quote (inline)", category: "Structure", insert: '#quote[${sel}]', cursorOffset: 7, expandOnInsert: true },
  { label: "Blockquote", category: "Structure", insert: '#quote(block: true)[${sel}]', cursorOffset: 20, expandOnInsert: true, shortcut: "> " },

  { label: "Link", category: "Insert", insert: '#link("")[${sel}]', cursorOffset: 7 },
  { label: "Image", category: "Insert", insert: '#image("")', cursorOffset: 8, pickAttachment: "image" },
  { label: "Code block", category: "Insert", insert: '```\n${sel}\n```', cursorOffset: 4, shortcut: "```" },
  { label: "Math block", category: "Insert", insert: '$ ${sel} $', cursorOffset: 2 },
  { label: "Horizontal rule", category: "Insert", insert: '#line(length: 100%)', cursorOffset: 19, shortcut: "+++" },
  { label: "Footnote", category: "Insert", insert: '#footnote[${sel}]', cursorOffset: 10, shortcut: "++…++" },
  { label: "Citation", category: "Insert", insert: '@', cursorOffset: 1, shortcut: "@" },

  { label: "Table", category: "Insert", insert: '#table(\n  columns: (auto, auto, auto),\n  [Header 1], [Header 2], [Header 3],\n  [], [], [],\n)', cursorOffset: 76 },

  { label: "Bibliography", category: "Insert", insert: '#bibliography("/.inkycap/zotero-export.bib")', cursorOffset: 16 },
  { label: "Page break", category: "Insert", insert: '#pagebreak()', cursorOffset: 12 },
  { label: "Line break", category: "Insert", insert: '#linebreak()', cursorOffset: 12 },
  { label: "Lorem ipsum", category: "Insert", insert: '#lorem(50)', cursorOffset: 7 },
  { label: "Figure", category: "Insert", insert: '#figure(\n  ${sel},\n  caption: [],\n)', cursorOffset: 11 },
  { label: "Align", category: "Insert", insert: '#align(center)[${sel}]', cursorOffset: 15 },
  { label: "Box", category: "Insert", insert: '#box[${sel}]', cursorOffset: 5 },
  { label: "Rect", category: "Insert", insert: '#rect[${sel}]', cursorOffset: 6 },
  { label: "Hide", category: "Insert", insert: '#hide[${sel}]', cursorOffset: 6 },
  { label: "Embed", category: "Insert", insert: '#embed("")', cursorOffset: 8, pickAttachment: "embed" },
  { label: "Callout", category: "Insert", insert: '#callout("note")[${sel}]', cursorOffset: 17, expandOnInsert: true },
  { label: "Wikilink", category: "InkyCap", insert: '#wikilink("")', cursorOffset: 11, shortcut: "[[…]]" },
  { label: "Verse", category: "InkyCap", insert: '#verse("")', cursorOffset: 8 },
  { label: "Task", category: "InkyCap", insert: '#task("")', cursorOffset: 7, shortcut: "- [ ]" },
  { label: "Due date", category: "InkyCap", insert: "#due()", cursorOffset: 5 },

  { label: "Page size", category: "Style", insert: '#set page(paper: "a4")', cursorOffset: 17 },
  { label: "Page margins", category: "Style", insert: '#set page(margin: (top: 2cm, bottom: 2cm, left: 2cm, right: 2cm))', cursorOffset: 24 },
  { label: "Page numbering", category: "Style", insert: '#set page(numbering: "1")', cursorOffset: 22 },
  { label: "Page columns", category: "Style", insert: '#set page(columns: 2)', cursorOffset: 20 },
  { label: "Text font", category: "Style", insert: '#set text(font: "")', cursorOffset: 17 },
  { label: "Text size", category: "Style", insert: '#set text(size: 12pt)', cursorOffset: 16 },
  { label: "Text language", category: "Style", insert: '#set text(lang: "en")', cursorOffset: 17 },
  { label: "Justify", category: "Style", insert: '#set par(justify: true)', cursorOffset: 22 },
  { label: "Line spacing", category: "Style", insert: '#set par(leading: 0.65em)', cursorOffset: 19 },
  { label: "Paragraph spacing", category: "Style", insert: '#set par(spacing: 1.2em)', cursorOffset: 18 },
  { label: "First line indent", category: "Style", insert: '#set par(first-line-indent: 1em)', cursorOffset: 27 },
  { label: "Heading numbering", category: "Style", insert: '#set heading(numbering: "1.1")', cursorOffset: 24 },
];

interface PaletteState {
  active: boolean;
  from: number;
  query: string;
}

const EMPTY: PaletteState = { active: false, from: 0, query: "" };

let popup: HTMLElement | null = null;
let selectedIndex = 0;
let filteredItems: PaletteItem[] = [];
let currentPaletteState: PaletteState = EMPTY;
let paletteActive = false;
let activeView: EditorView | null = null;

function getPopup(): HTMLElement {
  if (!popup) {
    popup = document.createElement("div");
    popup.className = "command-palette";
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
  currentPaletteState = EMPTY;
  paletteActive = false;
  activeView = null;
}

function detectPaletteContext(view: EditorView): PaletteState {
  const { from: cursor } = view.state.selection.main;
  if (cursor === 0) return EMPTY;

  const line = view.state.doc.lineAt(cursor);
  const textBefore = view.state.doc.sliceString(line.from, cursor);

  const slashIdx = textBefore.lastIndexOf("/");
  if (slashIdx < 0) return EMPTY;

  if (slashIdx > 0 && !/\s/.test(textBefore[slashIdx - 1])) return EMPTY;

  if (slashIdx >= 2) {
    const before = textBefore.slice(Math.max(0, slashIdx - 7), slashIdx + 1);
    if (/https?:\/$/.test(before)) return EMPTY;
  }

  const afterSlash = textBefore.slice(slashIdx + 1);
  if (afterSlash.includes(" ") || afterSlash.length > 20) return EMPTY;

  return {
    active: true,
    from: line.from + slashIdx,
    query: afterSlash,
  };
}

function filterItems(query: string): PaletteItem[] {
  if (query === "") return PALETTE_ITEMS;
  const q = query.toLowerCase();
  return PALETTE_ITEMS.filter(
    (item) =>
      item.label.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q),
  );
}

function showPopup(view: EditorView, state: PaletteState) {
  const el = getPopup();
  filteredItems = filterItems(state.query);
  currentPaletteState = state;

  if (filteredItems.length === 0) {
    hidePopup();
    return;
  }

  activeView = view;
  paletteActive = true;
  selectedIndex = 0;
  el.innerHTML = "";

  let currentCategory = "";
  for (let i = 0; i < filteredItems.length; i++) {
    const item = filteredItems[i];
    if (item.category !== currentCategory) {
      currentCategory = item.category;
      const header = document.createElement("div");
      header.className = "command-palette__category";
      header.textContent = currentCategory;
      el.appendChild(header);
    }

    const row = document.createElement("div");
    row.className = "command-palette__item";
    if (i === 0) row.classList.add("is-selected");

    const labelEl = document.createElement("span");
    labelEl.className = "command-palette__item-label";
    labelEl.textContent = item.label;
    row.appendChild(labelEl);

    if (item.shortcut) {
      const shortcutEl = document.createElement("span");
      shortcutEl.className = "command-palette__shortcut";
      shortcutEl.textContent = item.shortcut;
      row.appendChild(shortcutEl);
    }

    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      acceptItem(view, state, item);
    });
    el.appendChild(row);
  }

  const coords = view.coordsAtPos(state.from);
  if (coords) {
    const popupHeight = 300;
    const spaceBelow = window.innerHeight - coords.bottom - 8;
    const placeAbove = spaceBelow < popupHeight && coords.top > popupHeight;

    el.style.left = `${Math.min(coords.left, window.innerWidth - 330)}px`;
    if (placeAbove) {
      el.style.top = `${coords.top - popupHeight - 4}px`;
    } else {
      el.style.top = `${coords.bottom + 4}px`;
    }
  }
  el.style.display = "block";
}

function acceptItem(view: EditorView, state: PaletteState, item: PaletteItem) {
  const cursor = view.state.selection.main;
  const selectedText = view.state.doc.sliceString(cursor.from, cursor.to);
  const insert = item.insert.replace("${sel}", selectedText);
  const deleteFrom = state.from;
  const deleteTo = view.state.selection.main.from;

  // Image / Embed: open the attachment picker and replace the slash trigger
  // with a notebox-root-absolute call. The picker is async; hide the popup
  // first so the dialog can take focus cleanly.
  if (item.pickAttachment) {
    hidePopup();
    void pickAndInsertAttachments(view, deleteFrom, deleteTo, item.pickAttachment);
    return;
  }

  hidePopup();
  view.dispatch({
    changes: { from: deleteFrom, to: deleteTo, insert } as ChangeSpec,
    selection: {
      anchor: deleteFrom + (item.cursorOffset ?? insert.length),
    },
    // expandFunc keeps the call's source brackets visible after the
    // visual plugin runs, so the cursor lands inside `[…]` and typing
    // goes into the body. Without this, callout/quote/blockquote insert
    // collapses immediately into a block widget and the cursor snaps to
    // the widget edge — keystrokes then appear outside the call. Same
    // technique [src/editor/typst-decorations/markdown-shortcuts.ts](markdown-shortcuts.ts)
    // uses for the `> ` blockquote shortcut.
    effects: item.expandOnInsert ? expandFunc.of(deleteFrom) : undefined,
  });
}

function updateSelection(delta: number) {
  const el = getPopup();
  const items = el.querySelectorAll(".command-palette__item");
  if (items.length === 0) return;

  items[selectedIndex]?.classList.remove("is-selected");
  selectedIndex = (selectedIndex + delta + filteredItems.length) % filteredItems.length;
  items[selectedIndex]?.classList.add("is-selected");
  (items[selectedIndex] as HTMLElement)?.scrollIntoView({ block: "nearest" });
}

function handleKeyDown(e: KeyboardEvent) {
  if (!paletteActive || !activeView) return;

  if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    e.stopPropagation();
    const item = filteredItems[selectedIndex];
    if (item) acceptItem(activeView, currentPaletteState, item);
    return;
  }

  if (e.key === "ArrowDown") {
    e.preventDefault();
    e.stopPropagation();
    updateSelection(1);
    return;
  }

  if (e.key === "ArrowUp") {
    e.preventDefault();
    e.stopPropagation();
    updateSelection(-1);
    return;
  }

  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    hidePopup();
    return;
  }
}

let pendingFrame: number | null = null;

const paletteTracker = ViewPlugin.fromClass(
  class {
    private state: PaletteState = EMPTY;

    constructor(view: EditorView) {
      this.state = detectPaletteContext(view);
      view.contentDOM.addEventListener("keydown", handleKeyDown, true);
    }

    update(update: ViewUpdate) {
      if (!update.docChanged && !update.selectionSet) return;

      // Undo/redo can replay a doc state where a "/foo" slash query existed,
      // which would otherwise reopen the palette mid-undo. That's both a UX
      // distraction (the user is walking back through edits, not invoking
      // commands) and a source of rendering glitches: the popup overlays the
      // editor while the visual decorations are still being rebuilt against
      // the post-history syntax tree. Treat history transactions as a hard
      // suppress.
      for (const tr of update.transactions) {
        if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) {
          if (pendingFrame !== null) {
            cancelAnimationFrame(pendingFrame);
            pendingFrame = null;
          }
          hidePopup();
          this.state = EMPTY;
          return;
        }
      }

      this.state = detectPaletteContext(update.view);

      if (this.state.active) {
        const view = update.view;
        const state = this.state;
        if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
        pendingFrame = requestAnimationFrame(() => {
          pendingFrame = null;
          showPopup(view, state);
        });
      } else {
        if (pendingFrame !== null) {
          cancelAnimationFrame(pendingFrame);
          pendingFrame = null;
        }
        hidePopup();
      }
    }

    destroy() {
      if (pendingFrame !== null) {
        cancelAnimationFrame(pendingFrame);
        pendingFrame = null;
      }
      hidePopup();
    }
  },
);

export const commandPalette: Extension = paletteTracker;
