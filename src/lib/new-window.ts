import { pathEquals } from "./paths";
import * as ipc from "./ipc";
import type { DeepLink } from "./types";

// Opening more InkyCap windows.
//
// Each window has its own notebox session, so a new window is independent. With
// a `notebox` path it opens that notebox; without one it shows the notebox
// picker.
//
// The label starts with `note-` so the window matches the `["main", "note-*"]`
// capability and gets IPC and event access.

/**
 * Open a new window: on the given notebox root, or with the notebox picker if
 * none. With `link` (an `inkycap://` link the backend already checked, for that
 * notebox), the window follows it once the notebox is open.
 *
 * The WebviewWindow API is imported lazily, keeping it out of the initial
 * bundle.
 */
export function openNoteboxWindow(notebox?: string, link?: DeepLink): void {
  void (async () => {
    // A notebox lives in at most one window. If it's already open, focus that
    // window instead of opening a duplicate.
    if (notebox && (await focusNoteboxWindow(notebox, false))) return;
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const label = `note-win-${Date.now()}`;
    let url = notebox
      ? `index.html?notebox=${encodeURIComponent(notebox)}`
      : "index.html?new=1";
    if (notebox && link) url += `&link=${encodeURIComponent(JSON.stringify(link))}`;
    const win = new WebviewWindow(label, { url, width: 1100, height: 800 });
    win.once("tauri://error", (e) => {
      console.error("Failed to open new window:", e);
    });
  })();
}

/**
 * If `notebox` is open in a window, focus it and return true (a notebox is open
 * in one window only). With `excludeCurrent`, this window doesn't count, for
 * switching the current window.
 */
export async function focusNoteboxWindow(
  notebox: string,
  excludeCurrent: boolean,
): Promise<boolean> {
  try {
    const open = await ipc.listOpenNoteboxes();
    const { getCurrentWebviewWindow, WebviewWindow } = await import(
      "@tauri-apps/api/webviewWindow"
    );
    const me = excludeCurrent ? getCurrentWebviewWindow().label : null;
    const existing = open.find((o) => pathEquals(o.path, notebox) && o.label !== me);
    if (!existing) return false;
    const win = await WebviewWindow.getByLabel(existing.label);
    if (win) {
      await win.setFocus();
      return true;
    }
  } catch {
    // Fall through — the backend's open_notebox guard is the race-safe backstop.
  }
  return false;
}
