// Markup for notebox files placed in a note (dropped, pasted or picked), and
// inserting it into the editor. Shared by the editor's own drop/paste handler
// (editor/typst-decorations/drag-drop.ts) and the native drop listener
// (lib/tauri-drag-drop.ts), so both produce the same markup.

import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import * as ipc from "./ipc";
import { typstStringEscape } from "./typst";
import { t } from "./i18n";
import { showContextMenu } from "./context-menu";
import { protectedRangesField } from "../editor/typst-decorations/visual-plugin";
import { noteBodyStart } from "../editor/typst-decorations/note-header";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "mkv", "ogv", "m4v"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "opus"]);

/** The lower-cased extension of a file name, without the dot. */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** How a PDF is placed: a link to the file, or its first page shown in the
 *  note (`#image` places page 1 of a PDF). */
export type PdfPlacement = "link" | "firstPage";

/** Markup for the notebox file at `relativePath` (notebox-relative, no
 *  leading slash). Paths are written notebox-root-absolute (`/Assets/x.png`).
 *  Images, video and audio are shown; notes become wikilinks; a PDF follows
 *  `pdf`; anything else becomes a link to the file. */
export function attachmentMarkup(relativePath: string, pdf: PdfPlacement = "link"): string {
  const ext = fileExtension(relativePath);
  const path = typstStringEscape(relativePath);
  if (IMAGE_EXTS.has(ext) || (ext === "pdf" && pdf === "firstPage")) return `#image("/${path}")`;
  if (VIDEO_EXTS.has(ext)) return `#video("/${path}")`;
  if (AUDIO_EXTS.has(ext)) return `#audio("/${path}")`;
  const filename = relativePath.split("/").pop() ?? relativePath;
  if (ext === "typ") return `#wikilink("${typstStringEscape(filename.slice(0, -4))}")`;
  return `#link("/${path}")[${filename}]`;
}

/** Move `pos` past the note's header (imports, `#note(...)` and other top
 *  matter), then past any range the visual editor locks (such as hidden
 *  comments), so inserted markup never lands inside hidden source. */
export function clampPastProtected(state: EditorState, pos: number): number {
  const bodyStart = noteBodyStart(state);
  let p = pos < bodyStart ? bodyStart : pos;
  // The visual editor's locked ranges (present only in visual mode).
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

/** Ask, with a menu at `pos`, whether a PDF should be linked or have its
 *  first page shown. Dismissing the menu keeps the link. */
function choosePdfPlacement(view: EditorView, pos: number): Promise<PdfPlacement> {
  const at = view.coordsAtPos(pos) ?? view.dom.getBoundingClientRect();
  return new Promise((resolve) => {
    showContextMenu(
      at.left,
      at.bottom,
      [
        { hint: t("attachmentInsert.pdfQuestion") },
        { label: t("attachmentInsert.pdfAsLink"), run: () => resolve("link") },
        { label: t("attachmentInsert.pdfAsFirstPage"), run: () => resolve("firstPage") },
      ],
      { onDismiss: () => resolve("link") },
    );
  });
}

/** Insert markup for the notebox file at `relativePath` on its own line at
 *  `pos` (moved past the note's header and locked ranges), asking first how
 *  to place a PDF. Resolves with the position just after the insert, where a
 *  following file of the same drop goes. */
export async function insertAttachmentAt(
  view: EditorView,
  relativePath: string,
  pos: number,
): Promise<number> {
  const pdf =
    fileExtension(relativePath) === "pdf"
      ? await choosePdfPlacement(view, clampPastProtected(view.state, pos))
      : "link";
  // The document may have changed while the menu was open.
  const clamped = clampPastProtected(view.state, Math.min(pos, view.state.doc.length));
  const line = view.state.doc.lineAt(clamped);
  const onLineStart = clamped === line.from;
  const insertPos = onLineStart ? clamped : line.to;
  const body = attachmentMarkup(relativePath, pdf);
  const insert = onLineStart ? `${body}\n` : `\n${body}`;
  view.dispatch({
    changes: { from: insertPos, insert },
    selection: { anchor: insertPos + insert.length },
  });
  return insertPos + insert.length;
}

export type AttachmentFunc = "image" | "video" | "audio";

/**
 * Open the native attachment picker, copy each selected file into the
 * notebox's configured attachment folder, and replace the editor range
 * `[from, to]` with `#image("/<path>")` (or `#video(...)` / `#audio(...)`)
 * calls for each picked file. Notebox-root-absolute path emission is the
 * load-bearing invariant — see CLAUDE.md's portable-paths principle.
 *
 * If the user cancels the picker, the editor range is left untouched
 * (the slash-trigger or selection is preserved so the user can keep
 * typing or invoke a different command).
 */
export async function pickAndInsertAttachments(
  view: EditorView,
  from: number,
  to: number,
  func: AttachmentFunc,
): Promise<void> {
  let saved: string[];
  try {
    saved = await ipc.pickAndUploadToAttachments();
  } catch (err) {
    console.error(`[attachment-insert] picker failed for ${func}:`, err);
    return;
  }

  if (saved.length === 0) return; // user cancelled

  const calls = saved.map(
    (rel) => `#${func}("/${typstStringEscape(rel)}")`,
  );
  const insert = calls.join("\n");

  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
  });
  view.focus();
}
