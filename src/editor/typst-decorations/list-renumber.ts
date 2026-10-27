// Keeps the explicit `N.` numbers of a Typst ordered list in step with its
// shape.
//
// `+` items are numbered by Typst; `1.` is literal, printed as typed, and goes
// stale when the list changes (an indented item still reads `2.` instead of
// `1.`, and later items count wrongly). This fixes those numbers. It works on
// raw lines (no parser or editor state), so it can be tested directly and used
// by any command that reshapes a list.

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
 * Renumber the `N.` markers in `lines`, the lines of one list block (see
 * `listBlockRange`):
 *
 * - Only `N.` markers change; `+` numbers itself, `-` has none.
 * - Each nesting level counts separately, so indenting restarts at 1.
 * - A `+` item counts as a step at its level (Typst puts `+` and `N.` in one
 *   list) but isn't rewritten.
 * - The block's first item keeps its number, so a list starting at `5.` runs 5,
 *   6, 7; every later run starts at 1 (a sub-list starting elsewhere is
 *   `#enum(start: …)`).
 * - Blank lines don't end a run.
 * - A line indented deeper than the item above is its wrapped text and is left
 *   alone; any other non-item line ends the list.
 *
 * Returns a new array.
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
 * The lines (1-based, inclusive) of the list block containing `lineNumber`:
 * adjacent items, their wrapped lines and the blank lines between. Prose at the
 * list's indent, or a code fence, ends it. Commands renumber the whole block:
 * one contiguous edit suits the incremental parser, and a list with wrong
 * numbers is fixed the next time it is indented.
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
 * Width of a line's marker (indent, marker, one space), or 0 if it isn't a list
 * item. Keeps the caret in place when the marker's width changes (`9.` →
 * `10.`).
 */
export function markerWidth(text: string): number {
  const m = MARKER_RE.exec(text);
  return m ? m[0].length : 0;
}
