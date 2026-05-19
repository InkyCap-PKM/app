// Registers all built-in commands into the command registry.
// Called once on app startup after other systems are initialized.

import { registerCommand } from "./command-registry";
import {
  openTab,
  closeTab,
  reopenClosedTab,
  getActiveTab,
  switchToNextTab,
  switchToPrevTab,
  setTabEditingMode,
  createEmptyTab,
} from "../stores/tabs";
import { moveActiveFileInteractive } from "./move-file";
import { deleteActiveFileInteractive } from "./delete-file";
import { toggleTheme } from "../stores/theme";
import { updateSetting, settings } from "../stores/settings";
import { setShowReplace } from "../stores/search";
import { activeEditorView } from "../stores/editor";
import * as ipc from "./ipc";
import { pickAndInsertAttachments } from "./attachment-insert";
import { triggerCreationRule } from "../stores/creation-rules";

// Editor-targeting commands (toggle source mode, zoom in/out/reset)
// mutate Solid.js signals; the editor picks up changes automatically
// via createEffect. No imperative dispatch needed.

/** Register all built-in commands. Callbacks for toggling UI panels
 *  are passed in so this module doesn't depend on component state. */
export function registerBuiltinCommands(callbacks: {
  toggleQuickOpen: () => void;
  toggleSettings: () => void;
  toggleCommandPalette: () => void;
  toggleComposer: () => void;
  openFileHistory: () => void;
  openCitationPicker: () => void;
  openRefNotePicker: () => void;
  openSearch: () => void;
  openTypAudit: () => void;
  openScaffoldPicker: () => void;
}): void {
  // ── File commands ──

  registerCommand({
    id: "file:quick-open",
    title: "Quick Open",
    category: "File",
    keybinding: "Ctrl+O",
    execute: callbacks.toggleQuickOpen,
  });

  // Note: "New Simple File" (Ctrl+N) is registered by LeftSidebar so it
  // can share the file-tree refresh signal with the button that triggers
  // the same action. "New Note" (the creation rule) is registered by
  // `registerCreationRuleCommands` with whatever hotkey the user has on
  // the rule — default Ctrl+Shift+N.

  registerCommand({
    id: "file:close-tab",
    title: "Close Tab",
    category: "File",
    keybinding: "Ctrl+W",
    execute: () => {
      const tab = getActiveTab();
      if (tab) closeTab(tab.id);
    },
  });

  registerCommand({
    id: "file:new-empty-tab",
    title: "New Empty Tab",
    category: "File",
    keybinding: "Ctrl+T",
    execute: () => {
      createEmptyTab();
    },
  });

  // The keyboard dispatcher folds Cmd into Ctrl (see lib/keyboard.ts), so
  // a single "Ctrl+…" binding also covers the macOS Cmd equivalent.
  registerCommand({
    id: "file:reopen-closed-tab",
    title: "Reopen Closed Tab",
    category: "File",
    keybinding: "Ctrl+Shift+T",
    execute: reopenClosedTab,
  });

  registerCommand({
    id: "file:move",
    title: "Move File to...",
    category: "File",
    keybinding: "Ctrl+M",
    execute: () => {
      void moveActiveFileInteractive();
    },
  });

  registerCommand({
    id: "file:delete",
    title: "Delete File",
    category: "File",
    keybinding: "Ctrl+Shift+D",
    execute: () => {
      void deleteActiveFileInteractive();
    },
  });

  // ── Navigate commands ──

  registerCommand({
    id: "navigate:next-tab",
    title: "Next Tab",
    category: "Navigate",
    keybinding: "Ctrl+Tab",
    execute: switchToNextTab,
  });

  registerCommand({
    id: "navigate:prev-tab",
    title: "Previous Tab",
    category: "Navigate",
    keybinding: "Ctrl+Shift+Tab",
    execute: switchToPrevTab,
  });

  // ── View commands ──

  registerCommand({
    id: "view:command-palette",
    title: "Command Palette",
    category: "View",
    keybinding: "Ctrl+P",
    execute: callbacks.toggleCommandPalette,
  });

  registerCommand({
    id: "view:settings",
    title: "Settings",
    category: "View",
    keybinding: "Ctrl+,",
    execute: callbacks.toggleSettings,
  });

  registerCommand({
    id: "view:search",
    title: "Search in Notebox",
    category: "View",
    keybinding: "Ctrl+Shift+F",
    execute: callbacks.openSearch,
  });

  registerCommand({
    id: "view:search-replace",
    title: "Search and Replace (notebox-wide)",
    category: "View",
    execute: () => {
      setShowReplace(true);
      document.dispatchEvent(
        new CustomEvent("inkycap:open-search", { detail: { showReplace: true } }),
      );
    },
  });

  registerCommand({
    id: "view:toggle-theme",
    title: "Toggle Theme (Dark/Light)",
    category: "View",
    execute: toggleTheme,
  });

  registerCommand({
    id: "view:toggle-source-mode",
    title: "Toggle Source/Live Preview Mode",
    category: "View",
    execute: () => {
      const tab = getActiveTab();
      if (!tab || tab.type !== "file") return;
      // Each file tab remembers its own mode; default is `live`.
      const current = tab.editingMode ?? "live";
      setTabEditingMode(tab.id, current === "live" ? "source" : "live");
    },
  });

  // ── Edit commands ──

  // Zoom commands honour `settings.appearance.zoom_target`, which lets
  // the user pick whether Ctrl+= / Ctrl+- adjusts the editor body font,
  // the interface chrome, or both. Keeping that branching here (rather
  // than only in the keyboard handler) means the same behaviour applies
  // when zoom is triggered from the command palette.
  // "Ctrl+Plus" is ambiguous across keyboards: pressing the `=` key with
  // Ctrl (no Shift) produces `Ctrl+=`, holding Shift produces `Ctrl+Shift++`,
  // and the numpad key produces `Ctrl++`. Register all three so the command
  // fires regardless of which physical keystroke the user makes.
  registerCommand({
    id: "edit:zoom-in",
    title: "Zoom In",
    category: "Edit",
    keybinding: ["Ctrl+=", "Ctrl++", "Ctrl+Shift++"],
    execute: () => {
      const target = settings.appearance.zoom_target;
      if (target === "content" || target === "both") {
        updateSetting(
          "editor",
          "body_font_size",
          Math.min(32, settings.editor.body_font_size + 1),
        );
      }
      if (target === "interface" || target === "both") {
        updateSetting("editor", "font_size", Math.min(24, settings.editor.font_size + 1));
      }
    },
  });

  registerCommand({
    id: "edit:zoom-out",
    title: "Zoom Out",
    category: "Edit",
    keybinding: "Ctrl+-",
    execute: () => {
      const target = settings.appearance.zoom_target;
      if (target === "content" || target === "both") {
        updateSetting(
          "editor",
          "body_font_size",
          Math.max(8, settings.editor.body_font_size - 1),
        );
      }
      if (target === "interface" || target === "both") {
        updateSetting("editor", "font_size", Math.max(10, settings.editor.font_size - 1));
      }
    },
  });

  registerCommand({
    id: "edit:reset-zoom",
    title: "Reset Zoom",
    category: "Edit",
    keybinding: "Ctrl+0",
    execute: () => {
      const target = settings.appearance.zoom_target;
      if (target === "content" || target === "both") {
        updateSetting("editor", "body_font_size", 17);
      }
      if (target === "interface" || target === "both") {
        updateSetting("editor", "font_size", 15);
      }
    },
  });

  registerCommand({
    id: "edit:paste-as-markdown",
    title: "Paste from Markdown",
    category: "Edit",
    execute: async () => {
      const handle = activeEditorView();
      if (!handle) {
        console.warn("[paste-as-markdown] no active editor view");
        return;
      }
      try {
        const typst = await ipc.pasteMarkdownAsTypst();
        if (!typst) {
          console.warn("[paste-as-markdown] backend returned empty result");
          return;
        }
        const { from, to } = handle.view.state.selection.main;
        handle.view.dispatch({ changes: { from, to, insert: typst } });
        handle.view.focus();
      } catch (e) {
        console.error("Paste as Markdown failed:", e);
      }
    },
  });

  // ── Tools commands ──

  registerCommand({
    id: "tools:note-composer",
    title: "Note Composer (Merge/Split/Export)",
    category: "Tools",
    execute: callbacks.toggleComposer,
  });

  registerCommand({
    id: "tools:file-history",
    title: "File History (Snapshots)",
    category: "Tools",
    execute: callbacks.openFileHistory,
  });

  registerCommand({
    id: "tools:audit-typ-files",
    title: "Audit .typ files for InkyCap compatibility",
    category: "Tools",
    execute: callbacks.openTypAudit,
  });

  registerCommand({
    id: "tools:insert-scaffold",
    title: "Insert Scaffold",
    category: "Tools",
    keybinding: "Ctrl+\\",
    execute: callbacks.openScaffoldPicker,
  });

  registerCommand({
    id: "tools:mycelial-view",
    title: "Open Mycelial View",
    category: "Tools",
    execute: () => {
      const tab = getActiveTab();
      if (tab && tab.type === "file") {
        const name = tab.title.replace(/\.[^.]+$/, "");
        openTab(
          {
            type: "mycelial",
            title: name,
            path: tab.path,
          },
          { forceNewTab: true },
        );
      }
    },
  });

  registerCommand({
    id: "references:cite",
    title: "Search references & cite",
    category: "References",
    keybinding: "Ctrl+Shift+C",
    execute: callbacks.openCitationPicker,
  });

  registerCommand({
    id: "references:import-note",
    title: "Import note text from reference",
    category: "References",
    execute: callbacks.openRefNotePicker,
  });

  registerCommand({
    id: "tools:export-pdf",
    title: "Export Note as PDF",
    category: "Tools",
    execute: async () => {
      const tab = getActiveTab();
      if (tab && tab.type === "file") {
        document.dispatchEvent(
          new CustomEvent("inkycap:export-dialog", { detail: { path: tab.path } }),
        );
      }
    },
  });

  registerCommand({
    id: "tools:export-self-contained",
    title: "Export Self-Contained .typ",
    category: "Tools",
    execute: async () => {
      const tab = getActiveTab();
      if (tab && tab.type === "file") {
        document.dispatchEvent(
          new CustomEvent("inkycap:export-dialog", {
            detail: { path: tab.path, format: "typ" },
          }),
        );
      }
    },
  });

  // ── Zettelkasten commands ──

  registerCommand({
    id: "edit:insert-zid",
    title: "Insert Zettelkasten ID",
    category: "Edit",
    execute: async () => {
      const handle = activeEditorView();
      if (!handle) return;
      if (!settings.files.zettelkasten_enabled) return;
      try {
        const zid = await ipc.generateZid();
        const { from, to } = handle.view.state.selection.main;
        handle.view.dispatch({ changes: { from, to, insert: zid } });
        handle.view.focus();
      } catch (e) {
        console.error("Failed to insert Zettelkasten ID:", e);
      }
    },
  });

  // ── Markup insertion commands ──
  registerMarkupCommands();
}

function insertMarkup(template: string, cursorOffset: number) {
  const handle = activeEditorView();
  if (!handle) return;
  const view = handle.view;
  const sel = view.state.selection.main;
  const selectedText = view.state.doc.sliceString(sel.from, sel.to);
  const insert = template.replace("${sel}", selectedText);
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + cursorOffset },
  });
  view.focus();
}

function registerMarkupCommands() {
  type MarkupItem = { id: string; title: string; category: "Format" | "Structure" | "Insert" | "Style" | "InkyCap" | "References"; insert: string; cursorOffset: number; shortcut?: string };

  const items: MarkupItem[] = [
    // ── Format ──
    { id: "bold", title: "Bold", category: "Format", insert: "*${sel}*", cursorOffset: 1, shortcut: "*…*" },
    { id: "italic", title: "Italic", category: "Format", insert: "_${sel}_", cursorOffset: 1, shortcut: "_…_" },
    { id: "strikethrough", title: "Strikethrough", category: "Format", insert: "#strike[${sel}]", cursorOffset: 8 },
    { id: "highlight", title: "Highlight", category: "Format", insert: "#highlight[${sel}]", cursorOffset: 11 },
    { id: "underline", title: "Underline", category: "Format", insert: "#underline[${sel}]", cursorOffset: 11 },
    { id: "overline", title: "Overline", category: "Format", insert: "#overline[${sel}]", cursorOffset: 10 },
    { id: "subscript", title: "Subscript", category: "Format", insert: "#sub[${sel}]", cursorOffset: 5 },
    { id: "superscript", title: "Superscript", category: "Format", insert: "#super[${sel}]", cursorOffset: 7 },
    { id: "inline-code", title: "Inline Code", category: "Format", insert: "`${sel}`", cursorOffset: 1, shortcut: "`…`" },
    { id: "inline-math", title: "Inline Math", category: "Format", insert: "$${sel}$", cursorOffset: 1, shortcut: "$…$" },

    // ── Structure ──
    { id: "heading-1", title: "Heading 1", category: "Structure", insert: "= ", cursorOffset: 2, shortcut: "= " },
    { id: "heading-2", title: "Heading 2", category: "Structure", insert: "== ", cursorOffset: 3, shortcut: "== " },
    { id: "heading-3", title: "Heading 3", category: "Structure", insert: "=== ", cursorOffset: 4, shortcut: "=== " },
    { id: "heading-4", title: "Heading 4", category: "Structure", insert: "==== ", cursorOffset: 5, shortcut: "==== " },
    { id: "heading-5", title: "Heading 5", category: "Structure", insert: "===== ", cursorOffset: 6, shortcut: "===== " },
    { id: "heading-6", title: "Heading 6", category: "Structure", insert: "====== ", cursorOffset: 7, shortcut: "====== " },
    { id: "bullet-list", title: "Bullet List", category: "Structure", insert: "- ", cursorOffset: 2, shortcut: "- " },
    { id: "ordered-list", title: "Ordered List", category: "Structure", insert: "+ ", cursorOffset: 2, shortcut: "+ " },
    { id: "quote-inline", title: "Quote (inline)", category: "Structure", insert: "#quote[${sel}]", cursorOffset: 7 },
    { id: "blockquote", title: "Blockquote", category: "Structure", insert: "#quote(block: true)[${sel}]", cursorOffset: 20, shortcut: "> " },

    // ── Insert ──
    { id: "link", title: "Link", category: "Insert", insert: '#link("")[${sel}]', cursorOffset: 7 },
    // Image and Embed are special-cased below: rather than inserting a
    // template with an empty path the user must hand-type (which would
    // produce a fragile relative reference), they drive the attachment
    // picker, copy the chosen file(s) into `settings.files.attachment_folder`,
    // and emit a notebox-root-absolute `#image("/...")` call.
    // The `insert` field here is unused for these two ids — `pickInsert: true`
    // diverts the execute path.
    { id: "image", title: "Image", category: "Insert", insert: '#image("")', cursorOffset: 8 },
    { id: "code-block", title: "Code Block", category: "Insert", insert: "```\n${sel}\n```", cursorOffset: 4, shortcut: "```" },
    { id: "math-block", title: "Math Block", category: "Insert", insert: "$ ${sel} $", cursorOffset: 2 },
    { id: "horizontal-rule", title: "Horizontal Rule", category: "Insert", insert: "#line(length: 100%)", cursorOffset: 19, shortcut: "+++" },
    { id: "footnote", title: "Footnote", category: "Insert", insert: "#footnote[${sel}]", cursorOffset: 10, shortcut: "++…++" },
    { id: "table", title: "Table", category: "Insert", insert: '#table(\n  columns: (auto, auto, auto),\n  [Header 1], [Header 2], [Header 3],\n  [], [], [],\n)', cursorOffset: 76 },
    { id: "page-break", title: "Page Break", category: "Insert", insert: "#pagebreak()", cursorOffset: 12 },
    { id: "line-break", title: "Line Break", category: "Insert", insert: "#linebreak()", cursorOffset: 12 },
    { id: "lorem-ipsum", title: "Lorem Ipsum", category: "Insert", insert: "#lorem(50)", cursorOffset: 7 },
    { id: "figure", title: "Figure", category: "Insert", insert: '#figure(\n  ${sel},\n  caption: [],\n)', cursorOffset: 11 },
    { id: "align", title: "Align", category: "Insert", insert: "#align(center)[${sel}]", cursorOffset: 15 },
    { id: "box", title: "Box", category: "Insert", insert: "#box[${sel}]", cursorOffset: 5 },
    { id: "rect", title: "Rect", category: "Insert", insert: "#rect[${sel}]", cursorOffset: 6 },
    { id: "hide", title: "Hide", category: "Insert", insert: "#hide[${sel}]", cursorOffset: 6 },
    { id: "embed", title: "Embed", category: "Insert", insert: '#embed("")', cursorOffset: 8 },
    { id: "callout", title: "Callout", category: "Insert", insert: '#callout("note")[${sel}]', cursorOffset: 17 },
    { id: "citation-at", title: "Citation (@key)", category: "References", insert: "@", cursorOffset: 1, shortcut: "@" },
    { id: "bibliography", title: "Bibliography", category: "References", insert: '#bibliography("/.inkycap/zotero-export.bib")', cursorOffset: 16 },

    // ── Style ──
    { id: "page-size", title: "Page Size", category: "Style", insert: '#set page(paper: "a4")', cursorOffset: 17 },
    { id: "page-margins", title: "Page Margins", category: "Style", insert: '#set page(margin: (top: 2cm, bottom: 2cm, left: 2cm, right: 2cm))', cursorOffset: 24 },
    { id: "page-numbering", title: "Page Numbering", category: "Style", insert: '#set page(numbering: "1")', cursorOffset: 22 },
    { id: "page-columns", title: "Page Columns", category: "Style", insert: "#set page(columns: 2)", cursorOffset: 20 },
    { id: "text-font", title: "Text Font", category: "Style", insert: '#set text(font: "")', cursorOffset: 17 },
    { id: "text-size", title: "Text Size", category: "Style", insert: "#set text(size: 12pt)", cursorOffset: 16 },
    { id: "text-language", title: "Text Language", category: "Style", insert: '#set text(lang: "en")', cursorOffset: 17 },
    { id: "justify", title: "Justify", category: "Style", insert: "#set par(justify: true)", cursorOffset: 22 },
    { id: "line-spacing", title: "Line Spacing", category: "Style", insert: "#set par(leading: 0.65em)", cursorOffset: 19 },
    { id: "paragraph-spacing", title: "Paragraph Spacing", category: "Style", insert: "#set par(spacing: 1.2em)", cursorOffset: 18 },
    { id: "first-line-indent", title: "First Line Indent", category: "Style", insert: "#set par(first-line-indent: 1em)", cursorOffset: 27 },
    { id: "heading-numbering", title: "Heading Numbering", category: "Style", insert: '#set heading(numbering: "1.1")', cursorOffset: 24 },

    // ── InkyCap ──
    { id: "wikilink", title: "Wikilink", category: "InkyCap", insert: '#wikilink("")', cursorOffset: 11, shortcut: "[[…]]" },
    { id: "verse", title: "Verse", category: "InkyCap", insert: '#verse("")', cursorOffset: 8 },
  ];

  for (const item of items) {
    const execute =
      item.id === "image" || item.id === "embed"
        ? () => insertAttachmentViaPicker(item.id as "image" | "embed")
        : () => insertMarkup(item.insert, item.cursorOffset);

    registerCommand({
      id: `markup:${item.id}`,
      title: item.title,
      category: item.category,
      shortcut: item.shortcut,
      execute,
    });
  }
}

async function insertAttachmentViaPicker(func: "image" | "embed") {
  const handle = activeEditorView();
  if (!handle) return;
  const view = handle.view;
  const sel = view.state.selection.main;
  await pickAndInsertAttachments(view, sel.from, sel.to, func);
}

/** Register creation rules as commands. Call after rules are loaded.
 *  Disabled rules are skipped — they shouldn't surface in the palette or
 *  bind a global hotkey. */
export async function registerCreationRuleCommands(): Promise<void> {
  try {
    const rules = await ipc.listCreationRules();
    for (const rule of rules) {
      if (rule.disabled) continue;
      registerCommand({
        id: `creation-rule:${rule.id}`,
        title: rule.name,
        category: "Creation Rules",
        keybinding: rule.hotkey ?? undefined,
        execute: async () => {
          try {
            const result = await triggerCreationRule(rule.id);
            if (!result) return;
            if (rule.creation_mode === "create_and_open") {
              const name = result.path.split("/").pop() ?? "New Note";
              openTab(
                { type: "file", title: name, path: result.path },
                {
                  forceNewTab: true,
                  cursorOffset: result.cursor_offset ?? undefined,
                },
              );
            }
          } catch (e) {
            console.error(`Failed to execute creation rule ${rule.id}:`, e);
          }
        },
      });
    }
  } catch (e) {
    console.error("Failed to load creation rules for command palette:", e);
  }
}
