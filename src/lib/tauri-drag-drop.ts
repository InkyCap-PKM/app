// Tauri-level drag-drop listener.
//
// Handles native file drops from outside the webview (file manager).
// On Linux/webkit2gtk, DOM drag events for external drags have their
// dataTransfer blocked by cross-origin security, so we use Tauri's
// own drag/drop event which bypasses the webview's security model.

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { activeEditorView } from "../stores/editor";
import { protectedRangesField } from "../editor/typst-decorations/visual-plugin";
import { getLastDragPos } from "../editor/typst-decorations/drag-drop";
import type { EditorState } from "@codemirror/state";
import * as ipc from "./ipc";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"]);

function getExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Scan the document text to find the end of the prelude (the #import,
 *  #note(...), and #bibliography(...) block at the top). Tracks paren
 *  nesting so that array/dict values inside `#note(...)` arguments
 *  (e.g. `collection: ("Foo",),`) don't fool the scanner into closing
 *  the call early. */
function findPreludeEnd(state: EditorState): number {
  let end = 0;
  const maxLine = Math.min(state.doc.lines, 30);
  let parenDepth = 0;
  for (let i = 1; i <= maxLine; i++) {
    const line = state.doc.line(i);
    const trimmed = line.text.trimStart();

    if (parenDepth > 0) {
      // Inside a multi-line #note() / #bibliography() — count parens
      for (const ch of line.text) {
        if (ch === "(") parenDepth++;
        else if (ch === ")") parenDepth--;
      }
      end = line.to;
      if (parenDepth <= 0) { parenDepth = 0; }
      continue;
    }

    const isImport = /^#import\s/.test(trimmed);
    const isNote = trimmed.startsWith("#note(");
    const isBib = trimmed.startsWith("#bibliography(");
    if (!isImport && !isNote && !isBib) {
      if (trimmed === "") { end = line.to; continue; }
      break;
    }
    end = line.to;
    if (isNote || isBib) {
      parenDepth = 0;
      for (const ch of line.text) {
        if (ch === "(") parenDepth++;
        else if (ch === ")") parenDepth--;
      }
      if (parenDepth <= 0) parenDepth = 0;
    }
  }
  // Include trailing newline after the last prelude line
  if (end < state.doc.length) end = Math.min(end + 1, state.doc.length);
  return end;
}

/// Clamp `pos` past the prelude. Uses the text-based scan as the
/// authoritative floor, and supplements with the StateField ranges
/// (which also cover `#bibliography()` at the end of the file).
function clampPastProtected(state: EditorState, pos: number): number {
  // Text-based scan is always available (works in both source and
  // visual mode) and handles the top-of-file prelude.
  const preludeEnd = findPreludeEnd(state);
  let p = pos < preludeEnd ? preludeEnd : pos;

  // StateField ranges may additionally cover #bibliography() at
  // the bottom of the file or other protected regions.
  const ranges = state.field(protectedRangesField, false);
  if (ranges && ranges.length > 0) {
    let prev = -1;
    while (p !== prev) {
      prev = p;
      for (const r of ranges) {
        if (p >= r.from && p < r.to) p = r.to;
      }
    }
  }
  return p;
}

/// Build markup for a saved attachment.
/// `relativePath` is vault-root-relative (e.g. `assets/Foo.png`) — what
/// `copy_path_to_attachments` returns since the SEC-1 / path-fix work.
/// We emit it with a leading `/` so Typst's compiler reads it as
/// project-root-relative (works in reading view + export), while the
/// visual editor's `resolveEmbedPath` also handles the slash form.
/// - Images: Typst's built-in `#image()` so ImageWidget renders.
/// - Other: `#wikilink()` with the bare filename (wikilink resolves by
///   name). `#embed()` is reserved for note transclusion and renders
///   "Note not found" for files.
const NOTE_EXTS = new Set(["typ"]);

function attachmentMarkup(relativePath: string): string | null {
  const ext = getExtension(relativePath);
  if (IMAGE_EXTS.has(ext)) {
    return `#image("/${relativePath}")`;
  }
  if (NOTE_EXTS.has(ext)) {
    const basename = relativePath.split("/").pop() ?? relativePath;
    const stem = basename.replace(/\.typ$/, "");
    return `#wikilink("${stem}")`;
  }
  return null;
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

  // On Linux/webkit2gtk, external drags fire DOM dragover events with
  // correct clientX/clientY even though dataTransfer is blocked. The
  // CM6 drag-drop plugin tracks these coordinates. Prefer them over
  // Tauri's physical-pixel position, which is in a different coordinate
  // space (window-relative including the GTK header bar) and doesn't
  // map reliably to posAtCoords.
  let dropPos: number | null = null;
  const domPos = getLastDragPos();
  if (domPos) {
    try {
      const posInfo = view.posAtCoords({ x: domPos.x, y: domPos.y });
      if (posInfo !== null) dropPos = posInfo;
    } catch { /* fall through to Tauri coords */ }
  }

  if (dropPos === null) {
    // Fallback: try Tauri's physical-pixel coordinates
    const scale = window.devicePixelRatio || 1;
    const cssX = position.x / scale;
    const cssY = position.y / scale;
    try {
      const posInfo = view.posAtCoords({ x: cssX, y: cssY });
      if (posInfo !== null) {
        dropPos = posInfo;
      } else {
        const editorRect = view.dom.getBoundingClientRect();
        const clampedX = Math.max(editorRect.left + 4, Math.min(cssX, editorRect.right - 4));
        const retryPos = view.posAtCoords({ x: clampedX, y: cssY });
        if (retryPos !== null) dropPos = retryPos;
      }
    } catch (err) {
      console.warn("[tauri-drop] coord lookup failed, using cursor", err);
    }
  }

  for (const absPath of paths) {
    try {
      const savedName = await ipc.copyPathToAttachments(absPath);
      const body = attachmentMarkup(savedName);
      if (body === null) {
        console.warn("[tauri-drop] unsupported file type, copied to assets but no markup inserted:", absPath);
        continue;
      }

      // Pin insertion past any prelude (#import / #note / #bibliography) so
      // a drop near the top of the document never tears the protected
      // header. Then normalize to its own line — block-level markup like
      // `#image(...)` can't share a line with prose.
      const rawPos = dropPos ?? view.state.selection.main.from;
      const clamped = clampPastProtected(view.state, rawPos);
      const line = view.state.doc.lineAt(clamped);
      const onLineStart = clamped === line.from;
      const insertPos = onLineStart ? clamped : line.to;
      const insert = onLineStart ? `${body}\n` : `\n${body}`;

      view.dispatch({
        changes: { from: insertPos, to: insertPos, insert },
      });
      if (dropPos !== null) dropPos = insertPos + insert.length;
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
