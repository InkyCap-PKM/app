// Keeps the caret out of the blind spot in front of a line's hidden markup.
//
// The visual editor replaces a list marker (`- `, `+ `, `1. `) with a bullet
// pulled into the margin by a negative `margin-left`, so the text and its
// wrapped lines share a column (see the hanging-indent notes in
// visual-plugin.ts and visual-theme.ts). The bullet's margin box is then zero
// wide, so the caret before and after the marker are drawn at the same place,
// and the writer sometimes lands in front of the marker. Then:
//   * typing inserts before the marker (`x- item`);
//   * a selection ending there leaves the marker behind, so deleting items
//     produces `- - item`, which Typst reads as a nested list that Shift+Tab
//     can't outdent.
//
// So a line start covered by replaced markup is treated as the position after
// it. CodeMirror's `atomicRanges` only skips positions strictly inside a range;
// at a line start there is no text before the range to tell its start edge
// apart, so that edge is handled here.

import {
  EditorSelection,
  EditorState,
  RangeSet,
  RangeValue,
  Text,
  type Extension,
  type Line,
} from "@codemirror/state";
import { expandFunc } from "./effects";

/**
 * Where a caret at `pos` should sit: unchanged unless `pos` is a line start
 * covered by a replaced range, in which case the far end of that range (the
 * farthest, if several open the line). `atoms` are the visual layer's replaced
 * ranges. A range running past the line break stands for the whole line, so its
 * start is left alone.
 */
export function pastLineLeadingMarkup(
  atoms: RangeSet<RangeValue>,
  doc: Text,
  pos: number,
): number {
  const line = doc.lineAt(pos);
  if (pos !== line.from) return pos;
  let target = pos;
  atoms.between(line.from, line.from, (from, to) => {
    if (from === line.from && to > from && to <= line.to) target = Math.max(target, to);
  });
  return target;
}

/**
 * End of a list item's marker and its separating space (`- `, `+ `, `1. `), the
 * span the bullet widget replaces, or null for other lines.
 */
export function listMarkerEnd(line: Line): number | null {
  const match = line.text.match(/^\s*(?:[-+]|\d+\.)[ \t]/);
  return match ? line.from + match[0].length : null;
}

/**
 * Selection filter keeping the caret, and the forward end of a selection, out
 * of the position in front of a line's hidden markup. `atomsFor` gives the
 * replaced ranges, the same set the visual layer makes atomic.
 *
 * A caret landing there moves forward past the markup, except when it stepped
 * back from the same line (Left, Ctrl+Left, …), where CodeMirror has already
 * moved it to the range's start; moving it forward again would trap it, so it
 * goes to the end of the previous line instead. A click is never a step.
 *
 * For a list bullet, stepping back from the start of the text instead reveals
 * the marker as source (through `expandFunc`, keyed on the line start), with
 * the caret in front of it, so the item can be selected or deleted with its
 * bullet; the next step reaches the previous line.
 *
 * Only the forward end of a non-empty selection moves, and only when the
 * selection starts mid-line: moving the start too would leave the first item's
 * marker behind. A selection starting at a line start (triple-click, Ctrl+A,
 * Shift+Down) is a whole-line selection whose ends belong on line boundaries.
 */
export function lineStartCaretFilter(
  atomsFor: (state: EditorState) => RangeSet<RangeValue>,
): Extension {
  return EditorState.transactionFilter.of((tr) => {
    // Doc-changing transactions are skipped: the ranges reachable here belong
    // to the state *before* the change, so they'd point at the wrong offsets.
    if (!tr.selection || tr.docChanged) return tr;
    // Clicking a pill reveals its source in the same transaction, so the
    // markup we can see is already out of date for that line.
    if (tr.effects.some((e) => e.is(expandFunc))) return tr;

    const atoms = atomsFor(tr.startState);
    if (atoms.size === 0) return tr;
    const doc = tr.startState.doc;
    const before = tr.startState.selection.ranges;
    // Motion commands tag transactions "select"; a click is "select.pointer".
    // Anything else (a search hit, a restored selection) is a jump, not a step.
    const keyboardMove = tr.isUserEvent("select") && !tr.isUserEvent("select.pointer");

    let moved = false;
    let reveal: number | null = null;
    const ranges = tr.selection.ranges.map((range, i) => {
      if (range.empty) {
        const head = pastLineLeadingMarkup(atoms, doc, range.head);
        if (head === range.head) return range;
        moved = true;
        const line = doc.lineAt(range.head);
        const prev = before.length === tr.selection!.ranges.length ? before[i] : null;
        const steppedBack =
          keyboardMove &&
          prev !== null &&
          prev.empty &&
          prev.head > range.head &&
          prev.head <= line.to;
        if (
          steppedBack &&
          prev.head === head &&
          i === tr.selection!.mainIndex &&
          listMarkerEnd(line) === head
        ) {
          reveal = line.from;
          return range;
        }
        if (steppedBack && line.number > 1) return EditorSelection.cursor(doc.line(line.number - 1).to);
        // assoc 1 draws the caret on the content side of the markup.
        return EditorSelection.cursor(head, 1);
      }
      if (range.from === doc.lineAt(range.from).from) return range;
      const to = pastLineLeadingMarkup(atoms, doc, range.to);
      if (to === range.to) return range;
      moved = true;
      return range.anchor === range.to
        ? EditorSelection.range(to, range.head)
        : EditorSelection.range(range.anchor, to);
    });
    if (!moved) return tr;

    return [tr, {
      selection: EditorSelection.create(ranges, tr.selection.mainIndex),
      effects: reveal === null ? [] : expandFunc.of(reveal),
    }];
  });
}
