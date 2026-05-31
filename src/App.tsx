import { errorText } from "./lib/errors";
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
  distractionFree,
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
import { initLocale, syncLocaleFromSettings } from "./stores/locale";
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
import { collaborative, setManageOpen } from "./stores/git";
import { registerBuiltinCommands, registerCreationRuleCommands } from "./lib/commands";
import { activeEditorView } from "./stores/editor";
import { applyUiScale } from "./lib/ui-scale";
import { loadCreationRules, triggerCreationRule } from "./stores/creation-rules";
import { useI18n } from "./lib/i18n";

const App: Component = () => {
  const t = useI18n();
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

  // The left sidebar follows the active tab's content: a collection tab shows
  // the Collections list; a file / mycelial tab shows the general notebox
  // browse panel. We remember the most recent non-collection ("browse") mode
  // the user chose so moving between notes restores Files / Tags / Bookmarks /
  // etc. as they left it, rather than snapping back to Files each time.
  //
  // An *empty* tab (a fresh "New tab", or the placeholder left after the last
  // real tab closes) has no content of its own, so it leaves the sidebar where
  // it is: deleting the only collection, or opening a new tab beside one,
  // keeps the Collections panel up instead of throwing the user to the file
  // tree. Switching to a tab that *does* have content always re-syncs the
  // sidebar to match it.
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
    const type = tabs.find((t) => t.id === id)?.type;
    if (type === "collection") {
      setSidebarMode("collections");
    } else if (type && type !== "empty") {
      // A file / mycelial tab — match the content by restoring the browse panel.
      setSidebarMode(lastBrowseMode);
    }
    // An empty tab leaves the sidebar untouched (sticky), so closing a
    // collection down to an empty workspace doesn't yank the panel away.
  });

  // The collaboration pane is meaningful for a collaborative notebox (sync /
  // history) AND for a non-collaborative one the user is actively setting up —
  // the SetupForm lives there, reached by toggling collaboration on or the
  // `git:setup` command. So only LEAVE the pane when the active notebox
  // *becomes* non-collaborative while we're parked on it (i.e. a switch to a
  // non-collaborative notebox, or Stop collaborating), never when the user
  // deliberately opens the pane on a non-collaborative notebox to set it up.
  // We watch the `collaborative` true→false transition rather than the bare
  // `!collaborative()` state so opening the pane doesn't bounce away. Falls back
  // to the pane that fits: collections for a collection tab, else the last
  // browse pane (or the file tree).
  let prevSidebarMode = sidebarMode();
  let wasCollaborative = collaborative();
  createEffect(() => {
    const mode = sidebarMode();
    const isCollaborative = collaborative();
    const becameNonCollaborative = wasCollaborative && !isCollaborative;
    const stayedOnPane = mode === "collaboration" && prevSidebarMode === "collaboration";
    prevSidebarMode = mode;
    wasCollaborative = isCollaborative;
    if (stayedOnPane && becameNonCollaborative) {
      const active = tabs.find((t) => t.id === activeTabId());
      setSidebarMode(
        active?.type === "collection"
          ? "collections"
          : lastBrowseMode === "collaboration"
            ? "filetree"
            : lastBrowseMode,
      );
    }
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
    // Apply the UI language before registering commands below, so command
    // titles are built from the correct dictionary on first paint. React to
    // external changes (e.g. a settings import) live.
    initLocale();
    onSettingsChange(syncLocaleFromSettings);
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
  const onOpenCollaboration = (e: Event) => {
    setSettingsVisible(false);
    if (leftCollapsed()) setLeftCollapsed(false);
    selectSidebarMode("collaboration");
    // The Settings › Configure entry point asks for the Manage section expanded
    // (the user is there to edit the configuration); the toolbar / status-bar
    // entry points leave it collapsed (the sync workflow).
    if ((e as CustomEvent).detail?.manage) setManageOpen(true);
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
            <h2 style={{ "margin-bottom": "0.5rem" }}>{t("app.error.title")}</h2>
            <p style={{ color: "var(--fg-muted)", "margin-bottom": "1rem" }}>{errorText(err)}</p>
            <button onClick={() => window.location.reload()} style={{ padding: "6px 16px", cursor: "pointer" }}>{t("app.error.reload")}</button>
          </div>
        </div>
      )}
    >
      <div
        class={`app-shell${leftCollapsed() ? " app-shell--left-collapsed" : ""}${rightCollapsed() ? " app-shell--right-collapsed" : ""}${distractionFree() ? " app-shell--distraction-free" : ""}`}
        style={{
          "--left-width":
            distractionFree() || leftCollapsed() ? "0px" : `${leftWidth()}px`,
          "--right-width":
            distractionFree() || rightCollapsed() ? "0px" : `${rightWidth()}px`,
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
          title={rightCollapsed() ? t("app.rightSidebar.show") : t("app.rightSidebar.hide")}
          aria-label={rightCollapsed() ? t("app.rightSidebar.show") : t("app.rightSidebar.hide")}
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
