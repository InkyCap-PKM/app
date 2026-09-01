import { type EditorView, type KeyBinding } from "@codemirror/view";
import { Facet, EditorSelection, type EditorState, type ChangeSpec, type Line, type StateEffect } from "@codemirror/state";
import { syntaxTree, foldedRanges, foldEffect } from "@codemirror/language";
import { moveLineUp, moveLineDown } from "@codemirror/commands";
import { toggleWrap } from "./wrap-format";
import { listSubtreeEndLine, leadingWhitespace } from "./list-scan";

/**
 * When true, indent/outdent of a list item also moves any nested
 * children (subsequent lines indented deeper than the current line,
 * up to the next blank line or sibling/ancestor item).
 */
export const smartIndentListsFacet = Facet.define<boolean, boolean>({
  combine: (values) => (values.length ? values[0] : false),
});

/**
 * When true, pressing Enter at the end of a paragraph line inserts a
 * Typst linebreak (`\`) before the newline, so that the next line wraps
 * as a new visual line in the rendered output instead of being collapsed
 * into a space. A second consecutive Enter still produces a paragraph
 * break — the dangling `\` from the first Enter is stripped automatically
 * before the blank line is inserted.
 *
 * Suppressed inside lists, raw/code blocks, math, and verse calls.
 *
 * This is a *visual-mode* affordance only: the editor host
 * (`createTypstEditor`) sets this facet to the user's setting while the visual
 * editor is active and to `false` in source mode. In the visual editor the
 * inserted `\` is rendered invisibly and managed as an atomic "soft break"
 * (see visual-plugin.ts), so the writer sees a real line break without ever
 * seeing or editing the `\`; in source mode Enter stays a plain newline and
 * any `\` already present shows as ordinary text.
 */
export const enterInsertsLineBreakFacet = Facet.define<boolean, boolean>({
  combine: (values) => (values.length ? values[0] : false),
});

/**
 * True when `pos` sits inside a context where a trailing `\` is literal or
 * carries its own meaning — raw/code blocks (`` `…` ``, ``` ```…``` ```),
 * math (`$…$`), or a `verse` call — so InkyCap's paragraph soft-break
 * handling must not apply. That handling is twofold and these two call sites
 * must agree on exactly which `\` count as managed paragraph breaks:
 *   - the Enter keymap here, deciding whether to auto-insert a `\`, and
 *   - the visual-mode decorations, deciding which trailing `\` to render
 *     invisibly and treat as atomic soft breaks.
 *
 * Pure tree inspection — no DOM, no doc mutation.
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
      // Read the function identifier from the source (the first child of
      // a FuncCall is the callee Ident / FieldAccess). Match the bare name
      // "verse" — qualified imports like `notebox.verse` would still match
      // on the trailing segment.
      const callee = state.doc.sliceString(node.from, Math.min(node.from + 32, node.to));
      if (/^#?(?:[\w.-]+\.)?verse\b/.test(callee)) return true;
    }
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}

/** Code-mode and control-flow node kinds that must never receive a managed
 *  paragraph soft break — a trailing `\` after any of these injects a stray
 *  line break into the compiled output. */
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
 * True when `line` is a non-prose construct that should never carry a managed
 * paragraph soft break (`\`): a code statement (`#set`, `#show`, `#let`,
 * `#import`, `#include`, control flow), a heading, or a standalone block-level
 * function call (`#image(...)`, `#figure(...)`, `#pagebreak()`, …) that fills
 * the whole line. Appending `\` to any of these injects a stray line break into
 * the compiled output — the bug where a `/`-menu insert on its own line,
 * followed by Enter, silently broke reading/export rendering.
 *
 * Shared by the Enter keymap (so it doesn't insert the `\`) and the visual-mode
 * soft-break renderer (so a pre-existing `\` on such a line shows visibly
 * instead of being hidden, surfacing already-broken source for the user to fix).
 *
 * The trailing `\` is ignored when locating the line's content bounds so the
 * rendering call site — which passes lines that still carry the `\` — inspects
 * the construct beneath it. Pure tree inspection: no DOM, no doc mutation.
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
 * Decide whether the auto-`\` linebreak should be inserted before the
 * newline produced by an Enter keypress at `pos`. Returns `false` in lists
 * (`- `, `+ `) — the list-continuation keymap handles Enter — on non-prose
 * lines (code statements, headings, standalone block calls; see
 * `lineIsNonProse`), when the line already ends with an unescaped `\`, when the
 * cursor is mid-line (a deliberate split, not a soft wrap), or inside a
 * verbatim context where a literal `\` would be wrong (see
 * `inVerbatimLineContext`).
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
  // Don't insert when the cursor is not at the end of the line content.
  // Pressing Enter mid-line is a deliberate split; the user's intent there
  // is "break this paragraph here", not "soft-wrap the rest as a new line".
  const trailing = state.doc.sliceString(pos, line.to);
  if (trailing.trim().length > 0) return false;
  return !inVerbatimLineContext(state, pos);
}

/**
 * Document position where a line's meaningful content begins: just after a list
 * marker (`- `, `+ `, `1. `) when the line is a list item, otherwise after the
 * leading indentation. Used by smart Home so the caret lands on the text, not
 * before the bullet.
 */
export function listContentStart(line: Line): number {
  const listMatch = line.text.match(/^(\s*)(?:[-+]|\d+\.)\s+/);
  if (listMatch) return line.from + listMatch[0].length;
  const ws = line.text.length - line.text.trimStart().length;
  return line.from + ws;
}

/**
 * Smart Home. Moves the caret to the start of the line's content — for a list
 * item that means just after the bullet/number, so the writer can edit the text
 * immediately without stepping past the marker. Pressing Home again (caret
 * already at content start) jumps to the true line start, before the marker — so
 * a Home-then-Shift-End selection, or an empty-selection line copy, still
 * carries the marker and the item pastes back as a complete bullet.
 *
 * `extend` mirrors the same toggle for Shift-Home, keeping the selection anchor
 * fixed. Operates on every cursor in a multi-selection.
 */
function smartLineStart(view: EditorView, extend: boolean): boolean {
  const { state } = view;
  const ranges = state.selection.ranges.map((range) => {
    const line = state.doc.lineAt(range.head);
    const cs = listContentStart(line);
    const target = range.head === cs ? line.from : cs;
    return extend
      ? EditorSelection.range(range.anchor, target)
      : EditorSelection.cursor(target);
  });
  view.dispatch({
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    scrollIntoView: true,
  });
  return true;
}

function toggleBold(state: EditorState) {
  return toggleWrap(state, "*", "*");
}

function toggleItalic(state: EditorState) {
  return toggleWrap(state, "_", "_");
}

function toggleStrikethrough(state: EditorState) {
  return toggleWrap(state, "#strike[", "]");
}

function toggleHighlight(state: EditorState) {
  return toggleWrap(state, "#highlight[", "]");
}

function toggleLink(state: EditorState) {
  // Caret lands in the empty URL slot (`#link("⎸")[…]`) so the address can be
  // typed or pasted immediately; the selected text becomes the link label.
  // Matches the toolbar link button.
  return toggleWrap(state, '#link("")[', "]", '#link("'.length);
}

function toggleInlineCode(state: EditorState) {
  return toggleWrap(state, "`", "`");
}

function toggleInlineMath(state: EditorState) {
  return toggleWrap(state, "$", "$");
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

/** The tail of a just-opened, still-empty code block, measured from the end of
 *  its opening fence: one empty body line, then the closing fence (which may be
 *  indented along with the block). Exactly what the ``` gesture produces. */
const EMPTY_FENCE_TAIL = /^\n\n[ \t]*```$/;

/**
 * Move the caret from the end of a just-opened code fence down into the
 * block's empty body line, returning true when it did.
 *
 * Whether a ` ``` ` line *opens* a block or *closes* one depends on every
 * fence above it, so the question is put to the syntax tree rather than
 * answered by counting backticks here — per CLAUDE.md's Typst-first principle,
 * and because a hand-rolled version got it wrong: the caret at the end of a
 * block's *closing* fence, with a blank line and another fence below, looked
 * identical to an opener.
 *
 * Fires only on the exact shape the ``` gesture produces — the caret at the end
 * of the line the raw block starts on, one empty body line, closing fence.
 * A body with content, an unterminated block, or a caret mid-line all fall
 * through to normal Enter.
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

  view.dispatch({ selection: { anchor: line.to + 1 }, scrollIntoView: true });
  return true;
}

function continueList(state: EditorState): { changes: ChangeSpec; selection: { anchor: number } } | null {
  const { from } = state.selection.main;
  const line = state.doc.lineAt(from);
  const text = line.text;

  // Typst's three list markers: `-` (bullet), `+` (auto-numbered), and an
  // explicit number `N.`. A trailing space (or end-of-line, for a marker the
  // user just typed) confirms it is a list item rather than prose.
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

  // Double-Enter exit, visual-mode tolerant. The first Enter on the last item
  // inserts an empty `- ` bullet below; the second is meant to end the list.
  // In the visual editor that new bullet renders as an atomic widget, and CM
  // can leave the logical cursor back on this (non-empty) item rather than on
  // the empty line — so the same-line check above never sees the empty marker.
  // Detect it on the line *below* the cursor instead: clear that empty bullet
  // and drop the caret onto the now-blank line as regular text.
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

  // The marker (`indent + marker + space`) must stay at the head of the line —
  // never split ahead of it. The cursor can legitimately sit at `line.from`:
  // the bullet's atomic replace range spans [line.from, afterMarker], so a
  // click at the start of the item's text rounds the caret to the line start.
  // Splitting there would insert the newline before the marker and leave a
  // doubled/empty bullet. Clamp to the item's content start, which makes that
  // case behave exactly like an Enter pressed at the start of the text.
  const contentStart = line.from + listMatch[0].length;
  const pos = Math.max(from, contentStart);

  const insert = `\n${indent}${nextMarker} `;
  return {
    changes: { from: pos, insert },
    selection: { anchor: pos + insert.length },
  };
}

/**
 * Plan a list indent or outdent.
 *
 * Returns an ascending-by-position list of per-line changes plus the
 * final cursor anchor. The caller should apply changes in REVERSE order,
 * one transaction per change: the codemirror-lang-typst parser uses an
 * incremental edit API that expects positions in its current tree, but
 * CodeMirror's iterChanges yields positions in the original document —
 * so packing multiple shifted changes into a single transaction
 * desynchronises the syntax tree and breaks list-marker decorations
 * downstream. Reverse order keeps each dispatched edit's position valid.
 */
function indentList(state: EditorState, direction: 1 | -1): { changes: { from: number; to?: number; insert?: string }[]; finalAnchor: number } | null {
  const { from } = state.selection.main;
  const line = state.doc.lineAt(from);
  const text = line.text;

  if (!/^\s*[-+]\s/.test(text)) return null;

  const currentIndent = text.match(/^(\s*)/)?.[1].length ?? 0;
  const smart = state.facet(smartIndentListsFacet);

  // Collect the parent line plus, when smart-indent is on, any descendant
  // lines (anything indented deeper than the parent, until a blank line
  // or a line at ≤ the parent's indent).
  const lineStarts: number[] = [line.from];
  if (smart) {
    for (let n = line.number + 1; n <= state.doc.lines; n++) {
      const nextLine = state.doc.line(n);
      if (nextLine.text.trim() === "") break;
      const nextIndent = nextLine.text.match(/^(\s*)/)?.[1].length ?? 0;
      if (nextIndent <= currentIndent) break;
      lineStarts.push(nextLine.from);
    }
  }

  if (direction === 1) {
    return {
      changes: lineStarts.map((start) => ({ from: start, insert: "  " })),
      finalAnchor: from + 2,
    };
  }

  if (currentIndent === 0) return null;
  // Remove the same byte count from every line so relative nesting is
  // preserved. Children are guaranteed to have > currentIndent leading
  // spaces (we only included lines with strictly greater indent), so they
  // can absorb the same removal.
  const remove = Math.min(2, currentIndent);
  return {
    changes: lineStarts.map((start) => ({ from: start, to: start + remove })),
    finalAnchor: from - remove,
  };
}

/**
 * Apply a planned list indent/outdent. Dispatches one transaction per
 * change in reverse document order so the Typst parser receives a
 * sequence of edits whose positions remain valid in its current tree.
 * Cursor selection is set on the final transaction, which targets the
 * parent line — the line containing the cursor.
 */
function applyIndentPlan(view: EditorView, plan: { changes: { from: number; to?: number; insert?: string }[]; finalAnchor: number }): void {
  const { changes, finalAnchor } = plan;
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i];
    const spec: ChangeSpec = "insert" in change && change.insert !== undefined
      ? { from: change.from, insert: change.insert }
      : { from: change.from, to: change.to ?? change.from };
    if (i === 0) {
      view.dispatch({ changes: spec, selection: { anchor: finalAnchor } });
    } else {
      view.dispatch({ changes: spec });
    }
  }
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
 * Start line (1-based) of the previous same-indent sibling of the item at
 * `curStart`, walking up over any blank lines and the sibling's own nested
 * subtree. Null when the item is the first child of its parent (nothing above
 * to swap with at this level).
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
 * Reorder a list item, carrying its whole nested subtree with it: a parent item
 * moves as a group, a leaf item moves alone. It swaps places with the adjacent
 * same-indent sibling's subtree (past any blank-line gap between them), keeping
 * the gap between the two blocks.
 *
 * Explicit `1. 2. 3.` numbering stays in document order — the number belongs to
 * the position, not the moved text — so only the two blocks' first-line numbers
 * are swapped back into place; `+`/`-` lists need no such fix. Nested numbering
 * inside a moved block is untouched.
 *
 * Self-contained and a single transaction: it does NOT delegate to the generic
 * move-line command, which interacted badly with the visual decoration layer
 * (the move would silently stop working after a few presses). At a list edge it
 * consumes the key without moving — never falling through to a page scroll.
 * Returns false when the cursor is not on a list item, so the caller can fall
 * back to plain line movement for ordinary prose.
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

  // Preserve folds across the move. The swap deletes and reinserts the blocks,
  // which would drop any fold on them (a collapsed parent would spring open).
  // Re-apply each fold that was inside the region at its new position: within a
  // block the content is identical apart from a possibly-changed first-line
  // number, so a fold shifts by the block's move distance plus that number's
  // length delta.
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

  view.dispatch({
    changes: { from: regionFrom, to: regionTo, insert },
    selection: { anchor: newHead },
    effects: refolds,
    scrollIntoView: true,
    userEvent: "move.line",
  });
  return true;
}

export const typstKeymap: KeyBinding[] = [
  {
    // Smart Home: first press lands on the line's text (after a list marker);
    // a second press goes to the true line start. Shift-Home extends the
    // selection along the same toggle.
    key: "Home",
    run: (view) => smartLineStart(view, false),
    shift: (view) => smartLineStart(view, true),
  },
  {
    key: "Mod-b",
    run(view) {
      const result = toggleBold(view.state);
      if (!result) return false;
      view.dispatch({ changes: result.changes, selection: result.selection });
      return true;
    },
  },
  {
    key: "Mod-i",
    run(view) {
      const result = toggleItalic(view.state);
      if (!result) return false;
      view.dispatch({ changes: result.changes, selection: result.selection });
      return true;
    },
  },
  {
    key: "Mod-Shift-x",
    run(view) {
      const result = toggleStrikethrough(view.state);
      if (!result) return false;
      view.dispatch({ changes: result.changes, selection: result.selection });
      return true;
    },
  },
  {
    key: "Mod-Shift-h",
    run(view) {
      const result = toggleHighlight(view.state);
      if (!result) return false;
      view.dispatch({ changes: result.changes, selection: result.selection });
      return true;
    },
  },
  {
    key: "Mod-k",
    run(view) {
      const result = toggleLink(view.state);
      if (!result) return false;
      view.dispatch({ changes: result.changes, selection: result.selection });
      return true;
    },
  },
  {
    key: "Mod-e",
    run(view) {
      const result = toggleInlineCode(view.state);
      if (!result) return false;
      view.dispatch({ changes: result.changes, selection: result.selection });
      return true;
    },
  },
  {
    key: "Mod-Shift-m",
    run(view) {
      const result = toggleInlineMath(view.state);
      if (!result) return false;
      view.dispatch({ changes: result.changes, selection: result.selection });
      return true;
    },
  },
  {
    key: "Ctrl-Shift-ArrowUp",
    run(view) {
      const result = adjustHeading(view.state, -1);
      if (!result) return false;
      view.dispatch({ changes: result.changes, selection: result.selection });
      return true;
    },
  },
  {
    key: "Ctrl-Shift-ArrowDown",
    run(view) {
      const result = adjustHeading(view.state, 1);
      if (!result) return false;
      view.dispatch({ changes: result.changes, selection: result.selection });
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
          // ContentBlock (the `[…]` body of any FuncCall) used to be in
          // this list, originally for the wikilink "press Enter to leave
          // the brackets" flow. With multi-line callouts and quotes now
          // editable in the visual editor, stepping out of every
          // ContentBlock on Enter breaks ordinary line breaks inside
          // those bodies. Wikilinks still work because their Args (the
          // `("name")` form) handles the step-out for the
          // closing-paren case.
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
            view.dispatch({ selection: { anchor: pos + 1 } });
            return true;
          }
        }
      }
      // Enter at the end of a freshly-opened code fence steps *into* the
      // block instead of inserting another blank line. The ``` gesture leaves
      // the caret on the fence so the language can be typed (see
      // auto-pair-typst.ts); Enter is then the natural way to start writing
      // code, and without this it would push a second empty line into a block
      // that already has one. Deliberately narrow — it only fires on the exact
      // shape that gesture produces (fence line, one empty body line, closing
      // fence), so an ordinary Enter before a blank line is untouched.
      if (stepIntoOpenFence(view)) return true;

      const listResult = continueList(view.state);
      if (listResult) {
        view.dispatch({ changes: listResult.changes, selection: listResult.selection });
        return true;
      }

      // Auto-linebreak: when enabled, transform Enter at the end of a
      // paragraph line into `\␤` so the rendered output gets an actual
      // line break. A second consecutive Enter is detected via the empty-
      // current-line + previous-line-ends-with-`\` heuristic, in which
      // case we strip the dangling `\` and insert a plain newline — the
      // resulting blank line becomes Typst's paragraph break.
      const enabled = view.state.facet(enterInsertsLineBreakFacet);
      if (!enabled) return false;
      const { from: selFrom, to: selTo } = view.state.selection.main;
      // Non-empty selections: let default Enter handle the replacement.
      if (selFrom !== selTo) return false;
      const cursor = selFrom;

      const curLine = view.state.doc.lineAt(cursor);

      // Second-Enter detection: cursor sits on an empty line whose
      // previous line ends with `\` (likely inserted by us on the
      // previous Enter). Strip that `\` and let CM insert the newline
      // normally — the now-blank line forms a paragraph break.
      if (curLine.text.length === 0 && curLine.number > 1) {
        const prevLine = view.state.doc.line(curLine.number - 1);
        const prev = prevLine.text;
        if (prev.endsWith("\\") && !prev.endsWith("\\\\")) {
          const slashFrom = prevLine.from + prev.length - 1;
          view.dispatch({
            changes: { from: slashFrom, to: slashFrom + 1, insert: "" },
            selection: { anchor: cursor - 1 },
            userEvent: "input",
          });
          // Fall through so the default Enter handler appends the newline.
          return false;
        }
      }

      if (!shouldInsertAutoLineBreak(view.state, cursor)) return false;
      view.dispatch({
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
  // Override the defaultKeymap's copyLineUp / copyLineDown bindings so that
  // Shift-Alt-Up/Down moves lines instead of duplicating them — matching the
  // behavior of plain Alt-Up/Down. Duplication is rarely the desired action
  // when the user is reordering list items.
  //
  // Always consume the key (return true) even when the move is a no-op — e.g.
  // the item is already at the top/bottom of the list or document — and even
  // if the move command throws. Without this, an unhandled (or thrown) keydown
  // falls through to the webview, which scrolls the page: to the user it looks
  // like the shortcut works "for a few moves" and then suddenly starts
  // scrolling instead of reordering. The try/catch makes that impossible.
  // List items reorder via the self-contained content-swap (reliable + keeps
  // numbering in order); ordinary lines fall back to the generic move-line
  // command. Always consume the key so it can never scroll the page.
  { key: "Shift-Alt-ArrowUp", run: (view) => { try { if (!moveListItem(view, -1)) moveLineUp(view); } catch { /* swallow: never fall through to page scroll */ } return true; } },
  { key: "Shift-Alt-ArrowDown", run: (view) => { try { if (!moveListItem(view, 1)) moveLineDown(view); } catch { /* swallow */ } return true; } },
];

/**
 * Convert a CodeMirror keymap `key` string ("Mod-Shift-x") into the command
 * registry's canonical combo form ("Ctrl+Shift+X"), matching `formatKeyCombo`
 * in `lib/keybindings.ts`. `Mod`/`Cmd`/`Meta` fold into `Ctrl`; modifiers are
 * emitted in the canonical Ctrl→Shift→Alt order; arrow keys map to short
 * names. Returns null for a bare key (no modifier, not a function key) — those
 * never normalize to a bindable global shortcut, so they can't collide.
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
 * The subset of in-editor `typstKeymap` bindings that could collide with a
 * global UI shortcut, expressed in the registry's canonical combo form. The
 * shortcut-customization conflict check consults this so a user can't rebind a
 * global shortcut onto an editor formatting key (e.g. Ctrl+B bold). Derived
 * from `typstKeymap` itself, so it stays in sync as editor bindings change.
 */
export function editorReservedCombos(): string[] {
  const out: string[] = [];
  for (const binding of typstKeymap) {
    const combo = canonicalizeCmKey(binding.key);
    if (combo) out.push(combo);
  }
  return out;
}
