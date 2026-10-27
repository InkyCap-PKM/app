// Native file drops from outside the webview (the file manager). Files dropped
// on a file-tree folder are copied there; files dropped on the editor are
// copied in and linked at the drop point.
//
// On Linux (webkit2gtk) the DOM hides external drag data, so Tauri's own drop
// event is used. On Windows `dragDropEnabled` is false
// (`tauri.windows.conf.json`), because Tauri's native drop target would swallow
// every drag before WebView2 (breaking tree moves and tab reordering); there
// drops come through `initHtml5DragDrop` below.

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

/// The drop position in the active editor, as a document offset, from an
/// optional client-coordinate hint. `null` with no active editor. Falls back to
/// the current selection when the coordinates don't map to a position.
function resolveDropTarget(coordsHint: DropCoords | null) {
  const handle = activeEditorView();
  if (!handle) return null;
  const view = handle.view;

  let dropPos: number | null = null;

  // The DOM dragover position (tracked by the CM6 plugin) maps directly onto
  // the editor. Non-precise `posAtCoords` resolves drops between lines, in
  // padding or past a short line to the nearest position instead of null.
  const domPos = getLastDragPos();
  if (domPos) {
    try {
      dropPos = view.posAtCoords({ x: domPos.x, y: domPos.y }, false);
    } catch { /* fall through */ }
  }

  // Fallback to the caller's coordinates. Tauri's drops on Linux give CSS
  // pixels like DOM coordinates, so use them as they are; dividing by
  // devicePixelRatio would put HiDPI drops in the top-left. The Windows HTML5
  // path also gives CSS coordinates.
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
  // CodeMirror's `dragDropHandler` (typst-decorations/drag-drop.ts) handles
  // drops inside the editor and calls preventDefault; this window-level handler
  // is for drops elsewhere (the sidebar).
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
/// location", other files to the attachments folder) and insert markup for each
/// at the drop point.
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

/// Attach Tauri's native drop listener, on Linux (where the webview can't see
/// external drag data) and macOS (for the native path's file access).
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

/// Attach an HTML5 drop listener on the window, for Windows, where the native
/// event doesn't fire (see above). WebView2 gives external files as `File`
/// objects without paths, so their bytes are read with FileReader and sent to
/// Rust as base64.
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
