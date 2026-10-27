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
import NameAuditDialog from "./components/NameAuditDialog";
import { initNotebox, openNotebox, showNoteboxPicker, noteboxInfo, initAttempted } from "./stores/notebox";
import { initTheme, applyFontSettings } from "./stores/theme";
import { initLocale, syncLocaleFromSettings } from "./stores/locale";
import { maybeCheckOnStartup } from "./stores/updater";
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
import { initShortcuts } from "./lib/shortcuts";
import { initFocusRegions } from "./lib/focus-regions";
import { initInputModality } from "./lib/input-modality";
import { initMenuNav, destroyMenuNav } from "./lib/menu-nav";
import { initMenuPlacement, destroyMenuPlacement } from "./lib/menu-placement";
import { initTauriDragDrop, initHtml5DragDrop } from "./lib/tauri-drag-drop";
import { isWindows } from "./lib/platform";
import { openTab, getActiveTab, activeTabId, tabs } from "./stores/tabs";
import { installTabSessionRecorder } from "./stores/tab-session";
import { collaborative, setManageOpen } from "./stores/git";
import { registerBuiltinCommands, registerCreationRuleCommands } from "./lib/commands";
import { registerExternalToolPalette, registerExternalToolCommands } from "./lib/external-tools";
import { loadPlugins } from "./lib/plugins";
import { activeEditorView } from "./stores/editor";
import { applyUiScale } from "./lib/ui-scale";
import { loadCreationRules, triggerCreationRule } from "./stores/creation-rules";
import { useI18n } from "./lib/i18n";
import { followDelivery, followInOpenNotebox, listenForDeepLinks } from "./lib/deep-link";
import * as ipc from "./lib/ipc";
import type { DeepLink } from "./lib/types";

const App: Component = () => {
  const t = useI18n();
  const [sidebarMode, setSidebarMode] = createSignal<SidebarMode>("filetree");
  const [quickOpenVisible, setQuickOpenVisible] = createSignal(false);
  const [settingsVisible, setSettingsVisible] = createSignal(false);
  // An explicit tab to open Settings on (a deep-link). `undefined` means "open
  // wherever the user last was" — SettingsPanel remembers that within a session.
  const [settingsInitialTab, setSettingsInitialTab] = createSignal<string | undefined>(undefined);
  const [cmdPaletteVisible, setCmdPaletteVisible] = createSignal(false);
  const [citationPickerVisible, setCitationPickerVisible] = createSignal(false);
  const [refNotePickerVisible, setRefNotePickerVisible] = createSignal(false);
  const [typAuditVisible, setTypAuditVisible] = createSignal(false);
  const [nameAuditVisible, setNameAuditVisible] = createSignal(false);
  const [scaffoldPickerVisible, setScaffoldPickerVisible] = createSignal(false);

  // Keep the record of open tabs current for the "previous tabs" startup
  // option. Does nothing unless that option is chosen.
  installTabSessionRecorder();

  // Persist the active file path so "last-file" startup behavior can restore it.
  createEffect(() => {
    const id = activeTabId();
    if (!id) return;
    const tab = tabs.find((t) => t.id === id);
    if (tab && tab.type === "file" && tab.path) {
      updateNoteboxSetting("startup", "last_active_file", tab.path);
    }
  });

  // The left sidebar follows the active tab: Collections for a collection tab,
  // the browse panel for a file or Mycelial tab. The last browse mode is
  // remembered, so moving between notes keeps Files, Tags, Bookmarks etc. as
  // the user left them.
  //
  // An empty tab leaves the sidebar as it is, so deleting the only collection,
  // or opening a new tab beside one, keeps Collections showing. A tab with
  // content always re-syncs it.
  let lastBrowseMode: SidebarMode = "filetree";

  // Mode changes the user makes (toolbar, mode bar, Ctrl+Shift+F) go through
  // here so the browse mode is recorded. The tab-driven effect below sets the
  // signal directly, so a forced "collections" isn't remembered. "help" isn't
  // recorded either: it is a reference overlay, and this gives `openHelp` the
  // panel to return to.
  const selectSidebarMode = (m: SidebarMode) => {
    if (m !== "collections" && m !== "help") lastBrowseMode = m;
    setSidebarMode(m);
  };

  // Reveal the Help panel, expanding the sidebar if it is collapsed. The view
  // it lands on is whatever the caller put in the help store.
  const showHelp = () => {
    selectSidebarMode("help");
    if (leftCollapsed()) setLeftCollapsed(false);
  };

  // F1 / Info button toggle: open the Help panel, or — if it's already showing —
  // return to the panel the user was last browsing.
  const toggleHelp = () => {
    if (sidebarMode() === "help" && !leftCollapsed()) {
      selectSidebarMode(lastBrowseMode);
    } else {
      showHelp();
    }
  };

  // Other entry points (e.g. the empty-tab markup link) ask for the panel on a
  // specific view; they set the view in the help store, we just reveal it.
  {
    document.addEventListener("inkycap:open-help", showHelp);
    onCleanup(() => document.removeEventListener("inkycap:open-help", showHelp));
  }

  // Load declarative plugins at startup and whenever the notebox changes, since
  // notebox manifests are in its `.inkycap/plugins`. loadPlugins removes earlier
  // registrations first.
  createEffect(() => {
    noteboxInfo()?.path; // track: re-run on notebox change
    void loadPlugins();
  });

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

  // The collaboration pane also serves setting up a non-collaborative notebox
  // (its SetupForm), so only leave it when the active notebox stops being
  // collaborative while it is showing (a switch, or Stop collaborating), not
  // when the user opens it to set up. Watch the true → false change, not the
  // state, so opening it doesn't bounce away. Falls back to Collections for a
  // collection tab, else the last browse pane (or the file tree).
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
    // No forced tab — reopen on the section the user last viewed this session.
    setSettingsInitialTab(undefined);
    setSettingsVisible((v) => !v);
  };

  // Without an active notebox (e.g. it was removed in Settings),
  // NoteboxRequiredOverlay takes the screen, so close Settings.
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
    // Set the UI language before registering commands, so their titles are
    // right from the start; follow outside changes (e.g. a settings import).
    initLocale();
    onSettingsChange(syncLocaleFromSettings);
    // A secondary window can be opened on a notebox with `?notebox=<path>` (the
    // Documentation window does). Otherwise restore the last notebox.
    // openNotebox runs applyStartupBehavior itself.
    const params = new URLSearchParams(window.location.search);
    const noteboxParam = params.get("notebox");
    const fileParam = params.get("path");
    // A window opened to follow an inkycap:// link carries the link, already
    // checked by the backend, in `?link=` (see lib/new-window.ts).
    const linkParam = params.get("link");
    // Subscribe before the main window asks for its startup link below, so a
    // link arriving in between is not missed.
    await listenForDeepLinks();
    if (noteboxParam) {
      try {
        const opened = await openNotebox(noteboxParam);
        if (opened && linkParam) void followInOpenNotebox(JSON.parse(linkParam) as DeepLink);
        // A secondary window may also name a file to open within that notebox
        // (the "open in a new window" actions pass both notebox + path).
        if (fileParam) {
          const title = fileParam.split(/[/\\]/).pop() ?? fileParam;
          // Reuse the window's empty tab instead of adding a second one; only
          // open a new tab if the active one has content.
          openTab(
            { type: "file", title, path: fileParam },
            { forceNewTab: getActiveTab()?.type !== "empty" },
          );
        }
      } catch (e) {
        console.warn("Window failed to open its requested notebox:", e);
        await initNotebox();
      }
    } else if (params.get("new") !== null) {
      // A "new window" with no notebox chosen yet: show the picker rather than
      // auto-restoring the saved notebox, so the user opens what they want here.
      await showNoteboxPicker();
    } else {
      // A link InkyCap was started with opens its notebox in place of the
      // one restored from last time, without asking.
      const startupLink = await ipc.deepLinkReady().catch(() => null);
      await initNotebox(
        startupLink?.kind === "openNotebox" ? startupLink.link.notebox.path : undefined,
      );
      if (startupLink) void followDelivery(startupLink);
    }
    // Register the built-in commands. The keyboard dispatcher (initKeyboard,
    // below) reads key bindings from the registry, so any `keybinding` works as
    // a hotkey.
    registerBuiltinCommands({
      toggleQuickOpen,
      toggleSettings,
      toggleCommandPalette,
      openCitationPicker: () => setCitationPickerVisible(true),
      openRefNotePicker: () => setRefNotePickerVisible(true),
      openSearch: () => document.dispatchEvent(new CustomEvent("inkycap:open-search")),
      openTypAudit: () => setTypAuditVisible(true),
      openNameAudit: () => setNameAuditVisible(true),
      openScaffoldPicker: () => setScaffoldPickerVisible(true),
      openCollaborationPanel: () =>
        document.dispatchEvent(new CustomEvent("inkycap:open-collaboration")),
      openHelp: toggleHelp,
    });

    initKeyboard();
    initInputModality();
    initMenuNav();
    initMenuPlacement();

    // Register the creation rules too (this gives "New Note" its Ctrl+N), after
    // `initKeyboard`; the dispatcher reads the registry on every keydown, so
    // new rule hotkeys work without a restart.
    registerCreationRuleCommands();

    // Apply saved shortcut overrides on top of the registered defaults and keep
    // them in sync; after all commands are registered so bindings resolve in
    // one pass.
    initShortcuts();

    // External tools: in the `/` menu for those that opt in, otherwise in the
    // command palette. The slash source reads settings when it opens; the
    // registry follows settings changes.
    registerExternalToolPalette();
    registerExternalToolCommands();

    // Load creation rules into the reactive store (toolbar reads from it)
    void loadCreationRules();

    // Optional update check on launch, main window only (secondary windows have
    // `?notebox=` or `?new`). No network request unless
    // settings.updates.check_on_startup is on.
    if (!noteboxParam && params.get("new") === null) {
      void maybeCheckOnStartup();
    }

    // Drops from the OS file manager.
    //
    // On Linux (webkit2gtk), the DOM hides file paths during drags, so
    // drag-drop.ts can't see them; Tauri's native event can.
    //
    // On Windows, `dragDropEnabled` is false (see tauri.windows.conf.json) so
    // HTML5 drag and drop works for moving tree rows. The native event doesn't
    // fire, and file drops arrive as HTML5 DragEvents with
    // `dataTransfer.files`.
    if (isWindows()) {
      initHtml5DragDrop();
    } else {
      void initTauriDragDrop();
    }
  });

  // Switch to search panel when Ctrl+Shift+F fires
  {
    const openSearchHandler = () => selectSidebarMode("search");
    document.addEventListener("inkycap:open-search", openSearchHandler);
    onCleanup(() => document.removeEventListener("inkycap:open-search", openSearchHandler));
  }

  // Switch to the Agenda panel when a saved-view bookmark is activated. The
  // pending view is held in the agendaView store; the panel applies it on mount.
  {
    const openAgendaHandler = () => selectSidebarMode("agenda");
    document.addEventListener("inkycap:open-agenda", openAgendaHandler);
    onCleanup(() => document.removeEventListener("inkycap:open-agenda", openAgendaHandler));
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
    // A deep-link may target a specific tab; without one, honour the remembered
    // section rather than forcing Overview.
    setSettingsInitialTab(detail?.tab);
    setSettingsVisible(true);
  };
  document.addEventListener("inkycap:open-settings", onOpenSettings);
  onCleanup(() => document.removeEventListener("inkycap:open-settings", onOpenSettings));

  // Open the Git Collaboration panel (from Settings, the status-bar chip or the
  // palette): close Settings, show the sidebar and switch to it.
  const onOpenCollaboration = (e: Event) => {
    setSettingsVisible(false);
    if (leftCollapsed()) setLeftCollapsed(false);
    selectSidebarMode("collaboration");
    // From Settings › Configure, open with Manage expanded; from the toolbar or
    // status bar, collapsed.
    if ((e as CustomEvent).detail?.manage) setManageOpen(true);
  };
  document.addEventListener("inkycap:open-collaboration", onOpenCollaboration);
  onCleanup(() => document.removeEventListener("inkycap:open-collaboration", onOpenCollaboration));

  // Escape-to-editor for keyboard region navigation (F6 cycling and
  // Ctrl+Shift+0 are registry commands; only Escape needs a live listener).
  const disposeFocusRegions = initFocusRegions();

  onCleanup(() => {
    flushSettingsSave();
    destroyKeyboard();
    destroyMenuNav();
    destroyMenuPlacement();
    disposeFocusRegions();
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
          onOpenCommandPalette={toggleCommandPalette}
          onToggleHelp={toggleHelp}
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
        <NameAuditDialog
          open={nameAuditVisible()}
          onClose={() => setNameAuditVisible(false)}
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
