// Tauri-level drag-drop listener.
//
// Handles native file drops from outside the webview (file manager).
// Files dropped on a folder in the file tree are copied into that folder;
// files dropped on the editor are copied in and linked at the drop point.
// On Linux/webkit2gtk, DOM drag events for external drags have their
// dataTransfer blocked by cross-origin security, so we use Tauri's
// own drag/drop event which bypasses the webview's security model.
//
// On Windows, `dragDropEnabled` is forced to `false` via
// `tauri.windows.conf.json`, because Tauri's native IDropTarget
// otherwise swallows *all* drag events before they reach WebView2 —
// breaking internal HTML5 DnD (file tree row moves, tab reordering).
// As a side effect, this listener does not fire on Windows; external
// file drops from Explorer into the editor will need a separate
// HTML5 dataTransfer-based path before they work there.

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { activeEditorView } from "../stores/editor";
import { getLastDragPos } from "../editor/typst-decorations/drag-drop";
import { activeNotePath } from "../stores/tabs";
import { insertAttachmentAt } from "./attachment-insert";
import { bringFilesIntoNotebox, incomingFromPath, type IncomingFile } from "./incoming-files";
import {
  clearExternalDrop,
  dropFolderAt,
  installExternalDropTracking,
  takeNativeDropFolder,
  uninstallExternalDropTracking,
} from "./external-drop";

interface DropCoords {
  x: number;
  y: number;
}

/// Resolve the drop position inside the active editor, in CodeMirror
/// document offsets, given an optional client-coord hint. Returns
/// `null` when there is no active editor; callers should bail in that
/// case. When the lookup fails (no coord hint, or coords don't map to
/// a position), the cursor's current selection is used as the fallback.
function resolveDropTarget(coordsHint: DropCoords | null) {
  const handle = activeEditorView();
  if (!handle) return null;
  const view = handle.view;

  let dropPos: number | null = null;

  // The DOM dragover (tracked by the CM6 plugin) gives client CSS coords
  // that map directly onto the editor. `posAtCoords(coords, false)` uses
  // non-precise mode so a drop into inter-line space, padding, or past the
  // end of a short line still resolves to the *nearest* text position
  // instead of null (precise mode returns null off-glyph, which is why
  // drops used to collapse to the top of the document).
  const domPos = getLastDragPos();
  if (domPos) {
    try {
      dropPos = view.posAtCoords({ x: domPos.x, y: domPos.y }, false);
    } catch { /* fall through */ }
  }

  // Fallback: caller-provided coords. For Tauri-native drops on Linux/GTK
  // these arrive in logical (CSS) pixels — identical to DOM client coords
  // — so they are used as-is. Do NOT divide by devicePixelRatio: on a
  // HiDPI display that halves the point and pushes the drop into the
  // top-left corner. For the HTML5 path on Windows, the DropEvent's
  // clientX/clientY are also CSS coords.
  if (dropPos === null && coordsHint) {
    try {
      dropPos = view.posAtCoords({ x: coordsHint.x, y: coordsHint.y }, false);
    } catch (err) {
      console.warn("[external-drop] coord lookup failed, using cursor", err);
    }
  }

  return { view, dropPos };
}

async function handleTauriDrop(
  paths: string[],
  position: DropCoords,
): Promise<void> {
  const files = paths.map(incomingFromPath);
  // Dropped on a folder in the file tree: copy everything into that folder.
  const folder = takeNativeDropFolder();
  if (folder !== null) {
    await bringFilesIntoNotebox(files, { targetFolder: folder }, { announce: true });
    return;
  }
  const target = resolveDropTarget(position);
  if (!target) {
    console.warn("[tauri-drop] no active editor, ignoring drop");
    return;
  }
  await dropIntoEditor(target, files);
}

async function handleHtml5Drop(event: DragEvent): Promise<void> {
  // CodeMirror's per-editor `dragDropHandler` (typst-decorations/drag-drop.ts)
  // already processes file drops that land inside the editor and calls
  // preventDefault on the event. Skip those here so we don't double-insert
  // when the drop happens on the editor surface — this window-level handler
  // exists only to catch drops that landed on sidebar / non-editor surfaces.
  if (event.defaultPrevented) return;
  const dropped = event.dataTransfer?.files;
  if (!dropped || dropped.length === 0) return;
  event.preventDefault();
  const files: IncomingFile[] = Array.from(dropped).map((file) => ({ name: file.name, file }));

  // Dropped on a folder in the file tree: copy everything into that folder.
  const folder = dropFolderAt(event.clientX, event.clientY);
  if (folder !== null) {
    await bringFilesIntoNotebox(files, { targetFolder: folder }, { announce: true });
    return;
  }
  const target = resolveDropTarget({ x: event.clientX, y: event.clientY });
  if (!target) {
    console.warn("[html5-drop] no active editor, ignoring drop");
    return;
  }
  await dropIntoEditor(target, files);
}

/// Bring files dropped on the editor into the notebox (notes per "New note
/// location", other files to the attachments folder) and insert markup for
/// each one at the drop position.
async function dropIntoEditor(
  target: NonNullable<ReturnType<typeof resolveDropTarget>>,
  files: IncomingFile[],
): Promise<void> {
  const { view, dropPos } = target;
  const saved = await bringFilesIntoNotebox(files, { currentNote: activeNotePath() });
  let pos = dropPos ?? view.state.selection.main.from;
  for (const rel of saved ?? []) {
    pos = await insertAttachmentAt(view, rel, pos);
  }
}

let initialized = false;
let tauriUnlisten: (() => void) | null = null;
let html5DropHandler: ((e: DragEvent) => void) | null = null;
let html5DragOverHandler: ((e: DragEvent) => void) | null = null;

/// Attach the Tauri-native drag-drop listener. Used on Linux and macOS
/// where the webview can't see external drag dataTransfer (Linux) or
/// where we want the native path's filesystem access (macOS).
export async function initTauriDragDrop(): Promise<void> {
  if (initialized) return;
  initialized = true;
  installExternalDropTracking();
  try {
    const webview = getCurrentWebviewWindow();
    tauriUnlisten = await webview.onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "leave") clearExternalDrop();
      if (payload.type === "drop" && payload.paths.length > 0) {
        console.debug("[tauri-drop] drop:", payload.paths, payload.position);
        void handleTauriDrop(payload.paths, payload.position);
      }
    });
  } catch (err) {
    console.error("[tauri-drop] failed to attach listener:", err);
    initialized = false;
  }
}

/// Attach an HTML5 drop listener at the window level. Used on Windows,
/// where `dragDropEnabled` is forced off in `tauri.windows.conf.json`
/// (so HTML5 DnD works inside the webview — file tree row moves, tab
/// reordering, etc.) and the Tauri-native drop event therefore does
/// not fire. WebView2 exposes external file drops via `dataTransfer.
/// files` as `File` objects (no path — Chromium security), so the
/// bytes are read via FileReader and shipped to Rust as base64.
export function initHtml5DragDrop(): void {
  if (initialized) return;
  initialized = true;
  installExternalDropTracking();
  // Prevent the default behaviour (open file in webview) on dragover so
  // the drop event actually fires for files from Explorer.
  html5DragOverHandler = (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  };
  html5DropHandler = (e) => { void handleHtml5Drop(e); };
  window.addEventListener("dragover", html5DragOverHandler);
  window.addEventListener("drop", html5DropHandler);
}

export function destroyTauriDragDrop(): void {
  uninstallExternalDropTracking();
  if (tauriUnlisten) {
    tauriUnlisten();
    tauriUnlisten = null;
  }
  if (html5DropHandler) {
    window.removeEventListener("drop", html5DropHandler);
    html5DropHandler = null;
  }
  if (html5DragOverHandler) {
    window.removeEventListener("dragover", html5DragOverHandler);
    html5DragOverHandler = null;
  }
  initialized = false;
}
