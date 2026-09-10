// Keeps the caret out of the blind spot in front of a line's hidden markup.
//
// The visual editor replaces a list marker (`- `, `+ `, `1. `) with a bullet
// widget that a negative `margin-left` pulls one bullet-width into the left
// margin, so the item's text and its wrapped continuations share one column
// (see the hanging-indent notes in visual-plugin.ts and visual-theme.ts). The
// side effect is that the widget's margin box is zero wide: the caret before
// the marker and the caret after it are drawn at the *same* x. Two document
// positions, one pixel column — the writer aims for "just before my text" and
// lands, some of the time, in front of the marker instead.
//
// Two failures follow from that, and this module exists to stop both:
//
//   * Typing there inserts before the marker (`x- item`), so the characters
//     appear in front of the bullet even though the caret looked like it was
//     after it.
//   * Ending a selection there leaves the marker behind, so deleting a run of
//     items merges two markers into `- - item`. Typst reads that as a nested
//     list, so the surviving item looks indented, and Shift+Tab can't outdent
//     it because there is no leading whitespace to take away — the only fix is
//     to switch to source mode and delete the stray marker by hand.
//
// The rule is that a line start covered by replaced markup is an alias for the
// position after that markup. CodeMirror's own `atomicRanges` almost gets
// there, but it only skips positions strictly *inside* a range; a range's
// start edge is normally distinguishable because there is text before it. At a
// line start there is no such text, so that edge is handled here.

import {
  EditorSelection,
  EditorState,
  RangeSet,
  RangeValue,
  Text,
  type Extension,
} from "@codemirror/state";
import { expandFunc } from "./effects";

/**
 * Where a caret at `pos` should really sit.
 *
 * Unchanged unless `pos` is a line start that some replaced range covers, in
 * which case it moves to the far end of that range — the farthest, when
 * several markup ranges open the same line.
 *
 * `atoms` are the visual layer's replaced ranges. A range that runs past the
 * line break stands for the whole line rather than markup in front of content,
 * so it is left alone: its start is the only position the caret has there.
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
 * Selection filter that keeps the caret — and the forward end of a selection —
 * out of the dead position in front of a line's hidden leading markup.
 *
 * `atomsFor` supplies the replaced ranges, so callers can hand over the same
 * set the visual layer already makes atomic and the two can't disagree about
 * what counts as markup.
 *
 * A caret that lands there normally moves forward, past the markup. The one
 * exception is a caret that stepped *back* onto it from the same line — Left,
 * Ctrl+Left, and the like — which CodeMirror's atomic handling has already
 * pushed from the content side to the range's start. Sending that caret
 * forward again would pin it at the start of the item's text, so it goes where
 * the writer was heading: the end of the previous line. A pointer click is
 * never a step, whatever the caret was doing before it.
 *
 * Only the *forward* end of a non-empty selection moves, and only when the
 * selection starts mid-line. Pulling the start end forward as well would leave
 * the first selected item's marker behind, which is the `- - item` bug wearing
 * a different hat. And a selection that begins at a line start is a whole-line
 * selection — triple-click, Ctrl+A, Shift+Down from a line start — where both
 * ends belong on line boundaries and the following item must keep its marker.
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
    // Cursor-motion commands annotate their transactions as "select"; a click
    // is "select.pointer". Anything else (a search hit, a restored selection)
    // is a jump, not a step.
    const keyboardMove = tr.isUserEvent("select") && !tr.isUserEvent("select.pointer");

    let moved = false;
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
          prev.head <= line.to &&
          line.number > 1;
        if (steppedBack) return EditorSelection.cursor(doc.line(line.number - 1).to);
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

    return [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex) }];
  });
}
