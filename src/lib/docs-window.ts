import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as ipc from "./ipc";

/** The fixed window label for the documentation window — reused so a second
 *  open focuses the existing window rather than spawning a duplicate. */
const DOCS_WINDOW_LABEL = "note-docs";

/**
 * True when this webview is the documentation window, where notes open in
 * reading mode and an "edits aren't saved" banner shows. Computed once (a
 * window's label doesn't change). False outside Tauri (e.g. unit tests).
 */
let _isDocsWindow: boolean | undefined;
export function isDocumentationWindow(): boolean {
  if (_isDocsWindow === undefined) {
    try {
      _isDocsWindow = getCurrentWindow().label === DOCS_WINDOW_LABEL;
    } catch {
      _isDocsWindow = false;
    }
  }
  return _isDocsWindow;
}

/**
 * Open (or focus) the bundled manual in its own window, from the Help panel
 * (F1) or Settings → Overview. The backend creates the manual notebox on first
 * use and returns its path. Throws on failure; callers show their own toast.
 */
export async function openDocumentationWindow(title: string): Promise<void> {
  const { root, index } = await ipc.openDocumentationNotebox();
  const existing = await WebviewWindow.getByLabel(DOCS_WINDOW_LABEL);
  if (existing) {
    await existing.setFocus();
    return;
  }
  // Open on the manual's start page (not an empty pane), maximized, since the
  // file tree and both sidebars need room.
  let url = `index.html?notebox=${encodeURIComponent(root)}`;
  if (index) url += `&path=${encodeURIComponent(index)}`;
  const win = new WebviewWindow(DOCS_WINDOW_LABEL, {
    url,
    title,
    width: 1280,
    height: 900,
    center: true,
    maximized: true,
  });
  // Some Linux window managers ignore `maximized` at creation; maximize again
  // once the window exists so the docs reliably open full-size.
  win.once("tauri://created", () => {
    void win.maximize();
  });
}
