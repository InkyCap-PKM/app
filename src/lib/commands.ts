// Registers all built-in commands into the command registry.
// Called once on app startup after other systems are initialized.

import { registerCommand } from "./command-registry";
import {
  openTab,
  closeTab,
  getActiveTab,
  switchToNextTab,
  switchToPrevTab,
  setTabEditingMode,
} from "../stores/tabs";
import { toggleTheme } from "../stores/theme";
import { updateSetting, settings } from "../stores/settings";
import { activeEditorView } from "../stores/editor";
import * as ipc from "./ipc";

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
  newNote: () => Promise<void>;
  openTypAudit: () => void;
}): void {
  // ── File commands ──

  registerCommand({
    id: "file:quick-open",
    title: "Quick Open",
    category: "File",
    keybinding: "Ctrl+O",
    execute: callbacks.toggleQuickOpen,
  });

  registerCommand({
    id: "file:new-note",
    title: "New Note",
    category: "File",
    keybinding: "Ctrl+N",
    execute: callbacks.newNote,
  });

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
    title: "Search in Vault",
    category: "View",
    keybinding: "Ctrl+Shift+F",
    execute: callbacks.openSearch,
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

  registerCommand({
    id: "edit:zoom-in",
    title: "Zoom In",
    category: "Edit",
    keybinding: "Ctrl++",
    execute: () => {
      const newSize = Math.min(24, settings.editor.font_size + 1);
      updateSetting("editor", "font_size", newSize);
    },
  });

  registerCommand({
    id: "edit:zoom-out",
    title: "Zoom Out",
    category: "Edit",
    keybinding: "Ctrl+-",
    execute: () => {
      const newSize = Math.max(10, settings.editor.font_size - 1);
      updateSetting("editor", "font_size", newSize);
    },
  });

  registerCommand({
    id: "edit:reset-zoom",
    title: "Reset Zoom",
    category: "Edit",
    keybinding: "Ctrl+0",
    execute: () => {
      updateSetting("editor", "font_size", 15);
    },
  });

  registerCommand({
    id: "edit:paste-as-markdown",
    title: "Paste as Markdown",
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
    id: "tools:flow-view",
    title: "Open Flow View",
    category: "Tools",
    execute: () => {
      const tab = getActiveTab();
      if (tab && tab.type === "file") {
        const name = tab.title.replace(/\.[^.]+$/, "");
        openTab(
          {
            type: "flow",
            title: `Flow: ${name}`,
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
  const items: Array<{ id: string; title: string; insert: string; cursorOffset: number }> = [
    { id: "bold", title: "Bold", insert: "*${sel}*", cursorOffset: 1 },
    { id: "italic", title: "Italic", insert: "_${sel}_", cursorOffset: 1 },
    { id: "strikethrough", title: "Strikethrough", insert: "#strike[${sel}]", cursorOffset: 8 },
    { id: "highlight", title: "Highlight", insert: "#highlight[${sel}]", cursorOffset: 11 },
    { id: "inline-code", title: "Inline Code", insert: "`${sel}`", cursorOffset: 1 },
    { id: "inline-math", title: "Inline Math", insert: "$${sel}$", cursorOffset: 1 },
    { id: "heading-1", title: "Heading 1", insert: "= ", cursorOffset: 2 },
    { id: "heading-2", title: "Heading 2", insert: "== ", cursorOffset: 3 },
    { id: "heading-3", title: "Heading 3", insert: "=== ", cursorOffset: 4 },
    { id: "heading-4", title: "Heading 4", insert: "==== ", cursorOffset: 5 },
    { id: "heading-5", title: "Heading 5", insert: "===== ", cursorOffset: 6 },
    { id: "heading-6", title: "Heading 6", insert: "====== ", cursorOffset: 7 },
    { id: "bullet-list", title: "Bullet List", insert: "- ", cursorOffset: 2 },
    { id: "ordered-list", title: "Ordered List", insert: "+ ", cursorOffset: 2 },
    { id: "blockquote", title: "Blockquote", insert: "#quote[${sel}]", cursorOffset: 7 },
    { id: "link", title: "Link", insert: '#link("")[${sel}]', cursorOffset: 7 },
    { id: "image", title: "Image", insert: '#image("")', cursorOffset: 8 },
    { id: "code-block", title: "Code Block", insert: "```\n${sel}\n```", cursorOffset: 4 },
    { id: "math-block", title: "Math Block", insert: "$ ${sel} $", cursorOffset: 2 },
    { id: "horizontal-rule", title: "Horizontal Rule", insert: "#line(length: 100%)", cursorOffset: 19 },
    { id: "footnote", title: "Footnote", insert: "#footnote[${sel}]", cursorOffset: 10 },
    { id: "wikilink", title: "Wikilink", insert: '#wikilink("")', cursorOffset: 11 },
    { id: "embed", title: "Embed", insert: '#embed("")', cursorOffset: 8 },
    { id: "callout", title: "Callout", insert: '#callout("note")[${sel}]', cursorOffset: 17 },
    { id: "verse", title: "Verse", insert: '#verse("")', cursorOffset: 8 },
    { id: "table", title: "Table", insert: '#table(\n  columns: (auto, auto, auto),\n  [Header 1], [Header 2], [Header 3],\n  [], [], [],\n)', cursorOffset: 76 },
  ];

  for (const item of items) {
    registerCommand({
      id: `markup:${item.id}`,
      title: item.title,
      category: "Markup",
      execute: () => insertMarkup(item.insert, item.cursorOffset),
    });
  }

  const refInserts: Array<{ id: string; title: string; insert: string; cursorOffset: number }> = [
    { id: "citation-at", title: "Cite (@key)", insert: "@", cursorOffset: 1 },
    { id: "bibliography", title: "Bibliography (insert)", insert: '#bibliography("/.inkycap/zotero-export.bib")', cursorOffset: 16 },
  ];

  for (const item of refInserts) {
    registerCommand({
      id: `references:${item.id}`,
      title: item.title,
      category: "References",
      execute: () => insertMarkup(item.insert, item.cursorOffset),
    });
  }
}

/** Register creation rules as commands. Call after rules are loaded. */
export async function registerCreationRuleCommands(): Promise<void> {
  try {
    const rules = await ipc.listCreationRules();
    for (const rule of rules) {
      registerCommand({
        id: `creation-rule:${rule.id}`,
        title: `${rule.icon_emoji} ${rule.name}`,
        category: "Creation Rules",
        keybinding: rule.hotkey ?? undefined,
        execute: async () => {
          try {
            const result = await ipc.executeCreationRule(rule.id);
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
