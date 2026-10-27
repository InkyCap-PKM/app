import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { StateField, type ChangeSpec, type Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { applyToggleEmphasis, applyToggleWrap } from "./wrap-format";
import { VERSE_ICON_SVG } from "../../components/icons/verse";
import { t, localeVersion } from "../../lib/i18n";
import { positionPopupAtAnchor } from "./popup-position";

/* ── Inline format actions (always-visible buttons) ─────── */

interface InlineAction {
  icon: string;
  svgIcon?: string;
  /** i18n key for the button tooltip, resolved at DOM-build time. */
  titleKey: string;
  wrap: [string, string];
  /**
   * The Typst function for this format, for the two shorthand markers that only
   * work outside a word. When set, the action uses `applyToggleEmphasis`, which
   * picks a form Typst reads here.
   */
  emphasisFunc?: string;
  styleBold?: boolean;
  styleItalic?: boolean;
  styleStrike?: boolean;
  styleUnderline?: boolean;
}

const INLINE_ACTIONS: InlineAction[] = [
  { icon: "B", titleKey: "selToolbar.bold", wrap: ["*", "*"], emphasisFunc: "strong", styleBold: true },
  { icon: "I", titleKey: "selToolbar.italic", wrap: ["_", "_"], emphasisFunc: "emph", styleItalic: true },
  { icon: "U", titleKey: "selToolbar.underline", wrap: ["#underline[", "]"], styleUnderline: true },
  { icon: "S", titleKey: "selToolbar.strike", wrap: ["#strike[", "]"], styleStrike: true },
];

/* ── SVG icons ──────────────────────────────────────────── */

const ICON_LINK = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 11.5a4 4 0 0 0 5.66 0l2-2a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M11.5 8.5a4 4 0 0 0-5.66 0l-2 2a4 4 0 0 0 5.66 5.66l1-1"/></svg>`;

const ICON_CODE = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 14 2 10 6 6"/><polyline points="14 6 18 10 14 14"/></svg>`;

const ICON_ALIGN_LEFT = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="4" x2="17" y2="4"/><line x1="3" y1="8" x2="13" y2="8"/><line x1="3" y1="12" x2="17" y2="12"/><line x1="3" y1="16" x2="11" y2="16"/></svg>`;

const ICON_ALIGN_CENTER = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="4" x2="17" y2="4"/><line x1="5" y1="8" x2="15" y2="8"/><line x1="3" y1="12" x2="17" y2="12"/><line x1="6" y1="16" x2="14" y2="16"/></svg>`;

const ICON_ALIGN_RIGHT = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="4" x2="17" y2="4"/><line x1="7" y1="8" x2="17" y2="8"/><line x1="3" y1="12" x2="17" y2="12"/><line x1="9" y1="16" x2="17" y2="16"/></svg>`;

const ICON_CHEVRON = `<svg viewBox="0 0 10 10" width="8" height="8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 4 5 7 8 4"/></svg>`;

const ICON_BULLET = `<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><circle cx="4" cy="4.5" r="2"/><rect x="8" y="3.5" width="6" height="2" rx="1"/><circle cx="4" cy="11.5" r="2"/><rect x="8" y="10.5" width="6" height="2" rx="1"/></svg>`;

const ICON_SUPERSCRIPT = `<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor"><text x="0" y="17" font-size="14" font-family="serif">x</text><text x="11" y="8" font-size="9" font-family="serif">2</text></svg>`;

const ICON_SUBSCRIPT = `<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor"><text x="0" y="13" font-size="14" font-family="serif">x</text><text x="11" y="18" font-size="9" font-family="serif">2</text></svg>`;

const ICON_FOOTNOTE = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="3" y="6" width="9" height="1.6" rx="0.8"/><rect x="3" y="11" width="11" height="1.6" rx="0.8"/><rect x="3" y="16" width="7" height="1.6" rx="0.8"/><text x="15" y="9" font-size="9" font-family="serif">1</text></svg>`;


/* ── Dropdown block/structure items ─────────────────────── */

interface DropdownItem {
  /**
   * Fixed English identifier, also used for per-item styling (heading level,
   * below), so it must not be translated. Display text comes from `labelKey`.
   */
  label: string;
  /** i18n key for the displayed label, resolved at DOM-build time. */
  labelKey?: string;
  icon?: string;
  action: (view: EditorView) => void;
  separator?: boolean;
}

// Line-prefix markup removed before applying another: headings, list markers
// (including `1. `) and task boxes, so a numbered list becomes bullets without
// `- 1. item`.
const BLOCK_PREFIX = /^(=+ |[+\-] |\d+\. |\[[ x]\] )/;

// Apply `transform` to every line the selection touches, in one transaction,
// keeping each line's indentation so nested items stay nested.
function eachSelectedLine(view: EditorView, transform: (rest: string, indent: string) => string) {
  const { from, to } = view.state.selection.main;
  const startLine = view.state.doc.lineAt(from).number;
  const endLine = view.state.doc.lineAt(to).number;
  const changes: ChangeSpec[] = [];
  for (let n = startLine; n <= endLine; n++) {
    const line = view.state.doc.line(n);
    const indent = line.text.match(/^[ \t]*/)?.[0] ?? "";
    const rest = line.text.slice(indent.length);
    // Skip blank lines so list/heading conversion never sprays stray markers
    // onto empty rows inside the selection.
    if (rest.length === 0) continue;
    const next = indent + transform(rest, indent);
    if (next !== line.text) {
      changes.push({ from: line.from, to: line.to, insert: next });
    }
  }
  if (changes.length) view.dispatch({ changes });
  view.focus();
}

function insertAtLineStart(view: EditorView, prefix: string) {
  eachSelectedLine(view, (rest) => prefix + rest);
}

function replaceLinePrefix(view: EditorView, newPrefix: string) {
  eachSelectedLine(view, (rest) => newPrefix + rest.replace(BLOCK_PREFIX, ""));
}

function clearLinePrefix(view: EditorView) {
  eachSelectedLine(view, (rest) => rest.replace(BLOCK_PREFIX, ""));
}

const DROPDOWN_ITEMS: DropdownItem[] = [
  {
    label: "Bulleted list",
    labelKey: "selToolbar.bulletedList",
    icon: ICON_BULLET,
    action: (v) => replaceLinePrefix(v, "- "),
  },
  {
    label: "Numbered list",
    labelKey: "selToolbar.numberedList",
    icon: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><text x="2" y="6" font-size="7" font-family="serif">1.</text><rect x="8" y="3.5" width="6" height="2" rx="1"/><text x="2" y="13" font-size="7" font-family="serif">2.</text><rect x="8" y="10.5" width="6" height="2" rx="1"/></svg>`,
    action: (v) => replaceLinePrefix(v, "+ "),
  },
  { label: "", separator: true, action: () => {} },
  {
    label: "Highlight",
    labelKey: "selToolbar.highlight",
    icon: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>`,
    action: (v) => applyToggleWrap(v, "#highlight[", "]"),
  },
  {
    label: "Callout",
    labelKey: "selToolbar.callout",
    icon: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M13 8H7"/><path d="M17 12H7"/></svg>`,
    action: (v) => applyToggleWrap(v, '#callout("note")[', "]"),
  },
  { label: "", separator: true, action: () => {} },
  {
    label: "Regular Text",
    labelKey: "selToolbar.regularText",
    action: (v) => clearLinePrefix(v),
  },
  {
    label: "Heading 1",
    labelKey: "selToolbar.heading1",
    action: (v) => replaceLinePrefix(v, "= "),
  },
  {
    label: "Heading 2",
    labelKey: "selToolbar.heading2",
    action: (v) => replaceLinePrefix(v, "== "),
  },
  {
    label: "Heading 3",
    labelKey: "selToolbar.heading3",
    action: (v) => replaceLinePrefix(v, "=== "),
  },
  {
    label: "Heading 4",
    labelKey: "selToolbar.heading4",
    action: (v) => replaceLinePrefix(v, "==== "),
  },
  {
    label: "Heading 5",
    labelKey: "selToolbar.heading5",
    action: (v) => replaceLinePrefix(v, "===== "),
  },
  {
    label: "Heading 6",
    labelKey: "selToolbar.heading6",
    action: (v) => replaceLinePrefix(v, "====== "),
  },
];

/* ── Toolbar DOM construction ───────────────────────────── */

let toolbar: HTMLElement | null = null;
let dropdown: HTMLElement | null = null;
let alignPopup: HTMLElement | null = null;
let activeView: EditorView | null = null;

// The toolbar, dropdown and popup DOM is built once, with labels from `t()`.
// Record the locale version it was built with and discard it when the language
// changes, so `showToolbar` rebuilds it (CM6 extensions are outside Solid's
// reactivity; the search panel uses `relocalize` likewise).
let builtLocaleVersion = -1;

// Document listeners belong to the module, so a rebuild doesn't add them twice.
let documentListenersInstalled = false;

function ensureFreshLocale() {
  const v = localeVersion();
  if (v === builtLocaleVersion) return;
  builtLocaleVersion = v;
  toolbar?.remove();
  dropdown?.remove();
  alignPopup?.remove();
  toolbar = null;
  dropdown = null;
  alignPopup = null;
}

function closeDropdown() {
  if (dropdown) dropdown.style.display = "none";
}

function closeAlignPopup() {
  if (alignPopup) alignPopup.style.display = "none";
}

function closeAllPopups() {
  closeDropdown();
  closeAlignPopup();
}

function createSvgButton(svgHtml: string, title: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "selection-toolbar__btn";
  btn.innerHTML = svgHtml;
  btn.title = title;
  return btn;
}

function getToolbar(): HTMLElement {
  ensureFreshLocale();
  if (!toolbar) {
    toolbar = document.createElement("div");
    toolbar.className = "selection-toolbar";
    toolbar.style.display = "none";

    /* ── Block-type dropdown trigger ── */
    const dropdownTrigger = document.createElement("button");
    dropdownTrigger.className = "selection-toolbar__btn selection-toolbar__dropdown-trigger";
    dropdownTrigger.innerHTML = ICON_BULLET + ICON_CHEVRON;
    dropdownTrigger.title = t("selToolbar.blockType");
    dropdownTrigger.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeAlignPopup();
      toggleDropdown();
    });
    toolbar.appendChild(dropdownTrigger);

    /* ── Separator ── */
    toolbar.appendChild(createSeparator());

    /* ── Inline format buttons ── */
    for (const action of INLINE_ACTIONS) {
      const btn = document.createElement("button");
      btn.className = "selection-toolbar__btn";
      btn.textContent = action.icon;
      btn.title = t(action.titleKey);
      if (action.styleBold) btn.style.fontWeight = "bold";
      if (action.styleItalic) btn.style.fontStyle = "italic";
      if (action.styleStrike) btn.style.textDecoration = "line-through";
      if (action.styleUnderline) btn.style.textDecoration = "underline";

      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        closeAllPopups();
        if (!activeView) return;
        if (action.emphasisFunc) {
          applyToggleEmphasis(activeView, action.wrap[0], action.emphasisFunc);
        } else {
          applyToggleWrap(activeView, action.wrap[0], action.wrap[1]);
        }
      });
      toolbar.appendChild(btn);
    }

    /* ── Superscript / subscript / footnote ──
     * Content-bracket wrappers around the selection. `applyToggleWrap`
     * removes them when already present, as for B/I/U/S. */
    const wrapButtons: { svg: string; titleKey: string; wrap: [string, string] }[] = [
      { svg: ICON_SUPERSCRIPT, titleKey: "selToolbar.superscript", wrap: ["#super[", "]"] },
      { svg: ICON_SUBSCRIPT, titleKey: "selToolbar.subscript", wrap: ["#sub[", "]"] },
      { svg: ICON_FOOTNOTE, titleKey: "selToolbar.footnote", wrap: ["#footnote[", "]"] },
    ];
    for (const b of wrapButtons) {
      const btn = createSvgButton(b.svg, t(b.titleKey));
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        closeAllPopups();
        if (!activeView) return;
        applyToggleWrap(activeView, b.wrap[0], b.wrap[1]);
      });
      toolbar.appendChild(btn);
    }

    /* ── Separator ── */
    toolbar.appendChild(createSeparator());

    /* ── Link button ── */
    const linkBtn = createSvgButton(ICON_LINK, t("selToolbar.link"));
    linkBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      closeAllPopups();
      if (!activeView) return;
      // Put the caret in the empty URL (`#link("⎸")[label]`); the selection
      // becomes the label.
      applyToggleWrap(activeView, '#link("")[', "]", '#link("'.length);
    });
    toolbar.appendChild(linkBtn);

    /* ── Alignment button ── */
    const alignBtn = createSvgButton(ICON_ALIGN_LEFT, t("selToolbar.align"));
    alignBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeDropdown();
      toggleAlignPopup(alignBtn);
    });
    toolbar.appendChild(alignBtn);

    /* ── Separator ── */
    toolbar.appendChild(createSeparator());

    /* ── Verse button ── */
    const verseBtn = createSvgButton(VERSE_ICON_SVG, t("selToolbar.verse"));
    verseBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      closeAllPopups();
      if (!activeView) return;
      const { from, to } = activeView.state.selection.main;
      const selected = activeView.state.doc.sliceString(from, to);
      const insert = `#verse("${selected}")`;
      activeView.dispatch({
        changes: { from, to, insert } as ChangeSpec,
        selection: { anchor: from + 8, head: from + 8 + selected.length },
      });
      activeView.focus();
    });
    toolbar.appendChild(verseBtn);

    /* ── Code button ── */
    const codeBtn = createSvgButton(ICON_CODE, t("selToolbar.code"));
    codeBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      closeAllPopups();
      if (!activeView) return;
      applyToggleWrap(activeView, "`", "`");
    });
    toolbar.appendChild(codeBtn);

    /* ── Math button ── */
    const mathBtn = document.createElement("button");
    mathBtn.className = "selection-toolbar__btn";
    mathBtn.textContent = "∑";
    mathBtn.title = t("selToolbar.math");
    mathBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      closeAllPopups();
      if (!activeView) return;
      applyToggleWrap(activeView, "$", "$");
    });
    toolbar.appendChild(mathBtn);

    document.body.appendChild(toolbar);
    installDocumentListeners();
  }
  return toolbar;
}

/** Is either pop-up (the overflow menu or the alignment picker) showing? */
function anyPopupOpen(): boolean {
  const showing = (el: HTMLElement | null) => !!el && el.style.display !== "none";
  return showing(dropdown) || showing(alignPopup);
}

/** Dismiss the pop-ups on Escape and on an outside click. Installed once. */
function installDocumentListeners(): void {
  if (documentListenersInstalled) return;
  documentListenersInstalled = true;

  /* Escape closes them, as for other menus. Only when one is open, so Escape
   * still reaches later handlers otherwise. */
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !anyPopupOpen()) return;
    e.preventDefault();
    closeAllPopups();
  }, true);

  /* Close popups on outside click */
  document.addEventListener("mousedown", (e) => {
    if (dropdown && dropdown.style.display !== "none" &&
        !dropdown.contains(e.target as Node) &&
        !(e.target as Element)?.closest(".selection-toolbar__dropdown-trigger")) {
      closeDropdown();
    }
    if (alignPopup && alignPopup.style.display !== "none" &&
        !alignPopup.contains(e.target as Node) &&
        !(e.target as Element)?.closest(".selection-toolbar__btn")) {
      closeAlignPopup();
    }
  });
}

function createSeparator(): HTMLElement {
  const sep = document.createElement("div");
  sep.className = "selection-toolbar__sep";
  return sep;
}

function getDropdown(): HTMLElement {
  if (!dropdown) {
    dropdown = document.createElement("div");
    dropdown.className = "selection-toolbar__menu";
    dropdown.style.display = "none";

    for (const item of DROPDOWN_ITEMS) {
      if (item.separator) {
        const sep = document.createElement("div");
        sep.className = "selection-toolbar__menu-sep";
        dropdown.appendChild(sep);
        continue;
      }

      const row = document.createElement("button");
      row.className = "selection-toolbar__menu-item";

      if (item.icon) {
        const iconSpan = document.createElement("span");
        iconSpan.className = "selection-toolbar__menu-icon";
        iconSpan.innerHTML = item.icon;
        row.appendChild(iconSpan);
      }

      const labelSpan = document.createElement("span");
      labelSpan.className = "selection-toolbar__menu-label";
      labelSpan.textContent = item.labelKey ? t(item.labelKey) : item.label;

      if (item.label === "Title") {
        labelSpan.style.fontWeight = "700";
        labelSpan.style.fontSize = "1.1em";
      } else if (item.label.startsWith("Heading ")) {
        const level = parseInt(item.label.replace("Heading ", ""), 10);
        const sizes = [1.05, 0.95, 0.9, 0.85, 0.82, 0.8];
        const weights = ["700", "700", "600", "600", "500", "500"];
        labelSpan.style.fontSize = `${sizes[level - 1]}em`;
        labelSpan.style.fontWeight = weights[level - 1];
        labelSpan.style.fontFamily = "var(--editor-font-mono, monospace)";
      }

      row.appendChild(labelSpan);

      const run = () => {
        closeAllPopups();
        if (activeView) {
          item.action(activeView);
          activeView.focus();
        }
      };
      // mousedown, with the default prevented, so the editor keeps its
      // selection while the item runs.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        run();
      });
      // Keyboard activation is a click with no mousedown (lib/menu-nav.ts);
      // `detail === 0` marks it, so a real click doesn't run twice.
      row.addEventListener("click", (e) => {
        if (e.detail !== 0) return;
        run();
      });

      dropdown.appendChild(row);
    }

    document.body.appendChild(dropdown);
  }
  return dropdown;
}

function getAlignPopup(anchorBtn: HTMLElement): HTMLElement {
  if (!alignPopup) {
    alignPopup = document.createElement("div");
    alignPopup.className = "selection-toolbar__align-popup";
    alignPopup.style.display = "none";

    const aligns: { icon: string; labelKey: string; value: string }[] = [
      { icon: ICON_ALIGN_LEFT, labelKey: "selToolbar.alignLeft", value: "left" },
      { icon: ICON_ALIGN_CENTER, labelKey: "selToolbar.alignCenter", value: "center" },
      { icon: ICON_ALIGN_RIGHT, labelKey: "selToolbar.alignRight", value: "right" },
    ];

    for (const a of aligns) {
      const btn = createSvgButton(a.icon, t(a.labelKey));
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        closeAllPopups();
        if (!activeView) return;
        applyToggleWrap(activeView, `#align(${a.value})[`, "]");
      });
      alignPopup.appendChild(btn);
    }

    document.body.appendChild(alignPopup);
  }
  return alignPopup;
}

function toggleDropdown() {
  const dd = getDropdown();
  if (dd.style.display !== "none") {
    dd.style.display = "none";
    return;
  }
  if (!toolbar) return;
  // Anchor to the toolbar's own rect, so a menu that has to flip upward (near
  // the bottom of the viewport) clears the toolbar instead of covering it.
  positionPopupAtAnchor(dd, toolbar.getBoundingClientRect(), { display: "flex" });
}

function toggleAlignPopup(anchorBtn: HTMLElement) {
  const ap = getAlignPopup(anchorBtn);
  if (ap.style.display !== "none") {
    ap.style.display = "none";
    return;
  }
  // Align horizontally with the button but vertically with the toolbar's edges,
  // so the popup has the same gap as the block-type dropdown instead of nearly
  // touching (or, upward, overlapping) the toolbar.
  const btnRect = anchorBtn.getBoundingClientRect();
  const tbRect = toolbar?.getBoundingClientRect();
  positionPopupAtAnchor(
    ap,
    {
      left: btnRect.left,
      right: btnRect.right,
      top: tbRect ? tbRect.top : btnRect.top,
      bottom: tbRect ? tbRect.bottom : btnRect.bottom,
    },
    { display: "flex" },
  );
}

/* ── Core toolbar logic ─────────────────────────────────── */

function hideToolbar() {
  closeAllPopups();
  const el = getToolbar();
  el.style.display = "none";
}

function isInsideRaw(view: EditorView, from: number, to: number): boolean {
  const tree = syntaxTree(view.state);
  let inside = false;
  tree.iterate({
    from, to,
    enter(node) {
      if (node.name === "Raw" || node.name === "RawBlock") {
        if (node.from <= from && node.to >= to) inside = true;
      }
    },
  });
  return inside;
}

function showToolbar(view: EditorView) {
  activeView = view;
  const { from, to } = view.state.selection.main;
  if (from === to) {
    hideToolbar();
    return;
  }

  if (isInsideRaw(view, from, to)) {
    hideToolbar();
    return;
  }

  const el = getToolbar();
  const startCoords = view.coordsAtPos(from);
  const endCoords = view.coordsAtPos(to);
  if (!startCoords || !endCoords) {
    hideToolbar();
    return;
  }

  // Anchor to the selection's bounds: centred above it, or below the last line
  // when the selection is near the top, staying off the text; the helper keeps
  // it within the margins.
  positionPopupAtAnchor(
    el,
    {
      left: startCoords.left,
      right: endCoords.right,
      top: startCoords.top,
      bottom: endCoords.bottom,
    },
    { display: "flex", prefer: "above", align: "center", gap: 8 },
  );
}

/* ── User-gesture gate ───────────────────────────────────── */

// Whether the current selection came from the user (drag, double or triple
// click, Shift+arrow) rather than code (a search reveal, go-to-line, …). CM6
// tags user selections `select.*`; find's `select.search` is excluded so
// searching doesn't bring up the toolbar. Kept through edits, so clicking a
// toolbar button (which dispatches without a userEvent) doesn't hide it.
const userSelectionField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    if (tr.newSelection.main.empty) return false;
    if (tr.isUserEvent("select") && !tr.isUserEvent("select.search")) return true;
    if (tr.selection && !tr.docChanged) return false;
    return value;
  },
});

/* ── CM6 ViewPlugin ─────────────────────────────────────── */

const selectionToolbarPlugin = ViewPlugin.fromClass(
  class {
    private hideTimeout: ReturnType<typeof setTimeout> | null = null;

    constructor(view: EditorView) {
      this.checkSelection(view);
    }

    update(update: ViewUpdate) {
      if (update.selectionSet || update.docChanged) {
        this.checkSelection(update.view);
      }
    }

    checkSelection(view: EditorView) {
      if (this.hideTimeout) {
        clearTimeout(this.hideTimeout);
        this.hideTimeout = null;
      }

      const { from, to } = view.state.selection.main;
      if (from === to || !view.state.field(userSelectionField)) {
        this.hideTimeout = setTimeout(() => hideToolbar(), 100);
      } else {
        requestAnimationFrame(() => showToolbar(view));
      }
    }

    destroy() {
      hideToolbar();
      if (this.hideTimeout) clearTimeout(this.hideTimeout);
    }
  },
);

export const selectionToolbar: Extension = [
  userSelectionField,
  selectionToolbarPlugin,
];
