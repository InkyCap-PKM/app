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
  const path = await ipc.openDocumentationNotebox();
  const existing = await WebviewWindow.getByLabel(DOCS_WINDOW_LABEL);
  if (existing) {
    await existing.setFocus();
    return;
  }
  new WebviewWindow(DOCS_WINDOW_LABEL, {
    url: `index.html?notebox=${encodeURIComponent(path)}`,
    title,
    width: 1000,
    height: 760,
  });
}
