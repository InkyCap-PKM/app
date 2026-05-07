// Tauri-level drag-drop listener.
//
// Handles native file drops from outside the webview (file manager).
// On Linux/webkit2gtk, DOM drag events for external drags have their
// dataTransfer blocked by cross-origin security, so we use Tauri's
// own drag/drop event which bypasses the webview's security model.

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { activeEditorView } from "../stores/editor";
import * as ipc from "./ipc";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"]);
const EMBED_EXTS = new Set([
  ...IMAGE_EXTS,
  "pdf",
  "mp3",
  "wav",
  "ogg",
  "mp4",
  "webm",
]);

function getExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

interface PhysicalPosition {
  x: number;
  y: number;
}

async function handleDrop(
  paths: string[],
  position: PhysicalPosition,
): Promise<void> {
  const handle = activeEditorView();
  if (!handle) {
    console.warn("[tauri-drop] no active editor, ignoring drop");
    return;
  }

  const view = handle.view;
  const scale = window.devicePixelRatio || 1;
  const cssX = position.x / scale;
  const cssY = position.y / scale;

  let dropPos: number | null = null;
  try {
    const posInfo = view.posAtCoords({ x: cssX, y: cssY });
    if (posInfo !== null) dropPos = posInfo;
  } catch (err) {
    console.warn("[tauri-drop] coord lookup failed, using cursor", err);
  }

  for (const absPath of paths) {
    try {
      const savedName = await ipc.copyPathToAttachments(absPath);
      const ext = getExtension(savedName);
      const isEmbed = EMBED_EXTS.has(ext);

      const insertAt = dropPos ?? view.state.selection.main.from;
      const markup = isEmbed
        ? `#embed("${savedName}")`
        : `#wikilink("${savedName}")`;
      view.dispatch({
        changes: { from: insertAt, to: insertAt, insert: markup },
      });
      if (dropPos !== null) dropPos += markup.length;
    } catch (err) {
      console.error("[tauri-drop] failed to copy", absPath, err);
    }
  }
}

let initialized = false;
let unlisten: (() => void) | null = null;

export async function initTauriDragDrop(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const webview = getCurrentWebviewWindow();
    unlisten = await webview.onDragDropEvent((event) => {
      const payload = event.payload;
      console.debug("[tauri-drop] event:", payload);
      if (payload.type === "drop" && payload.paths.length > 0) {
        void handleDrop(payload.paths, payload.position);
      }
    });
  } catch (err) {
    console.error("[tauri-drop] failed to attach listener:", err);
    initialized = false;
  }
}

export function destroyTauriDragDrop(): void {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
  initialized = false;
}
