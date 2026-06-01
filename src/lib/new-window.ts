import { pathEquals } from "./paths";
import * as ipc from "./ipc";

// Opening additional InkyCap windows.
//
// Each OS window owns its own notebox session (see the per-window notebox
// backend), so a new window is a genuinely independent view. With a `notebox`
// path it boots straight into that notebox; without one it shows the notebox
// picker (a clean "new instance" where the user chooses what to open).
//
// The label uses the `note-*` prefix so the window is covered by the
// `["main", "note-*"]` capability glob and gets full IPC/event access.

/**
 * Open a new InkyCap window. Pass a notebox root to open it directly;
 * omit it to open an empty window that shows the notebox picker.
 *
 * The WebviewWindow API is lazy-imported so it stays out of the initial
 * bundle for sessions that never open a second window.
 */
export function openNoteboxWindow(notebox?: string): void {
  void (async () => {
    // A notebox lives in at most one window. If it's already open, focus that
    // window instead of opening a duplicate.
    if (notebox && (await focusNoteboxWindow(notebox, false))) return;
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const label = `note-win-${Date.now()}`;
    const url = notebox
      ? `index.html?notebox=${encodeURIComponent(notebox)}`
      : "index.html?new=1";
    const win = new WebviewWindow(label, { url, width: 1100, height: 800 });
    win.once("tauri://error", (e) => {
      console.error("Failed to open new window:", e);
    });
  })();
}

/**
 * If `notebox` is already open in a window, focus that window and return true
 * (a notebox is exclusive to one window). With `excludeCurrent`, a match in
 * *this* window doesn't count — used when switching the current window, so it
 * only redirects to a genuinely different window.
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
