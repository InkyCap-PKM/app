// Makes the inkycap-vault `#import` line uneditable in the source editor.
//
// The line stays visible — it's useful context, and revealing it is better
// than hiding vault machinery — but it must not be casually altered or
// deleted: every note auto-imports the vault package through it, and a
// mangled import breaks compilation in ways that aren't obvious from the
// error. The visual editor already protects it via `computeProtectedRanges`;
// this guard extends the same protection to source mode.
//
// Implemented as an `EditorState.changeFilter`: returning the import line's
// range marks it off-limits, so CM6 drops any change touching it while still
// applying the rest of a multi-range edit. The trailing newline is included
// in the range so a Backspace at the start of the next line can't join it
// into the import line. Full-document replacements tagged with
// `externalReload` (file open, sidebar property reload, vault upgrade) pass
// through untouched.

import { EditorState } from "@codemirror/state";
import { isVaultImportLine, externalReload } from "./visual-protected";

/** Byte range of the inkycap-vault import line including its trailing
 *  newline, or `null` when the note has no such line. Only the first few
 *  lines are scanned — the import is generated as line 1. */
function importLineRange(
  state: EditorState,
): { from: number; to: number } | null {
  const maxScan = Math.min(state.doc.lines, 5);
  for (let i = 1; i <= maxScan; i++) {
    const line = state.doc.line(i);
    if (!isVaultImportLine(line.text)) continue;
    const to =
      line.to < state.doc.length ? line.to + 1 : line.to;
    return { from: line.from, to };
  }
  return null;
}

/** Change filter that protects the inkycap-vault `#import` line from edits. */
export function importLineGuard() {
  return EditorState.changeFilter.of((tr) => {
    if (tr.annotation(externalReload)) return true;
    const range = importLineRange(tr.startState);
    if (!range) return true;
    return [range.from, range.to];
  });
}
