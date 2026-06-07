import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import * as ipc from "./ipc";

/** The fixed window label for the documentation window — reused so a second
 *  open focuses the existing window rather than spawning a duplicate. */
const DOCS_WINDOW_LABEL = "note-docs";

/**
 * Open (or focus) the bundled InkyCap documentation notebox in its own window.
 *
 * Shared by the F1 Help panel and the Settings → Overview link so both entry
 * points behave identically. The backend lazily seeds the system documentation
 * notebox and returns its path; we open it in a dedicated window. Throws on
 * failure — callers surface their own localized toast.
 */
export async function openDocumentationWindow(title: string): Promise<void> {
  const { root, index } = await ipc.openDocumentationNotebox();
  const existing = await WebviewWindow.getByLabel(DOCS_WINDOW_LABEL);
  if (existing) {
    await existing.setFocus();
    return;
  }
  // Boot straight onto the manual's landing note (so the window isn't a blank
  // "no file selected" pane), and open maximized — the file tree plus both
  // sidebars need room or they crowd out the reading pane on first open.
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
