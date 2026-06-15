import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type ChangeSpec, type Extension } from "@codemirror/state";
import { expandFunc } from "./effects";
import { pickAndInsertAttachments } from "../../lib/attachment-insert";
import { buildAnnotationInsert, type InsertKind } from "./annotation-insert";
import { CURATED_SYMBOLS } from "./symbols";
import { getRegisteredPaletteItems } from "./palette-registry";
import { t } from "../../lib/i18n";

export interface PaletteItem {
  /** Stable English identifier — also the group/expanded-state key, so it must
   *  NOT be localized. Display text comes from `labelKey` when present (symbol
   *  rows keep their glyph+name `label` directly). */
  label: string;
  /** i18n key for the displayed label, resolved at render. */
  labelKey?: string;
  category: string;
  /** Static template; `${sel}` is replaced with the selection. Optional when
   *  `dynamic` is set (annotation/suggestion items build their markup at accept
   *  time so they can stamp the current author + date). */
  insert?: string;
  cursorOffset?: number;
  /** When set, the item's markup is built at accept time from the live
   *  selection — used by the annotation/suggestion entries so each carries the
   *  author's `by:`/`on:` attribution. Takes precedence over `insert`. */
  dynamic?: (sel: string) => { insert: string; cursorOffset: number; expand: boolean };
  /** When set, accepting the item runs the attachment picker instead of
   *  inserting the `insert` template. The picker copies the selected
   *  file(s) into `settings.files.attachment_folder` and emits
   *  `#image("/...")` (or `#video` / `#audio`) with a notebox-root-absolute
   *  path. See CLAUDE.md's portable-paths principle. */
  pickAttachment?: "image" | "video" | "audio";
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
  /** When set, this is a group row (e.g. "More symbols…") that has no
   *  insert of its own — selecting it (Right arrow / click / Enter) opens a
   *  side submenu listing these child items. While the user is typing a
   *  query the children are flattened into the main results so they stay
   *  searchable; the group row only appears for the empty-query browse. */
  submenu?: PaletteItem[];
  /** Render this row indented — used for a group's children when expanded. */
  indent?: boolean;
  /** When set, accepting the item runs this action instead of inserting
   *  markup. Used by runtime-contributed items (external-tool bridge, plugin
   *  commands) that *do* something rather than insert a template. Takes
   *  precedence over `insert` / `dynamic` / `pickAttachment`. The slash trigger
   *  text (`/query`) is removed before the action runs. */
  action?: (view: EditorView) => void;
}

/** Shorthand for the annotation/suggestion palette entries — builds the markup
 *  (with author attribution) from the live selection at accept time. */
const mark = (kind: InsertKind, sel: string) => buildAnnotationInsert(kind, sel);

/** Category id (stable, used for grouping) → i18n key for the display header. */
const CATEGORY_KEYS: Record<string, string> = {
  Format: "slash.cat.format",
  Structure: "slash.cat.structure",
  Insert: "slash.cat.insert",
  Symbol: "slash.cat.symbol",
  InkyCap: "slash.cat.inkycap",
  Style: "slash.cat.style",
  Tools: "slash.cat.tools",
};

/** Displayed label for a palette row: localized via `labelKey`, else the raw
 *  `label` (symbol rows). */
const itemLabel = (item: PaletteItem): string =>
  item.labelKey ? t(item.labelKey) : item.label;

/** Displayed category header for a row's category id. */
const categoryLabel = (category: string): string =>
  CATEGORY_KEYS[category] ? t(CATEGORY_KEYS[category]) : category;

/** Curated `#sym.*` named symbols (single source of truth in symbols.ts).
 *  Surfaced behind the "More symbols…" group so they don't flood the menu,
 *  but flattened back into the results when the user types a query. */
const SYMBOL_ITEMS: PaletteItem[] = CURATED_SYMBOLS.map((s) => ({
  label: `${s.char}  ${s.label}`,
  category: "Symbol",
  insert: `#sym.${s.name}`,
  cursorOffset: `#sym.${s.name}`.length,
  shortcut: `sym.${s.name}`,
  indent: true,
}));

const PALETTE_ITEMS: PaletteItem[] = [
  { label: "Bold", labelKey: "slash.bold", category: "Format", insert: '*${sel}*', cursorOffset: 1, shortcut: "*…*" },
  { label: "Italic", labelKey: "slash.italic", category: "Format", insert: '_${sel}_', cursorOffset: 1, shortcut: "_…_" },
  // `#func[…]` formatting collapses to a pill the moment the visual plugin runs.
  // expandOnInsert keeps the source brackets visible right after insertion so the
  // caret lands inside `[…]` and typing goes into the body — without it the pill
  // is atomic and CM rounds the caret to its outer edge, so text lands after `]`.
  { label: "Strikethrough", labelKey: "slash.strikethrough", category: "Format", insert: '#strike[${sel}]', cursorOffset: 8, expandOnInsert: true },
  { label: "Highlight", labelKey: "slash.highlight", category: "Format", insert: '#highlight[${sel}]', cursorOffset: 11, expandOnInsert: true },
  { label: "Underline", labelKey: "slash.underline", category: "Format", insert: '#underline[${sel}]', cursorOffset: 11, expandOnInsert: true },
  { label: "Overline", labelKey: "slash.overline", category: "Format", insert: '#overline[${sel}]', cursorOffset: 10, expandOnInsert: true },
  { label: "Subscript", labelKey: "slash.subscript", category: "Format", insert: '#sub[${sel}]', cursorOffset: 5, expandOnInsert: true },
  { label: "Superscript", labelKey: "slash.superscript", category: "Format", insert: '#super[${sel}]', cursorOffset: 7, expandOnInsert: true },
  { label: "Inline code", labelKey: "slash.inlineCode", category: "Format", insert: '`${sel}`', cursorOffset: 1, shortcut: "`…`" },
  { label: "Inline math", labelKey: "slash.inlineMath", category: "Format", insert: '$${sel}$', cursorOffset: 1, shortcut: "$…$" },

  { label: "Heading 1", labelKey: "slash.heading1", category: "Structure", insert: '= ', cursorOffset: 2, shortcut: "= " },
  { label: "Heading 2", labelKey: "slash.heading2", category: "Structure", insert: '== ', cursorOffset: 3, shortcut: "== " },
  { label: "Heading 3", labelKey: "slash.heading3", category: "Structure", insert: '=== ', cursorOffset: 4, shortcut: "=== " },
  { label: "Heading 4", labelKey: "slash.heading4", category: "Structure", insert: '==== ', cursorOffset: 5, shortcut: "==== " },
  { label: "Heading 5", labelKey: "slash.heading5", category: "Structure", insert: '===== ', cursorOffset: 6, shortcut: "===== " },
  { label: "Heading 6", labelKey: "slash.heading6", category: "Structure", insert: '====== ', cursorOffset: 7, shortcut: "====== " },
  { label: "Bullet list", labelKey: "slash.bulletList", category: "Structure", insert: '- ', cursorOffset: 2, shortcut: "- " },
  { label: "Ordered list", labelKey: "slash.orderedList", category: "Structure", insert: '+ ', cursorOffset: 2, shortcut: "+ " },
  { label: "Term list", labelKey: "slash.termList", category: "Structure", insert: '/ ', cursorOffset: 2, shortcut: "/ Term: …" },
  { label: "Quote (inline)", labelKey: "slash.quoteInline", category: "Structure", insert: '#quote[${sel}]', cursorOffset: 7, expandOnInsert: true },
  { label: "Blockquote", labelKey: "slash.blockquote", category: "Structure", insert: '#quote(block: true)[${sel}]', cursorOffset: 20, expandOnInsert: true, shortcut: "> " },

  { label: "Link", labelKey: "slash.link", category: "Insert", insert: '#link("")[${sel}]', cursorOffset: 7 },
  { label: "Image", labelKey: "slash.image", category: "Insert", insert: '#image("")', cursorOffset: 8, pickAttachment: "image" },
  { label: "Video", labelKey: "slash.video", category: "Insert", insert: '#video("")', cursorOffset: 8, pickAttachment: "video" },
  { label: "Audio", labelKey: "slash.audio", category: "Insert", insert: '#audio("")', cursorOffset: 8, pickAttachment: "audio" },
  { label: "Code block", labelKey: "slash.codeBlock", category: "Insert", insert: '```\n${sel}\n```', cursorOffset: 4, shortcut: "```" },
  { label: "Math block", labelKey: "slash.mathBlock", category: "Insert", insert: '$ ${sel} $', cursorOffset: 2 },
  { label: "Horizontal rule", labelKey: "slash.horizontalRule", category: "Insert", insert: '#line(length: 100%)', cursorOffset: 19, shortcut: "+++" },
  { label: "Footnote", labelKey: "slash.footnote", category: "Insert", insert: '#footnote[${sel}]', cursorOffset: 10, shortcut: "++…++" },
  { label: "Citation", labelKey: "slash.citation", category: "Insert", insert: '@', cursorOffset: 1, shortcut: "@" },
  { label: "Label", labelKey: "slash.label", category: "Insert", insert: '<>', cursorOffset: 1, shortcut: "<…>" },

  { label: "Table", labelKey: "slash.table", category: "Insert", insert: '#table(\n  columns: (auto, auto, auto),\n  [Header 1], [Header 2], [Header 3],\n  [], [], [],\n)', cursorOffset: 76 },

  { label: "Bibliography", labelKey: "slash.bibliography", category: "Insert", insert: '#bibliography("/.inkycap/zotero-export.bib")', cursorOffset: 16 },
  { label: "Page break", labelKey: "slash.pageBreak", category: "Insert", insert: '#pagebreak()', cursorOffset: 12 },
  { label: "Line break", labelKey: "slash.lineBreak", category: "Insert", insert: '#linebreak()', cursorOffset: 12 },
  { label: "Lorem ipsum", labelKey: "slash.loremIpsum", category: "Insert", insert: '#lorem(50)', cursorOffset: 7 },
  { label: "Figure", labelKey: "slash.figure", category: "Insert", insert: '#figure(\n  [${sel}],\n  caption: [],\n)', cursorOffset: 12, expandOnInsert: true },
  { label: "Align", labelKey: "slash.align", category: "Insert", insert: '#align(center)[${sel}]', cursorOffset: 15 },
  { label: "Box", labelKey: "slash.box", category: "Insert", insert: '#box[${sel}]', cursorOffset: 5 },
  { label: "Rect", labelKey: "slash.rect", category: "Insert", insert: '#rect[${sel}]', cursorOffset: 6 },
  { label: "Hide", labelKey: "slash.hide", category: "Insert", insert: '#hide[${sel}]', cursorOffset: 6 },
  { label: "Callout", labelKey: "slash.callout", category: "Insert", insert: '#callout("note")[${sel}]', cursorOffset: 17, expandOnInsert: true },

  // Symbol shorthands — Typst's parser-level abbreviations that compile to
  // typographic characters. We insert the shorthand sequence (not the literal
  // glyph) so the source stays Typst-native and the ShorthandWidget renders it.
  { label: "Em dash (—)", labelKey: "slash.emDash", category: "Symbol", insert: '---', cursorOffset: 3, shortcut: "---" },
  { label: "En dash (–)", labelKey: "slash.enDash", category: "Symbol", insert: '--', cursorOffset: 2, shortcut: "--" },
  { label: "Ellipsis (…)", labelKey: "slash.ellipsis", category: "Symbol", insert: '...', cursorOffset: 3, shortcut: "..." },
  { label: "Non-breaking space", labelKey: "slash.nbsp", category: "Symbol", insert: '~', cursorOffset: 1, shortcut: "~" },
  { label: "Soft hyphen", labelKey: "slash.softHyphen", category: "Symbol", insert: '-?', cursorOffset: 2, shortcut: "-?" },
  { label: "More symbols…", labelKey: "slash.moreSymbols", category: "Symbol", submenu: SYMBOL_ITEMS },

  { label: "Wikilink", labelKey: "slash.wikilink", category: "InkyCap", insert: '#wikilink("")', cursorOffset: 11, shortcut: "[[…]]" },
  { label: "Verse", labelKey: "slash.verse", category: "InkyCap", insert: '#verse("")', cursorOffset: 8 },
  { label: "Annotation", labelKey: "slash.annotation", category: "InkyCap", dynamic: (s) => mark("annotation", s) },
  { label: "Suggest insertion", labelKey: "slash.suggestInsertion", category: "InkyCap", dynamic: (s) => mark("insert", s) },
  { label: "Suggest deletion", labelKey: "slash.suggestDeletion", category: "InkyCap", dynamic: (s) => mark("delete", s) },
  { label: "Suggest replacement", labelKey: "slash.suggestReplacement", category: "InkyCap", dynamic: (s) => mark("replace", s) },
  { label: "Task", labelKey: "slash.task", category: "InkyCap", insert: '#task("")', cursorOffset: 7, shortcut: "- [ ]" },
  { label: "Due date", labelKey: "slash.dueDate", category: "InkyCap", insert: "#due()", cursorOffset: 5 },

  { label: "Page size", labelKey: "slash.pageSize", category: "Style", insert: '#set page(paper: "a4")', cursorOffset: 17 },
  { label: "Page margins", labelKey: "slash.pageMargins", category: "Style", insert: '#set page(margin: (top: 2cm, bottom: 2cm, left: 2cm, right: 2cm))', cursorOffset: 24 },
  { label: "Page numbering", labelKey: "slash.pageNumbering", category: "Style", insert: '#set page(numbering: "1")', cursorOffset: 22 },
  { label: "Page columns", labelKey: "slash.pageColumns", category: "Style", insert: '#set page(columns: 2)', cursorOffset: 20 },
  { label: "Text font", labelKey: "slash.textFont", category: "Style", insert: '#set text(font: "")', cursorOffset: 17 },
  { label: "Text size", labelKey: "slash.textSize", category: "Style", insert: '#set text(size: 12pt)', cursorOffset: 16 },
  { label: "Text language", labelKey: "slash.textLanguage", category: "Style", insert: '#set text(lang: "en")', cursorOffset: 17 },
  { label: "Justify", labelKey: "slash.justify", category: "Style", insert: '#set par(justify: true)', cursorOffset: 22 },
  { label: "Line spacing", labelKey: "slash.lineSpacing", category: "Style", insert: '#set par(leading: 0.65em)', cursorOffset: 19 },
  { label: "Paragraph spacing", labelKey: "slash.paragraphSpacing", category: "Style", insert: '#set par(spacing: 1.2em)', cursorOffset: 18 },
  { label: "First line indent", labelKey: "slash.firstLineIndent", category: "Style", insert: '#set par(first-line-indent: 1em)', cursorOffset: 27 },
  { label: "Heading numbering", labelKey: "slash.headingNumbering", category: "Style", insert: '#set heading(numbering: "1.1")', cursorOffset: 24 },
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

// Labels of group rows (e.g. "More symbols…") currently expanded inline.
const expandedGroups = new Set<string>();

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
  expandedGroups.clear();
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

function buildDisplayList(query: string): PaletteItem[] {
  // Built-in items plus any contributed at runtime (external-tool bridge,
  // plugin manifests). Registered items are appended so they group after the
  // built-in categories.
  const all = [...PALETTE_ITEMS, ...getRegisteredPaletteItems()];
  // Querying: flatten group rows into their children so submenu items
  // (curated symbols) remain directly searchable, then filter everything.
  if (query !== "") {
    const q = query.toLowerCase();
    const flattened = all.flatMap((item) => item.submenu ?? [item]);
    return flattened.filter(
      (item) =>
        itemLabel(item).toLowerCase().includes(q) ||
        categoryLabel(item.category).toLowerCase().includes(q),
    );
  }
  // Empty query: browse view — group rows stay collapsed unless expanded, in
  // which case their children are spliced in directly beneath them.
  const out: PaletteItem[] = [];
  for (const item of all) {
    out.push(item);
    if (item.submenu && expandedGroups.has(item.label)) {
      out.push(...item.submenu);
    }
  }
  return out;
}

function showPopup(view: EditorView, state: PaletteState) {
  const el = getPopup();
  filteredItems = buildDisplayList(state.query);
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
      header.textContent = categoryLabel(currentCategory);
      el.appendChild(header);
    }

    const row = document.createElement("div");
    row.className = "command-palette__item";
    if (item.indent) row.classList.add("command-palette__item--child");
    if (i === 0) row.classList.add("is-selected");

    const labelEl = document.createElement("span");
    labelEl.className = "command-palette__item-label";
    labelEl.textContent = itemLabel(item);
    row.appendChild(labelEl);

    if (item.shortcut) {
      const shortcutEl = document.createElement("span");
      shortcutEl.className = "command-palette__shortcut";
      shortcutEl.textContent = item.shortcut;
      row.appendChild(shortcutEl);
    }

    if (item.submenu) {
      row.classList.add("command-palette__item--group");
      const caret = document.createElement("span");
      caret.className = "command-palette__submenu-caret";
      caret.textContent = expandedGroups.has(item.label) ? "⌄" : "›";
      row.appendChild(caret);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        toggleGroup(view, state, item);
      });
    } else {
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        acceptItem(view, state, item);
      });
    }
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
  // `dynamic` items (annotation/suggestion) build their markup + caret + expand
  // at accept time so the author's `by:`/`on:` are stamped; the rest use their
  // static template with the selection substituted in.
  const built = item.dynamic?.(selectedText);
  const insert = built ? built.insert : (item.insert ?? "").replace("${sel}", selectedText);
  const cursorOffset = built ? built.cursorOffset : item.cursorOffset;
  const expand = built ? built.expand : item.expandOnInsert;
  const deleteFrom = state.from;
  const deleteTo = view.state.selection.main.from;

  // Action items (external-tool bridge, plugin commands) perform work instead
  // of inserting a template. Remove the slash trigger first, then run the
  // action against the now-clean document.
  if (item.action) {
    hidePopup();
    view.dispatch({ changes: { from: deleteFrom, to: deleteTo, insert: "" } as ChangeSpec });
    item.action(view);
    return;
  }

  // Image: open the attachment picker and replace the slash trigger with a
  // notebox-root-absolute call. The picker is async; hide the popup first so
  // the dialog can take focus cleanly.
  if (item.pickAttachment) {
    hidePopup();
    void pickAndInsertAttachments(view, deleteFrom, deleteTo, item.pickAttachment);
    return;
  }

  hidePopup();
  view.dispatch({
    changes: { from: deleteFrom, to: deleteTo, insert } as ChangeSpec,
    selection: {
      anchor: deleteFrom + (cursorOffset ?? insert.length),
    },
    // expandFunc keeps the call's source brackets visible after the
    // visual plugin runs, so the cursor lands inside `[…]` and typing
    // goes into the body. Without this, callout/quote/blockquote insert
    // collapses immediately into a block widget and the cursor snaps to
    // the widget edge — keystrokes then appear outside the call. Same
    // technique [src/editor/typst-decorations/markdown-shortcuts.ts](markdown-shortcuts.ts)
    // uses for the `> ` blockquote shortcut.
    effects: expand ? expandFunc.of(deleteFrom) : undefined,
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

/** Expand or collapse a group row (e.g. "More symbols…") inline: its children
 *  are spliced into the list directly beneath it. Re-renders and keeps the
 *  group row selected so keyboard focus doesn't jump. */
function toggleGroup(view: EditorView, state: PaletteState, item: PaletteItem) {
  if (expandedGroups.has(item.label)) expandedGroups.delete(item.label);
  else expandedGroups.add(item.label);

  showPopup(view, state); // rebuilds the list with/without the children
  const idx = filteredItems.indexOf(item);
  if (idx >= 0) {
    const rows = getPopup().querySelectorAll(".command-palette__item");
    rows[selectedIndex]?.classList.remove("is-selected");
    selectedIndex = idx;
    rows[idx]?.classList.add("is-selected");
    (rows[idx] as HTMLElement)?.scrollIntoView({ block: "nearest" });
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if (!paletteActive || !activeView) return;

  if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    e.stopPropagation();
    const item = filteredItems[selectedIndex];
    // A group row (e.g. "More symbols…") toggles its inline children instead
    // of inserting; everything else inserts its markup.
    if (item?.submenu) toggleGroup(activeView, currentPaletteState, item);
    else if (item) acceptItem(activeView, currentPaletteState, item);
    return;
  }

  if (e.key === "ArrowRight") {
    const item = filteredItems[selectedIndex];
    if (item?.submenu && !expandedGroups.has(item.label)) {
      e.preventDefault();
      e.stopPropagation();
      toggleGroup(activeView, currentPaletteState, item);
    }
    return;
  }

  if (e.key === "ArrowLeft") {
    const item = filteredItems[selectedIndex];
    if (item?.submenu && expandedGroups.has(item.label)) {
      e.preventDefault();
      e.stopPropagation();
      toggleGroup(activeView, currentPaletteState, item);
    }
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
