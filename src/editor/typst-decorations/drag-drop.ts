import { EditorView, ViewPlugin } from "@codemirror/view";
import * as ipc from "../../lib/ipc";
import { typstStringEscape } from "../../lib/typst";
import { fileToBase64 } from "../../lib/file-bytes";
import { ensureNoteboxImports } from "../../lib/notebox-import-check";
import { activeNotePath } from "../../stores/tabs";
import { pasteUrlHandler } from "./paste-url";
import { protectedRangesField } from "./visual-plugin";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"]);

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

function clampPastProtected(view: EditorView, pos: number): number {
  const ranges = view.state.field(protectedRangesField, false);
  if (!ranges || ranges.length === 0) return pos;
  let p = pos;
  let prev = -1;
  while (p !== prev) {
    prev = p;
    for (const r of ranges) {
      if (p >= r.from && p < r.to) p = r.to;
    }
  }
  return p;
}

const NOTE_EXTS = new Set(["typ"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "mkv", "ogv", "m4v"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "opus"]);

function attachmentMarkup(relativePath: string): string {
  const ext = getExtension(relativePath);
  if (IMAGE_EXTS.has(ext)) {
    return `#image("/${typstStringEscape(relativePath)}")`;
  }
  if (VIDEO_EXTS.has(ext)) {
    return `#video("/${typstStringEscape(relativePath)}")`;
  }
  if (AUDIO_EXTS.has(ext)) {
    return `#audio("/${typstStringEscape(relativePath)}")`;
  }
  if (NOTE_EXTS.has(ext)) {
    const basename = relativePath.split("/").pop() ?? relativePath;
    const stem = basename.replace(/\.typ$/, "");
    return `#wikilink("${typstStringEscape(stem)}")`;
  }
  const filename = relativePath.split("/").pop() ?? relativePath;
  return `#link("/${typstStringEscape(relativePath)}")[${filename}]`;
}

function insertAttachment(view: EditorView, relativePath: string, pos: number) {
  const body = attachmentMarkup(relativePath);

  // Pin past any prelude (#import / #note / #bibliography) and normalize
  // to its own line — block-level markup can't share a line with prose.
  const clamped = clampPastProtected(view, pos);
  const line = view.state.doc.lineAt(clamped);
  const onLineStart = clamped === line.from;
  const insertPos = onLineStart ? clamped : line.to;
  const insert = onLineStart ? `${body}\n` : `\n${body}`;

  view.dispatch({
    changes: { from: insertPos, insert },
    selection: { anchor: insertPos + insert.length },
  });
}

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
    insertAttachment(view, savedName, pos);
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
    insertAttachment(view, savedName, pos);
    return savedName;
  } catch (err) {
    console.error("[drag-drop] copyPathIntoNotebox failed:", absPath, err);
    return null;
  }
}

/** Once every dropped file is copied, check any Typst files among them for
 *  the InkyCap import line. */
function afterDrop(copies: Promise<string | null>[]): void {
  void Promise.all(copies).then((saved) =>
    ensureNoteboxImports(saved.filter((p): p is string => p !== null)),
  );
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
    const name = file.name || `pasted-${Date.now()}.${getExtension(file.type.split("/")[1] ?? "png")}`;
    const savedName = await ipc.copyBytesIntoNotebox(name, base64);
    const pos = view.state.selection.main.from;
    insertAttachment(view, savedName, pos);
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
      insertAttachment(view, rel, view.state.selection.main.from);
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
          insertAttachment(view, noteboxPath, pos);
          return true;
        }

        if (cd.files && cd.files.length > 0) {
          event.preventDefault();
          afterDrop(Array.from(cd.files).map((file) => handleDroppedFile(view, file, pos)));
          return true;
        }

        const uriList = cd.getData("text/uri-list");
        if (uriList) {
          event.preventDefault();
          afterDrop(parseUriList(uriList).map((uri) => handleDroppedUri(view, uri, pos)));
          return true;
        }

        const text = cd.getData("text/plain");
        if (text && text.trim().startsWith("file://")) {
          event.preventDefault();
          afterDrop(parseUriList(text).map((uri) => handleDroppedUri(view, uri, pos)));
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
