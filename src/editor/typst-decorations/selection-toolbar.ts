import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { StateField, type ChangeSpec, type Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { applyToggleWrap } from "./wrap-format";
import { VERSE_ICON_SVG } from "../../components/icons/verse";
import { t, localeVersion } from "../../lib/i18n";

/* ── Inline format actions (always-visible buttons) ─────── */

interface InlineAction {
  icon: string;
  svgIcon?: string;
  /** i18n key for the button tooltip, resolved at DOM-build time. */
  titleKey: string;
  wrap: [string, string];
  styleBold?: boolean;
  styleItalic?: boolean;
  styleStrike?: boolean;
  styleUnderline?: boolean;
}

const INLINE_ACTIONS: InlineAction[] = [
  { icon: "B", titleKey: "selToolbar.bold", wrap: ["*", "*"], styleBold: true },
  { icon: "I", titleKey: "selToolbar.italic", wrap: ["_", "_"], styleItalic: true },
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
  /** Stable English identifier — also drives per-item styling (heading-level
   *  parsing below), so it must NOT be localized. Display text comes from
   *  `labelKey`. */
  label: string;
  /** i18n key for the displayed label, resolved at DOM-build time. */
  labelKey?: string;
  icon?: string;
  action: (view: EditorView) => void;
  separator?: boolean;
}

// Existing block-prefix markup the line-prefix actions strip before applying a
// new one: headings (`= `), list markers (`- ` / `+ ` / explicit `1. `), and
// task checkboxes. Stripping explicit enum markers too means an ordered list
// the user hand-numbered converts cleanly to a bullet list (no `- 1. item`).
const BLOCK_PREFIX = /^(=+ |[+\-] |\d+\. |\[[ x]\] )/;

// Apply `transform` to every line the selection touches, as a single
// transaction. The block-type actions (lists, headings, regular text) are
// per-line operations, so a multi-line selection must convert *all* the lines
// it spans — not just the one under the selection anchor. Each transform keeps
// the line's leading whitespace intact so nested list items stay nested.
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

// The toolbar/dropdown/popup DOM is built once and cached. Their labels are
// resolved at build time via `t()`, so on a UI-locale switch the cached nodes
// would keep the old language. Track the locale version they were built under
// and tear them down when it changes, so the next `showToolbar` rebuilds them
// in the new locale. (CM6 extensions live outside Solid's reactive scope, so
// this version check is the out-of-band refresh hook — mirrors how the editor
// search panel refreshes via `relocalize`.)
let builtLocaleVersion = -1;

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
        applyToggleWrap(activeView, action.wrap[0], action.wrap[1]);
      });
      toolbar.appendChild(btn);
    }

    /* ── Superscript / subscript / footnote ──
     * Content-bracket inserts wrapping the selection. `applyToggleWrap` toggles
     * them off when the selection already carries the markup, matching B/I/U/S —
     * so they sit alongside the other inline character formatting. */
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
      applyToggleWrap(activeView, '#link("")[', "]");
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
  return toolbar;
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

      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        closeAllPopups();
        if (activeView) item.action(activeView);
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
  const tbRect = toolbar.getBoundingClientRect();
  dd.style.left = `${tbRect.left}px`;
  dd.style.top = `${tbRect.bottom + 4}px`;
  dd.style.display = "flex";
}

function toggleAlignPopup(anchorBtn: HTMLElement) {
  const ap = getAlignPopup(anchorBtn);
  if (ap.style.display !== "none") {
    ap.style.display = "none";
    return;
  }
  // Drop from the toolbar's bottom edge — not the button's — so the popup
  // clears the toolbar with the same 4px gap as the block-type dropdown.
  // The button sits inside the toolbar's padding, so anchoring to it would
  // leave the popup all but touching the toolbar.
  const btnRect = anchorBtn.getBoundingClientRect();
  const tbRect = toolbar?.getBoundingClientRect();
  ap.style.left = `${btnRect.left}px`;
  ap.style.top = `${(tbRect ? tbRect.bottom : btnRect.bottom) + 4}px`;
  ap.style.display = "flex";
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

  const midX = (startCoords.left + endCoords.right) / 2;
  const top = startCoords.top;

  el.style.left = `${midX}px`;
  el.style.top = `${top - 44}px`;
  el.style.transform = "translateX(-50%)";
  el.style.display = "flex";
}

/* ── User-gesture gate ───────────────────────────────────── */

// Tracks whether the current non-empty selection was produced by an explicit
// user gesture (mouse drag, double/triple-click, shift+arrow, etc.) versus a
// programmatic dispatch (search reveal, "go to line", reveal-by-label, …).
// CM6 tags pointer- and keyboard-driven selection transactions with a
// `select.*` userEvent; everything else is treated as programmatic. The
// in-page find/replace is a special case — it tags its match-reveal
// selections `select.search`, so those are excluded explicitly: a search
// should highlight matches without summoning the format toolbar. The flag is
// preserved across doc edits so that clicking a toolbar button (which
// dispatches changes + a new selection without a userEvent) does not dismiss
// the toolbar mid-format.
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
