// Global keyboard shortcut handler.
// Registered once from App.tsx onMount.

import {
  closeTab,
  createEmptyTab,
  getActiveTab,
  switchToNextTab,
  switchToPrevTab,
  switchToTabByIndex,
} from "../stores/tabs";

export type ShortcutCallback = () => void;

// Store for custom callbacks (e.g. quick-open toggle, settings toggle)
const callbacks: Record<string, ShortcutCallback> = {};

/** Register a callback for a named shortcut action. */
export function onShortcut(name: string, cb: ShortcutCallback) {
  callbacks[name] = cb;
}

/** Initialize global keyboard shortcuts. Call once from App.tsx onMount. */
export function initKeyboard() {
  document.addEventListener("keydown", handleKeyDown);
}

/** Clean up keyboard listeners. */
export function destroyKeyboard() {
  document.removeEventListener("keydown", handleKeyDown);
}

function handleKeyDown(e: KeyboardEvent) {
  const ctrl = e.ctrlKey || e.metaKey;

  // Ctrl+W: close active tab
  if (ctrl && e.key === "w") {
    e.preventDefault();
    const tab = getActiveTab();
    if (tab) closeTab(tab.id);
    return;
  }

  // Ctrl+Tab / Ctrl+Shift+Tab: switch tabs
  if (ctrl && e.key === "Tab") {
    e.preventDefault();
    if (e.shiftKey) {
      switchToPrevTab();
    } else {
      switchToNextTab();
    }
    return;
  }

  // Ctrl+O: quick-open
  if (ctrl && e.key === "o") {
    e.preventDefault();
    callbacks["quick-open"]?.();
    return;
  }

  // Ctrl+P: command palette (will be connected in Phase 8)
  if (ctrl && e.key === "p") {
    e.preventDefault();
    callbacks["command-palette"]?.();
    return;
  }

  // Ctrl+,: open settings
  if (ctrl && e.key === ",") {
    e.preventDefault();
    callbacks["settings"]?.();
    return;
  }

  // Ctrl+Shift+F: vault search
  if (ctrl && e.shiftKey && e.key === "F") {
    e.preventDefault();
    document.dispatchEvent(new CustomEvent("inkycap:open-search"));
    return;
  }

  // Ctrl+Shift+C: citation picker
  if (ctrl && e.shiftKey && e.key === "C") {
    e.preventDefault();
    callbacks["citation-picker"]?.();
    return;
  }

  // Ctrl+T: open new empty tab
  if (ctrl && !e.shiftKey && e.key === "t") {
    e.preventDefault();
    createEmptyTab();
    return;
  }

  // Ctrl+N: execute "new-note" creation rule
  if (ctrl && !e.shiftKey && e.key === "n") {
    e.preventDefault();
    callbacks["new-note"]?.();
    return;
  }

  // Ctrl+= / Ctrl++: zoom in
  if (ctrl && (e.key === "=" || e.key === "+")) {
    e.preventDefault();
    callbacks["zoom-in"]?.();
    return;
  }

  // Ctrl+-: zoom out
  if (ctrl && e.key === "-") {
    e.preventDefault();
    callbacks["zoom-out"]?.();
    return;
  }

  // Ctrl+0: reset zoom
  if (ctrl && e.key === "0") {
    e.preventDefault();
    callbacks["zoom-reset"]?.();
    return;
  }

  // Ctrl+\: insert scaffold into current note
  if (ctrl && !e.shiftKey && e.key === "\\") {
    e.preventDefault();
    callbacks["insert-scaffold"]?.();
    return;
  }

  // Ctrl+1 through Ctrl+9: switch to tab by index
  if (ctrl && e.key >= "1" && e.key <= "9") {
    e.preventDefault();
    const idx = parseInt(e.key) - 1;
    switchToTabByIndex(idx);
    return;
  }
}
