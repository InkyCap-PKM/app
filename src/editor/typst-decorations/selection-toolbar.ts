import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type ChangeSpec } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

/* ── Inline format actions (always-visible buttons) ─────── */

interface InlineAction {
  icon: string;
  svgIcon?: string;
  title: string;
  wrap: [string, string];
  styleBold?: boolean;
  styleItalic?: boolean;
  styleStrike?: boolean;
  styleUnderline?: boolean;
}

const INLINE_ACTIONS: InlineAction[] = [
  { icon: "B", title: "Bold (Ctrl+B)", wrap: ["*", "*"], styleBold: true },
  { icon: "I", title: "Italic (Ctrl+I)", wrap: ["_", "_"], styleItalic: true },
  { icon: "S", title: "Strikethrough (Ctrl+Shift+X)", wrap: ["#strike[", "]"], styleStrike: true },
  { icon: "U", title: "Underline (Ctrl+U)", wrap: ["#underline[", "]"], styleUnderline: true },
];

/* ── SVG icons ──────────────────────────────────────────── */

const ICON_LINK = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 11.5a4 4 0 0 0 5.66 0l2-2a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M11.5 8.5a4 4 0 0 0-5.66 0l-2 2a4 4 0 0 0 5.66 5.66l1-1"/></svg>`;

const ICON_CODE = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 14 2 10 6 6"/><polyline points="14 6 18 10 14 14"/></svg>`;


const ICON_VERSE = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="14" height="14" rx="1.5"/><rect x="5" y="5" width="10" height="3" rx="0.5"/><line x1="5" y1="10" x2="7" y2="10"/><line x1="8" y1="10" x2="10" y2="10"/><line x1="11" y1="10" x2="13" y2="10"/><line x1="14" y1="10" x2="15" y2="10"/><rect x="5" y="12" width="10" height="2" rx="0.5"/><line x1="7" y1="15" x2="13" y2="15"/></svg>`;

const ICON_ALIGN_LEFT = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="4" x2="17" y2="4"/><line x1="3" y1="8" x2="13" y2="8"/><line x1="3" y1="12" x2="17" y2="12"/><line x1="3" y1="16" x2="11" y2="16"/></svg>`;

const ICON_ALIGN_CENTER = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="4" x2="17" y2="4"/><line x1="5" y1="8" x2="15" y2="8"/><line x1="3" y1="12" x2="17" y2="12"/><line x1="6" y1="16" x2="14" y2="16"/></svg>`;

const ICON_ALIGN_RIGHT = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="4" x2="17" y2="4"/><line x1="7" y1="8" x2="17" y2="8"/><line x1="3" y1="12" x2="17" y2="12"/><line x1="9" y1="16" x2="17" y2="16"/></svg>`;

const ICON_CHEVRON = `<svg viewBox="0 0 10 10" width="8" height="8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 4 5 7 8 4"/></svg>`;

const ICON_BULLET = `<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><circle cx="4" cy="4.5" r="2"/><rect x="8" y="3.5" width="6" height="2" rx="1"/><circle cx="4" cy="11.5" r="2"/><rect x="8" y="10.5" width="6" height="2" rx="1"/></svg>`;


/* ── Dropdown block/structure items ─────────────────────── */

interface DropdownItem {
  label: string;
  icon?: string;
  action: (view: EditorView) => void;
  separator?: boolean;
}

function insertAtLineStart(view: EditorView, prefix: string) {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  view.dispatch({
    changes: { from: line.from, to: line.from, insert: prefix },
  });
  view.focus();
}

function replaceLinePrefix(view: EditorView, newPrefix: string) {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const text = line.text;
  const stripped = text.replace(/^(=+ |[+\-] |\[[ x]\] )/, "");
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: newPrefix + stripped },
  });
  view.focus();
}

function clearLinePrefix(view: EditorView) {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const text = line.text;
  const stripped = text.replace(/^(=+ |[+\-] |\[[ x]\] )/, "");
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: stripped },
  });
  view.focus();
}

function wrapSelection(view: EditorView, before: string, after: string) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.doc.sliceString(from, to);
  view.dispatch({
    changes: { from, to, insert: before + selected + after } as ChangeSpec,
    selection: { anchor: from + before.length, head: to + before.length },
  });
  view.focus();
}

const DROPDOWN_ITEMS: DropdownItem[] = [
  {
    label: "Bulleted list",
    icon: ICON_BULLET,
    action: (v) => replaceLinePrefix(v, "- "),
  },
  {
    label: "Numbered list",
    icon: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><text x="2" y="6" font-size="7" font-family="serif">1.</text><rect x="8" y="3.5" width="6" height="2" rx="1"/><text x="2" y="13" font-size="7" font-family="serif">2.</text><rect x="8" y="10.5" width="6" height="2" rx="1"/></svg>`,
    action: (v) => replaceLinePrefix(v, "+ "),
  },
  { label: "", separator: true, action: () => {} },
  {
    label: "Highlight",
    icon: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><rect x="1" y="6" width="14" height="7" rx="1" fill="var(--accent-primary)" opacity="0.3"/><line x1="3" y1="9.5" x2="13" y2="9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    action: (v) => wrapSelection(v, "#highlight[", "]"),
  },
  {
    label: "Callout",
    icon: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="2"/><line x1="5" y1="6" x2="11" y2="6"/><line x1="5" y1="9" x2="9" y2="9"/></svg>`,
    action: (v) => wrapSelection(v, '#callout("note")[', "]"),
  },
  { label: "", separator: true, action: () => {} },
  {
    label: "Regular Text",
    action: (v) => clearLinePrefix(v),
  },
  {
    label: "Heading 1",
    action: (v) => replaceLinePrefix(v, "= "),
  },
  {
    label: "Heading 2",
    action: (v) => replaceLinePrefix(v, "== "),
  },
  {
    label: "Heading 3",
    action: (v) => replaceLinePrefix(v, "=== "),
  },
  {
    label: "Heading 4",
    action: (v) => replaceLinePrefix(v, "==== "),
  },
  {
    label: "Heading 5",
    action: (v) => replaceLinePrefix(v, "===== "),
  },
  {
    label: "Heading 6",
    action: (v) => replaceLinePrefix(v, "====== "),
  },
];

/* ── Toolbar DOM construction ───────────────────────────── */

let toolbar: HTMLElement | null = null;
let dropdown: HTMLElement | null = null;
let alignPopup: HTMLElement | null = null;
let activeView: EditorView | null = null;

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
  if (!toolbar) {
    toolbar = document.createElement("div");
    toolbar.className = "selection-toolbar";
    toolbar.style.display = "none";

    /* ── Block-type dropdown trigger ── */
    const dropdownTrigger = document.createElement("button");
    dropdownTrigger.className = "selection-toolbar__btn selection-toolbar__dropdown-trigger";
    dropdownTrigger.innerHTML = ICON_BULLET + ICON_CHEVRON;
    dropdownTrigger.title = "Block type";
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
      btn.title = action.title;
      if (action.styleBold) btn.style.fontWeight = "bold";
      if (action.styleItalic) btn.style.fontStyle = "italic";
      if (action.styleStrike) btn.style.textDecoration = "line-through";
      if (action.styleUnderline) btn.style.textDecoration = "underline";

      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        closeAllPopups();
        if (!activeView) return;
        applyWrap(activeView, action.wrap[0], action.wrap[1]);
      });
      toolbar.appendChild(btn);
    }

    /* ── Separator ── */
    toolbar.appendChild(createSeparator());

    /* ── Link button ── */
    const linkBtn = createSvgButton(ICON_LINK, "Link (Ctrl+K)");
    linkBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      closeAllPopups();
      if (!activeView) return;
      applyWrap(activeView, '#link("")[', "]");
    });
    toolbar.appendChild(linkBtn);

    /* ── Code button ── */
    const codeBtn = createSvgButton(ICON_CODE, "Inline code (Ctrl+E)");
    codeBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      closeAllPopups();
      if (!activeView) return;
      applyWrap(activeView, "`", "`");
    });
    toolbar.appendChild(codeBtn);

    /* ── Math button ── */
    const mathBtn = document.createElement("button");
    mathBtn.className = "selection-toolbar__btn";
    mathBtn.textContent = "∑";
    mathBtn.title = "Inline math (Ctrl+Shift+M)";
    mathBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      closeAllPopups();
      if (!activeView) return;
      applyWrap(activeView, "$", "$");
    });
    toolbar.appendChild(mathBtn);

    /* ── Separator ── */
    toolbar.appendChild(createSeparator());

    /* ── Verse button ── */
    const verseBtn = createSvgButton(ICON_VERSE, "Insert verse");
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

    /* ── Alignment button ── */
    const alignBtn = createSvgButton(ICON_ALIGN_LEFT, "Text alignment");
    alignBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeDropdown();
      toggleAlignPopup(alignBtn);
    });
    toolbar.appendChild(alignBtn);

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
      labelSpan.textContent = item.label;

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

    const aligns: { icon: string; label: string; value: string }[] = [
      { icon: ICON_ALIGN_LEFT, label: "Left", value: "left" },
      { icon: ICON_ALIGN_CENTER, label: "Center", value: "center" },
      { icon: ICON_ALIGN_RIGHT, label: "Right", value: "right" },
    ];

    for (const a of aligns) {
      const btn = createSvgButton(a.icon, a.label);
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        closeAllPopups();
        if (!activeView) return;
        wrapSelection(activeView, `#align(${a.value})[`, "]");
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
  const btnRect = anchorBtn.getBoundingClientRect();
  ap.style.left = `${btnRect.left}px`;
  ap.style.top = `${btnRect.bottom + 4}px`;
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

function applyWrap(view: EditorView, before: string, after: string) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.doc.sliceString(from, to);

  if (
    selected.startsWith(before) &&
    selected.endsWith(after) &&
    selected.length >= before.length + after.length
  ) {
    const inner = selected.slice(before.length, selected.length - after.length);
    view.dispatch({
      changes: { from, to, insert: inner } as ChangeSpec,
      selection: { anchor: from, head: from + inner.length },
    });
  } else {
    view.dispatch({
      changes: { from, to, insert: before + selected + after } as ChangeSpec,
      selection: { anchor: from + before.length, head: to + before.length },
    });
  }

  view.focus();
}

/* ── CM6 ViewPlugin ─────────────────────────────────────── */

export const selectionToolbar = ViewPlugin.fromClass(
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
      if (from === to) {
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
