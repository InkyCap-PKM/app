import { EditorView, type KeyBinding } from "@codemirror/view";
import { Facet, EditorSelection, type EditorState, type ChangeSpec, type Line, type StateEffect } from "@codemirror/state";
import { syntaxTree, foldedRanges, foldEffect } from "@codemirror/language";
import { moveLineUp, moveLineDown } from "@codemirror/commands";
import { closeBrackets, deleteBracketPair } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { toggleEmphasis, toggleWrap } from "./wrap-format";
import { listSubtreeEndLine, leadingWhitespace } from "./list-scan";
import { listBlockRange, linesOfRange, markerWidth, renumberListLines } from "./list-renumber";
import { dispatchVisible } from "./dispatch-visible";
import { pastLineLeadingMarkup, listMarkerEnd } from "./line-start-caret";
import { expandFunc } from "./effects";

/**
 * When true, typing an opening bracket or quote adds its closing partner, and
 * Backspace between an empty pair removes both halves. Settings → Editor →
 * "Auto-pair brackets".
 */
export const autoPairBracketsFacet = Facet.define<boolean, boolean>({
  combine: (values) => (values.length ? values[0] : true),
});

/**
 * CodeMirror's close-brackets behaviour plus the facet `autoPairBracketsKeymap`
 * reads, in one compartment so the setting applies to an open note.
 */
export function autoPairBracketsExtension(enabled: boolean): Extension {
  return enabled
    ? [autoPairBracketsFacet.of(true), closeBrackets()]
    : autoPairBracketsFacet.of(false);
}

/**
 * Backspace between an empty pair deletes both halves. Replaces CodeMirror's
 * `closeBracketsKeymap`, which would keep doing this with pairing switched off.
 */
export const autoPairBracketsKeymap: KeyBinding[] = [
  {
    key: "Backspace",
    run: (view) => view.state.facet(autoPairBracketsFacet) && deleteBracketPair(view),
  },
];

/**
 * When true, indenting or outdenting a list item also moves its nested
 * children.
 */
export const smartIndentListsFacet = Facet.define<boolean, boolean>({
  combine: (values) => (values.length ? values[0] : false),
});

/**
 * When true, Enter at the end of a paragraph line inserts a Typst line break
 * (`\`) before the newline, so the next line starts a new line in the output. A
 * second Enter removes that `\` and makes a paragraph break. Not applied in
 * lists, raw or code blocks, math or verse.
 *
 * Visual editor only: `createTypstEditor` sets this from the user's setting in
 * visual mode and to `false` in source mode. The visual editor hides the `\`
 * and treats it as an atomic soft break (see visual-plugin.ts).
 */
export const enterInsertsLineBreakFacet = Facet.define<boolean, boolean>({
  combine: (values) => (values.length ? values[0] : false),
});

/**
 * True when `pos` is in raw or code, math, or a `verse` call, where a trailing
 * `\` is literal or has its own meaning. Used by both the Enter keymap (whether
 * to insert a `\`) and the visual decorations (which `\` to hide as soft
 * breaks), so they agree.
 */
export function inVerbatimLineContext(state: EditorState, pos: number): boolean {
  const tree = syntaxTree(state);
  // Resolve just before `pos` so the inner-most enclosing node is found
  // even when the cursor sits at a node boundary.
  let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, -1);
  while (node) {
    const name = node.name;
    if (name === "Raw" || name === "Equation" || name === "Math") return true;
    if (name === "FuncCall") {
      // Match the callee's last name segment, so `notebox.verse` counts too.
      const callee = state.doc.sliceString(node.from, Math.min(node.from + 32, node.to));
      if (/^#?(?:[\w.-]+\.)?verse\b/.test(callee)) return true;
    }
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}

/**
 * Code-mode and control-flow nodes that must never get a soft break; a trailing
 * `\` after them adds a stray line break to the output.
 */
const NON_PROSE_STATEMENT_NODES = new Set([
  "SetRule",
  "ShowRule",
  "LetBinding",
  "ModuleImport",
  "ModuleInclude",
  "Conditional",
  "ForLoop",
  "WhileLoop",
]);

/**
 * True when `line` is a code statement (`#set`, `#show`, `#let`, `#import`,
 * `#include`, control flow), a heading, or a block-level call filling the line
 * (`#image(...)`, `#figure(...)`, `#pagebreak()`, …). A `\` after any of these
 * adds a stray line break to the output.
 *
 * The Enter keymap doesn't insert `\` on these lines, and the visual editor
 * shows an existing one instead of hiding it so it can be fixed. A trailing `\`
 * is ignored when finding the line's content.
 */
export function lineIsNonProse(state: EditorState, line: Line): boolean {
  const text = line.text;
  const leadingWs = text.length - text.trimStart().length;
  let endTrim = text.trimEnd().length;
  if (
    endTrim > leadingWs &&
    text[endTrim - 1] === "\\" &&
    !(endTrim >= 2 && text[endTrim - 2] === "\\")
  ) {
    endTrim = text.slice(0, endTrim - 1).trimEnd().length;
  }
  if (endTrim <= leadingWs) return false;
  const first = text[leadingWs];
  // Only code (`#…`) and heading (`=…`) lines can be non-prose; anything else
  // is flowing text that legitimately wants a soft break.
  if (first !== "#" && first !== "=") return false;
  const contentFrom = line.from + leadingWs;
  const contentTo = line.from + endTrim;
  const tree = syntaxTree(state);
  let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(
    contentFrom + 1,
    1,
  );
  while (node) {
    if (node.name === "Heading") return true;
    if (NON_PROSE_STATEMENT_NODES.has(node.name)) return true;
    if (node.name === "FuncCall") {
      // Standalone call only — one that fills the line with no trailing prose.
      // An inline call followed by text (`#emph[x] and more`) stays prose.
      return node.to >= contentTo;
    }
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}

/**
 * Whether Enter at `pos` should insert a `\` line break. Not in lists (the list
 * keymap handles Enter), on non-prose lines (see `lineIsNonProse`), when the
 * line already ends with `\`, when the cursor is mid-line, or in verbatim
 * contexts (see `inVerbatimLineContext`).
 */
function shouldInsertAutoLineBreak(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  // Lists (`-`, `+`, `N.`) are continued by the list keymap, not soft-broken.
  if (/^\s*([-+]|\d+\.)\s/.test(line.text)) return false;
  // Code statements, headings, and standalone block calls must not get a `\`.
  if (lineIsNonProse(state, line)) return false;
  // If the line already ends with an unescaped trailing `\`, don't double up.
  const trimmedEnd = line.text.replace(/\s+$/, "");
  if (trimmedEnd.endsWith("\\") && !trimmedEnd.endsWith("\\\\")) return false;
  // Enter mid-line splits the paragraph; only add `\` at the end of the line.
  const trailing = state.doc.sliceString(pos, line.to);
  if (trailing.trim().length > 0) return false;
  return !inVerbatimLineContext(state, pos);
}

/**
 * Where a line's text begins: after a list marker (`- `, `+ `, `1. `),
 * otherwise after the indentation. Used by smart Home.
 */
export function listContentStart(line: Line): number {
  const listMatch = line.text.match(/^(\s*)(?:[-+]|\d+\.)\s+/);
  if (listMatch) return line.from + listMatch[0].length;
  const ws = line.text.length - line.text.trimStart().length;
  return line.from + ws;
}

/**
 * Smart Home. Moves the caret to the start of the line's text: after the bullet of
 * a list item, or after a block element's hidden opener (`#callout("note")[`).
 *
 * Pressing Home again goes to the true line start, before the marker, so Home then
 * Shift-End (or a whole-line copy) includes the bullet. On a wrapped row after the
 * first, Home first goes to the start of that row, as End goes to its end.
 *
 * In the visual editor, a caret before a hidden bullet would look the same as one
 * after it, so the second press also reveals the marker as source (through
 * `expandFunc`, keyed on the line start). Only the main cursor reveals, since one
 * marker can be revealed at a time.
 *
 * `extend` does the same for Shift-Home, keeping the anchor. Applies to every
 * cursor.
 */
function smartLineStart(view: EditorView, extend: boolean): boolean {
  const { state } = view;
  const atomics = state.facet(EditorView.atomicRanges);
  let reveal: number | null = null;
  const ranges = state.selection.ranges.map((range, i) => {
    const line = state.doc.lineAt(range.head);
    // Where the line's own markup ends: past a list marker, past hidden
    // element markup, whichever reaches further into the line.
    const pastMarkup = atomics.reduce(
      (furthest, get) => Math.max(furthest, pastLineLeadingMarkup(get(view), state.doc, line.from)),
      line.from,
    );
    const cs = Math.max(listContentStart(line), pastMarkup);
    const markerHidden = pastMarkup !== line.from;
    // On a wrapped row after the first, go to that row's start; pressing again
    // continues to the paragraph start.
    const rowStart = view.moveToLineBoundary(range, false, true).head;
    let target = cs;
    if (rowStart > cs && range.head !== rowStart) {
      target = rowStart;
    } else if (range.head === cs) {
      if (!markerHidden) {
        target = line.from;
      } else if (i === state.selection.mainIndex && listMarkerEnd(line) === pastMarkup) {
        target = line.from;
        reveal = line.from;
      }
    }
    return extend
      ? EditorSelection.range(range.anchor, target)
      : EditorSelection.cursor(target);
  });
  dispatchVisible(view, {
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    effects: reveal === null ? [] : expandFunc.of(reveal),
    // Tag it like CodeMirror's own selection commands; the selection toolbar
    // only responds to tagged selections.
    userEvent: "select",
  });
  return true;
}

function toggleBold(state: EditorState) {
  return toggleEmphasis(state, "*", "strong");
}

function toggleItalic(state: EditorState) {
  return toggleEmphasis(state, "_", "emph");
}

function toggleStrikethrough(state: EditorState) {
  return toggleWrap(state, "#strike[", "]");
}

function toggleHighlight(state: EditorState) {
  return toggleWrap(state, "#highlight[", "]");
}

function toggleLink(state: EditorState) {
  // The caret lands in the empty URL (`#link("⎸")[…]`); the selected text
  // becomes the label. Same as the toolbar link button.
  return toggleWrap(state, '#link("")[', "]", '#link("'.length);
}

function toggleInlineCode(state: EditorState) {
  return toggleWrap(state, "`", "`");
}

function adjustHeading(state: EditorState, delta: number): { changes: ChangeSpec; selection: { anchor: number } } | null {
  const { from } = state.selection.main;
  const line = state.doc.lineAt(from);
  const text = line.text;

  const match = text.match(/^(=+)\s?/);
  const currentLevel = match ? match[1].length : 0;

  let newLevel = currentLevel + delta;
  if (newLevel < 0) newLevel = 0;
  if (newLevel > 6) newLevel = 6;

  if (newLevel === currentLevel) return null;

  const contentStart = match ? match[0].length : 0;
  const content = text.slice(contentStart);

  const prefix = newLevel > 0 ? "=".repeat(newLevel) + " " : "";
  const newText = prefix + content;

  return {
    changes: { from: line.from, to: line.to, insert: newText },
    selection: { anchor: line.from + newText.length },
  };
}

function insertListItem(state: EditorState, marker: string): { changes: ChangeSpec; selection: { anchor: number } } | null {
  const { from } = state.selection.main;
  const line = state.doc.lineAt(from);
  const text = line.text;
  const indent = text.match(/^(\s*)/)?.[1] ?? "";

  if (text.trim() === "") {
    const insert = `${indent}${marker} `;
    return {
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + insert.length },
    };
  }

  const insert = `\n${indent}${marker} `;
  return {
    changes: { from: line.to, insert },
    selection: { anchor: line.to + insert.length },
  };
}

/**
 * The rest of a just-opened empty code block after its opening fence: one empty
 * line, then the closing fence (possibly indented). What the ``` gesture
 * produces.
 */
const EMPTY_FENCE_TAIL = /^\n\n[ \t]*```$/;

/**
 * Move the caret from the end of a just-opened code fence into the block's
 * empty line; true if it did. Whether a ``` line opens or closes a block
 * depends on the fences above, so per CLAUDE.md's Typst-first principle the
 * syntax tree decides.
 *
 * Only fires on the exact shape the ``` gesture produces: caret at the end of
 * the opening line, one empty line, closing fence.
 */
function stepIntoOpenFence(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const doc = view.state.doc;
  const line = doc.lineAt(sel.head);
  if (sel.head !== line.to) return false;

  let raw = syntaxTree(view.state).resolveInner(sel.head, -1);
  while (raw.name !== "Raw") {
    if (!raw.parent) return false;
    raw = raw.parent;
  }
  // The block must start on the caret's own line — otherwise the caret is
  // somewhere inside (or at the end of) an existing block, not on its opener.
  if (raw.from < line.from) return false;
  if (!EMPTY_FENCE_TAIL.test(doc.sliceString(line.to, raw.to))) return false;

  dispatchVisible(view, { selection: { anchor: line.to + 1 } });
  return true;
}

function continueList(state: EditorState): { changes: ChangeSpec; selection: { anchor: number } } | null {
  const { from } = state.selection.main;
  const line = state.doc.lineAt(from);
  const text = line.text;

  // Typst's list markers: `-`, `+` and `N.`, followed by a space or the line
  // end.
  const listMatch = text.match(/^(\s*)([-+]|\d+\.)(?:\s|$)/);
  if (!listMatch) return null;

  const indent = listMatch[1];
  const marker = listMatch[2];

  // Pressing Enter on an empty item (marker only) ends the list: clear the
  // marker and leave the cursor on the now-blank line.
  if (text.trim() === marker) {
    return {
      changes: { from: line.from, to: line.to, insert: "" },
      selection: { anchor: line.from },
    };
  }

  // Second Enter on an empty new bullet ends the list. In the visual editor the
  // new bullet is an atomic widget and the cursor can stay on the item above,
  // so check the line below too: clear the empty bullet and put the caret on
  // the blank line.
  if (from === line.to && line.number < state.doc.lines) {
    const below = state.doc.line(line.number + 1);
    const belowMatch = below.text.match(/^(\s*)([-+]|\d+\.)(?:\s|$)/);
    if (belowMatch && below.text.trim() === belowMatch[2]) {
      return {
        changes: { from: below.from, to: below.to, insert: "" },
        selection: { anchor: below.from },
      };
    }
  }

  // Bullets and `+` repeat their marker; an explicit number increments so the
  // writer gets 1., 2., 3.… as they go (Typst renumbers from the source).
  const numMatch = marker.match(/^(\d+)\.$/);
  const nextMarker = numMatch ? `${Number(numMatch[1]) + 1}.` : marker;

  // Never split before the marker. A click at the start of the item text can
  // put the caret at `line.from` (the bullet's atomic range starts there), so
  // clamp to the content start.
  const contentStart = line.from + listMatch[0].length;
  const pos = Math.max(from, contentStart);

  // Only the new line is written: existing items keep their numbers, so a
  // deliberate restart survives and the undo step stays small. Numbers are
  // corrected on Tab and Shift+Tab (see indentList).
  const insert = `\n${indent}${nextMarker} `;
  return {
    changes: { from: pos, insert },
    selection: { anchor: pos + insert.length },
  };
}

/** One nesting level, in spaces. Typst treats leading whitespace as nesting. */
const INDENT_UNIT = "  ";

/** A planned indent/outdent: one contiguous edit plus the selection to keep. */
interface IndentPlan {
  /** Replacement covering every line the plan touches, first to last. */
  change: { from: number; to: number; insert: string };
  /** Where the selection sits once the change has been applied. */
  selection: { anchor: number; head: number };
  /** CodeMirror user-event name, so history and other extensions can react. */
  userEvent: string;
  /** Folds inside the replaced region, re-issued at their new positions. */
  refolds: StateEffect<unknown>[];
}

/** A line that opens a list item: indent, then a `-`/`+`/`N.` marker and a space. */
const LIST_LINE_RE = /^([ \t]*)(?:[-+]|\d+\.)[ \t]/;

/**
 * Shift for a line at `indent` moving one level: two spaces in, or out by as
 * much as its indentation allows (zero at the margin).
 */
function shiftFor(indent: number, direction: 1 | -1): number {
  return direction === 1 ? INDENT_UNIT.length : -Math.min(INDENT_UNIT.length, indent);
}

/**
 * Lines to shift when the caret is in one item, keyed by line number. With
 * smart indent on, nested children move too: the following lines indented
 * deeper than the item, up to a blank line or a line at its level or shallower.
 */
function shiftsForItem(state: EditorState, lineNumber: number, direction: 1 | -1, smart: boolean): Map<number, number> {
  const shifts = new Map<number, number>();
  const match = LIST_LINE_RE.exec(state.doc.line(lineNumber).text);
  if (!match) return shifts;
  const indent = match[1].length;
  const shift = shiftFor(indent, direction);
  if (shift === 0) return shifts;
  shifts.set(lineNumber, shift);
  if (!smart) return shifts;
  for (let n = lineNumber + 1; n <= state.doc.lines; n++) {
    const text = state.doc.line(n).text;
    if (text.trim() === "") break;
    if (leadingWhitespace(text) <= indent) break;
    shifts.set(n, shift);
  }
  return shifts;
}

/**
 * Lines to shift when the selection spans several lines, keyed by line number.
 * Only selected lines move; an unselected child stays put and becomes a
 * sibling. Wrapped continuation lines also move with their item.
 */
function shiftsForSelectedLines(state: EditorState, firstNumber: number, lastNumber: number, direction: 1 | -1): Map<number, number> {
  const shifts = new Map<number, number>();
  let itemIndent = -1;
  let itemShift = 0;
  for (let n = firstNumber; n <= lastNumber; n++) {
    const text = state.doc.line(n).text;
    const match = LIST_LINE_RE.exec(text);
    if (match) {
      itemIndent = match[1].length;
      itemShift = shiftFor(itemIndent, direction);
      if (itemShift !== 0) shifts.set(n, itemShift);
      continue;
    }
    const isContinuation = text.trim() !== "" && itemIndent >= 0 && leadingWhitespace(text) > itemIndent;
    if (isContinuation) {
      if (itemShift !== 0) shifts.set(n, itemShift);
      continue;
    }
    // Prose or a blank line ends the run: the next item starts a fresh one.
    itemIndent = -1;
    itemShift = 0;
  }
  return shifts;
}

/**
 * Plan a list indent or outdent for the selection: one replacement covering the
 * first to last shifted line, plus the selection to restore. A single edit
 * means one undo step, and the Typst parser handles it correctly (several
 * changes in one transaction desynchronize its tree). Null when nothing would
 * move, so Tab falls through to the generic indent.
 */
function indentList(state: EditorState, direction: 1 | -1): IndentPlan | null {
  const { anchor, head } = state.selection.main;
  const firstLine = state.doc.lineAt(Math.min(anchor, head));
  let lastLine = state.doc.lineAt(Math.max(anchor, head));
  // A selection that stops exactly at a line's start doesn't reach into it.
  if (lastLine.number > firstLine.number && Math.max(anchor, head) === lastLine.from) {
    lastLine = state.doc.line(lastLine.number - 1);
  }

  const shifts = lastLine.number > firstLine.number
    ? shiftsForSelectedLines(state, firstLine.number, lastLine.number, direction)
    : shiftsForItem(state, firstLine.number, direction, state.facet(smartIndentListsFacet));
  if (shifts.size === 0) return null;

  const shiftedNumbers = [...shifts.keys()].sort((a, b) => a - b);
  const shiftedFirst = shiftedNumbers[0];
  const shiftedLast = shiftedNumbers[shiftedNumbers.length - 1];

  // Moving an item between levels changes the `N.` numbers of both levels, so
  // the rewrite covers the whole list block (see list-renumber.ts). A selection
  // spanning several blocks rewrites from the first block's start to the last
  // one's end, each counted separately.
  const [blockFirst] = listBlockRange(state.doc, shiftedFirst);
  const [, blockLast] = listBlockRange(state.doc, shiftedLast);
  const first = Math.min(blockFirst, shiftedFirst);
  const last = Math.max(blockLast, shiftedLast);

  const shifted = linesOfRange(state.doc, first, last).map((text, i) => {
    const shift = shifts.get(first + i) ?? 0;
    return shift > 0 ? INDENT_UNIT + text : shift < 0 ? text.slice(-shift) : text;
  });
  const rewritten = renumberListLines(shifted);

  const startLine = state.doc.line(first);
  const endLine = state.doc.line(last);

  // A position moves with the lines before it, plus its own line's shift and
  // any change in its number's width. A position inside removed indentation
  // goes to the new line start.
  const regionDelta = rewritten.join("\n").length - shifted.join("\n").length;
  const mapPos = (pos: number): number => {
    const line = state.doc.lineAt(pos);
    if (line.number < first) return pos;
    if (line.number > last) return pos + regionDelta;
    const index = line.number - first;
    let lineStart = startLine.from;
    for (let i = 0; i < index; i++) lineStart += rewritten[i].length + 1;
    const shift = shifts.get(line.number) ?? 0;
    const column = pos - line.from;
    const numberShift = column >= markerWidth(line.text)
      ? rewritten[index].length - shifted[index].length
      : 0;
    return lineStart + Math.max(0, column + shift + numberShift);
  };

  // Replacing the region drops folds inside it, so re-add them at their new
  // positions. CodeMirror maps folds that extend outside the region.
  const refolds: StateEffect<unknown>[] = [];
  foldedRanges(state).between(startLine.from, endLine.to, (from, to) => {
    if (from >= startLine.from && to <= endLine.to) {
      refolds.push(foldEffect.of({ from: mapPos(from), to: mapPos(to) }));
    }
  });

  return {
    change: { from: startLine.from, to: endLine.to, insert: rewritten.join("\n") },
    selection: { anchor: mapPos(anchor), head: mapPos(head) },
    userEvent: direction === 1 ? "input.indent" : "delete.dedent",
    refolds,
  };
}

/** Apply a planned list indent/outdent as one undoable transaction. */
function applyIndentPlan(view: EditorView, plan: IndentPlan): void {
  dispatchVisible(view, {
    changes: plan.change,
    selection: plan.selection,
    userEvent: plan.userEvent,
    effects: plan.refolds,
  });
}

/** Is `text` a list item whose leading indent is exactly `indent`? */
function isListItemAt(text: string, indent: number): boolean {
  const m = text.match(/^(\s*)(?:[-+]|\d+\.)\s/);
  return !!m && m[1].length === indent;
}

/** The explicit number of a numbered (`N.`) item's first line, or null for a
 *  `-`/`+` item. */
function numberOf(firstLine: string): string | null {
  const m = firstLine.match(/^\s*(\d+)\./);
  return m ? m[1] : null;
}

/** Replace the leading `N.` number on a block's first line, keeping indent and
 *  content. No-op when `newNum` is null or the first line isn't numbered. */
function withNumber(blockText: string, newNum: string | null): string {
  if (newNum === null) return blockText;
  const nl = blockText.indexOf("\n");
  const first = nl === -1 ? blockText : blockText.slice(0, nl);
  const rest = nl === -1 ? "" : blockText.slice(nl);
  return first.replace(/^(\s*)\d+\./, `$1${newNum}.`) + rest;
}

/** Length of the leading marker (indent + `-`/`+`/`N.` + separators) on the
 *  first line of a block. */
function markerLenOf(firstLine: string): number {
  return firstLine.match(/^(\s*)(?:[-+]|\d+\.)[ \t]+/)?.[0].length ?? 0;
}

/**
 * Start line (1-based) of the previous sibling at the same indent as the item
 * at `curStart`, skipping blank lines and the sibling's children. Null for a
 * first child.
 */
function prevSiblingStart(doc: EditorState["doc"], curStart: number, indent: number): number | null {
  let n = curStart - 1;
  while (n >= 1 && doc.line(n).text.trim() === "") n--;
  if (n < 1) return null;
  if (leadingWhitespace(doc.line(n).text) < indent) return null; // first child
  while (n >= 1) {
    const t = doc.line(n).text;
    if (t.trim() === "") { n--; continue; }
    const ind = leadingWhitespace(t);
    if (ind < indent) return null;               // ran past into a shallower scope
    if (ind === indent) return isListItemAt(t, indent) ? n : null;
    n--;                                          // deeper — inside the sibling subtree
  }
  return null;
}

/**
 * Move a list item up or down with its nested children, swapping with the
 * adjacent sibling's block and keeping any blank lines between them.
 *
 * Explicit `1. 2. 3.` numbers stay in document order, so the two blocks'
 * first-line numbers are swapped back. One self-contained transaction; the
 * generic move-line command stopped working after a few presses with the visual
 * layer. At a list edge the key is consumed without moving. Returns false when
 * not on a list item.
 */
function moveListItem(view: EditorView, dir: -1 | 1): boolean {
  const { state } = view;
  const doc = state.doc;
  const head = state.selection.main.head;
  const line = doc.lineAt(head);
  const m = line.text.match(/^(\s*)(?:[-+]|\d+\.)\s+/);
  if (!m) return false; // not a list item → caller falls back to plain line move
  const indent = m[1].length;

  // The current block is the item and everything nested under it.
  const curStart = line.number;
  const curEnd = listSubtreeEndLine(doc, curStart, indent);
  const curText = doc.sliceString(doc.line(curStart).from, doc.line(curEnd).to);
  const curNum = numberOf(line.text);
  // Caret column within the current item's first-line content (after its marker).
  const contentCol = Math.max(0, head - (line.from + m[0].length));

  // Resolve the sibling block above/below to swap with.
  let sibStart: number, sibEnd: number;
  if (dir < 0) {
    const s = prevSiblingStart(doc, curStart, indent);
    if (s === null) return true; // no sibling above → consume
    sibStart = s;
    sibEnd = listSubtreeEndLine(doc, sibStart, indent);
  } else {
    let n = curEnd + 1;
    while (n <= doc.lines && doc.line(n).text.trim() === "") n++;
    if (n > doc.lines || !isListItemAt(doc.line(n).text, indent)) return true; // no sibling below
    sibStart = n;
    sibEnd = listSubtreeEndLine(doc, sibStart, indent);
  }
  const sibText = doc.sliceString(doc.line(sibStart).from, doc.line(sibEnd).to);
  const sibNum = numberOf(doc.line(sibStart).text);

  // Order the two blocks top→bottom and grab the untouched gap between them.
  const upFirst = dir < 0 ? sibStart : curStart;
  const upLast = dir < 0 ? sibEnd : curEnd;
  const downFirst = dir < 0 ? curStart : sibStart;
  const downLast = dir < 0 ? curEnd : sibEnd;
  const regionFrom = doc.line(upFirst).from;
  const regionTo = doc.line(downLast).to;
  const gap = doc.sliceString(doc.line(upLast).to, doc.line(downFirst).from);

  // After the swap the blocks trade places; the top position keeps the top
  // number and the bottom keeps the bottom number (positional numbering).
  const upText = dir < 0 ? sibText : curText;   // originally on top
  const downText = dir < 0 ? curText : sibText; // originally on bottom
  const upNum = dir < 0 ? sibNum : curNum;
  const downNum = dir < 0 ? curNum : sibNum;
  const newTop = withNumber(downText, upNum);   // bottom block rises, shows top's number
  const newBottom = withNumber(upText, downNum); // top block sinks, shows bottom's number
  const insert = newTop + gap + newBottom;

  // Where each block lands after the swap.
  const curIsTop = dir < 0; // moving up puts the current block on top
  const currentNewText = curIsTop ? newTop : newBottom;
  const curNewStart = curIsTop ? regionFrom : regionFrom + newTop.length + gap.length;
  const sibNewText = curIsTop ? newBottom : newTop;
  const sibNewStart = curIsTop ? regionFrom + newTop.length + gap.length : regionFrom;
  const newHead = curNewStart + markerLenOf(currentNewText) + contentCol;

  // Swapping the blocks would drop their folds, so re-add each one shifted by
  // its block's move distance plus any change in the first-line number's
  // length.
  const curFrom = doc.line(curStart).from, curTo = doc.line(curEnd).to;
  const sibFrom = doc.line(sibStart).from, sibTo = doc.line(sibEnd).to;
  const curDelta = currentNewText.length - curText.length;
  const sibDelta = sibNewText.length - sibText.length;
  const refolds: StateEffect<unknown>[] = [];
  foldedRanges(state).between(regionFrom, regionTo, (from, to) => {
    if (from >= curFrom && to <= curTo) {
      refolds.push(foldEffect.of({ from: curNewStart + (from - curFrom) + curDelta, to: curNewStart + (to - curFrom) + curDelta }));
    } else if (from >= sibFrom && to <= sibTo) {
      refolds.push(foldEffect.of({ from: sibNewStart + (from - sibFrom) + sibDelta, to: sibNewStart + (to - sibFrom) + sibDelta }));
    }
  });

  dispatchVisible(view, {
    changes: { from: regionFrom, to: regionTo, insert },
    selection: { anchor: newHead },
    effects: refolds,
    userEvent: "move.line",
  });
  return true;
}

export const typstKeymap: KeyBinding[] = [
  {
    // Smart Home: the first press goes to the line's text, the second to the
    // line start. Shift-Home extends the selection the same way.
    key: "Home",
    run: (view) => smartLineStart(view, false),
    shift: (view) => smartLineStart(view, true),
  },
  {
    key: "Mod-b",
    run(view) {
      const result = toggleBold(view.state);
      if (!result) return false;
      dispatchVisible(view, { changes: result.changes, selection: result.selection });
      return true;
    },
  },
  {
    key: "Mod-i",
    run(view) {
      const result = toggleItalic(view.state);
      if (!result) return false;
      dispatchVisible(view, { changes: result.changes, selection: result.selection });
      return true;
    },
  },
  {
    key: "Mod-Shift-x",
    run(view) {
      const result = toggleStrikethrough(view.state);
      if (!result) return false;
      dispatchVisible(view, { changes: result.changes, selection: result.selection });
      return true;
    },
  },
  {
    key: "Mod-Shift-h",
    run(view) {
      const result = toggleHighlight(view.state);
      if (!result) return false;
      dispatchVisible(view, { changes: result.changes, selection: result.selection });
      return true;
    },
  },
  {
    key: "Mod-k",
    run(view) {
      const result = toggleLink(view.state);
      if (!result) return false;
      dispatchVisible(view, { changes: result.changes, selection: result.selection });
      return true;
    },
  },
  {
    key: "Mod-e",
    run(view) {
      const result = toggleInlineCode(view.state);
      if (!result) return false;
      dispatchVisible(view, { changes: result.changes, selection: result.selection });
      return true;
    },
  },
  {
    key: "Ctrl-Shift-ArrowUp",
    run(view) {
      const result = adjustHeading(view.state, -1);
      if (!result) return false;
      dispatchVisible(view, { changes: result.changes, selection: result.selection });
      return true;
    },
  },
  {
    key: "Ctrl-Shift-ArrowDown",
    run(view) {
      const result = adjustHeading(view.state, 1);
      if (!result) return false;
      dispatchVisible(view, { changes: result.changes, selection: result.selection });
      return true;
    },
  },
  {
    key: "Enter",
    run(view) {
      const pos = view.state.selection.main.head;
      if (pos < view.state.doc.length) {
        const charAfter = view.state.doc.sliceString(pos, pos + 1);
        if ("])*`$_".includes(charAfter)) {
          // ContentBlock (`[…]`) isn't listed: Enter must make ordinary line
          // breaks inside callout and quote bodies. Wikilinks step out through
          // `Args`.
          const STEP_OUT_NODES = ["Strong", "Emph", "Raw", "Equation", "Args"];
          const tree = syntaxTree(view.state);
          let cur = tree.resolveInner(pos, -1);
          let canStep = false;
          while (cur) {
            if (STEP_OUT_NODES.includes(cur.name) && cur.to === pos + 1) {
              canStep = true;
              break;
            }
            if (!cur.parent) break;
            cur = cur.parent;
          }
          if (canStep) {
            dispatchVisible(view, { selection: { anchor: pos + 1 } });
            return true;
          }
        }
      }
      // Enter at the end of a just-opened code fence steps into the block
      // instead of adding another empty line (the ``` gesture leaves the caret
      // on the fence for the language; see auto-pair-typst.ts).
      if (stepIntoOpenFence(view)) return true;

      const listResult = continueList(view.state);
      if (listResult) {
        dispatchVisible(view, { changes: listResult.changes, selection: listResult.selection });
        return true;
      }

      // Auto line break: Enter at the end of a paragraph line inserts `\␤`. A
      // second Enter removes the `\`, leaving a blank line, which is a
      // paragraph break.
      const enabled = view.state.facet(enterInsertsLineBreakFacet);
      if (!enabled) return false;
      const { from: selFrom, to: selTo } = view.state.selection.main;
      // Non-empty selections: let default Enter handle the replacement.
      if (selFrom !== selTo) return false;
      const cursor = selFrom;

      const curLine = view.state.doc.lineAt(cursor);

      // Second Enter: the cursor is on an empty line after a line ending in
      // `\`. Remove the `\` and let CM insert the newline.
      if (curLine.text.length === 0 && curLine.number > 1) {
        const prevLine = view.state.doc.line(curLine.number - 1);
        const prev = prevLine.text;
        if (prev.endsWith("\\") && !prev.endsWith("\\\\")) {
          const slashFrom = prevLine.from + prev.length - 1;
          dispatchVisible(view, {
            changes: { from: slashFrom, to: slashFrom + 1, insert: "" },
            selection: { anchor: cursor - 1 },
            userEvent: "input",
          });
          // Fall through so the default Enter handler appends the newline.
          return false;
        }
      }

      if (!shouldInsertAutoLineBreak(view.state, cursor)) return false;
      dispatchVisible(view, {
        changes: { from: cursor, insert: "\\\n" },
        selection: { anchor: cursor + 2 },
        userEvent: "input",
      });
      return true;
    },
  },
  {
    key: "Tab",
    run(view) {
      const result = indentList(view.state, 1);
      if (!result) return false;
      applyIndentPlan(view, result);
      return true;
    },
  },
  {
    key: "Shift-Tab",
    run(view) {
      const result = indentList(view.state, -1);
      if (!result) return false;
      applyIndentPlan(view, result);
      return true;
    },
  },
  // Shift-Alt-Up/Down move lines like Alt-Up/Down, replacing the default
  // copy-line bindings. List items move with their children (see moveListItem);
  // other lines use the generic command.
  //
  // The key is always consumed, even when nothing moves or the command throws,
  // so it never falls through to the webview and scrolls the page.
  { key: "Shift-Alt-ArrowUp", run: (view) => { try { if (!moveListItem(view, -1)) moveLineUp(view); } catch { /* swallow: never fall through to page scroll */ } return true; } },
  { key: "Shift-Alt-ArrowDown", run: (view) => { try { if (!moveListItem(view, 1)) moveLineDown(view); } catch { /* swallow */ } return true; } },
];

/**
 * Convert a CodeMirror key ("Mod-Shift-x") to the command registry's form
 * ("Ctrl+Shift+X"), as `formatKeyCombo` in `lib/keybindings.ts` does:
 * `Mod`/`Cmd`/`Meta` become `Ctrl`, modifiers are ordered Ctrl, Shift, Alt, and
 * arrows get short names. Null for a bare key, which can't clash with a global
 * shortcut.
 */
function canonicalizeCmKey(key: string | undefined): string | null {
  if (!key) return null;
  const parts = key.split("-");
  const base = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()));
  const hasCtrl = mods.has("mod") || mods.has("ctrl") || mods.has("cmd") || mods.has("meta");
  const hasShift = mods.has("shift");
  const hasAlt = mods.has("alt") || mods.has("option");

  let k = base;
  if (k === "ArrowUp") k = "Up";
  else if (k === "ArrowDown") k = "Down";
  else if (k === "ArrowLeft") k = "Left";
  else if (k === "ArrowRight") k = "Right";
  else if (k.length === 1) k = k.toUpperCase();

  const isFKey = /^F\d{1,2}$/.test(k);
  if (!hasCtrl && !hasShift && !hasAlt && !isFKey) return null;

  const ordered: string[] = [];
  if (hasCtrl) ordered.push("Ctrl");
  if (hasShift) ordered.push("Shift");
  if (hasAlt) ordered.push("Alt");
  ordered.push(k);
  return ordered.join("+");
}

/**
 * Editor key bindings that could clash with a global shortcut, in the
 * registry's form. The shortcut settings use this to stop a global shortcut
 * being bound to an editor key such as Ctrl+B. Derived from `typstKeymap`.
 */
export function editorReservedCombos(): string[] {
  const out: string[] = [];
  for (const binding of typstKeymap) {
    const combo = canonicalizeCmKey(binding.key);
    if (combo) out.push(combo);
  }
  return out;
}
