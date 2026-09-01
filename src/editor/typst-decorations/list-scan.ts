// The one place InkyCap asks "where are this document's list items?".
//
// Like heading-scan.ts, the answer is parser-first: a `- x` line typed inside a
// ``` fence, a comment, or a string is not a list item, and only Typst's parser
// draws that boundary reliably (a line regex only sees the start of the line).
// So a cheap regex proposes candidate lines and the syntax tree rules on each
// one via the shared O(log n) descent in `nodeStartingAt` — the same
// index-then-confirm technique that keeps the heading scan fast enough to run
// on every keystroke, which matters here because an outline is mostly list
// lines.
//
// Nesting itself (which item sits under which) is plain indentation and is
// computed by the caller over the raw lines; this module only reports the
// confirmed marker lines and their indent depth.

import { syntaxTree } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";
import { Tree } from "@lezer/common";
import { nodeStartingAt } from "./heading-scan";

/** The parser's marker nodes for unordered (`-`) / ordered (`+`, `N.`) items. */
const LIST_MARKER_NAMES = new Set(["ListMarker", "EnumMarker"]);

// A line that *might* open a list item: optional indent, then a `-`/`+`/`N.`
// marker followed by a separating space or tab. Deliberately looser than
// Typst's rule — the tree decides; this only says where to look. Requiring the
// separator mirrors the visual editor's rule that a bare marker with no
// following space is just typed text, not a list item.
const CANDIDATE_RE = /^([ \t]*)(?:[-+]|\d+\.)[ \t]/;

export interface ListItemSpan {
  /** Start offset of the item's line. */
  lineFrom: number;
  /** End offset of the item's line, before the line break. */
  lineTo: number;
  /** 1-based line number, for walking a subtree by line. */
  lineNumber: number;
  /** Leading-whitespace width in characters — the nesting-depth key. */
  indent: number;
}

/** Every confirmed list item in `doc`, in document order, as `tree` sees them. */
export function listItemsInTree(tree: Tree, doc: Text): ListItemSpan[] {
  const out: ListItemSpan[] = [];
  let pos = 0;
  let lineNumber = 0;
  for (const line of doc.iterLines()) {
    lineNumber++;
    const candidate = CANDIDATE_RE.exec(line);
    if (candidate) {
      const indent = candidate[1].length;
      const markerFrom = pos + indent;
      if (nodeStartingAt(tree, markerFrom, LIST_MARKER_NAMES)) {
        out.push({ lineFrom: pos, lineTo: pos + line.length, lineNumber, indent });
      }
    }
    pos += line.length + 1;
  }
  return out;
}

/** Every list item in `state`'s document, in document order. */
export function scanListItems(state: EditorState): ListItemSpan[] {
  return listItemsInTree(syntaxTree(state), state.doc);
}

/** Leading-whitespace width of a line's text, in characters. */
export function leadingWhitespace(text: string): number {
  const m = /^[ \t]*/.exec(text);
  return m ? m[0].length : 0;
}

/**
 * Last line (1-based) belonging to the subtree of a list item at
 * `itemLineNumber` whose leading indent is `indent`: the deepest run of
 * following lines indented strictly deeper than the item. Blank lines are
 * skipped — a blank line between two deeper lines stays inside the subtree,
 * while trailing blank lines after the last deeper line are excluded. Returns
 * `itemLineNumber` itself when the item has no children (a leaf).
 *
 * This is the shared definition of "an item and everything nested under it",
 * used both to compute a list fold's range and to move a whole subtree.
 */
export function listSubtreeEndLine(doc: Text, itemLineNumber: number, indent: number): number {
  let end = itemLineNumber;
  for (let n = itemLineNumber + 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (text.trim() === "") continue;
    if (leadingWhitespace(text) > indent) end = n;
    else break;
  }
  return end;
}
