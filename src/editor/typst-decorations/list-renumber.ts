// Keeps the explicit `N.` numbers in a Typst ordered list in step with the
// list's shape.
//
// Typst has two ordered-list markers. `+` numbers itself at compile time, so it
// is always right. An explicit `1.` is a literal: Typst prints the number the
// writer typed, and so does the visual editor. That literal goes stale the
// moment the list's shape changes — indent an item and its number is still the
// one it had as a sibling of the item above, so a nested item reads `2.` where
// it should read `1.`, and everything after it keeps counting from the wrong
// place.
//
// This module is the one place that fixes those numbers up. It works on the raw
// lines of a region (no parser, no editor state) so it can be unit-tested
// directly and reused by any command that changes a list's shape.

import type { Text } from "@codemirror/state";
import { leadingWhitespace } from "./list-scan";

/** A list item's opening: indent, a `-`/`+`/`N.` marker, and one separator. */
const MARKER_RE = /^([ \t]*)([-+]|\d+\.)[ \t]/;

/** A raw-block fence, which the region walk must never step across. */
const FENCE_RE = /^\s*```/;

/** Kind of list a marker opens: bullets and numbers are separate lists. */
type MarkerKind = "bullet" | "enum";

/** One open list level: the indent it sits at and the next number to hand out. */
interface Level {
  indent: number;
  kind: MarkerKind;
  next: number;
}

/**
 * Renumber the explicit `N.` markers in `lines`, which must be the lines of one
 * contiguous list block (see `listBlockRange`).
 *
 * The rules, in full:
 *
 * - Only `N.` markers are rewritten. `+` numbers itself, `-` has no number.
 * - Each nesting level counts on its own, so indenting an item restarts it at 1
 *   instead of continuing its former parent's run.
 * - A `+` item counts as a step at its level (Typst puts `+` and `N.` items in
 *   one enum), it is just never rewritten.
 * - The block's very first item keeps the number the writer typed, so a list
 *   deliberately starting at `5.` still runs 5, 6, 7. Every later run starts at
 *   1; a sub-list that should start elsewhere is `#enum(start: …)` in Typst,
 *   not a hand-typed marker.
 * - Blank lines do not end a run — a Typst list with blank lines between items
 *   is still one list (just loosely spaced).
 * - A line indented deeper than the item above it is that item's wrapped text
 *   and is left alone; any other non-item line ends the list.
 *
 * Returns a new array; `lines` is not modified.
 */
export function renumberListLines(lines: string[]): string[] {
  const out = lines.slice();
  const levels: Level[] = [];
  let lastItemIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (text.trim() === "") continue;

    const match = MARKER_RE.exec(text);
    if (!match) {
      if (lastItemIndent >= 0 && leadingWhitespace(text) > lastItemIndent) continue;
      levels.length = 0;
      lastItemIndent = -1;
      continue;
    }

    const indent = match[1].length;
    const marker = match[2];
    const kind: MarkerKind = marker === "-" ? "bullet" : "enum";

    // Anything nested deeper has ended; a same-indent list of the other kind
    // has ended too, and the one starting here counts from scratch.
    while (levels.length > 0 && levels[levels.length - 1].indent > indent) levels.pop();
    let level = levels[levels.length - 1];
    if (level && level.indent === indent && level.kind !== kind) {
      levels.pop();
      level = levels[levels.length - 1];
    }

    if (!level || level.indent !== indent) {
      const firstOfBlock = lastItemIndent < 0;
      const typed = firstOfBlock && kind === "enum" ? Number.parseInt(marker, 10) : NaN;
      level = { indent, kind, next: Number.isNaN(typed) ? 1 : typed };
      levels.push(level);
    }

    if (kind === "enum") {
      if (marker !== "+") out[i] = text.replace(/^([ \t]*)\d+\./, `$1${level.next}.`);
      level.next++;
    }
    lastItemIndent = indent;
  }

  return out;
}

/**
 * The line range (1-based, inclusive) of the whole list block containing
 * `lineNumber` — every adjacent list item, its wrapped continuation lines, and
 * the blank lines between them. Prose at the list's own indent, and a raw-block
 * fence, end the block.
 *
 * Commands renumber over this whole range rather than from the edit downwards:
 * one contiguous replacement is what the incremental parser handles cleanly,
 * and it means a list whose numbers were already wrong straightens itself out
 * the next time the writer indents or outdents an item in it.
 */
export function listBlockRange(doc: Text, lineNumber: number): [number, number] {
  let first = lineNumber;
  for (let n = lineNumber - 1; n >= 1; n--) {
    const text = doc.line(n).text;
    if (text.trim() === "") continue;
    if (FENCE_RE.test(text)) break;
    if (!MARKER_RE.test(text) && leadingWhitespace(text) === 0) break;
    first = n;
  }

  let last = lineNumber;
  for (let n = lineNumber + 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (text.trim() === "") continue;
    if (FENCE_RE.test(text)) break;
    if (!MARKER_RE.test(text) && leadingWhitespace(text) === 0) break;
    last = n;
  }

  return [first, last];
}

/** The lines of `doc` from `first` to `last` (1-based, inclusive). */
export function linesOfRange(doc: Text, first: number, last: number): string[] {
  const out: string[] = [];
  for (let n = first; n <= last; n++) out.push(doc.line(n).text);
  return out;
}

/**
 * Width of a line's leading marker (indent, marker, and one separator), or 0
 * when the line does not open a list item. Used to keep a caret at the same
 * spot in the item's text when the marker's width changes (`9.` → `10.`).
 */
export function markerWidth(text: string): number {
  const m = MARKER_RE.exec(text);
  return m ? m[0].length : 0;
}
