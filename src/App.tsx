import { Component, createEffect, createSignal, ErrorBoundary, onCleanup, onMount, Show } from "solid-js";
import LeftSidebar from "./components/LeftSidebar";
import MainContent from "./components/MainContent";
import RightPanel from "./components/RightPanel";
import StatusBar from "./components/StatusBar";
import ResizeHandle from "./components/ResizeHandle";
import VerticalToolbar, { type SidebarMode } from "./components/VerticalToolbar";
import NoteboxLostBanner from "./components/NoteboxLostBanner";
import NoteboxRequiredOverlay from "./components/NoteboxRequiredOverlay";
import {
  leftWidth,
  rightWidth,
  leftCollapsed,
  rightCollapsed,
  setLeftWidth,
  setRightWidth,
  setLeftCollapsed,
  toggleRightCollapsed,
} from "./stores/layout";
import { PanelRightDashed } from "lucide-solid";
import QuickOpen from "./components/QuickOpen";
import SettingsPanel from "./components/SettingsPanel";
import ScaffoldPicker from "./components/ScaffoldPicker";
import CommandPalette from "./components/CommandPalette";
import CitationPicker from "./components/CitationPicker";
import RefNotePicker from "./components/RefNotePicker";
import ExportDialog from "./components/ExportDialog";
import ToastHost from "./components/ToastHost";
import PromptHost from "./components/PromptHost";
import FolderPickerHost from "./components/FolderPickerHost";
import NoteboxSeedHost from "./components/NoteboxSeedHost";
import TypAuditDialog from "./components/TypAuditDialog";
import { initNotebox, noteboxInfo, initAttempted } from "./stores/notebox";
import { initTheme, applyFontSettings } from "./stores/theme";
import {
  initSettings,
  onSettingsChange,
  settings,
  noteboxSettings,
  updateNoteboxSetting,
  flushSettingsSave,
} from "./stores/settings";
import { stopLsp } from "./stores/lsp";
import { initKeyboard, destroyKeyboard } from "./lib/keyboard";
import { initTauriDragDrop } from "./lib/tauri-drag-drop";
import { openTab, getActiveTab, activeTabId, tabs } from "./stores/tabs";
import { registerBuiltinCommands, registerCreationRuleCommands } from "./lib/commands";
import { activeEditorView } from "./stores/editor";
import { applyUiScale } from "./lib/ui-scale";
import { loadCreationRules, triggerCreationRule } from "./stores/creation-rules";

const App: Component = () => {
  const [sidebarMode, setSidebarMode] = createSignal<SidebarMode>("filetree");
  const [quickOpenVisible, setQuickOpenVisible] = createSignal(false);
  const [settingsVisible, setSettingsVisible] = createSignal(false);
  const [settingsInitialTab, setSettingsInitialTab] = createSignal<string>("overview");
  const [cmdPaletteVisible, setCmdPaletteVisible] = createSignal(false);
  const [citationPickerVisible, setCitationPickerVisible] = createSignal(false);
  const [refNotePickerVisible, setRefNotePickerVisible] = createSignal(false);
  const [typAuditVisible, setTypAuditVisible] = createSignal(false);
  const [scaffoldPickerVisible, setScaffoldPickerVisible] = createSignal(false);

  // Persist the active file path so "last-file" startup behavior can restore it.
  createEffect(() => {
    const id = activeTabId();
    if (!id) return;
    const tab = tabs.find((t) => t.id === id);
    if (tab && tab.type === "file" && tab.path) {
      updateNoteboxSetting("startup", "last_active_file", tab.path);
    }
  });

  // The left sidebar follows the active tab's context: a collection tab always
  // shows the Collections list, while every other tab (note/file/mycelial)
  // shows the general notebox sidebar. We remember the most recent
  // non-collection ("browse") mode the user chose so that switching from a
  // collection back to a note restores Files / Tags / Bookmarks / etc. exactly
  // as they left it, rather than snapping back to Files each time. Only the
  // collection-vs-not distinction drives the auto-switch; the cross-cutting
  // browse modes apply to the whole notebox regardless of which note is open.
  let lastBrowseMode: SidebarMode = "filetree";

  // User-initiated mode changes (toolbar buttons, the sidebar mode bar,
  // Ctrl+Shift+F search) route through here so the last browse mode is
  // recorded. The tab-driven effect below sets the signal directly and is
  // deliberately NOT recorded, so an auto-forced "collections" never becomes
  // the remembered browse mode.
  const selectSidebarMode = (m: SidebarMode) => {
    if (m !== "collections") lastBrowseMode = m;
    setSidebarMode(m);
  };

  createEffect(() => {
    const id = activeTabId();
    // Read the type reactively (not just the id) so an in-place type change
    // is also honoured.
    const tab = tabs.find((t) => t.id === id);
    setSidebarMode(tab?.type === "collection" ? "collections" : lastBrowseMode);
  });

  const toggleSettings = () => {
    setSettingsInitialTab("overview");
    setSettingsVisible((v) => !v);
  };

  // When the app falls into the "no active notebox" state — e.g. the user
  // removed the active notebox from Settings — the NoteboxRequiredOverlay must
  // own the screen. Close Settings so the overlay isn't stacked behind it.
  createEffect(() => {
    if (initAttempted() && !noteboxInfo() && settingsVisible()) {
      setSettingsVisible(false);
    }
  });
  const toggleQuickOpen = () => setQuickOpenVisible((v) => !v);
  const toggleCommandPalette = () => setCmdPaletteVisible((v) => !v);

  onMount(async () => {
    // Load settings first — theme and other init depends on them
    await initSettings();
    applyUiScale(settings.editor.font_size);
    onSettingsChange((s) => applyUiScale(s.editor.font_size));
    await applyFontSettings(settings.fonts);
    onSettingsChange((s) => applyFontSettings(s.fonts));
    initTheme();
    // openNotebox now runs applyStartupBehavior internally on every
    // successful open (initial launch and subsequent switches alike),
    // so we don't need to call it separately here.
    await initNotebox();
    // Register every built-in command with the registry. The global
    // keyboard dispatcher (initKeyboard, called below) reads keybindings
    // straight off the registry, so anything with a `keybinding` field
    // becomes a working hotkey automatically — no per-key wiring here.
    registerBuiltinCommands({
      toggleQuickOpen,
      toggleSettings,
      toggleCommandPalette,
      openCitationPicker: () => setCitationPickerVisible(true),
      openRefNotePicker: () => setRefNotePickerVisible(true),
      openSearch: () => document.dispatchEvent(new CustomEvent("inkycap:open-search")),
      openTypAudit: () => setTypAuditVisible(true),
      openScaffoldPicker: () => setScaffoldPickerVisible(true),
      openCollaborationPanel: () =>
        document.dispatchEvent(new CustomEvent("inkycap:open-collaboration")),
    });

    initKeyboard();

    // Register the user's creation rules with the registry as well —
    // this is what gives e.g. "New Note" its Ctrl+N binding.
    // Done after `initKeyboard` so newly-added rule hotkeys take effect
    // without needing a relaunch (the dispatcher reads live from the
    // registry on every keydown).
    registerCreationRuleCommands();

    // Load creation rules into the reactive store (toolbar reads from it)
    void loadCreationRules();

    // Native drag-drop from the OS file manager. WebKitGTK blocks
    // cross-origin reads of dataTransfer for security, so the JS
    // drag-drop events in typst-decorations/drag-drop.ts can't see
    // the file paths on Linux. Tauri's own listener bypasses that.
    void initTauriDragDrop();
  });

  // Switch to search panel when Ctrl+Shift+F fires
  {
    const openSearchHandler = () => selectSidebarMode("search");
    document.addEventListener("inkycap:open-search", openSearchHandler);
    onCleanup(() => document.removeEventListener("inkycap:open-search", openSearchHandler));
  }

  // Insert citation from References panel browse
  {
    const insertCitationHandler = (e: Event) => {
      const key = (e as CustomEvent).detail?.key;
      if (!key) return;
      const h = activeEditorView();
      if (!h) return;
      const view = h.view;
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: `@${key}` },
        selection: { anchor: from + key.length + 1 },
      });
      view.focus();
    };
    document.addEventListener("inkycap:insert-citation", insertCitationHandler);
    onCleanup(() => document.removeEventListener("inkycap:insert-citation", insertCitationHandler));
  }

  const onOpenSettings = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    setSettingsInitialTab(detail?.tab ?? "overview");
    setSettingsVisible(true);
  };
  document.addEventListener("inkycap:open-settings", onOpenSettings);
  onCleanup(() => document.removeEventListener("inkycap:open-settings", onOpenSettings));

  // Open the Git Collaboration sidebar panel (from Settings' per-notebox entry
  // point, the status-bar chip, or the command palette). Close Settings,
  // ensure the sidebar is visible, and switch to the collaboration mode.
  const onOpenCollaboration = () => {
    setSettingsVisible(false);
    if (leftCollapsed()) setLeftCollapsed(false);
    selectSidebarMode("collaboration");
  };
  document.addEventListener("inkycap:open-collaboration", onOpenCollaboration);
  onCleanup(() => document.removeEventListener("inkycap:open-collaboration", onOpenCollaboration));

  onCleanup(() => {
    flushSettingsSave();
    destroyKeyboard();
    stopLsp();
  });

  return (
    <ErrorBoundary
      fallback={(err) => (
        <div class="app-shell" style={{ display: "flex", "align-items": "center", "justify-content": "center", height: "100vh", padding: "2rem", "text-align": "center" }}>
          <div>
            <h2 style={{ "margin-bottom": "0.5rem" }}>Something went wrong</h2>
            <p style={{ color: "var(--fg-muted)", "margin-bottom": "1rem" }}>{err?.message ?? String(err)}</p>
            <button onClick={() => window.location.reload()} style={{ padding: "6px 16px", cursor: "pointer" }}>Reload</button>
          </div>
        </div>
      )}
    >
      <div
        class={`app-shell${leftCollapsed() ? " app-shell--left-collapsed" : ""}${rightCollapsed() ? " app-shell--right-collapsed" : ""}`}
        style={{
          "--left-width": leftCollapsed() ? "0px" : `${leftWidth()}px`,
          "--right-width": rightCollapsed() ? "0px" : `${rightWidth()}px`,
        }}
      >
        <NoteboxLostBanner />
        <VerticalToolbar
          mode={sidebarMode}
          setMode={selectSidebarMode}
          onOpenSettings={toggleSettings}
        />
        <LeftSidebar mode={sidebarMode} setMode={selectSidebarMode} />
        <MainContent />
        <RightPanel />
        <button
          class="right-panel-toggle"
          onClick={toggleRightCollapsed}
          title={rightCollapsed() ? "Show right sidebar" : "Hide right sidebar"}
          aria-label={rightCollapsed() ? "Show right sidebar" : "Hide right sidebar"}
        >
          <PanelRightDashed size={16} />
        </button>
        <ResizeHandle
          side="left"
          getWidth={leftWidth}
          setWidth={setLeftWidth}
        />
        <ResizeHandle
          side="right"
          getWidth={rightWidth}
          setWidth={setRightWidth}
        />
        <StatusBar />
        <QuickOpen
          visible={quickOpenVisible()}
          onClose={() => setQuickOpenVisible(false)}
        />
        <SettingsPanel
          visible={settingsVisible()}
          onClose={() => setSettingsVisible(false)}
          initialTab={settingsInitialTab()}
        />
        <ScaffoldPicker
          visible={scaffoldPickerVisible()}
          onClose={() => setScaffoldPickerVisible(false)}
        />
        <CommandPalette
          visible={cmdPaletteVisible()}
          onClose={() => setCmdPaletteVisible(false)}
        />
        <CitationPicker
          visible={citationPickerVisible()}
          onClose={() => setCitationPickerVisible(false)}
        />
        <RefNotePicker
          visible={refNotePickerVisible()}
          onClose={() => setRefNotePickerVisible(false)}
        />
        <ExportDialog />
        <TypAuditDialog
          open={typAuditVisible()}
          onClose={() => setTypAuditVisible(false)}
        />
        <ToastHost />
        <PromptHost />
        <FolderPickerHost />
        <NoteboxSeedHost />
        <NoteboxRequiredOverlay />
      </div>
    </ErrorBoundary>
  );
};

export default App;
