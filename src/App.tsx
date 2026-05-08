import { Component, createEffect, createSignal, ErrorBoundary, onCleanup, onMount, Show } from "solid-js";
import LeftSidebar from "./components/LeftSidebar";
import MainContent from "./components/MainContent";
import RightPanel from "./components/RightPanel";
import StatusBar from "./components/StatusBar";
import ResizeHandle from "./components/ResizeHandle";
import VerticalToolbar, { type SidebarMode } from "./components/VerticalToolbar";
import {
  leftWidth,
  rightWidth,
  leftCollapsed,
  rightCollapsed,
  setLeftWidth,
  setRightWidth,
  toggleRightCollapsed,
} from "./stores/layout";
import { PanelRightDashed } from "lucide-solid";
import QuickOpen from "./components/QuickOpen";
import SettingsPanel from "./components/SettingsPanel";
import CommandPalette from "./components/CommandPalette";
import CitationPicker from "./components/CitationPicker";
import NoteComposer from "./components/NoteComposer";
import ExportDialog from "./components/ExportDialog";
import ToastHost from "./components/ToastHost";
import SnapshotViewer from "./components/SnapshotViewer";
import TypAuditDialog from "./components/TypAuditDialog";
import { initVault } from "./stores/vault";
import { initTheme, applyMonospaceFont, applyInterfaceFont } from "./stores/theme";
import { initSettings, onSettingsChange, settings, updateSetting } from "./stores/settings";
import { stopLsp } from "./stores/lsp";
import { initKeyboard, destroyKeyboard, onShortcut } from "./lib/keyboard";
import { initTauriDragDrop } from "./lib/tauri-drag-drop";
import { openTab, getActiveTab, activeTabId, tabs } from "./stores/tabs";
import { registerBuiltinCommands, registerCreationRuleCommands } from "./lib/commands";
import { activeEditorView } from "./stores/editor";
import { applyUiScale } from "./lib/ui-scale";
import { loadCreationRules } from "./stores/creation-rules";
import * as ipc from "./lib/ipc";
import { toastError } from "./stores/toasts";

function applyStartupBehavior() {
  const { behavior, target, last_active_file } = settings.startup;

  switch (behavior) {
    case "last-file":
      if (last_active_file) {
        const name = last_active_file.split("/").pop() ?? last_active_file;
        openTab({ type: "file", title: name, path: last_active_file });
      }
      break;

    case "creation-rule":
      if (target) {
        ipc.executeCreationRule(target).then((result) => {
          const name = result.path.split("/").pop() ?? "New Note";
          openTab(
            { type: "file", title: name, path: result.path },
            { cursorOffset: result.cursor_offset ?? undefined },
          );
        }).catch((e) => {
          console.error("Startup creation rule failed:", e);
        });
      }
      break;

    case "specific-page":
      if (target) {
        const name = target.split("/").pop() ?? target;
        openTab({ type: "file", title: name, path: target });
      }
      break;
  }
}

const App: Component = () => {
  const [sidebarMode, setSidebarMode] = createSignal<SidebarMode>("filetree");
  const [quickOpenVisible, setQuickOpenVisible] = createSignal(false);
  const [settingsVisible, setSettingsVisible] = createSignal(false);
  const [cmdPaletteVisible, setCmdPaletteVisible] = createSignal(false);
  const [composerVisible, setComposerVisible] = createSignal(false);
  const [citationPickerVisible, setCitationPickerVisible] = createSignal(false);
  const [snapshotVisible, setSnapshotVisible] = createSignal(false);
  const [snapshotPath, setSnapshotPath] = createSignal("");
  const [typAuditVisible, setTypAuditVisible] = createSignal(false);

  // Persist the active file path so "last-file" startup behavior can restore it.
  createEffect(() => {
    const id = activeTabId();
    if (!id) return;
    const tab = tabs.find((t) => t.id === id);
    if (tab && tab.type === "file" && tab.path) {
      updateSetting("startup", "last_active_file", tab.path);
    }
  });

  const toggleSettings = () => setSettingsVisible((v) => !v);
  const toggleQuickOpen = () => setQuickOpenVisible((v) => !v);
  const toggleCommandPalette = () => setCmdPaletteVisible((v) => !v);
  const toggleComposer = () => setComposerVisible((v) => !v);
  const openFileHistory = () => {
    const tab = getActiveTab();
    if (tab && tab.type === "file") {
      setSnapshotPath(tab.path);
      setSnapshotVisible(true);
    }
  };

  const newNote = async () => {
    try {
      const result = await ipc.executeCreationRule("new-note");
      const name = result.path.split("/").pop() ?? "New Note";
      openTab(
        { type: "file", title: name, path: result.path },
        { forceNewTab: true, cursorOffset: result.cursor_offset ?? undefined },
      );
    } catch (e) {
      toastError("Failed to create note", e);
    }
  };

  onMount(async () => {
    // Load settings first — theme and other init depends on them
    await initSettings();
    applyUiScale(settings.editor.font_size);
    onSettingsChange((s) => applyUiScale(s.editor.font_size));
    onSettingsChange((s) => applyMonospaceFont(s.appearance.monospace_font));
    onSettingsChange((s) => applyInterfaceFont(s.appearance.interface_font));
    initTheme();
    await initVault();
    applyStartupBehavior();
    initKeyboard();

    // Register shortcut callbacks
    onShortcut("quick-open", toggleQuickOpen);
    onShortcut("settings", toggleSettings);
    onShortcut("command-palette", toggleCommandPalette);
    onShortcut("new-note", newNote);
    onShortcut("citation-picker", () => setCitationPickerVisible(true));
    // Ctrl +/-/0 adjusts the editor content size (the note text), not the
    // overall UI scale — the UI scale is configurable in settings but isn't
    // what users typically want to nudge with zoom shortcuts.
    onShortcut("zoom-in", () => {
      const newSize = Math.min(32, settings.editor.body_font_size + 1);
      updateSetting("editor", "body_font_size", newSize);
    });
    onShortcut("zoom-out", () => {
      const newSize = Math.max(8, settings.editor.body_font_size - 1);
      updateSetting("editor", "body_font_size", newSize);
    });
    onShortcut("zoom-reset", () => updateSetting("editor", "body_font_size", 17));

    // Register all built-in commands with the command palette
    registerBuiltinCommands({
      toggleQuickOpen,
      toggleSettings,
      toggleCommandPalette,
      toggleComposer,
      openFileHistory,
      openCitationPicker: () => setCitationPickerVisible(true),
      openSearch: () => document.dispatchEvent(new CustomEvent("inkycap:open-search")),
      newNote,
      openTypAudit: () => setTypAuditVisible(true),
    });

    // Register creation rules as commands (async, non-blocking)
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
    const openSearchHandler = () => setSidebarMode("search");
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

  onCleanup(() => {
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
        <VerticalToolbar
          mode={sidebarMode}
          setMode={setSidebarMode}
          onOpenSettings={toggleSettings}
        />
        <LeftSidebar mode={sidebarMode} setMode={setSidebarMode} />
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
        />
        <CommandPalette
          visible={cmdPaletteVisible()}
          onClose={() => setCmdPaletteVisible(false)}
        />
        <CitationPicker
          visible={citationPickerVisible()}
          onClose={() => setCitationPickerVisible(false)}
        />
        <NoteComposer
          visible={composerVisible()}
          onClose={() => setComposerVisible(false)}
        />
        <ExportDialog />
        <TypAuditDialog
          open={typAuditVisible()}
          onClose={() => setTypAuditVisible(false)}
        />
        <SnapshotViewer
          filePath={snapshotPath()}
          visible={snapshotVisible()}
          onClose={() => setSnapshotVisible(false)}
          onRestore={async (content) => {
            const tab = getActiveTab();
            if (tab && tab.type === "file") {
              await ipc.writeFileContent(tab.path, content);
              document.dispatchEvent(
                new CustomEvent("inkycap:file-restored", { detail: { path: tab.path } })
              );
            }
          }}
        />
        <ToastHost />
      </div>
    </ErrorBoundary>
  );
};

export default App;
