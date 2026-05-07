import { EditorView, ViewPlugin } from "@codemirror/view";
import * as ipc from "../../lib/ipc";
import { pasteUrlHandler } from "./paste-url";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"]);

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

function insertAttachment(view: EditorView, savedName: string, pos: number) {
  const ext = getExtension(savedName);
  const isImage = IMAGE_EXTS.has(ext);
  const insert = isImage
    ? `#image("attachments/${savedName}")`
    : `#embed("${savedName}")`;

  view.dispatch({
    changes: { from: pos, insert },
    selection: { anchor: pos + insert.length },
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

export const dragDropHandler = ViewPlugin.fromClass(
  class {
    constructor(_view: EditorView) {}
    update() {}
  },
  {
    eventHandlers: {
      dragover(_event: DragEvent) {
        const types = _event.dataTransfer?.types;
        if (!types) return false;
        if (
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
