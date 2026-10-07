import { EditorView, ViewPlugin } from "@codemirror/view";
import * as ipc from "../../lib/ipc";
import { fileToBase64 } from "../../lib/file-bytes";
import { ensureNoteboxImports } from "../../lib/notebox-import-check";
import { activeNotePath } from "../../stores/tabs";
import { pasteUrlHandler } from "./paste-url";
import { fileExtension, insertAttachmentAt } from "../../lib/attachment-insert";

/** Copy a dropped file into the notebox and insert markup for it. Resolves
 *  with the saved path, or `null` if the copy failed. */
async function handleDroppedFile(
  view: EditorView,
  file: File,
  pos: number,
): Promise<string | null> {
  try {
    const base64 = await fileToBase64(file);
    const savedName = await ipc.copyBytesIntoNotebox(file.name, base64, {
      currentNote: activeNotePath(),
    });
    await insertAttachmentAt(view, savedName, pos);
    return savedName;
  } catch (err) {
    console.error("[drag-drop] handleDroppedFile failed:", err);
    return null;
  }
}

/** Like {@link handleDroppedFile}, for a dropped `file://` URI. */
async function handleDroppedUri(
  view: EditorView,
  uri: string,
  pos: number,
): Promise<string | null> {
  const trimmed = uri.trim();
  if (!trimmed.startsWith("file://")) return null;
  let absPath: string;
  try {
    absPath = decodeURIComponent(new URL(trimmed).pathname);
  } catch {
    return null;
  }
  try {
    const savedName = await ipc.copyPathIntoNotebox(absPath, {
      currentNote: activeNotePath(),
    });
    await insertAttachmentAt(view, savedName, pos);
    return savedName;
  } catch (err) {
    console.error("[drag-drop] copyPathIntoNotebox failed:", absPath, err);
    return null;
  }
}

/** Bring dropped items in one at a time, so each can ask its own question
 *  (how to place a PDF), then check any Typst files among them for the
 *  InkyCap import line. */
function dropInOrder<T>(items: T[], bringIn: (item: T) => Promise<string | null>): void {
  void (async () => {
    const saved: string[] = [];
    for (const item of items) {
      const path = await bringIn(item);
      if (path !== null) saved.push(path);
    }
    await ensureNoteboxImports(saved);
  })();
}

function parseUriList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

async function handlePastedImage(view: EditorView, file: File) {
  try {
    const base64 = await fileToBase64(file);
    const name = file.name || `pasted-${Date.now()}.${fileExtension(file.type.split("/")[1] ?? "png")}`;
    const savedName = await ipc.copyBytesIntoNotebox(name, base64);
    await insertAttachmentAt(view, savedName, view.state.selection.main.from);
  } catch (err) {
    console.error("[paste] handlePastedImage failed:", err);
  }
}

/** Fallback for pastes the webview can't see: on WebKitGTK the clipboard's
 *  file references and (on Linux) pasted image data never reach the paste
 *  event, so we read them from the Rust side and insert whatever was saved. */
async function handleClipboardPasteFallback(view: EditorView) {
  try {
    const saved = await ipc.pasteClipboardIntoNotebox({ currentNote: activeNotePath() });
    for (const rel of saved) {
      await insertAttachmentAt(view, rel, view.state.selection.main.from);
    }
    await ensureNoteboxImports(saved);
  } catch (err) {
    console.error("[paste] clipboard fallback failed:", err);
  }
}

/** Last drag-over position tracked from DOM events. On Linux/webkit2gtk,
 *  external drags block dataTransfer but still fire dragover with correct
 *  clientX/clientY. The Tauri-level drop handler reads this to get an
 *  accurate drop position instead of relying on Tauri's physical-pixel
 *  coordinates (which are in a different coordinate space). */
let lastDragPos: { x: number; y: number; time: number } | null = null;
export function getLastDragPos(): { x: number; y: number } | null {
  if (!lastDragPos) return null;
  // Only use if recent (within 2 seconds of the drop)
  if (Date.now() - lastDragPos.time > 2000) return null;
  return { x: lastDragPos.x, y: lastDragPos.y };
}

export const dragDropHandler = ViewPlugin.fromClass(
  class {
    constructor(_view: EditorView) {}
    update() {}
  },
  {
    eventHandlers: {
      dragover(_event: DragEvent) {
        // Track position for the Tauri handler — DOM events have correct
        // client coordinates even when dataTransfer is blocked.
        lastDragPos = { x: _event.clientX, y: _event.clientY, time: Date.now() };

        const types = _event.dataTransfer?.types;
        if (!types) return false;
        if (
          types.includes("application/x-inkycap-notebox-path") ||
          types.includes("Files") ||
          types.includes("text/uri-list") ||
          types.includes("text/plain")
        ) {
          _event.preventDefault();
          if (_event.dataTransfer) _event.dataTransfer.dropEffect = "copy";
          return true;
        }
        return false;
      },

      drop(event: DragEvent, view: EditorView) {
        const cd = event.dataTransfer;
        if (!cd) return false;

        const coords = view.posAtCoords({
          x: event.clientX,
          y: event.clientY,
        });
        const pos = coords ?? view.state.selection.main.from;

        // Internal drag from the file tree — file is already in the notebox,
        // no copy needed. The notebox-relative path is set directly.
        const noteboxPath = cd.getData("application/x-inkycap-notebox-path");
        if (noteboxPath) {
          event.preventDefault();
          void insertAttachmentAt(view, noteboxPath, pos);
          return true;
        }

        if (cd.files && cd.files.length > 0) {
          event.preventDefault();
          dropInOrder(Array.from(cd.files), (file) => handleDroppedFile(view, file, pos));
          return true;
        }

        const uriList = cd.getData("text/uri-list");
        if (uriList) {
          event.preventDefault();
          dropInOrder(parseUriList(uriList), (uri) => handleDroppedUri(view, uri, pos));
          return true;
        }

        const text = cd.getData("text/plain");
        if (text && text.trim().startsWith("file://")) {
          event.preventDefault();
          dropInOrder(parseUriList(text), (uri) => handleDroppedUri(view, uri, pos));
          return true;
        }

        return false;
      },

      paste(event: ClipboardEvent, view: EditorView) {
        const cd = event.clipboardData;
        if (!cd) return false;

        if (cd.items) {
          for (const item of Array.from(cd.items)) {
            if (item.kind === "file" && item.type.startsWith("image/")) {
              const file = item.getAsFile();
              if (file) {
                event.preventDefault();
                void handlePastedImage(view, file);
                return true;
              }
            }
          }
        }

        if (pasteUrlHandler(event, view)) return true;

        // WebKitGTK hides clipboard files (and Linux image data) from the
        // webview. When the webview sees no text either, the clipboard most
        // likely holds a native file reference or image — read it from Rust.
        // Plain-text pastes still fall through to CM's default handling.
        const text = cd.getData("text/plain");
        if (!text || text.trim() === "") {
          event.preventDefault();
          void handleClipboardPasteFallback(view);
          return true;
        }

        return false;
      },
    },
  },
);
