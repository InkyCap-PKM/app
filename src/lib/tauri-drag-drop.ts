// Tauri-level drag-drop listener.
//
// Handles native file drops from outside the webview (file manager).
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
import { protectedRangesField } from "../editor/typst-decorations/visual-plugin";
import { getLastDragPos } from "../editor/typst-decorations/drag-drop";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { fileToBase64 } from "./file-bytes";
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
/// `relativePath` is notebox-root-relative (e.g. `assets/Foo.png`) — what
/// `copy_path_to_attachments` returns since the SEC-1 / path-fix work.
/// We emit it with a leading `/` so Typst's compiler reads it as
/// project-root-relative (works in reading view + export), while the
/// visual editor's `resolveEmbedPath` also handles the slash form.
const NOTE_EXTS = new Set(["typ"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "mkv", "ogv", "m4v"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "opus"]);

function attachmentMarkup(relativePath: string): string {
  const ext = getExtension(relativePath);
  if (IMAGE_EXTS.has(ext)) {
    return `#image("/${relativePath}")`;
  }
  if (VIDEO_EXTS.has(ext)) {
    return `#video("/${relativePath}")`;
  }
  if (AUDIO_EXTS.has(ext)) {
    return `#audio("/${relativePath}")`;
  }
  if (NOTE_EXTS.has(ext)) {
    const basename = relativePath.split("/").pop() ?? relativePath;
    const stem = basename.replace(/\.typ$/, "");
    return `#wikilink("${stem}")`;
  }
  const filename = relativePath.split("/").pop() ?? relativePath;
  return `#link("/${relativePath}")[${filename}]`;
}

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

/// Insert markup for an already-saved attachment at `dropPos`. Pins past
/// the document's `#import` / `#note` / `#bibliography` prelude and
/// normalizes to its own line — block-level markup like `#image(...)`
/// can't share a line with prose. Returns the dispatched insert length
/// so the caller can advance `dropPos` for the next attachment.
function insertSavedAttachment(
  view: EditorView,
  dropPos: number | null,
  savedRelativePath: string,
): { newDropPos: number | null } {
  const body = attachmentMarkup(savedRelativePath);
  const rawPos = dropPos ?? view.state.selection.main.from;
  const clamped = clampPastProtected(view.state, rawPos);
  const line = view.state.doc.lineAt(clamped);
  const onLineStart = clamped === line.from;
  const insertPos = onLineStart ? clamped : line.to;
  const insert = onLineStart ? `${body}\n` : `\n${body}`;
  view.dispatch({ changes: { from: insertPos, to: insertPos, insert } });
  return {
    newDropPos: dropPos !== null ? insertPos + insert.length : null,
  };
}

async function handleTauriDrop(
  paths: string[],
  position: DropCoords,
): Promise<void> {
  const target = resolveDropTarget(position);
  if (!target) {
    console.warn("[tauri-drop] no active editor, ignoring drop");
    return;
  }
  let { view, dropPos } = target;

  for (const absPath of paths) {
    try {
      const savedName = await ipc.copyPathToAttachments(absPath);
      ({ newDropPos: dropPos } = insertSavedAttachment(view, dropPos, savedName));
    } catch (err) {
      console.error("[tauri-drop] failed to copy", absPath, err);
    }
  }
}

async function handleHtml5Drop(event: DragEvent): Promise<void> {
  // CodeMirror's per-editor `dragDropHandler` (typst-decorations/drag-drop.ts)
  // already processes file drops that land inside the editor and calls
  // preventDefault on the event. Skip those here so we don't double-insert
  // when the drop happens on the editor surface — this window-level handler
  // exists only to catch drops that landed on sidebar / non-editor surfaces.
  if (event.defaultPrevented) return;
  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return;
  event.preventDefault();

  const target = resolveDropTarget({ x: event.clientX, y: event.clientY });
  if (!target) {
    console.warn("[html5-drop] no active editor, ignoring drop");
    return;
  }
  let { view, dropPos } = target;

  for (const file of Array.from(files)) {
    try {
      const base64 = await fileToBase64(file);
      const savedName = await ipc.copyToAttachments(file.name, base64);
      ({ newDropPos: dropPos } = insertSavedAttachment(view, dropPos, savedName));
    } catch (err) {
      console.error("[html5-drop] failed to save", file.name, err);
    }
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
  try {
    const webview = getCurrentWebviewWindow();
    tauriUnlisten = await webview.onDragDropEvent((event) => {
      const payload = event.payload;
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
