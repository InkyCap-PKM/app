// Registers all built-in commands into the command registry.
// Called once on app startup after other systems are initialized.

import { createEffect } from "solid-js";
import { registerCommand, unregisterCommand } from "./command-registry";
import { openNoteboxWindow } from "./new-window";
import { t } from "./i18n";
import { errorText, errorCode } from "./errors";
import {
  openTab,
  openCreatedNote,
  closeTab,
  reopenClosedTab,
  getActiveTab,
  switchToNextTab,
  switchToPrevTab,
  setTabEditingMode,
  createEmptyTab,
  splitPane,
  closePane,
  nudgeTabReadingZoom,
  resetTabReadingZoom,
  READING_ZOOM_STEP,
} from "../stores/tabs";
import { focusedLeaf, focusAdjacentPane, hasMultiplePanes } from "../stores/panes";
import { moveActiveFileInteractive } from "./move-file";
import { deleteActiveFileInteractive } from "./delete-file";
import { toggleTheme } from "../stores/theme";
import { toggleDistractionFree, toggleLeftCollapsed, toggleRightCollapsed } from "../stores/layout";
import { toggleScroll, isEnabled as isScrollEnabled } from "../stores/journal-scroll";
import { cycleRegion, focusEditor } from "./focus-regions";
import { openEditorReplace } from "../editor/search-panel";
import { updateSetting, settings } from "../stores/settings";
import { setShowReplace } from "../stores/search";
import { activeEditorView } from "../stores/editor";
import { insertAnnotationMarkup } from "../editor/typst-decorations/annotation-insert";
import * as ipc from "./ipc";
import { pickAndInsertAttachments } from "./attachment-insert";
import { triggerCreationRule, activeRules } from "../stores/creation-rules";
import { showToast } from "../stores/toasts";
import {
  collaborative,
  packageMode,
  sync as gitSyncAction,
  checkUpdates as gitCheckUpdatesAction,
} from "../stores/git";
import { exportPackageInteractive, importPackageInteractive } from "./package-handoff";

// Editor-targeting commands (toggle source mode, zoom in/out/reset)
// mutate Solid.js signals; the editor picks up changes automatically
// via createEffect. No imperative dispatch needed.

/** Register all built-in commands. Callbacks for toggling UI panels
 *  are passed in so this module doesn't depend on component state. */
/** Callbacks for the built-in commands. */
export interface BuiltinCommandCallbacks {
  toggleQuickOpen: () => void;
  toggleSettings: () => void;
  toggleCommandPalette: () => void;
  openCitationPicker: () => void;
  openRefNotePicker: () => void;
  openSearch: () => void;
  openTypAudit: () => void;
  openScaffoldPicker: () => void;
  openCollaborationPanel: () => void;
  openHelp: () => void;
}

// Retained so `relocalizeCommands()` can re-register built-in commands with
// fresh translated titles after a UI-language switch — see that function.
let lastBuiltinCallbacks: BuiltinCommandCallbacks | null = null;

/** Id of the tab whose compiled reading view is currently on screen, or null
 *  when the active pane is showing something else. Used by the zoom commands
 *  to decide whether "content" means the preview or the editor body. Journal
 *  Scroll takes over the pane when enabled, so a reading-mode tab in scroll
 *  mode isn't showing the reading view and doesn't count. */
function activeReadingTabId(): string | null {
  const tab = getActiveTab();
  if (!tab || tab.type !== "file") return null;
  if (tab.editingMode !== "reading") return null;
  if (isScrollEnabled(tab.id)) return null;
  return tab.id;
}

export function registerBuiltinCommands(callbacks: BuiltinCommandCallbacks): void {
  lastBuiltinCallbacks = callbacks;
  // ── File commands ──

  registerCommand({
    id: "file:quick-open",
    title: t("command.file.quick-open"),
    category: "File",
    keybinding: "Ctrl+O",
    execute: callbacks.toggleQuickOpen,
  });

  // Note: "New Note" is registered by `registerCreationRuleCommands` as
  // a creation rule (id "new-note") with whatever hotkey the user has on
  // the rule — default Ctrl+N. It is the rule that backs the file tree's
  // New Note icon button and the context menu's "New Note" entry; the
  // legacy "New Simple File" command was removed when those call sites
  // were unified onto the rule.

  registerCommand({
    id: "file:close-tab",
    title: t("command.file.close-tab"),
    category: "File",
    keybinding: "Ctrl+W",
    execute: () => {
      const tab = getActiveTab();
      if (tab) closeTab(tab.id);
    },
  });

  registerCommand({
    id: "file:new-empty-tab",
    title: t("command.file.new-empty-tab"),
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
    title: t("command.file.reopen-closed-tab"),
    category: "File",
    keybinding: "Ctrl+Shift+T",
    execute: reopenClosedTab,
  });

  registerCommand({
    id: "file:move",
    title: t("command.file.move"),
    category: "File",
    keybinding: "Ctrl+M",
    execute: () => {
      void moveActiveFileInteractive();
    },
  });

  registerCommand({
    id: "file:delete",
    title: t("command.file.delete"),
    category: "File",
    keybinding: "Ctrl+Shift+D",
    execute: () => {
      void deleteActiveFileInteractive();
    },
  });

  registerCommand({
    id: "file:rename",
    title: t("command.file.rename"),
    category: "File",
    keybinding: "F2",
    // The inline rename affordance lives in the status bar (StatusBar.tsx);
    // it owns the draft/commit state, so the command just asks it to begin.
    execute: () => {
      document.dispatchEvent(new CustomEvent("inkycap:start-rename"));
    },
  });

  // ── Navigate commands ──

  registerCommand({
    id: "navigate:next-tab",
    title: t("command.navigate.next-tab"),
    category: "Navigate",
    keybinding: "Ctrl+Tab",
    execute: switchToNextTab,
  });

  registerCommand({
    id: "navigate:prev-tab",
    title: t("command.navigate.prev-tab"),
    category: "Navigate",
    keybinding: "Ctrl+Shift+Tab",
    execute: switchToPrevTab,
  });

  // ── Pane (split) commands ──

  registerCommand({
    id: "pane:split-right",
    title: t("command.pane.splitRight"),
    category: "Navigate",
    keybinding: "Ctrl+Shift+]",
    execute: () => {
      splitPane(focusedLeaf().id, "row");
    },
  });

  registerCommand({
    id: "pane:split-down",
    title: t("command.pane.splitDown"),
    category: "Navigate",
    keybinding: "Ctrl+Shift+[",
    execute: () => {
      splitPane(focusedLeaf().id, "column");
    },
  });

  registerCommand({
    id: "pane:close",
    title: t("command.pane.close"),
    category: "Navigate",
    keybinding: "Ctrl+Shift+W",
    execute: () => {
      if (hasMultiplePanes()) closePane(focusedLeaf().id);
    },
  });

  registerCommand({
    id: "pane:focus-next",
    title: t("command.pane.focusNext"),
    category: "Navigate",
    execute: () => focusAdjacentPane(1),
  });

  registerCommand({
    id: "pane:focus-prev",
    title: t("command.pane.focusPrev"),
    category: "Navigate",
    execute: () => focusAdjacentPane(-1),
  });

  // ── View commands ──

  registerCommand({
    id: "view:command-palette",
    title: t("command.view.command-palette"),
    category: "View",
    keybinding: "Ctrl+P",
    execute: callbacks.toggleCommandPalette,
  });

  registerCommand({
    id: "view:settings",
    title: t("command.view.settings"),
    category: "View",
    keybinding: "Ctrl+,",
    execute: callbacks.toggleSettings,
  });

  registerCommand({
    id: "view:search",
    title: t("command.view.search"),
    category: "View",
    keybinding: "Ctrl+Shift+F",
    execute: callbacks.openSearch,
  });

  // In-note find & replace — the CodeMirror panel scoped to the active editor.
  // Ctrl+H is deliberately the *note*-scoped replace, not the notebox-wide one.
  registerCommand({
    id: "editor:find-replace",
    title: t("command.editor.find-replace"),
    category: "Edit",
    keybinding: "Ctrl+H",
    execute: () => {
      const handle = activeEditorView();
      if (handle) openEditorReplace(handle.view);
    },
  });

  // Notebox-wide find & replace. Intentionally has NO keybinding: a global
  // replace can touch many files at once, so it stays palette-only to keep it a
  // deliberate action rather than something a stray chord can trigger.
  registerCommand({
    id: "view:search-replace",
    title: t("command.view.search-replace"),
    category: "View",
    execute: () => {
      setShowReplace(true);
      document.dispatchEvent(
        new CustomEvent("inkycap:open-search", { detail: { showReplace: true } }),
      );
    },
  });

  registerCommand({
    id: "view:toggle-help",
    title: t("command.view.toggle-help"),
    category: "View",
    keybinding: "F1",
    execute: callbacks.openHelp,
  });

  registerCommand({
    id: "window:new",
    title: t("command.window.new"),
    category: "View",
    keybinding: "Ctrl+Shift+N",
    // Opens an empty new window that shows the notebox picker, so the user
    // chooses which notebox it opens (each window is its own notebox view).
    execute: () => openNoteboxWindow(),
  });

  registerCommand({
    id: "view:toggle-left-sidebar",
    title: t("command.view.toggle-left-sidebar"),
    category: "View",
    keybinding: "Ctrl+/",
    execute: toggleLeftCollapsed,
  });

  registerCommand({
    id: "view:toggle-right-panel",
    title: t("command.view.toggle-right-panel"),
    category: "View",
    keybinding: "Ctrl+\\",
    execute: toggleRightCollapsed,
  });

  registerCommand({
    id: "view:focus-editor",
    title: t("command.view.focus-editor"),
    category: "View",
    keybinding: "Ctrl+Shift+0",
    execute: focusEditor,
  });

  registerCommand({
    id: "view:cycle-region-forward",
    title: t("command.view.cycle-region-forward"),
    category: "View",
    keybinding: "F6",
    execute: () => cycleRegion(1),
  });

  registerCommand({
    id: "view:cycle-region-back",
    title: t("command.view.cycle-region-back"),
    category: "View",
    keybinding: "Shift+F6",
    execute: () => cycleRegion(-1),
  });

  registerCommand({
    id: "view:toggle-theme",
    title: t("command.view.toggle-theme"),
    category: "View",
    keybinding: "Ctrl+Shift+L",
    execute: toggleTheme,
  });

  registerCommand({
    id: "view:toggle-source-mode",
    title: t("command.view.toggle-source-mode"),
    category: "View",
    keybinding: "Ctrl+Shift+M",
    execute: () => {
      const tab = getActiveTab();
      if (!tab || tab.type !== "file") return;
      // Each file tab remembers its own mode; default is `live`.
      const current = tab.editingMode ?? "live";
      setTabEditingMode(tab.id, current === "live" ? "source" : "live");
    },
  });

  registerCommand({
    id: "view:toggle-reading-mode",
    title: t("command.view.toggle-reading-mode"),
    category: "View",
    keybinding: "Ctrl+Shift+R",
    execute: () => {
      const tab = getActiveTab();
      if (!tab || tab.type !== "file") return;
      // Reading is a third per-tab mode alongside live/source. Toggle it
      // against the editing modes: leaving reading returns to live preview.
      const current = tab.editingMode ?? "live";
      setTabEditingMode(tab.id, current === "reading" ? "live" : "reading");
    },
  });

  registerCommand({
    id: "view:toggle-distraction-free",
    title: t("command.view.toggle-distraction-free"),
    category: "View",
    keybinding: "Ctrl+Shift+1",
    execute: toggleDistractionFree,
  });

  // ── Edit commands ──

  // Zoom commands honour `settings.appearance.zoom_target`, which lets
  // the user pick whether Ctrl+= / Ctrl+- adjusts the editor body font,
  // the interface chrome, or both. Keeping that branching here (rather
  // than only in the keyboard handler) means the same behaviour applies
  // when zoom is triggered from the command palette.
  //
  // The "content" target resolves to whatever content is actually on screen:
  // in reading mode that's the compiled preview, which zooms as a whole
  // (page scale for SVG, layout zoom for HTML) rather than by nudging the
  // editor's body font — a font-size bump wouldn't scale an SVG page at all.
  // See `activeReadingTabId`.
  // "Ctrl+Plus" is ambiguous across keyboards: pressing the `=` key with
  // Ctrl (no Shift) produces `Ctrl+=`, holding Shift normalizes to `Ctrl+Shift+=`
  // (formatKeyCombo maps the shifted `+` glyph back to `=`), and the numpad
  // key produces `Ctrl++`. Register all three so the command fires regardless
  // of which physical keystroke the user makes.
  registerCommand({
    id: "edit:zoom-in",
    title: t("command.edit.zoom-in"),
    category: "Edit",
    keybinding: ["Ctrl+=", "Ctrl++", "Ctrl+Shift+="],
    execute: () => {
      const target = settings.appearance.zoom_target;
      if (target === "content" || target === "both") {
        const reading = activeReadingTabId();
        if (reading) nudgeTabReadingZoom(reading, READING_ZOOM_STEP);
        else {
          updateSetting(
            "editor",
            "body_font_size",
            Math.min(32, settings.editor.body_font_size + 1),
          );
        }
      }
      if (target === "interface" || target === "both") {
        updateSetting("editor", "font_size", Math.min(24, settings.editor.font_size + 1));
      }
    },
  });

  registerCommand({
    id: "edit:zoom-out",
    title: t("command.edit.zoom-out"),
    category: "Edit",
    keybinding: "Ctrl+-",
    execute: () => {
      const target = settings.appearance.zoom_target;
      if (target === "content" || target === "both") {
        const reading = activeReadingTabId();
        if (reading) nudgeTabReadingZoom(reading, 1 / READING_ZOOM_STEP);
        else {
          updateSetting(
            "editor",
            "body_font_size",
            Math.max(8, settings.editor.body_font_size - 1),
          );
        }
      }
      if (target === "interface" || target === "both") {
        updateSetting("editor", "font_size", Math.max(10, settings.editor.font_size - 1));
      }
    },
  });

  registerCommand({
    id: "edit:reset-zoom",
    title: t("command.edit.reset-zoom"),
    category: "Edit",
    keybinding: "Ctrl+0",
    execute: () => {
      const target = settings.appearance.zoom_target;
      if (target === "content" || target === "both") {
        const reading = activeReadingTabId();
        if (reading) resetTabReadingZoom(reading);
        else updateSetting("editor", "body_font_size", 17);
      }
      if (target === "interface" || target === "both") {
        updateSetting("editor", "font_size", 15);
      }
    },
  });

  registerCommand({
    id: "edit:paste-as-markdown",
    title: t("command.edit.paste-as-markdown"),
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

  // Annotation / suggestion authoring. These mirror the four InkyCap entries
  // in the `/` slash palette and the Annotations pane toolbar — all three route
  // through `insertAnnotationMarkup`, which wraps the current selection and
  // no-ops when no editor is focused, so the templates stay in one place.
  registerCommand({
    id: "edit:add-annotation",
    title: t("command.edit.add-annotation"),
    category: "Edit",
    execute: () => insertAnnotationMarkup(activeEditorView()?.view, "annotation"),
  });

  registerCommand({
    id: "edit:suggest-insertion",
    title: t("command.edit.suggest-insertion"),
    category: "Edit",
    execute: () => insertAnnotationMarkup(activeEditorView()?.view, "insert"),
  });

  registerCommand({
    id: "edit:suggest-deletion",
    title: t("command.edit.suggest-deletion"),
    category: "Edit",
    execute: () => insertAnnotationMarkup(activeEditorView()?.view, "delete"),
  });

  registerCommand({
    id: "edit:suggest-replacement",
    title: t("command.edit.suggest-replacement"),
    category: "Edit",
    execute: () => insertAnnotationMarkup(activeEditorView()?.view, "replace"),
  });

  // ── Tools commands ──

  registerCommand({
    id: "tools:audit-typ-files",
    title: t("command.tools.audit-typ-files"),
    category: "Tools",
    execute: callbacks.openTypAudit,
  });

  registerCommand({
    id: "tools:backup-now",
    title: t("backup.runNow.paletteTitle"),
    category: "Tools",
    execute: async () => {
      // Surface progress + result through the toast system rather
      // than opening Settings — palette flows shouldn't yank focus
      // into another UI surface. Errors and the per-run summary go
      // to the same place so the user has one consistent feedback
      // channel for ad-hoc backups.
      const { showToast, dismissToast } = await import("../stores/toasts");
      // Persistent toast: the backup write is synchronous on the
      // backend (zip serialization) and may take several seconds on
      // larger noteboxes, longer than the default 5s auto-dismiss.
      // Keep the "in progress" toast visible until the result toast
      // explicitly replaces it. The toast carries an X button wired
      // to `cancelBackup`, which flips the backend's cancel flag and
      // the archive writer aborts at its next poll.
      let cancelRequested = false;
      const progressId = showToast(
        "info",
        t("backup.toast.inProgress"),
        undefined,
        {
          persistent: true,
          onCancel: () => {
            cancelRequested = true;
            void ipc.cancelBackup();
          },
        },
      );
      try {
        const report = await ipc.backupNow();
        dismissToast(progressId);
        if (!report) {
          showToast("info", t("backup.toast.skipped"));
          return;
        }
        const mb = (report.uncompressed_bytes / 1024 / 1024).toFixed(2);
        showToast(
          "success",
          t("backup.toast.success", {
            files: report.file_count,
            size: mb,
            encrypted: report.encrypted ? t("backup.toast.successEncryptedSuffix") : "",
            pruned: report.pruned > 0
              ? t("backup.toast.successPrunedSuffix", { n: report.pruned })
              : "",
          }),
        );
      } catch (e) {
        dismissToast(progressId);
        if (cancelRequested || errorCode(e) === "cancelled") {
          showToast("info", t("backup.toast.cancelled"));
        } else {
          showToast("error", t("backup.toast.failed", { error: errorText(e) }));
        }
      }
    },
  });

  registerCommand({
    id: "tools:insert-scaffold",
    title: t("command.tools.insert-scaffold"),
    category: "Tools",
    // Moved off Ctrl+\ (now "toggle right panel") to keep the panel-toggle
    // pair Ctrl+/ + Ctrl+\ symmetric.
    keybinding: "Ctrl+Shift+\\",
    execute: callbacks.openScaffoldPicker,
  });

  registerCommand({
    id: "tools:mycelial-view",
    title: t("command.tools.mycelial-view"),
    category: "Tools",
    keybinding: "Ctrl+Shift+Y",
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
    id: "tools:journal-scroll",
    title: t("command.tools.journal-scroll"),
    category: "Tools",
    keybinding: "Ctrl+Shift+J",
    // Journal Scroll anchors on the active note and streams related notes in
    // place; the pill in the editor toolbar drives the same toggle.
    execute: () => {
      const tab = getActiveTab();
      if (tab && tab.type === "file") void toggleScroll(tab.id, tab.path);
    },
  });

  registerCommand({
    id: "references:cite",
    title: t("command.references.cite"),
    category: "References",
    keybinding: "Ctrl+Shift+C",
    execute: callbacks.openCitationPicker,
  });

  registerCommand({
    id: "references:import-note",
    title: t("command.references.import-note"),
    category: "References",
    execute: callbacks.openRefNotePicker,
  });


  registerCommand({
    id: "tools:export-pdf",
    title: t("command.tools.export-pdf"),
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
    title: t("command.tools.export-self-contained"),
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

  // ── Collaboration commands ──
  // Each gesture acts on the open collaborative notebox and opens the
  // collaboration panel for feedback (the post-sync digest, the import merge
  // result). When the notebox isn't collaborative they just open the panel
  // (its setup form). Sync / Check for updates apply only to an ONLINE git
  // remote; Export / Import package apply only to OFFLINE package handoff — a
  // command invoked in the wrong mode explains itself instead of acting.

  registerCommand({
    id: "git:sync",
    title: t("command.git.sync"),
    category: "Collaboration",
    keybinding: "Ctrl+Shift+S",
    execute: () => {
      if (!collaborative()) return void callbacks.openCollaborationPanel();
      if (packageMode()) return void showToast("info", t("command.git.onlineOnly"));
      callbacks.openCollaborationPanel();
      void gitSyncAction();
    },
  });

  registerCommand({
    id: "git:check-updates",
    title: t("command.git.checkUpdates"),
    category: "Collaboration",
    keybinding: "Ctrl+Shift+U",
    execute: () => {
      if (!collaborative()) return void callbacks.openCollaborationPanel();
      if (packageMode()) return void showToast("info", t("command.git.onlineOnly"));
      callbacks.openCollaborationPanel();
      void gitCheckUpdatesAction();
    },
  });

  // Package handoff (server-less). The command drives the same file-dialog
  // gesture as the panel buttons — opening the panel too so the export toast /
  // import merge result surface there.
  registerCommand({
    id: "git:export-package",
    title: t("command.git.exportPackage"),
    category: "Collaboration",
    keybinding: "Ctrl+Shift+E",
    execute: () => {
      if (!collaborative()) return void callbacks.openCollaborationPanel();
      if (!packageMode()) return void showToast("info", t("command.git.offlineOnly"));
      callbacks.openCollaborationPanel();
      void exportPackageInteractive();
    },
  });

  registerCommand({
    id: "git:import-package",
    title: t("command.git.importPackage"),
    category: "Collaboration",
    // Not Ctrl+Shift+I: the webview grabs that for "Inspect Element".
    keybinding: "Ctrl+Shift+G",
    execute: () => {
      if (!collaborative()) return void callbacks.openCollaborationPanel();
      if (!packageMode()) return void showToast("info", t("command.git.offlineOnly"));
      callbacks.openCollaborationPanel();
      void importPackageInteractive();
    },
  });

  // ── Zettelkasten commands ──

  registerCommand({
    id: "edit:insert-zid",
    title: t("command.edit.insert-zid"),
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

/**
 * Re-register the built-in commands so their titles pick up the active locale's
 * strings. Built-in commands capture their `t(...)` titles as frozen values in
 * the registry Map at registration time, so a language switch leaves them stale
 * until re-registered. `registerCommand` overwrites by id and bumps
 * `commandVersion`, so this is idempotent and prompts the command palette to
 * re-render. Called from src/stores/locale.ts on locale change. No-op before
 * the first `registerBuiltinCommands`. Creation-rule commands carry user-authored
 * titles (not translated), so they are intentionally left untouched.
 */
export function relocalizeCommands(): void {
  if (lastBuiltinCallbacks) registerBuiltinCommands(lastBuiltinCallbacks);
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
  type MarkupItem = { id: string; title: string; category: "Format" | "Structure" | "Insert" | "Symbol" | "Style" | "InkyCap" | "References"; insert: string; cursorOffset: number; shortcut?: string };

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
    { id: "term-list", title: "Term List", category: "Structure", insert: "/ ", cursorOffset: 2, shortcut: "/ Term: …" },
    { id: "quote-inline", title: "Quote (inline)", category: "Structure", insert: "#quote[${sel}]", cursorOffset: 7 },
    { id: "blockquote", title: "Blockquote", category: "Structure", insert: "#quote(block: true)[${sel}]", cursorOffset: 20, shortcut: "> " },

    // ── Insert ──
    { id: "link", title: "Link", category: "Insert", insert: '#link("")[${sel}]', cursorOffset: 7 },
    // Image/Video/Audio are special-cased below: rather than inserting a
    // template with an empty path the user must hand-type (which would produce
    // a fragile relative reference), they drive the attachment picker, copy the
    // chosen file(s) into `settings.files.attachment_folder`, and emit a
    // notebox-root-absolute `#image("/...")` / `#video(...)` / `#audio(...)`
    // call. The `insert` field is unused for those ids — the picker diverts the
    // execute path.
    { id: "image", title: "Image", category: "Insert", insert: '#image("")', cursorOffset: 8 },
    { id: "video", title: "Video", category: "Insert", insert: '#video("")', cursorOffset: 8 },
    { id: "audio", title: "Audio", category: "Insert", insert: '#audio("")', cursorOffset: 8 },
    { id: "code-block", title: "Code Block", category: "Insert", insert: "```\n${sel}\n```", cursorOffset: 4, shortcut: "```" },
    { id: "math-block", title: "Math Block", category: "Insert", insert: "$ ${sel} $", cursorOffset: 2 },
    { id: "horizontal-rule", title: "Horizontal Rule", category: "Insert", insert: "#line(length: 100%)", cursorOffset: 19, shortcut: "+++" },
    { id: "footnote", title: "Footnote", category: "Insert", insert: "#footnote[${sel}]", cursorOffset: 10, shortcut: "++…++" },
    { id: "table", title: "Table", category: "Insert", insert: '#table(\n  columns: (auto, auto, auto),\n  [Header 1], [Header 2], [Header 3],\n  [], [], [],\n)', cursorOffset: 76 },
    { id: "page-break", title: "Page Break", category: "Insert", insert: "#pagebreak()", cursorOffset: 12 },
    { id: "line-break", title: "Line Break", category: "Insert", insert: "#linebreak()", cursorOffset: 12 },
    { id: "lorem-ipsum", title: "Lorem Ipsum", category: "Insert", insert: "#lorem(50)", cursorOffset: 7 },
    { id: "figure", title: "Figure", category: "Insert", insert: '#figure(\n  [${sel}],\n  caption: [],\n)', cursorOffset: 12 },
    { id: "align", title: "Align", category: "Insert", insert: "#align(center)[${sel}]", cursorOffset: 15 },
    { id: "box", title: "Box", category: "Insert", insert: "#box[${sel}]", cursorOffset: 5 },
    { id: "rect", title: "Rect", category: "Insert", insert: "#rect[${sel}]", cursorOffset: 6 },
    { id: "hide", title: "Hide", category: "Insert", insert: "#hide[${sel}]", cursorOffset: 6 },
    { id: "callout", title: "Callout", category: "Insert", insert: '#callout("note")[${sel}]', cursorOffset: 17 },
    { id: "label", title: "Label", category: "Insert", insert: "<>", cursorOffset: 1, shortcut: "<…>" },
    { id: "citation-at", title: "Citation (@key)", category: "References", insert: "@", cursorOffset: 1, shortcut: "@" },
    { id: "bibliography", title: "Bibliography", category: "References", insert: '#bibliography("/.inkycap/zotero-export.bib")', cursorOffset: 16 },

    // ── Symbol shorthands ──
    { id: "em-dash", title: "Em dash (—)", category: "Symbol", insert: "---", cursorOffset: 3, shortcut: "---" },
    { id: "en-dash", title: "En dash (–)", category: "Symbol", insert: "--", cursorOffset: 2, shortcut: "--" },
    { id: "ellipsis", title: "Ellipsis (…)", category: "Symbol", insert: "...", cursorOffset: 3, shortcut: "..." },
    { id: "nbsp", title: "Non-breaking space", category: "Symbol", insert: "~", cursorOffset: 1, shortcut: "~" },
    { id: "soft-hyphen", title: "Soft hyphen", category: "Symbol", insert: "-?", cursorOffset: 2, shortcut: "-?" },

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
    { id: "task", title: "Task", category: "InkyCap", insert: '#task("")', cursorOffset: 7, shortcut: "- [ ]" },
    { id: "due", title: "Due date", category: "InkyCap", insert: "#due()", cursorOffset: 5 },
  ];

  const ATTACHMENT_IDS = new Set(["image", "video", "audio"]);
  for (const item of items) {
    const execute = ATTACHMENT_IDS.has(item.id)
      ? () => insertAttachmentViaPicker(item.id as "image" | "video" | "audio")
      : () => insertMarkup(item.insert, item.cursorOffset);

    registerCommand({
      // `item.title` stays as the English source (mirrored in en.json under
      // `command.markup.<id>`); the registered title is the localized form,
      // resolved here so `relocalizeCommands()` refreshes it on a UI-language
      // switch. The translated label also drives the palette's fuzzy search.
      id: `markup:${item.id}`,
      title: t(`command.markup.${item.id}`),
      category: item.category,
      shortcut: item.shortcut,
      execute,
    });
  }
}

async function insertAttachmentViaPicker(func: "image" | "video" | "audio") {
  const handle = activeEditorView();
  if (!handle) return;
  const view = handle.view;
  const sel = view.state.selection.main;
  await pickAndInsertAttachments(view, sel.from, sel.to, func);
}

/** Keep the command registry in sync with the user's creation rules, so each
 *  rule's palette entry and global hotkey reflect edits without a relaunch.
 *
 *  Driven reactively off the `creationRules` store (the same signal the toolbar
 *  reads), this re-runs whenever a rule is saved, toggled, or deleted —
 *  registering the current active set and unregistering rules that disappeared
 *  or were disabled. This is what makes a newly-assigned hotkey live
 *  immediately: the global keydown dispatcher reads `keybinding` live from the
 *  registry, but only sees it once the command is (re-)registered here.
 *
 *  Mirrors `registerExternalToolCommands`. Call once at startup inside a
 *  reactive owner (App's onMount). Disabled rules are excluded by
 *  `activeRules()`. */
export function registerCreationRuleCommands(): void {
  let registered = new Set<string>();
  createEffect(() => {
    const next = new Set<string>();
    for (const rule of activeRules()) {
      const id = `creation-rule:${rule.id}`;
      next.add(id);
      registerCommand({
        id,
        title: rule.name,
        category: "Creation Rules",
        keybinding: rule.hotkey ?? undefined,
        execute: async () => {
          try {
            const result = await triggerCreationRule(rule.id);
            if (!result) return;
            if (rule.creation_mode === "create_and_open") {
              const name = result.path.split("/").pop() ?? "New Note";
              openCreatedNote(
                { type: "file", title: name, path: result.path },
                { cursorOffset: result.cursor_offset ?? undefined },
              );
            }
          } catch (e) {
            console.error(`Failed to execute creation rule ${rule.id}:`, e);
          }
        },
      });
    }
    // Drop commands for rules that were deleted or disabled since the last run.
    for (const id of registered) {
      if (!next.has(id)) unregisterCommand(id);
    }
    registered = next;
  });
}
