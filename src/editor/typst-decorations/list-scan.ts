// Finds the document's list items.
//
// As in heading-scan.ts, Typst's parser decides: a `- x` line inside a ```
// fence, a comment or a string isn't a list item, which a line regex can't
// tell. A quick regex finds candidate lines and the syntax tree confirms each
// with `nodeStartingAt`, which is fast enough to run on every keystroke.
//
// Nesting is plain indentation, worked out by the caller from the lines; this
// only reports the confirmed lines and their indent.

import { syntaxTree } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";
import { Tree } from "@lezer/common";
import { nodeStartingAt } from "./heading-scan";

/** The parser's marker nodes for unordered (`-`) / ordered (`+`, `N.`) items. */
const LIST_MARKER_NAMES = new Set(["ListMarker", "EnumMarker"]);

// A line that might start a list item: optional indent, a `-`/`+`/`N.` marker,
// then a space or tab. Looser than Typst's rule, since the tree decides.
// Requiring the space matches the visual editor, where a marker without one is
// just text.
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
 * Last line (1-based) of the subtree of the list item at `itemLineNumber` with
 * indent `indent`: the following lines indented deeper than the item. Blank
 * lines between deeper lines are inside it; trailing blank lines aren't. A leaf
 * returns `itemLineNumber`.
 *
 * The shared definition of "an item and everything under it", for folding a
 * list and moving a subtree.
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
