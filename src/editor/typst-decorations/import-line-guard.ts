// Makes the inkycap-notebox `#import` line uneditable in the source editor.
//
// The line stays visible, but every note imports the notebox package through
// it, and a broken import fails compilation in confusing ways. The visual
// editor already protects it (`computeProtectedRanges`); this does the same in
// source mode.
//
// An `EditorState.changeFilter` returns the line's range, so CodeMirror drops
// any change touching it while applying the rest of an edit. The range includes
// the newline, so Backspace at the start of the next line can't join onto it.
// Whole-document replacements tagged `externalReload` (opening a file, property
// reloads, notebox upgrade) pass through.

import { EditorState } from "@codemirror/state";
import { isNoteboxImportLine, externalReload } from "./visual-protected";

/** Lines searched for the notebox import when the note has no `#note(`. */
const MAX_HEADER_LINES = 50;

/**
 * Range of the inkycap-notebox import line with its newline, or `null` without
 * one. The import is in the note's header, below any package imports InkyCap
 * placed above it (see `add_note_package` in the backend), so the search stops
 * at the `#note(...)` call.
 */
export function importLineRange(
  state: EditorState,
): { from: number; to: number } | null {
  const maxScan = Math.min(state.doc.lines, MAX_HEADER_LINES);
  for (let i = 1; i <= maxScan; i++) {
    const line = state.doc.line(i);
    if (line.text.trimStart().startsWith("#note(")) break;
    if (!isNoteboxImportLine(line.text)) continue;
    const to =
      line.to < state.doc.length ? line.to + 1 : line.to;
    return { from: line.from, to };
  }
  return null;
}

/** Change filter that protects the inkycap-notebox `#import` line from edits. */
export function importLineGuard() {
  return EditorState.changeFilter.of((tr) => {
    if (tr.annotation(externalReload)) return true;
    const range = importLineRange(tr.startState);
    if (!range) return true;
    return [range.from, range.to];
  });
}
