import { EditorView, ViewPlugin } from "@codemirror/view";
import * as ipc from "../../lib/ipc";
import { typstStringEscape } from "../../lib/typst";
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

function attachmentMarkup(relativePath: string): string {
  const ext = getExtension(relativePath);
  if (IMAGE_EXTS.has(ext)) {
    return `#image("/${typstStringEscape(relativePath)}")`;
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

async function handleDroppedFile(view: EditorView, file: File, pos: number) {
  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);
    const savedName = await ipc.copyToAttachments(file.name, base64);
    insertAttachment(view, savedName, pos);
  } catch (err) {
    console.error("[drag-drop] handleDroppedFile failed:", err);
  }
}

async function handleDroppedUri(view: EditorView, uri: string, pos: number) {
  const trimmed = uri.trim();
  if (!trimmed.startsWith("file://")) return;
  let absPath: string;
  try {
    absPath = decodeURIComponent(new URL(trimmed).pathname);
  } catch {
    return;
  }
  try {
    const savedName = await ipc.copyPathToAttachments(absPath);
    insertAttachment(view, savedName, pos);
  } catch (err) {
    console.error("[drag-drop] copyPathToAttachments failed:", absPath, err);
  }
}

function parseUriList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

async function handlePastedImage(view: EditorView, file: File) {
  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);
    const name = file.name || `pasted-${Date.now()}.${getExtension(file.type.split("/")[1] ?? "png")}`;
    const savedName = await ipc.copyToAttachments(name, base64);
    const pos = view.state.selection.main.from;
    insertAttachment(view, savedName, pos);
  } catch (err) {
    console.error("[paste] handlePastedImage failed:", err);
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
          for (const file of Array.from(cd.files)) {
            void handleDroppedFile(view, file, pos);
          }
          return true;
        }

        const uriList = cd.getData("text/uri-list");
        if (uriList) {
          event.preventDefault();
          for (const uri of parseUriList(uriList)) {
            void handleDroppedUri(view, uri, pos);
          }
          return true;
        }

        const text = cd.getData("text/plain");
        if (text && text.trim().startsWith("file://")) {
          event.preventDefault();
          for (const uri of parseUriList(text)) {
            void handleDroppedUri(view, uri, pos);
          }
          return true;
        }

        return false;
      },

      paste(event: ClipboardEvent, view: EditorView) {
        const items = event.clipboardData?.items;
        if (!items) return false;

        for (const item of Array.from(items)) {
          if (item.kind === "file" && item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) {
              event.preventDefault();
              void handlePastedImage(view, file);
              return true;
            }
          }
        }

        if (pasteUrlHandler(event, view)) return true;

        return false;
      },
    },
  },
);
