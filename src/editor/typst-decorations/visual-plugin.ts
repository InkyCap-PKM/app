import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { type ChangeSet, EditorState, Facet, type Line, Prec, type Range, RangeSet, RangeValue, StateEffect, StateField, type Transaction } from "@codemirror/state";
import { expandFunc } from "./effects";
import { inVerbatimLineContext, lineIsNonProse } from "./keymaps";
import { findCallEnd } from "./pill";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { caretLineErrorMute } from "./caret-line-errors";
import {
  CalloutBlockWidget,
  CodeBlockWidget,
  ImageBlockWidget,
  MediaBlockWidget,
  BlockquoteBlockWidget,
  BlockquoteAttributionRowWidget,
  CalloutHeadRowWidget,
  BibliographyBlockWidget,
  TagWidget,
  TaskWidget,
  DueWidget,
  WikilinkWidget,
  LinkWidget,
  LabelLinkWidget,
  CitationWidget,
  ReferenceWidget,
  VerseWidget,
  FootnoteWidget,
  SuggestionWidget,
  type SuggestionKind,
  createVerseEntryKeymap,
} from "./widgets";
import { calloutColor, readCalloutColorArg } from "./callout-kinds";
import { TableWidget, editingTableRange, editingTableStarts } from "./table-widget";
import { inlineOnlyFacet, scopeRangeField } from "./cell-scope";
import { parseCanonicalTable } from "./table-parser";
import { fileList } from "../../stores/filelist";
import { getCachedBibKeys, activeReferenceSearchAt } from "./reference-suggest";
import { isEmailLikeAt } from "./reference-form";
import { scanDocumentLabels, type DocLabel } from "./document-labels";
import { FuncPillWidget, FuncChipWidget, BulletWidget, ShorthandWidget, HrWidget, AngleBracketWarningWidget, ANGLE_BRACKET_TAGS, StylePreambleWidget, SetRuleWidget, SymWidget, AnnotationPillWidget, CommentPillWidget } from "./visual-widgets";
import { symbolGlyph } from "./symbols";
import { highlight, buildHighlightMark, widgetHighlightFor, type WidgetHighlight } from "./visual-colors";
import { visualTheme } from "./visual-theme";
import { computePreambleImportRanges, noteHeaderItems } from "./note-header";
import { urlTyping } from "./url-typing";
import { commentRunAt, commentRunStartingAt, isCommentClosed, isCommentRunExpanded } from "./comments";
import { createProtectedRangesField, createProtectedCursorFilter, createProtectedChangeFilter, externalReload } from "./visual-protected";
import { lineStartCaretFilter } from "./line-start-caret";
export { externalReload } from "./visual-protected";
import { linkClickHandler } from "./visual-links";
import {
  tableClipboardHandler,
  cellEditorSync,
  tableSearchSync,
  tableScrollHandler,
  createTableEntryKeymap,
} from "./visual-tables";
import { pillBoundaryNav, createBlockBodyCaretEntry } from "./pill-boundary-nav";
import { leadingWhitespace } from "./list-scan";

/**
 * Inline formatting around the node being decorated. Replace widgets (wikilink,
 * link) render outside any mark that spans them, so they reproduce this
 * formatting themselves.
 */
export interface InlineFormatting {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  /** Null outside a `#highlight[…]`; see `WidgetHighlight`. */
  highlight: WidgetHighlight;
}

const escapedChar = Decoration.mark({ class: "cm-typst-escaped" });
const bold = Decoration.mark({ class: "cm-typst-bold" });
const italic = Decoration.mark({ class: "cm-typst-italic" });
const strikethrough = Decoration.mark({ class: "cm-typst-strike" });
// highlight imported from ./visual-colors
const underlineMark = Decoration.mark({ class: "cm-typst-underline-mark" });
const overlineMark = Decoration.mark({ class: "cm-typst-overline-mark" });
const subMark = Decoration.mark({ class: "cm-typst-sub" });
const supMark = Decoration.mark({ class: "cm-typst-sup" });
const rawInline = Decoration.mark({ class: "cm-typst-raw-inline" });
const linkMark = Decoration.mark({ class: "cm-typst-link" });
const mathInline = Decoration.mark({ class: "cm-typst-math-inline" });
const mathDisplay = Decoration.mark({ class: "cm-typst-math-display" });
const labelMark = Decoration.mark({ class: "cm-typst-label" });
const refMark = Decoration.mark({ class: "cm-typst-ref" });
const refPlainMark = Decoration.mark({ class: "cm-typst-ref-plain" });
// A standalone `@target` that matches no bibliography entry or document label,
// flagged so the writer notices it won't resolve.
const refBrokenMark = Decoration.mark({ class: "cm-typst-ref-broken" });
// An atomic widget showing a fixed glyph in place of hidden markup, such as the
// smart quotes of an inline `#quote` or the `[[` `]]` brackets of an editable
// wikilink. A widget, unlike a CSS pseudo-element, gives the caret a definite
// edge on each side.
class GlyphWidget extends WidgetType {
  constructor(private readonly glyph: string, private readonly className: string) {
    super();
  }
  eq(other: GlyphWidget) {
    return other.glyph === this.glyph && other.className === this.className;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = this.className;
    span.textContent = this.glyph;
    return span;
  }
  ignoreEvent() {
    return false;
  }
}
// Inline #quote[…] smart quotes (U+201C `“` / U+201D `”`).
const openQuote = Decoration.replace({ widget: new GlyphWidget("“", "cm-typst-quote-glyph") });
const closeQuote = Decoration.replace({ widget: new GlyphWidget("”", "cm-typst-quote-glyph") });
// Brackets that show a cursor-adjacent `#wikilink("Name", label: "L")` as
// `[[Name::L]]`. The name and label stay as editable source text.
const openWikiBracket = Decoration.replace({ widget: new GlyphWidget("[[", "cm-typst-wikilink-bracket") });
const closeWikiBracket = Decoration.replace({ widget: new GlyphWidget("]]", "cm-typst-wikilink-bracket") });
const wikiHeadingSep = Decoration.replace({ widget: new GlyphWidget("::", "cm-typst-wikilink-bracket") });
// Styling for the editable note/heading text shown between the brackets.
const wikilinkEditMark = Decoration.mark({ class: "cm-typst-wikilink-edit" });
// Body of a block `#quote` while editing. Bounded to the body so text after the
// closing `]` isn't styled as part of the quote.
const blockquoteBodyMark = Decoration.mark({ class: "cm-typst-blockquote-body" });

// `inclusiveEnd` keeps a widget at the heading's end (a wikilink's `]]`, a
// trailing `#tag`) inside the heading span, so it renders at heading size.
//
// A mark is used rather than a line decoration because the preamble's multi-line
// replace swallows the line break before the first body heading, which would
// drop a line decoration there.
const headingMarks = [
  Decoration.mark({ class: "cm-typst-h1", inclusiveEnd: true }),
  Decoration.mark({ class: "cm-typst-h2", inclusiveEnd: true }),
  Decoration.mark({ class: "cm-typst-h3", inclusiveEnd: true }),
  Decoration.mark({ class: "cm-typst-h4", inclusiveEnd: true }),
  Decoration.mark({ class: "cm-typst-h5", inclusiveEnd: true }),
  Decoration.mark({ class: "cm-typst-h6", inclusiveEnd: true }),
];

const termKey = Decoration.mark({ class: "cm-typst-term-key" });
const termSep = Decoration.mark({ class: "cm-typst-term-sep" });

const hide = Decoration.replace({});

/** Push a mark only when the range is non-empty; CM6 throws on empty marks. */
function pushMark(decos: Range<Decoration>[], mark: Decoration, from: number, to: number) {
  if (from < to) decos.push(mark.range(from, to));
}

// ── Pill system: collapsed func-call affordance ──────────

export { expandFunc } from "./effects";

export const autoExpandFacet = Facet.define<boolean, boolean>({
  combine: values => values.length > 0 ? values[values.length - 1] : false,
});

// Widget classes imported from ./visual-widgets

function cursorLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const startLine = state.doc.lineAt(r.from).number;
    const endLine = state.doc.lineAt(r.to).number;
    for (let n = startLine; n <= endLine; n++) {
      lines.add(n);
    }
  }
  return lines;
}

function isOnCursorLine(state: EditorState, from: number, to: number, focused: Set<number>): boolean {
  const len = state.doc.length;
  const clampedFrom = Math.min(from, len);
  const clampedTo = Math.min(to, len);
  const startLine = state.doc.lineAt(clampedFrom).number;
  const endLine = state.doc.lineAt(clampedTo).number;
  for (let n = startLine; n <= endLine; n++) {
    if (focused.has(n)) return true;
  }
  return false;
}

/**
 * Layout of a block content-bracket call's edit state (`#callout(...)[…]`,
 * `#quote(block: true)[…]`): which ranges are hidden with the brackets, and which
 * lines make up the editable body.
 *
 * The edit state shows only the body rows, like the rendered widget. A line break
 * right after `[` or right before a `]` on its own line is hidden with the
 * bracket. Blank lines inside the body stay visible so the caret has somewhere to
 * go. A body that is all whitespace hides only the brackets.
 */
export function blockEditLayout(
  state: EditorState,
  bodyFrom: number,
  bodyTo: number,
): { hideOpenTo: number; hideCloseFrom: number; firstLine: number; lastLine: number } {
  const body = state.doc.sliceString(bodyFrom, bodyTo);
  let s = 0;
  while (s < body.length && /\s/.test(body[s])) s++;
  let e = body.length;
  while (e > s && /\s/.test(body[e - 1])) e--;
  let hideOpenTo = bodyFrom;
  let hideCloseFrom = bodyTo;
  if (s < body.length) {
    if (body.slice(0, s).includes("\n")) hideOpenTo = bodyFrom + s;
    const trailingBreak = body.slice(e).lastIndexOf("\n");
    if (trailingBreak >= 0) hideCloseFrom = bodyFrom + e + trailingBreak;
  }
  return {
    hideOpenTo,
    hideCloseFrom,
    firstLine: state.doc.lineAt(hideOpenTo).number,
    lastLine: state.doc.lineAt(hideCloseFrom).number,
  };
}

/**
 * Per-line decorations for a block's edit state. Every line gets `className`;
 * the first and last also get `cm-typst-block-edit-first` / `-last` for the
 * outer gap and padding.
 */
function pushBlockEditLines(
  decos: Range<Decoration>[],
  state: EditorState,
  layout: { firstLine: number; lastLine: number },
  className: string,
  style?: string,
) {
  for (let ln = layout.firstLine; ln <= layout.lastLine; ln++) {
    const classes = [className];
    if (ln === layout.firstLine) classes.push("cm-typst-block-edit-first");
    if (ln === layout.lastLine) classes.push("cm-typst-block-edit-last");
    decos.push(
      Decoration.line({
        class: classes.join(" "),
        attributes: style ? { style } : undefined,
      }).range(state.doc.line(ln).from),
    );
  }
}

/**
 * Splits a fenced raw block's source into its language tag and body. The body
 * keeps every source line, blank ones included. `hasBody` tells an empty body
 * line (```\n\n```) apart from no body (```\n```).
 */
export function parseRawBlock(text: string): { lang: string; code: string; hasBody: boolean } {
  const ticks = text.match(/^`+/)?.[0].length ?? 3;
  const firstNewline = text.indexOf("\n");
  const lang = firstNewline > ticks ? text.slice(ticks, firstNewline).trim() : "";
  const codeStart = firstNewline >= 0 ? firstNewline + 1 : ticks;
  const closeAt = text.lastIndexOf("`".repeat(ticks));
  const codeEnd = closeAt >= codeStart ? closeAt : text.length;
  let code = text.slice(codeStart, codeEnd);
  if (code.endsWith("\n")) code = code.slice(0, -1);
  return { lang, code, hasBody: codeEnd > codeStart };
}

/**
 * Edit-state classes for each line of a fenced raw block. The opening and
 * closing fence lines stand in for the widget's header and footer; the lines
 * between are the code area. See the code block rules in visual-theme.ts.
 */
export function rawBlockEditLineClasses(state: EditorState, from: number, to: number): string[] {
  const open = state.doc.lineAt(from);
  const end = state.doc.lineAt(to);
  const closeIsOwnLine = end.number > open.number && /^\s*`+$/.test(state.doc.sliceString(end.from, to));
  const bodyEnd = closeIsOwnLine ? end.number - 1 : end.number;
  const out: string[] = [];
  for (let ln = open.number; ln <= end.number; ln++) {
    const classes = ["cm-typst-codeblock-edit"];
    if (ln === open.number) {
      classes.push("cm-typst-codeblock-edit--open");
    } else if (closeIsOwnLine && ln === end.number) {
      classes.push("cm-typst-codeblock-edit--close");
    } else {
      if (ln === open.number + 1) classes.push("cm-typst-codeblock-edit--first");
      if (ln === bodyEnd) classes.push("cm-typst-codeblock-edit--last");
    }
    out.push(classes.join(" "));
  }
  return out;
}

/**
 * True once an equation has a `$` at both ends. A lone `$` already parses as an
 * equation running to the end of the document, so nothing decorates it until it
 * closes.
 */
export function isClosedEquation(node: SyntaxNode): boolean {
  const open = node.firstChild;
  const close = node.lastChild;
  return open?.name === "Dollar" && close?.name === "Dollar" && open.from !== close.from;
}

function pushRawBlockEditLines(decos: Range<Decoration>[], state: EditorState, from: number, to: number) {
  const first = state.doc.lineAt(from).number;
  rawBlockEditLineClasses(state, from, to).forEach((cls, i) => {
    decos.push(Decoration.line({ class: cls }).range(state.doc.line(first + i).from));
  });
}

// Functions never followed by a trailing `[...]` body, so the call-end scan
// doesn't pick up an unrelated `[` on a later line.
const NO_TRAILING_BRACKET_FUNCS = new Set([
  "table", "note", "bibliography", "image", "video", "audio", "verse", "cite",
]);

/**
 * The true end offset of a `FuncCall`. The lezer-typst parser can end a
 * multi-line call at the first inner `)` or `]`, or run past its closing
 * bracket, so the end is found by balanced scanning from the first `(`,
 * including an optional trailing `[…]` body.
 *
 * The decoration builder and `expandRangesToBlockElements` must both use this,
 * so that incremental rebuilds always cover a whole block element.
 */
export function correctedFuncCallEnd(state: EditorState, funcFrom: number, lezerTo: number): number {
  let funcTo = lezerTo;
  const rawCheck = state.doc.sliceString(funcFrom, lezerTo);
  const hashOff = rawCheck.startsWith("#") ? 1 : 0;
  const firstParen = rawCheck.indexOf("(", hashOff);
  if (firstParen < 0) return funcTo;

  let parenDepth = 0;
  let bracketDepth = 0;
  let inStr = false;
  let balanced = false;
  let realEnd = -1;
  const scanStart = funcFrom + firstParen;
  const scanEnd = Math.min(funcFrom + 50000, state.doc.length);
  const scanText = state.doc.sliceString(scanStart, scanEnd);
  for (let i = 0; i < scanText.length; i++) {
    const ch = scanText[i];
    if (ch === '"' && (i === 0 || scanText[i - 1] !== "\\")) { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "(") parenDepth++;
    else if (ch === ")") {
      parenDepth--;
      if (parenDepth === 0 && bracketDepth === 0) {
        realEnd = scanStart + i + 1;
        const fnm = rawCheck.match(/^#?(\w[\w-]*)/);
        const fnb = fnm ? fnm[1] : null;
        if (!fnb || !NO_TRAILING_BRACKET_FUNCS.has(fnb)) {
          const after = state.doc.sliceString(realEnd, Math.min(realEnd + 100, state.doc.length));
          const trimmed = after.trimStart();
          if (trimmed.startsWith("[")) {
            const bStart = realEnd + (after.length - trimmed.length);
            const bScan = state.doc.sliceString(bStart, Math.min(bStart + 50000, state.doc.length));
            // Treat brackets inside inline raw or behind `\` as literal, so a
            // `[[` in backticks inside a callout body doesn't move the call's
            // end.
            const bClose = matchContentBracket(bScan, 0, bScan.length);
            if (bClose >= 0) realEnd = bStart + bClose + 1;
          }
        }
        balanced = true;
        break;
      }
    } else if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth--;
  }
  if (balanced && realEnd > funcTo) funcTo = realEnd;
  return funcTo;
}

/**
 * Position of the managed soft break at the end of `line` (a single unescaped
 * trailing `\` outside verbatim text), or null. The visual editor inserts it on
 * Enter and renders it invisibly (see `enterInsertsLineBreakFacet`); source
 * mode shows it as text. The verbatim check is shared with the Enter keymap so
 * both agree on which `\` are managed breaks.
 */
function softBreakSlashPos(state: EditorState, line: Line): number | null {
  const text = line.text;
  if (text.length === 0 || text[text.length - 1] !== "\\") return null;
  // An escaped backslash (`…\\`) is literal content, not a line break.
  if (text.length >= 2 && text[text.length - 2] === "\\") return null;
  const slashPos = line.from + text.length - 1;
  if (inVerbatimLineContext(state, slashPos)) return null;
  // A `\` after a code statement, heading or block call isn't a managed break;
  // leave it visible so the writer can fix it.
  if (lineIsNonProse(state, line)) return null;
  return slashPos;
}

function cursorPositions(state: EditorState): Set<number> {
  const positions = new Set<number>();
  for (const r of state.selection.ranges) {
    positions.add(r.head);
  }
  return positions;
}

function isCursorAdjacentOrInside(_state: EditorState, from: number, to: number, cursors: Set<number>): boolean {
  for (const pos of cursors) {
    if (pos >= from && pos <= to) return true;
  }
  return false;
}

/**
 * True when collapsing a call into a widget that replaces its whole range would
 * swallow the caret. `closeBrackets()` inserts `)` as soon as `(` is typed, so
 * a half-written `#figure(` is already a complete call; collapsing it would
 * hide it before the arguments are typed (issue #20).
 *
 * The check is by caret proximity rather than by line, so surrounding prose
 * isn't revealed. Every branch of {@link handleFuncCall} that replaces a call's
 * full range must check this first.
 */
function collapseWouldSwallowCaret(
  state: EditorState,
  from: number,
  to: number,
  cursors: Set<number>,
): boolean {
  return isCursorAdjacentOrInside(state, from, to, cursors);
}

function nodeOverlapsRanges(from: number, to: number, ranges: { from: number; to: number }[]): boolean {
  for (const r of ranges) {
    if (from < r.to && to > r.from) return true;
  }
  return false;
}

type StylePreamble = { from: number; to: number; count: number };

/**
 * The leading run of `#set` / `#show` / `#let` rules (the document's style
 * preamble) as a line-aligned range with its rule count, or null. Imports and
 * the `#note(...)` call may come first; any other content before the first rule
 * means there is no preamble. Comments are skipped. A `#set` after content is a
 * local style change and is left alone.
 */
export function findStylePreamble(state: EditorState): StylePreamble | null {
  let firstFrom = -1;
  let lastTo = -1;
  let count = 0;
  let sawNote = false;
  for (const item of noteHeaderItems(state)) {
    if (item.kind === "comment") continue;
    const isRule =
      item.kind === "set" || item.kind === "show" || item.kind === "let" || item.kind === "locale";
    if (isRule) {
      // A language directive before `#note(...)` is hidden with the imports
      // (see `computePreambleImportRanges`), so it neither starts nor joins the
      // preamble chip. After the note, or once the run has started, it is
      // ordinary setup.
      if (firstFrom < 0 && !sawNote && item.kind === "locale") continue;
      if (firstFrom < 0) firstFrom = item.from;
      lastTo = item.to;
      count++;
      continue;
    }
    if (firstFrom >= 0) break; // the run is over
    if (item.kind === "import") continue;
    if (item.kind === "note") {
      sawNote = true;
      continue;
    }
    return null; // some other leading construct — no collapsible preamble
  }
  if (firstFrom < 0) return null;
  return {
    from: state.doc.lineAt(firstFrom).from,
    to: state.doc.lineAt(Math.min(lastTo, state.doc.length)).to,
    count,
  };
}

function posWithinPreamble(pos: number, preamble: StylePreamble): boolean {
  return pos >= preamble.from && pos < preamble.to;
}

/**
 * Top-level named-argument keys of the argument list opening at `openParen`.
 * Nested keys and positional arguments are skipped, and strings are opaque.
 */
function topLevelArgKeys(text: string, openParen: number): string[] {
  if (openParen < 0 || text[openParen] !== "(") return [];
  const keys: string[] = [];
  let depth = 0;
  let inStr = false;
  let atArgStart = false; // at the start of a fresh top-level argument
  for (let i = openParen; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '"' && text[i - 1] !== "\\") inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      if (depth === 1) atArgStart = true; // just opened the arg list
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1 && ch === ",") { atArgStart = true; continue; }
    if (depth === 1 && atArgStart) {
      if (/\s/.test(ch)) continue;
      const m = text.slice(i).match(/^([A-Za-z_][\w-]*)\s*:/);
      if (m) keys.push(m[1]);
      atArgStart = false; // value chars (incl. nested calls) skipped until next `,`
    }
  }
  return keys;
}

/**
 * Chip label for a standalone `#set` / `#show` rule: the keyword, target and up
 * to two configured keys, e.g. `#set text(size: 12pt)` → `set text: size`. Falls
 * back to keyword and target, or just the keyword. Not translated, since Typst
 * identifiers aren't.
 */
export function setRuleLabel(raw: string): string {
  const body = raw.startsWith("#") ? raw.slice(1) : raw;
  const setRule = body.match(/^set\s+([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)\s*(\()/);
  if (setRule) {
    const target = setRule[1];
    const keys = topLevelArgKeys(body, body.indexOf("(", setRule.index! + setRule[0].length - 1));
    if (keys.length === 0) return `set ${target}`;
    const shown = keys.slice(0, 2).join(", ") + (keys.length > 2 ? "…" : "");
    return `set ${target}: ${shown}`;
  }
  const withTarget = body.match(/^(set|show)\s+([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)/);
  if (withTarget) return `${withTarget[1]} ${withTarget[2]}`;
  const keyword = body.match(/^(set|show)\b/);
  return keyword ? keyword[1] : "set";
}

/**
 * Display number for an ordered-list item, computed from the document text
 * alone so it is the same in full and partial rebuilds. An explicit number
 * (`1.`) is shown as typed; a `+` item counts the run of same-indent items
 * above it.
 */
function enumItemNumber(state: EditorState, markerFrom: number): string {
  const line = state.doc.lineAt(markerFrom);
  // Take the indent from the line text: just after an edit, the tree may still
  // hold the marker's old position.
  const indent = leadingWhitespace(line.text);
  const explicit = line.text.slice(indent).match(/^(\d+)\./);
  if (explicit) return `${explicit[1]}.`;

  // Count the `+` item's position with the same rules as list-renumber.ts, so
  // the number matches the source and Typst's output.
  let count = 1;
  for (let n = line.number - 1; n >= 1; n--) {
    const text = state.doc.line(n).text;
    if (text.trim() === "") continue;   // blank line — a loose list is one list
    const m = text.match(/^(\s*)(\+|\d+\.)(?:\s|$)/);
    if (!m) {
      if (leadingWhitespace(text) > indent) continue; // wrapped item text
      break;                            // prose (or a bullet) ends the list
    }
    const prevIndent = m[1].length;
    if (prevIndent < indent) break;     // parent level — our run starts below it
    if (prevIndent > indent) continue;  // nested child — does not affect our number
    const anchored = m[2].match(/^(\d+)\./);
    if (anchored) return `${Number(anchored[1]) + count}.`;
    count++;
  }
  return `${count}.`;
}

/**
 * Extra left padding per leading column of a list item, in `ch`, so nesting
 * levels are easy to tell apart. Display only; the source is unchanged.
 *
 * The line's `padding-left` (nesting plus one bullet width) aligns wrapped lines
 * with the item text. The bullet widget's negative `margin-left` (see
 * `.cm-typst-list-bullet`) pulls the bullet back into that space. A negative
 * `text-indent` on the line isn't used because WebKitGTK doesn't apply it
 * reliably to a leading inline-block.
 */
const LIST_INDENT_CH = 1.2;

/**
 * Whether a list/enum marker is followed by the space or tab that makes it a
 * Typst list item. A bare marker is left undecorated until the space is typed.
 */
function markerHasSeparator(state: EditorState, node: { to: number }): boolean {
  return /^[ \t]/.test(state.doc.sliceString(node.to, node.to + 1));
}

/**
 * Whether a list/enum marker opens its line. A second marker further along (`-
 * - item`) stays plain text, so a stray marker left by an edit is visible and
 * can be deleted.
 */
function markerOpensLine(state: EditorState, node: { from: number }): boolean {
  const line = state.doc.lineAt(node.from);
  return state.doc.sliceString(line.from, node.from).trim() === "";
}

/**
 * The range the bullet/number widget replaces: from the line start through
 * the marker's single separating space, so the item text begins right after
 * the bullet and wrapped lines align with it. Only one space is included, so
 * further spaces the writer types stay visible.
 */
function markerReplaceRange(
  state: EditorState,
  node: { from: number; to: number },
): [number, number] {
  const lineFrom = state.doc.lineAt(node.from).from;
  // Callers only reach here for markers that have a separator and open their
  // line (see the ListMarker/EnumMarker cases), so the separator space is
  // always folded in and everything back to the line start is whitespace.
  return [lineFrom, node.to + (markerHasSeparator(state, node) ? 1 : 0)];
}

/**
 * Indentation, in characters, that counts as zero for list items in `range`.
 * Inside a table cell, the cell's own indentation within the `#table(...)` call
 * isn't nesting, so the shallowest line of the cell is the baseline. Outside a
 * cell it is zero. Only lines that begin inside the range count.
 */
function listIndentBase(state: EditorState, range: { from: number; to: number } | null): number {
  if (!range) return 0;
  const { doc } = state;
  const first = doc.lineAt(range.from).number;
  const last = doc.lineAt(range.to).number;
  let base = Infinity;
  for (let n = first; n <= last; n++) {
    const line = doc.line(n);
    if (line.from < range.from) continue; // shared with the opening `[`
    const text = doc.sliceString(line.from, Math.min(line.to, range.to));
    if (text.trim() === "") continue; // blank lines carry no indentation
    base = Math.min(base, text.length - text.trimStart().length);
  }
  return base === Infinity ? 0 : base;
}

function pushListIndent(
  decos: Range<Decoration>[],
  state: EditorState,
  markerFrom: number,
  baseCols: number,
) {
  const line = state.doc.lineAt(markerFrom);
  // Leading-whitespace width, in chars, less whatever indentation the item
  // sits in for reasons that aren't nesting (see `listIndentBase`).
  const cols = Math.max(0, markerFrom - line.from - baseCols);
  const nest = cols > 0 ? `${(cols * LIST_INDENT_CH).toFixed(2)}ch + ` : "";
  decos.push(
    Decoration.line({
      attributes: {
        // `padding-left` sets the text column; the bullet's negative margin
        // pulls it back for the hanging indent. `--line-block-inset` keeps a
        // block quote or callout's inset for a list inside one.
        style: `padding-left: calc(var(--line-block-inset, 0px) + ${nest}var(--list-bullet-width))`,
      },
    }).range(line.from),
  );
}

/**
 * Draw a list item's marker as a bullet or number with a hanging indent. Draws
 * nothing and returns false when the marker has been revealed as source (by
 * Home or Left at the item start; see `smartLineStart` and
 * `lineStartCaretFilter`).
 */
function pushListMarker(
  decos: Range<Decoration>[],
  state: EditorState,
  node: { from: number; to: number },
  baseCols: number,
  expandedPos: number | null,
  label: string,
): boolean {
  const [from, to] = markerReplaceRange(state, node);
  if (expandedPos === from) return false;
  pushListIndent(decos, state, node.from, baseCols);
  decos.push(Decoration.replace({ widget: new BulletWidget(label) }).range(from, to));
  return true;
}

/**
 * Build the visual layer's decoration set for `state`. Exported for tests; the
 * editor uses it through `typstVisualMode()`.
 */
export function buildDecorations(
  state: EditorState,
  onlyRanges?: { from: number; to: number }[],
  options?: { inlineOnly?: boolean },
): DecorationSet {
  // Inline-only mode (table cells): block constructs stay raw markup (see
  // cell-scope.ts). A cell editor also limits the build to its own range.
  const inlineOnly = options?.inlineOnly === true || state.facet(inlineOnlyFacet);
  if (!options?.inlineOnly && state.facet(inlineOnlyFacet)) {
    const scope = state.field(scopeRangeField, false);
    if (scope) onlyRanges = [scope];
  }
  // A cell's own source indentation is not list nesting (see below).
  const listBase = listIndentBase(state, inlineOnly && onlyRanges?.length === 1 ? onlyRanges[0] : null);
  const focused = cursorLines(state);
  const cursors = cursorPositions(state);
  const autoExpand = state.facet(autoExpandFacet);
  const expandedPos = state.field(expandedFuncField, false) ?? null;
  const decos: Range<Decoration>[] = [];

  // The style preamble collapses to one chip unless the cursor is inside it or
  // it was expanded. Its inner nodes are then skipped.
  const stylePreamble = findStylePreamble(state);
  const stylePreambleCollapsed = stylePreamble
    ? !isOnCursorLine(state, stylePreamble.from, stylePreamble.to, focused)
      && expandedPos !== stylePreamble.from
    : false;
  if (
    stylePreamble &&
    stylePreambleCollapsed &&
    (!onlyRanges || nodeOverlapsRanges(stylePreamble.from, stylePreamble.to, onlyRanges))
  ) {
    // Inline replace spanning the block's lines; the widget's root is
    // block-level, so it takes its own line.
    decos.push(
      Decoration.replace({
        widget: new StylePreambleWidget(stylePreamble.from, stylePreamble.to, stylePreamble.count),
      }).range(stylePreamble.from, stylePreamble.to),
    );
  }

  const escapeRanges = new Set<string>();
  const escapeDecos: { from: number; backslashEnd: number; charEnd: number }[] = [];
  const activeFormatting: InlineFormatting = { bold: false, italic: false, strike: false, highlight: null };
  let consumedUntil = -1;

  // Document labels, computed on the first `@reference`. They cover the whole
  // document, since a reference can point at a label outside the ranges being
  // rebuilt.
  let docLabelMap: Map<string, DocLabel> | null = null;
  const getDocLabelMap = (): Map<string, DocLabel> => {
    if (!docLabelMap) {
      docLabelMap = new Map();
      for (const l of scanDocumentLabels(state)) docLabelMap.set(l.name, l);
    }
    return docLabelMap;
  };

  // Hide the leading imports (the notebox import and any package imports) so
  // the visual editor opens on the body. They remain in the source editor;
  // `computeProtectedRanges` locks the same ranges.
  const preambleImportRanges = computePreambleImportRanges(state);
  for (const r of preambleImportRanges) {
    if (!onlyRanges || nodeOverlapsRanges(r.from, r.to, onlyRanges)) {
      decos.push(hide.range(r.from, r.to));
    }
  }

  syntaxTree(state).iterate({
    from: onlyRanges ? onlyRanges[0].from : 0,
    to: onlyRanges ? onlyRanges[onlyRanges.length - 1].to : state.doc.length,
    enter(node) {
        if (node.from > state.doc.length || node.to > state.doc.length) return;
        if (node.from < consumedUntil) return false;
        if (onlyRanges && !nodeOverlapsRanges(node.from, node.to, onlyRanges)) return;
        // Inside a collapsed style preamble: the chip replaces the whole range,
        // so don't render its inner markup.
        if (stylePreamble && stylePreambleCollapsed && posWithinPreamble(node.from, stylePreamble)) {
          return false;
        }
        const onCursor = isOnCursorLine(state, node.from, node.to, focused);

        switch (node.name) {
          case "LineComment":
          case "BlockComment": {
            // A run of comment lines collapses to one pill; clicking it reveals
            // the run. An unclosed `/*` stays visible until it is closed.
            if (!isCommentClosed(state, node.name, node.from, node.to)) return false;
            const run = commentRunAt(state, node.from, node.to);
            consumedUntil = Math.max(consumedUntil, run.replaceTo);
            if (isCommentRunExpanded(run, expandedPos)) return false;
            decos.push(
              Decoration.replace({
                widget: new CommentPillWidget(run, state.doc.sliceString(run.from, run.to)),
              }).range(run.replaceFrom, run.replaceTo),
            );
            return false;
          }
          // `*bold*` / `_italic_`: the delimiters are hidden unless the caret
          // is inside. The body keeps its mark and is still traversed, so
          // nested calls (`*a #highlight[b] c*`) keep their own decorations.
          case "Strong": {
            if (autoExpand && onCursor) return false;
            activeFormatting.bold = true;
            if (!isCursorAdjacentOrInside(state, node.from, node.to, cursors)) {
              decos.push(hide.range(node.from, node.from + 1));
              decos.push(hide.range(node.to - 1, node.to));
            }
            pushMark(decos, bold, node.from + 1, node.to - 1);
            break;
          }
          case "Emph": {
            if (autoExpand && onCursor) return false;
            activeFormatting.italic = true;
            if (!isCursorAdjacentOrInside(state, node.from, node.to, cursors)) {
              decos.push(hide.range(node.from, node.from + 1));
              decos.push(hide.range(node.to - 1, node.to));
            }
            pushMark(decos, italic, node.from + 1, node.to - 1);
            break;
          }
          case "Escape": {
            if (isCursorAdjacentOrInside(state, node.from, node.to, cursors)) return false;
            if (autoExpand && onCursor) return false;
            if (node.to - node.from >= 2) {
              escapeRanges.add(`${node.from}:${node.to}`);
              decos.push(hide.range(node.from, node.from + 1));
              decos.push(escapedChar.range(node.from + 1, node.to));
            }
            return false;
          }
          case "Heading": {
            const text = state.doc.sliceString(node.from, node.to);
            const eqMatch = text.match(/^(=+)\s*/);
            if (!eqMatch) return false;
            const eqCount = eqMatch[1].length;
            const level = Math.min(eqCount, 6) - 1;
            const contentStart = node.from + eqMatch[0].length;
            if (contentStart > node.from && contentStart <= node.to) {
              if (!onCursor) {
                decos.push(hide.range(node.from, contentStart));
              }
              decos.push(headingMarks[level].range(node.from, node.to));
            }
            break;
          }
          case "ListMarker": {
            // Render a bullet only once the marker is followed by a space, so a
            // bare `-` doesn't look like a list before it is one.
            if (!markerHasSeparator(state, node) || !markerOpensLine(state, node)) break;
            if (!pushListMarker(decos, state, node, listBase, expandedPos, "•")) break;
            return false;
          }
          case "EnumMarker": {
            if (!markerHasSeparator(state, node) || !markerOpensLine(state, node)) break;
            if (!pushListMarker(decos, state, node, listBase, expandedPos, enumItemNumber(state, node.from))) break;
            return false;
          }
          case "Raw": {
            const text = state.doc.sliceString(node.from, node.to);
            const ticks = text.match(/^`+/)?.[0].length ?? 1;
            // Typst only lays out a three-backtick raw as a block when its
            // content spans a line break; a one-line ```…``` is inline raw.
            const isBlock = ticks >= 3 && text.includes("\n");
            if (!isBlock) {
              // An unclosed backtick already parses as raw. Hide the delimiters
              // only once a matching closing run exists, so a just-typed
              // backtick doesn't vanish.
              const closed = text.length >= 2 * ticks && text.endsWith("`".repeat(ticks));
              if (!closed) return false;
              if (isCursorAdjacentOrInside(state, node.from, node.to, cursors)) return false;
              if (autoExpand && onCursor) return false;
              decos.push(hide.range(node.from, node.from + ticks));
              decos.push(hide.range(node.to - ticks, node.to));
              pushMark(decos, rawInline, node.from + ticks, node.to - ticks);
            } else {
              if (isCursorAdjacentOrInside(state, node.from, node.to, cursors)) {
                pushRawBlockEditLines(decos, state, node.from, node.to);
                return false;
              }
              const block = parseRawBlock(text);
              decos.push(
                Decoration.replace({
                  widget: new CodeBlockWidget(block.lang, block.code, block.hasBody),
                }).range(node.from, node.to),
              );
            }
            return false;
          }
          case "Equation": {
            // A lone `$` already parses as an equation running to the end of
            // the document, so wait for a matched pair. A matched pair can
            // still span several lines (a new `$` pairs with the next
            // equation's opener), which is why the math marks only change
            // colour and font.
            if (!isClosedEquation(node.node)) return false;
            // With the caret inside, show an equation as plain source, so a
            // half-typed one doesn't tint the text below it.
            if (isCursorAdjacentOrInside(state, node.from, node.to, cursors)) return false;
            if (autoExpand && onCursor) return false;
            // An equation is set as a block only with a space inside both
            // delimiters (`$ x $`), matching `Equation::block()` in
            // typst-syntax.
            const isDisplay =
              node.node.firstChild?.nextSibling?.name === "Space" &&
              node.node.lastChild?.prevSibling?.name === "Space";
            if (isDisplay) {
              decos.push(mathDisplay.range(node.from, node.to));
            } else {
              decos.push(hide.range(node.from, node.from + 1));
              decos.push(hide.range(node.to - 1, node.to));
              pushMark(decos, mathInline, node.from + 1, node.to - 1);
            }
            return false;
          }
          case "Link": {
            decos.push(linkMark.range(node.from, node.to));
            return false;
          }
          case "Label": {
            const parent = node.node.parent;
            if (parent?.name === "Heading" && !onCursor) {
              let hideFrom = node.from;
              if (hideFrom > 0 && state.doc.sliceString(hideFrom - 1, hideFrom) === " ") {
                hideFrom--;
              }
              decos.push(hide.range(hideFrom, node.to));
            } else {
              decos.push(labelMark.range(node.from, node.to));
            }
            return false;
          }
          case "Ref": {
            const refText = state.doc.sliceString(node.from, node.to);
            if (refText.startsWith("@")) {
              // `@` refers either to a bibliography entry or to a document
              // `<label>`; check both.
              const key = refText.slice(1);
              const bibKeys = getCachedBibKeys();
              const label = getDocLabelMap().get(key);
              // An unresolved `@` after an email local part (`athena@inkycap.org`) is
              // an address, not a reference (the same rule the `@` popup and compile
              // pipeline use). It is marked as plain text even under the caret, so it
              // isn't highlighted as a reference while being typed.
              const before = node.from > 0 ? state.doc.sliceString(node.from - 1, node.from) : "";
              if (isEmailLikeAt(before) && !bibKeys.has(key) && !label) {
                decos.push(refPlainMark.range(node.from, node.to));
                return false;
              }
              if (isCursorAdjacentOrInside(state, node.from, node.to, cursors)) return false;
              // Leave the `@…` of an active citation search as plain text, so a
              // multi-word query doesn't look resolved.
              if (activeReferenceSearchAt() === node.from) return false;
              if (bibKeys.has(key)) {
                decos.push(
                  Decoration.replace({
                    widget: new CitationWidget(key, node.from, node.to),
                    inclusiveStart: false,
                    inclusiveEnd: false,
                  }).range(node.from, node.to),
                );
              } else if (label) {
                decos.push(
                  Decoration.replace({
                    widget: new ReferenceWidget(key, label.kind, label.display, node.from, node.to),
                    inclusiveStart: false,
                    inclusiveEnd: false,
                  }).range(node.from, node.to),
                );
              } else if (bibKeys.size === 0) {
                // Bibliography not loaded yet: render as a citation so it
                // doesn't flash as broken.
                decos.push(
                  Decoration.replace({
                    widget: new CitationWidget(key, node.from, node.to),
                    inclusiveStart: false,
                    inclusiveEnd: false,
                  }).range(node.from, node.to),
                );
              } else {
                // A standalone reference that resolves to nothing — flag it so
                // the writer sees it won't compile.
                decos.push(refBrokenMark.range(node.from, node.to));
              }
            } else {
              if (isCursorAdjacentOrInside(state, node.from, node.to, cursors)) return false;
              decos.push(refMark.range(node.from, node.to));
            }
            return false;
          }
          case "TermMarker": {
            if (isCursorAdjacentOrInside(state, node.from, node.to, cursors)) return false;
            if (autoExpand && onCursor) return false;
            const line = state.doc.lineAt(node.from);
            const lineText = line.text;
            const colonIdx = lineText.indexOf(":", node.to - line.from);
            if (colonIdx >= 0) {
              const colonAbs = line.from + colonIdx;
              decos.push(hide.range(node.from, node.to));
              pushMark(decos, termKey, node.to, colonAbs);
              decos.push(termSep.range(colonAbs, colonAbs + 1));
            } else {
              decos.push(hide.range(node.from, node.to));
              pushMark(decos, termKey, node.to, line.to);
            }
            return false;
          }
          case "Shorthand": {
            if (isCursorAdjacentOrInside(state, node.from, node.to, cursors)) return false;
            if (autoExpand && onCursor) return false;
            const text = state.doc.sliceString(node.from, node.to);
            let replacement: string | null = null;
            // `ghost` shows a faint placeholder for non-printing shorthands,
            // such as a soft hyphen.
            let ghost = false;
            if (text === "---") replacement = "—";
            else if (text === "--") replacement = "–";
            else if (text === "~") replacement = " ";
            else if (text === "...") replacement = "…";
            else if (text === "-?") { replacement = "-"; ghost = true; }
            if (replacement !== null) {
              decos.push(
                Decoration.replace({
                  widget: new ShorthandWidget(replacement, text, ghost),
                }).range(node.from, node.to),
              );
            }
            return false;
          }
          case "SmartQuote": {
            return false;
          }
          case "FieldAccess": {
            // `#sym.*` renders as a glyph pill. The `#` is a separate node, so
            // a sym reference is a FieldAccess preceded by `#`; only the
            // outermost one is handled. Other field accesses render as raw
            // source.
            if (node.from > 0 && state.doc.sliceString(node.from - 1, node.from) === "#") {
              const text = state.doc.sliceString(node.from, node.to);
              if (text.startsWith("sym.")) {
                const hashFrom = node.from - 1;
                if (isCursorAdjacentOrInside(state, hashFrom, node.to, cursors)) return false;
                if (autoExpand && onCursor) return false;
                const path = text.slice(4);
                decos.push(
                  Decoration.replace({
                    widget: new SymWidget(hashFrom, node.to, path, symbolGlyph(path)),
                  }).range(hashFrom, node.to),
                );
                return false;
              }
            }
            return;
          }
          case "SetRule":
          case "ShowRule": {
            // Rules in the leading style preamble are handled by its chip. A
            // set/show rule after content (e.g. inserted from the `/` Style
            // menu) gets the usual pill.
            if (stylePreamble && posWithinPreamble(node.from, stylePreamble)) return false;
            // A leading language directive is hidden with the imports (see
            // computePreambleImportRanges). A later `#set text(lang: …)` is a
            // style change and gets its pill.
            if (preambleImportRanges.some((r) => node.from >= r.from && node.from < r.to)) return false;
            const ruleFrom = (node.from > 0 && state.doc.sliceString(node.from - 1, node.from) === "#")
              ? node.from - 1 : node.from;
            // Show raw source when the cursor is on the rule's line or the pill
            // was expanded.
            if (onCursor) return false;
            if (expandedPos === ruleFrom) return false;
            const raw = state.doc.sliceString(ruleFrom, node.to);
            decos.push(
              Decoration.replace({
                widget: new SetRuleWidget(ruleFrom, node.to, setRuleLabel(raw), raw),
              }).range(ruleFrom, node.to),
            );
            return false;
          }
          case "FuncCall": {
            const funcFrom = (node.from > 0 && state.doc.sliceString(node.from - 1, node.from) === "#")
              ? node.from - 1 : node.from;
            const lastChar = state.doc.sliceString(node.to - 1, node.to);
            if (lastChar !== ")" && lastChar !== "]") return false;
            // `node.to` can be short for multi-line calls (see
            // `correctedFuncCallEnd`); use the corrected end so the edit state
            // stays stable and matches the dirty-range expander.
            const funcTo = correctedFuncCallEnd(state, funcFrom, node.to);
            const callOnCursor = isOnCursorLine(state, funcFrom, funcTo, focused);
            const fn = funcCallName(state.doc.sliceString(funcFrom, funcTo));
            // Inline-only: a block call keeps its raw markup, and its body is
            // still traversed.
            if (inlineOnly && fn !== null && BLOCK_LEVEL_FUNCS.has(fn)) break;
            // Decorate each call defensively: a malformed call must not throw and
            // drop the whole visual layer. On failure, discard its partial
            // decorations and leave it as raw source.
            const decoMark = decos.length;
            let traverseChildren: boolean;
            try {
              traverseChildren = handleFuncCall(state, funcFrom, funcTo, decos, callOnCursor, cursors, autoExpand, expandedPos, activeFormatting);
            } catch (err) {
              decos.length = decoMark;
              console.error("visual-plugin: skipped a function call that failed to decorate", err);
              if (funcTo > node.to) consumedUntil = funcTo;
              return false;
            }
            if (!traverseChildren) {
              if (funcTo > node.to) consumedUntil = funcTo;
              return false;
            }
            if (fn === "strike") activeFormatting.strike = true;
            else if (fn === "highlight") {
              // Carry the highlight's fill/stroke/radius: a wikilink or link
              // inside renders as a replace widget outside the mark and paints
              // itself.
              activeFormatting.highlight = widgetHighlightFor(state.doc.sliceString(funcFrom, funcTo));
            }
            else if (fn === "strong") activeFormatting.bold = true;
            else if (fn === "emph") activeFormatting.italic = true;
            break;
          }
        }
    },
    leave(node) {
      if (node.name === "Strong") activeFormatting.bold = false;
      if (node.name === "Emph") activeFormatting.italic = false;
      if (node.name === "FuncCall") {
        activeFormatting.strike = false;
        activeFormatting.highlight = null;
      }
    },
  });

  // Text-level escape scan, for escapes the parser doesn't emit as Escape nodes
  // (e.g. `\#`). `escapeRanges` prevents doubles.
  const ESCAPE_CHARS = "#*_$=~`\\";
  const escScanLines = onlyRanges
    ? onlyRanges.flatMap(r => {
        const lines: number[] = [];
        const startLine = state.doc.lineAt(r.from).number;
        const endLine = state.doc.lineAt(Math.min(r.to, state.doc.length)).number;
        for (let n = startLine; n <= endLine; n++) lines.push(n);
        return lines;
      })
    : Array.from({ length: state.doc.lines }, (_, i) => i + 1);
  // The tree doesn't change during this scan.
  const escTree = syntaxTree(state);
  for (const i of escScanLines) {
    const line = state.doc.line(i);
    if (autoExpand && isOnCursorLine(state, line.from, line.to, focused)) continue;
    // Skip lines hidden behind the collapsed style-preamble chip.
    if (stylePreamble && stylePreambleCollapsed && posWithinPreamble(line.from, stylePreamble)) continue;
    const text = line.text;
    let idx = text.indexOf("\\");
    while (idx >= 0 && idx < text.length - 1) {
      const nextChar = text[idx + 1];
      if (ESCAPE_CHARS.includes(nextChar)) {
        const absFrom = line.from + idx;
        const key = `${absFrom}:${absFrom + 2}`;
        // A `\` inside raw/code/comment/string is literal content, not an
        // escape — leave it visible (e.g. the lone backslash in `` `\` ``).
        if (!escapeRanges.has(key) && !posInsideRawOrCode(escTree, absFrom)) {
          escapeDecos.push({ from: absFrom, backslashEnd: absFrom + 1, charEnd: absFrom + 2 });
        }
      }
      idx = text.indexOf("\\", idx + 2);
    }
  }
  if (escapeDecos.length > 0) {
    const takenPositions = new Set<number>();
    for (const d of decos) {
      if (d.from < d.to && (d.value === hide || d.value.spec?.widget != null)) {
        for (let p = d.from; p < d.to; p++) takenPositions.add(p);
      }
    }
    for (const esc of escapeDecos) {
      if (!takenPositions.has(esc.from)) {
        decos.push(hide.range(esc.from, esc.backslashEnd));
        pushMark(decos, escapedChar, esc.backslashEnd, esc.charEnd);
      }
    }
  }

  // Always hide a trailing `\` soft break in visual mode, even on the cursor
  // line. The `\␤` pair is atomic (see `softBreakRangesField`), so the writer
  // edits across the break without landing inside it.
  for (const i of escScanLines) {
    const line = state.doc.line(i);
    const slashPos = softBreakSlashPos(state, line);
    if (slashPos === null) continue;
    decos.push(hide.range(slashPos, slashPos + 1));
  }

  if (!onlyRanges) {
    // Detect bare HTML-like tags (e.g. <script>) that are ambiguous in Typst
    const docText = state.doc.toString();
    // Reuse the tree fetched for the escape scan above — invariant across both.
    const tree = escTree;
    let match: RegExpExecArray | null;
    ANGLE_BRACKET_TAGS.lastIndex = 0;
    while ((match = ANGLE_BRACKET_TAGS.exec(docText)) !== null) {
      const pos = match.index;
      let inCode = false;
      tree.iterate({
        from: pos,
        to: pos + 1,
        enter(node) {
          if (node.name === "Raw" || node.name === "RawBlock" || node.name === "CodeBlock"
              || node.name === "Comment" || node.name === "String") {
            inCode = true;
            return false;
          }
        },
      });
      if (inCode) continue;

      const tagEnd = docText.indexOf(">", pos);
      const end = tagEnd !== -1 ? tagEnd + 1 : pos + match[0].length;
      decos.push(
        Decoration.widget({
          widget: new AngleBracketWarningWidget(pos, end, match[1]),
          side: -1,
        }).range(pos),
      );
    }
  }

  // Only the note's own decorations render tables; a cell editor leaves the
  // call as inline markup.
  if (!inlineOnly) keepEditedTables(state, decos, onlyRanges);

  decos.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  return RangeSet.of(decos);
}

/**
 * While a table's source is briefly unparseable during cell editing, keep a
 * stand-in widget over its known range instead of dropping to raw source. The
 * next parseable state repaints it.
 */
function keepEditedTables(state: EditorState, decos: Range<Decoration>[], onlyRanges?: { from: number; to: number }[]) {
  for (const from of editingTableStarts()) {
    const range = editingTableRange(from, state.doc.length);
    if (!range || range.to <= range.from || range.to > state.doc.length) continue;
    if (onlyRanges && !nodeOverlapsRanges(range.from, range.to, onlyRanges)) continue;
    if (decos.some((d) => d.from === from && d.value.spec?.widget instanceof TableWidget)) continue;
    if (!state.doc.sliceString(from, from + 7).startsWith("#table(")) continue;
    decos.push(Decoration.replace({ widget: TableWidget.unparsed(range.from, range.to) }).range(range.from, range.to));
  }
}

const BLOCK_FUNCS = new Set([
  "callout", "quote", "verse", "note", "bibliography", "table",
]);

/** The name of the function a `#name(…)` / `#name[…]` call text invokes, or
 *  null when the text has no argument delimiter. */
function funcCallName(funcText: string): string | null {
  const hashOff = funcText.startsWith("#") ? 1 : 0;
  const paren = funcText.indexOf("(", hashOff);
  const bracket = funcText.indexOf("[", hashOff);
  const delim = paren >= 0 && bracket >= 0 ? Math.min(paren, bracket) : paren >= 0 ? paren : bracket;
  return delim >= 0 ? funcText.substring(hashOff, delim).trim() : null;
}

// Functions that always render as widgets, even on the cursor line. `footnote`
// reveals its source when the cursor is adjacent or inside, like wikilinks.
//
// `task`, `due` and `suggestion` aren't here: they also render widgets, but
// show a pill on the cursor line for editing through the pill menu. Their cases
// push both decorations.
const INTERACTIVE_FUNCS = new Set(["wikilink", "tag", "link", "footnote"]);

/**
 * Extract an ISO `YYYY-MM-DD` date from a `datetime(...)` call or a quoted
 * string, or null.
 */
function extractDateLiteral(s: string): string | null {
  const dt = s.match(
    /datetime\(\s*(?:year\s*:\s*)?(\d{1,4})\s*,\s*(?:month\s*:\s*)?(\d{1,2})\s*,\s*(?:day\s*:\s*)?(\d{1,2})/,
  );
  if (dt) {
    return `${dt[1].padStart(4, "0")}-${dt[2].padStart(2, "0")}-${dt[3].padStart(2, "0")}`;
  }
  const str = s.match(/"(\d{4}-\d{2}-\d{2})"/);
  return str ? str[1] : null;
}

// Block widgets that collapse to pill + editable value when cursor is on line.
const BLOCK_WIDGET_FUNCS = new Set(["image", "video", "audio"]);

/** Calls that produce block-level widgets, left as raw markup in inline-only
 *  mode (`inlineOnlyFacet`). */
const BLOCK_LEVEL_FUNCS = new Set([...BLOCK_FUNCS, ...BLOCK_WIDGET_FUNCS]);

/**
 * Decorate one `#func(...)` / `#func[...]` call. Returns true when the caller
 * should traverse the call's children (its body is live source), false when
 * this call handles its whole range.
 *
 * Works from the source text, not the syntax tree, so the collapse rules can be
 * tested without a language configured (see func-collapse.test.ts).
 */
export function handleFuncCall(
  state: EditorState,
  from: number,
  to: number,
  decos: Range<Decoration>[],
  onCursor: boolean,
  cursors: Set<number>,
  autoExpand: boolean,
  expandedPos: number | null,
  formatting: InlineFormatting = { bold: false, italic: false, strike: false, highlight: null },
): boolean {
  const text = state.doc.sliceString(from, to);

  const hashOffset = text.startsWith("#") ? 1 : 0;
  const nameEnd = text.indexOf("(", hashOffset);
  const bracketStart = text.indexOf("[", hashOffset);
  const delimIdx = (nameEnd >= 0 && bracketStart >= 0)
    ? Math.min(nameEnd, bracketStart)
    : (nameEnd >= 0 ? nameEnd : bracketStart);
  if (delimIdx < 0) return false;

  const funcName = text.substring(hashOffset, delimIdx).trim();

  // `#align(left|center|right)[#image(...)]` renders as the image widget with
  // the alignment applied.
  const alignedImage = funcName === "align" ? parseAlignedImage(text) : null;

  if (INTERACTIVE_FUNCS.has(funcName)) {
    // A wikilink shows an editable `[[Name]]` form on the cursor (handled in
    // its case below), so it doesn't return early.
    if (funcName !== "wikilink" && isCursorAdjacentOrInside(state, from, to, cursors)) return false;
  } else if (BLOCK_WIDGET_FUNCS.has(funcName) || funcName === "callout" || funcName === "quote" || alignedImage) {
    // Block elements (image, callout, quote) stay rendered with a pill above
    // them; handled in their cases below.
  } else if (BLOCK_FUNCS.has(funcName)) {
    if (funcName === "table" && expandedPos === from) return false;
    // Verse always renders as its widget, which handles editing and focus
    // itself.
  } else if (funcName === "task") {
    // A task reveals its source in its case below while keeping its pill, so
    // the done/due/label menu is reachable right after insertion.
  } else {
    const isExpanded = expandedPos === from;
    if (isExpanded || (autoExpand && onCursor)) return false;
  }

  // Inline functions show the pill when the cursor is on the line. Block
  // functions place their own pill below.
  const showPill = onCursor && hashOffset === 1
    && !BLOCK_FUNCS.has(funcName) && !INTERACTIVE_FUNCS.has(funcName)
    && !BLOCK_WIDGET_FUNCS.has(funcName) && !alignedImage;

  // Decorations for a block element with a pill above it. Three states:
  //   - cursor away: the element widget replaces the call.
  //   - cursor on the line: the same widget, with a pill row at its top.
  //   - expanded: raw markup is shown, with the element rendered as a block
  //     widget after it.
  const pushBlockElement = (build: (withPill: boolean) => WidgetType) => {
    const isExpanded = expandedPos === from || (autoExpand && onCursor);
    if (isExpanded) {
      decos.push(
        Decoration.widget({ widget: build(false), block: true, side: 1 }).range(to),
      );
      return;
    }
    decos.push(Decoration.replace({ widget: build(onCursor) }).range(from, to));
  };

  switch (funcName) {
    case "strike": {
      const content = extractContentBracket(text, from);
      if (content) {
        decos.push((showPill
          ? Decoration.replace({ widget: new FuncPillWidget(from, "strike") })
          : hide
        ).range(from, content.from));
        decos.push(hide.range(content.to, to));
        addSplitMarks(state, content.from, content.to, strikethrough, decos);
      }
      return true;
    }
    case "highlight": {
      const content = extractContentBracket(text, from);
      if (content) {
        decos.push((showPill
          ? Decoration.replace({ widget: new FuncPillWidget(from, "highlight") })
          : hide
        ).range(from, content.from));
        decos.push(hide.range(content.to, to));
        addSplitMarks(state, content.from, content.to, buildHighlightMark(text), decos);
      }
      return true;
    }
    case "emph": {
      const content = extractContentBracket(text, from);
      if (content) {
        decos.push((showPill
          ? Decoration.replace({ widget: new FuncPillWidget(from, "emph") })
          : hide
        ).range(from, content.from));
        decos.push(hide.range(content.to, to));
        addSplitMarks(state, content.from, content.to, italic, decos);
      }
      return true;
    }
    case "strong": {
      const content = extractContentBracket(text, from);
      if (content) {
        decos.push((showPill
          ? Decoration.replace({ widget: new FuncPillWidget(from, "strong") })
          : hide
        ).range(from, content.from));
        decos.push(hide.range(content.to, to));
        addSplitMarks(state, content.from, content.to, bold, decos);
      }
      return true;
    }
    case "underline":
    case "overline":
    case "sub":
    case "super": {
      // Inline content-bracket functions: hide `#fn[` and `]` when the cursor
      // is off the line and style the body with a mark, keeping it editable.
      const content = extractContentBracket(text, from);
      if (content) {
        decos.push((showPill
          ? Decoration.replace({ widget: new FuncPillWidget(from, funcName) })
          : hide
        ).range(from, content.from));
        decos.push(hide.range(content.to, to));
        const mark = funcName === "underline" ? underlineMark
          : funcName === "overline" ? overlineMark
          : funcName === "sub" ? subMark
          : supMark;
        addSplitMarks(state, content.from, content.to, mark, decos);
      }
      return true;
    }
    case "line": {
      // `#line(...)` takes arguments, so it stays editable while the caret is
      // in it.
      if (collapseWouldSwallowCaret(state, from, to, cursors)) return false;
      if (/^#line\b/.test(text)) {
        decos.push(Decoration.replace({
          widget: new HrWidget(from, showPill),
        }).range(from, to));
      }
      return false;
    }
    case "callout": {
      const kind = extractFirstStringArg(text);
      if (!kind) return false;
      const bodyRange = bracketRangeAfterArgs(text, from);
      if (bodyRange === null) return false;
      // Read overrides from the argument list only, so words like `title:` in
      // the body aren't mistaken for arguments.
      const argsText = text.slice(0, bodyRange.from - from);
      const title = extractNamedStringArg(argsText, "title");
      const color = calloutColor(kind, readCalloutColorArg(argsText));
      // Callout always expands from its pill. The in-place body editing can't
      // reach its arguments, so an expand request (or the auto-expand setting)
      // shows the raw markup. It collapses when the cursor leaves.
      if (expandedPos === from || (autoExpand && onCursor)) return false;
      // A rendered widget when the cursor is away, an editable body with
      // callout styling when it is on. Both use the same geometry so the height
      // doesn't change.
      if (!onCursor) {
        const bodyText = state.doc.sliceString(bodyRange.from, bodyRange.to);
        decos.push(
          Decoration.replace({
            widget: new CalloutBlockWidget(kind, title ?? "", color, bodyText, from, bodyRange.from),
          }).range(from, to),
        );
        return false;
      }
      // Cursor on the callout: the opener becomes the heading row (pill and
      // label) on the first body line, the closer is hidden, and each body line
      // gets the frame's inset and tint.
      const layout = blockEditLayout(state, bodyRange.from, bodyRange.to);
      decos.push(
        Decoration.replace({
          widget: new CalloutHeadRowWidget(kind, title ?? "", color, from),
        }).range(from, layout.hideOpenTo),
      );
      if (layout.hideCloseFrom < to) decos.push(hide.range(layout.hideCloseFrom, to));
      pushBlockEditLines(
        decos,
        state,
        layout,
        "cm-typst-callout-line",
        `--callout-color: ${color}; background-color: color-mix(in srgb, ${color} 8%, transparent);`,
      );
      return false;
    }
    case "annotation": {
      // An annotation is a remark on the writing: a pill marks its place and
      // opens the comment in the Changes & History pane. When expanded, the raw
      // source shows instead.
      const attribution = [extractNamedStringArg(text, "by"), extractNamedStringArg(text, "on")]
        .filter(Boolean).join(" · ");
      const body = extractBracketContent(text) ?? "";
      const summary = attribution ? `${attribution}\n${body}` : body;
      decos.push(
        Decoration.replace({ widget: new AnnotationPillWidget(from, summary) }).range(from, to),
      );
      return false;
    }
    case "image": {
      const path = extractFirstStringArg(text);
      if (!path) return false;
      const imgAlt = extractNamedStringArg(text, "alt");
      const imgWidth = extractNamedBareArg(text, "width");
      const imgHeight = extractNamedBareArg(text, "height");
      pushBlockElement((withPill) => new ImageBlockWidget(path, from, withPill, imgAlt, imgWidth, imgHeight));
      return false;
    }
    case "video":
    case "audio": {
      const path = extractFirstStringArg(text);
      if (!path) return false;
      const mediaKind = funcName as "video" | "audio";
      const mediaWidth = mediaKind === "video" ? extractNamedBareArg(text, "width") : null;
      pushBlockElement((withPill) => new MediaBlockWidget(mediaKind, path, from, withPill, mediaWidth));
      return false;
    }
    case "tag": {
      const name = extractFirstStringArg(text);
      if (name) {
        decos.push(
          Decoration.replace({ widget: new TagWidget(name), inclusiveStart: false, inclusiveEnd: false }).range(from, to),
        );
      }
      return false;
    }
    case "task": {
      const body = extractFirstStringArg(text);
      // Show the pill even without a body, so an unfinished `#task()` is still
      // recognized (issue #24).
      if (showPill) {
        decos.push(
          Decoration.widget({ widget: new FuncPillWidget(from, "task"), side: -1 }).range(from),
        );
      }
      if (body !== null && body !== undefined) {
        const done = /\bdone\s*:\s*true\b/.test(text);
        // Look for the due date only after the `due:` keyword so a date
        // inside the body string can't be mistaken for it.
        const dueIdx = text.search(/\bdue\s*:/);
        const due = dueIdx >= 0 ? extractDateLiteral(text.slice(dueIdx)) : null;
        // Caret on or next to the call: reveal the raw source for editing,
        // keeping the pill for the menu. Moving away collapses it back to the
        // checkbox.
        const revealSource = expandedPos === from
          || (autoExpand && onCursor)
          || isCursorAdjacentOrInside(state, from, to, cursors);
        if (revealSource) return false;
        decos.push(
          Decoration.replace({
            widget: new TaskWidget(body, done, due, from),
            inclusiveStart: false,
            inclusiveEnd: false,
          }).range(from, to),
        );
      }
      return false;
    }
    case "due": {
      const date = extractDateLiteral(text);
      const label = extractNamedStringArg(text, "label");
      // Show the pill even without a date, so one can be filled in through the
      // menu.
      if (showPill) {
        decos.push(
          Decoration.widget({ widget: new FuncPillWidget(from, "due"), side: -1 }).range(from),
        );
      }
      if (date) {
        decos.push(
          Decoration.replace({
            widget: new DueWidget(date, label ?? ""),
            inclusiveStart: false,
            inclusiveEnd: false,
          }).range(from, to),
        );
      }
      return false;
    }
    case "wikilink": {
      const target = extractFirstStringArg(text);
      if (target === null || target === undefined) return false;
      const display = extractNamedStringArg(text, "display");
      const label = extractNamedStringArg(text, "label");

      // Cursor on or next to the call: show it as an editable `[[Name]]` /
      // `[[Name::label]]`. The source is unchanged, so the suggestion picker
      // still works; widgets hide the function wrapper.
      if (isCursorAdjacentOrInside(state, from, to, cursors)) {
        // A `display:` alias has no `[[ ]]` form — fall back to raw source.
        if (display !== null && display !== undefined) return false;
        const q1 = text.indexOf('"');
        const q2 = q1 >= 0 ? text.indexOf('"', q1 + 1) : -1;
        if (q1 < 0 || q2 < 0) return false;
        // `#wikilink("` → `[[`
        decos.push(openWikiBracket.range(from, from + q1 + 1));
        pushMark(decos, wikilinkEditMark, from + q1 + 1, from + q2);
        if (label !== null && label !== undefined) {
          const q3 = text.indexOf('"', q2 + 1);
          const q4 = q3 >= 0 ? text.indexOf('"', q3 + 1) : -1;
          if (q3 < 0 || q4 < 0) return false;
          // `", label: "` → `::`, then the label text, then `")` → `]]`
          decos.push(wikiHeadingSep.range(from + q2, from + q3 + 1));
          pushMark(decos, wikilinkEditMark, from + q3 + 1, from + q4);
          decos.push(closeWikiBracket.range(from + q4, to));
        } else {
          // `")` → `]]`
          decos.push(closeWikiBracket.range(from + q2, to));
        }
        return false;
      }

      // Cursor away → the rendered link pill, exactly as before.
      const files = fileList();
      const normalizedTarget = target.toLowerCase().replace(/\.typ$/, "");
      const exists = files.some(f => f.name.replace(/\.typ$/, "").toLowerCase() === normalizedTarget);
      decos.push(
        Decoration.replace({
          widget: new WikilinkWidget(target, display ?? "", formatting.bold, formatting.italic, formatting.strike, formatting.highlight, label ?? "", exists),
          inclusiveStart: false,
          inclusiveEnd: false,
        }).range(from, to),
      );
      return false;
    }
    case "link": {
      const display = extractBracketContent(text);
      const url = extractFirstStringArg(text);
      if (url) {
        decos.push(
          Decoration.replace({
            widget: new LinkWidget(url, display ?? "", formatting.bold, formatting.italic, formatting.strike, formatting.highlight),
            inclusiveStart: false,
            inclusiveEnd: false,
          }).range(from, to),
        );
        return false;
      }
      // `#link(<label>)[…]` links to a label in the document; render it as an
      // internal link.
      const label = extractFirstLabelArg(text);
      if (label) {
        decos.push(
          Decoration.replace({
            widget: new LabelLinkWidget(label, display ?? "", formatting.bold, formatting.italic, formatting.strike, formatting.highlight),
            inclusiveStart: false,
            inclusiveEnd: false,
          }).range(from, to),
        );
      }
      return false;
    }
    case "suggestion": {
      // Like `#task`: the tracked change always renders as a SuggestionWidget
      // (click to accept, reject or comment), with a pill on the cursor line
      // that expands the raw source for editing.
      const kind = (extractNamedStringArg(text, "kind") ?? "insert") as SuggestionKind;
      const by = extractNamedStringArg(text, "by") ?? "";
      const on = extractNamedStringArg(text, "on") ?? "";
      const note = extractNamedStringArg(text, "note") ?? "";
      const body = extractBodyBracket(text) ?? "";
      const oldText = kind === "replace" ? (extractNamedBracket(text, "old") ?? "") : "";
      if (showPill) {
        decos.push(
          Decoration.widget({ widget: new FuncPillWidget(from, "suggestion"), side: -1 }).range(from),
        );
      }
      decos.push(
        Decoration.replace({
          widget: new SuggestionWidget(kind, body, oldText, by, on, from, note),
          inclusiveStart: false,
          inclusiveEnd: false,
        }).range(from, to),
      );
      return false;
    }
    case "cite": {
      const keyMatch = text.match(/<([^>]+)>/);
      if (keyMatch) {
        if (showPill) {
          decos.push(
            Decoration.widget({ widget: new FuncPillWidget(from, "cite"), side: -1 }).range(from),
          );
        }
        decos.push(
          Decoration.replace({
            widget: new CitationWidget(keyMatch[1]),
            inclusiveStart: false,
            inclusiveEnd: false,
          }).range(from, to),
        );
      }
      return false;
    }
    case "table": {
      const tableData = parseCanonicalTable(text);
      if (tableData) {
        decos.push(
          Decoration.replace({
            widget: new TableWidget(tableData, from, to),
          }).range(from, to),
        );
      }
      // An unparseable table hosting a cell editor is handled after the
      // tree walk (see `keepEditedTables`), tree or no tree.
      return false;
    }
    case "verse": {
      const range = extractFirstEscapedStringArgRange(text, from);
      if (range !== null) {
        const source = state.doc.sliceString(range.from, range.to);
        const alignArg = (text.match(/align-to\s*:\s*(left|center|right)\b/) ?? [])[1];
        const fontArg = extractNamedStringArg(text, "font");
        // Only an integer weight (what the pill emits) is reflected in the
        // chip; named weights like `"bold"` still work in Typst.
        const weightMatch = text.match(/\bweight\s*:\s*(\d+)\b/);
        const weight = weightMatch ? Number(weightMatch[1]) : null;
        decos.push(
          Decoration.replace({
            widget: new VerseWidget({
              source,
              bodyFrom: range.from,
              bodyTo: range.to,
              callFrom: from,
              align: (alignArg as "left" | "center" | "right") ?? "left",
              font: fontArg ?? null,
              weight,
            }),
          }).range(from, to),
        );
      }
      return false;
    }
    case "footnote": {
      const content = extractBracketContent(text);
      if (content !== null) {
        decos.push(
          Decoration.replace({
            widget: new FootnoteWidget(content),
          }).range(from, to),
        );
      }
      return false;
    }
    case "quote": {
      // Match Typst's rendering: `block: true` is a display quote with
      // attribution; the inline form is a live-edit pill between smart quotes,
      // without attribution.
      const isBlock = /\bblock\s*:\s*true\b/.test(text);
      if (isBlock) {
        const bodyRange = bracketRangeAfterArgs(text, from);
        if (bodyRange === null) return false;
        // Block quote always expands from its pill. The in-place body editing can't
        // reach its arguments, so an expand request (or the auto-expand setting)
        // shows the raw markup.
        if (expandedPos === from || (autoExpand && onCursor)) return false;
        // Edit in place when the cursor is on the quote; render a widget when
        // it is away.
        const attribution = extractAttributionDisplay(text);
        if (!onCursor) {
          // Cursor away: one atomic blockquote widget.
          const content = state.doc.sliceString(bodyRange.from, bodyRange.to);
          decos.push(
            Decoration.replace({ widget: new BlockquoteBlockWidget(content, attribution, from, bodyRange.from) }).range(from, to),
          );
          return false;
        }
        // Cursor on the quote: the body is edited as ordinary text. A pill
        // replaces the opener, the closing `]` is hidden (or replaced by the
        // attribution row), and body lines get blockquote styling with the
        // widget's geometry.
        const layout = blockEditLayout(state, bodyRange.from, bodyRange.to);
        decos.push(
          Decoration.replace({ widget: new FuncPillWidget(from, "quote") }).range(from, layout.hideOpenTo),
        );
        if (layout.hideCloseFrom < to) {
          decos.push((attribution
            ? Decoration.replace({ widget: new BlockquoteAttributionRowWidget(attribution) })
            : hide
          ).range(layout.hideCloseFrom, to));
        }
        pushBlockEditLines(decos, state, layout, "cm-typst-blockquote-line");
        // Style only the body, not text after the closing `]`.
        if (layout.hideOpenTo < layout.hideCloseFrom) {
          decos.push(blockquoteBodyMark.range(layout.hideOpenTo, layout.hideCloseFrom));
        }
        return false;
      }
      // Inline quote: the body stays editable between two smart-quote widgets
      // standing in for the hidden `#quote[` and `]`. "quote" is in BLOCK_FUNCS
      // for its block form, so the pill condition is computed here.
      const inlineShowPill = onCursor && hashOffset === 1;
      const content = extractContentBracket(text, from);
      if (content) {
        decos.push((inlineShowPill
          ? Decoration.replace({ widget: new FuncPillWidget(from, "quote") })
          : openQuote
        ).range(from, content.from));
        decos.push(closeQuote.range(content.to, to));
      }
      return true;
    }
    case "note": {
      let hideEnd = to;
      const docLen = state.doc.length;
      if (hideEnd < docLen) {
        const afterLine = state.doc.lineAt(hideEnd);
        if (hideEnd === afterLine.to) {
          hideEnd = Math.min(hideEnd + 1, docLen);
        }
        if (hideEnd < docLen) {
          const nextLine = state.doc.lineAt(hideEnd);
          if (nextLine.text.trim() === "") {
            hideEnd = Math.min(nextLine.to + 1, docLen);
          }
        }
      }
      decos.push(hide.range(from, hideEnd));
      return false;
    }
    case "bibliography": {
      // When expanded, show the raw `#bibliography(...)` source.
      if (expandedPos === from) return false;
      // Typing the path by hand must not be interrupted by the block widget
      // replacing the call out from under the caret.
      if (collapseWouldSwallowCaret(state, from, to, cursors)) return false;
      const path = extractFirstStringArg(text) ?? "";
      let replaceEnd = to;
      const docLen = state.doc.length;
      // Include a trailing newline and blank line so no stray empty line
      // remains.
      if (replaceEnd < docLen) {
        const afterLine = state.doc.lineAt(replaceEnd);
        if (replaceEnd === afterLine.to) {
          replaceEnd = Math.min(replaceEnd + 1, docLen);
        }
        if (replaceEnd < docLen) {
          const nextLine = state.doc.lineAt(replaceEnd);
          if (nextLine.text.trim() === "") {
            replaceEnd = Math.min(nextLine.to + 1, docLen);
          }
        }
      }
      decos.push(
        Decoration.replace({
          widget: new BibliographyBlockWidget(path, from),
        }).range(from, replaceEnd),
      );
      return false;
    }
    case "figure": {
      // Figure always renders as a chip: its body is a positional argument, and
      // the default "first `[` is the body" rule would hide a `caption: [...]`.
      // The caption is edited through the menu.
      //
      // When expanded (after insertion from the `/` palette, or via "Edit
      // source"), the raw source is shown so the cursor can reach the body. It
      // collapses when the cursor leaves. A hand-typed `#figure(` also needs
      // the caret guard.
      if (expandedPos === from) return false;
      if (collapseWouldSwallowCaret(state, from, to, cursors)) return false;
      decos.push(Decoration.replace({
        widget: new FuncChipWidget(from, "figure"),
      }).range(from, to));
      return false;
    }
    case "align": {
      // An aligned image renders as the image widget. Its pill sits at the
      // `#align`, so the menu edits the image and the alignment together.
      if (alignedImage) {
        const path = extractFirstStringArg(alignedImage.imgText);
        if (path) {
          const imgAlt = extractNamedStringArg(alignedImage.imgText, "alt");
          const imgWidth = extractNamedBareArg(alignedImage.imgText, "width");
          const imgHeight = extractNamedBareArg(alignedImage.imgText, "height");
          pushBlockElement((withPill) =>
            new ImageBlockWidget(path, from, withPill, imgAlt, imgWidth, imgHeight, alignedImage.kw));
          return false;
        }
      }
      // falls through to default
    }
    // eslint-disable-next-line no-fallthrough
    default: {
      if (!hashOffset) return false;
      const content = extractContentBracket(text, from);
      if (content) {
        decos.push((showPill
          ? Decoration.replace({ widget: new FuncPillWidget(from, funcName) })
          : hide
        ).range(from, content.from));
        decos.push(hide.range(content.to, to));
        return true;
      }
      // An arguments-only call collapses to a chip, but not while the caret is
      // inside it.
      if (collapseWouldSwallowCaret(state, from, to, cursors)) return false;
      decos.push(Decoration.replace({
        widget: new FuncChipWidget(from, funcName),
      }).range(from, to));
      return false;
    }
  }
}

function addSplitMarks(
  state: EditorState,
  contentFrom: number,
  contentTo: number,
  mark: Decoration,
  decos: Range<Decoration>[],
) {
  const innerRanges: { from: number; to: number }[] = [];
  // Find inner calls by scanning the text: the tree's boundaries can be wrong
  // here (see `correctedFuncCallEnd`).
  const contentText = state.doc.sliceString(contentFrom, contentTo);
  const funcRe = /#(\w[\w-]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = funcRe.exec(contentText)) !== null) {
    const fStart = contentFrom + m.index;
    // Find matching closing paren accounting for nesting and strings
    let parenDepth = 1;
    let inStr = false;
    let i = m.index + m[0].length;
    for (; i < contentText.length && parenDepth > 0; i++) {
      const ch = contentText[i];
      if (inStr) { if (ch === '"' && contentText[i - 1] !== '\\') inStr = false; }
      else if (ch === '"') inStr = true;
      else if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth--;
    }
    if (parenDepth === 0) {
      innerRanges.push({ from: fStart, to: contentFrom + i });
      funcRe.lastIndex = i;
    }
  }
  innerRanges.sort((a, b) => a.from - b.from);
  let pos = contentFrom;
  for (const r of innerRanges) {
    if (pos < r.from) decos.push(mark.range(pos, r.from));
    pos = Math.max(pos, r.to);
  }
  if (pos < contentTo) decos.push(mark.range(pos, contentTo));
}

function extractContentBracket(
  text: string,
  nodeFrom: number,
): { from: number; to: number } | null {
  const open = text.indexOf("[");
  if (open < 0) return null;
  let depth = 0;
  let closeIdx = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") {
      depth--;
      if (depth === 0) { closeIdx = i; break; }
    }
  }
  if (closeIdx < 0) return null;
  // An empty body (`#highlight[]`) returns a zero-width range, so callers can
  // still hide the markup and leave a typing slot.
  return { from: nodeFrom + open + 1, to: nodeFrom + closeIdx };
}

/** True when `pos` is inside a node where `\` is literal (raw, code, comment,
 *  string). The escape scan skips these. */
function posInsideRawOrCode(tree: ReturnType<typeof syntaxTree>, pos: number): boolean {
  let n: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, 1);
  while (n) {
    if (n.name === "Raw" || n.name === "RawBlock" || n.name === "CodeBlock"
        || n.name === "Comment" || n.name === "String") {
      return true;
    }
    n = n.parent;
  }
  return false;
}

/** Skip an inline raw span starting at `i`. Returns the index after its closing
 *  backticks, or `end` when it is unterminated. */
function skipInlineRaw(text: string, i: number, end: number): number {
  let n = 0;
  while (i + n < end && text[i + n] === "`") n++;
  const fence = "`".repeat(n);
  const close = text.indexOf(fence, i + n);
  return close >= 0 && close < end ? close + n : end;
}

/**
 * Index of the `]` closing the `[` at `open`, or -1. Brackets inside inline raw
 * or behind `\` are literal, as in Typst markup, so a `[[` in backticks doesn't
 * unbalance the body.
 */
function matchContentBracket(text: string, open: number, end: number): number {
  let depth = 0;
  let i = open;
  while (i < end) {
    const ch = text[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "`") { i = skipInlineRaw(text, i, end); continue; }
    if (ch === "[") depth++;
    else if (ch === "]") { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

/**
 * Range of the `[…]` body after a call's argument list. Use instead of
 * {@link extractContentBracket} when a bracket argument can come before the
 * body (`#quote(attribution: [Smith])[body]`). String- and depth-aware.
 * Returns a zero-width range for an empty body.
 */
function bracketRangeAfterArgs(
  text: string,
  nodeFrom: number,
): { from: number; to: number } | null {
  let scanFrom = 0;
  const lp = text.indexOf("(");
  if (lp >= 0) {
    let depth = 0;
    let inStr = false;
    for (let i = lp; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"' && text[i - 1] !== "\\") inStr = !inStr;
      else if (!inStr && ch === "(") depth++;
      else if (!inStr && ch === ")") {
        depth--;
        if (depth === 0) { scanFrom = i + 1; break; }
      }
    }
  }
  const open = text.indexOf("[", scanFrom);
  if (open < 0) return null;
  const close = matchContentBracket(text, open, text.length);
  if (close < 0) return null;
  return { from: nodeFrom + open + 1, to: nodeFrom + close };
}

function extractFirstStringArg(text: string): string | null {
  const m = text.match(/\(\s*"([^"]*)"/) ?? text.match(/\(\s*'([^']*)'/);
  return m ? m[1] : null;
}

/** A label as the first argument: `#link(<my-label>)…`. */
function extractFirstLabelArg(text: string): string | null {
  const m = text.match(/\(\s*<([^>\s]+)>/);
  return m ? m[1] : null;
}

function extractFirstStringArgRange(
  text: string,
  nodeFrom: number,
): { from: number; to: number } | null {
  const m = text.match(/\(\s*"/) ?? text.match(/\(\s*'/);
  if (!m || m.index == null) return null;
  const quote = text[m.index + m[0].length - 1];
  const contentStart = m.index + m[0].length;
  const contentEnd = text.indexOf(quote, contentStart);
  if (contentEnd < 0) return null;
  return { from: nodeFrom + contentStart, to: nodeFrom + contentEnd };
}

/**
 * Like {@link extractFirstStringArgRange}, but honours `\X` escapes in the
 * string (verse bodies often contain `\"`, `\\`, `\*`).
 */
function extractFirstEscapedStringArgRange(
  text: string,
  nodeFrom: number,
): { from: number; to: number } | null {
  const m = text.match(/\(\s*"/);
  if (!m || m.index == null) return null;
  const contentStart = m.index + m[0].length;
  let i = contentStart;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === '"') return { from: nodeFrom + contentStart, to: nodeFrom + i };
    i++;
  }
  return null;
}

export function extractNamedStringArg(text: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*:\\s*"([^"]*)"`);
  const m = text.match(re);
  return m ? m[1] : null;
}

/** Extract a named arg with a bare (non-string) value like `width: 40%`. */
function extractNamedBareArg(text: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*:\\s*([^,)\\]]+)`);
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

/** Index just past the closing `)` of the first `(...)` call in `s`,
 *  starting from `start`. Balanced-paren and string aware. -1 if none. */
function callParenEnd(s: string, start: number): number {
  const open = s.indexOf("(", start);
  if (open < 0) return -1;
  let depth = 0;
  let inStr = false;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && s[i - 1] !== "\\") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/**
 * Recognize `#align(left|center|right)[#image(...)]` around a lone image.
 * Returns the alignment and the image source, or null.
 */
function parseAlignedImage(
  text: string,
): { kw: "left" | "center" | "right"; imgText: string } | null {
  const m = text.match(/^#align\s*\(\s*(left|center|right)\s*\)\s*\[/);
  if (!m) return null;
  const kw = m[1] as "left" | "center" | "right";
  const bodyStart = m[0].length;
  // Find the `]` matching the body-opening `[`.
  let depth = 1;
  let inStr = false;
  let end = -1;
  for (let i = bodyStart; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== "\\") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "[") depth++;
    else if (ch === "]") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  if (text.slice(end + 1).trim() !== "") return null; // trailing content → not a lone image
  const body = text.slice(bodyStart, end).trim();
  if (!body.startsWith("#image")) return null;
  // The image call must span the whole body (no extra siblings after it).
  if (callParenEnd(body, 0) !== body.length) return null;
  return { kw, imgText: body };
}

function extractNamedBracketArg(text: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*:\\s*\\[([^\\]]*)\\]`);
  const m = text.match(re);
  return m ? m[1] : null;
}

/**
 * Display text for `attribution: …` in the four forms the pill writes (string,
 * label, `link("…")[…]`, bracket content), or "".
 */
function extractAttributionDisplay(text: string): string {
  const str = extractNamedStringArg(text, "attribution");
  if (str !== null) return str;
  // `link("url")[Text]`: show only the text.
  const linkMatch = text.match(
    /attribution\s*:\s*link\(\s*"(?:\\.|[^"\\])*"\s*\)\s*\[([\s\S]*?)\]/,
  );
  if (linkMatch) return linkMatch[1];
  // `attribution: <bibkey>`: show the label so the author can see which key
  // they used.
  const labelMatch = text.match(/attribution\s*:\s*(<[^\s<>]+>)/);
  if (labelMatch) return labelMatch[1];
  // Bracket content: attribution: [free content].
  const bracket = extractNamedBracketArg(text, "attribution");
  if (bracket !== null) return bracket;
  return "";
}

export function extractBracketContent(text: string): string | null {
  const open = text.indexOf("[");
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") {
      depth--;
      if (depth === 0) return text.substring(open + 1, i);
    }
  }
  return null;
}

/** Inner content of the first balanced `[...]` at or after `startIdx`. */
function extractBracketAfter(text: string, startIdx: number): string | null {
  const open = text.indexOf("[", startIdx);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") {
      depth--;
      if (depth === 0) return text.substring(open + 1, i);
    }
  }
  return null;
}

/** Inner content of a named content argument, e.g. `old: [..]`. */
export function extractNamedBracket(text: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*:\\s*`).exec(text);
  if (!m) return null;
  return extractBracketAfter(text, m.index + m[0].length);
}

/**
 * Content of the `[body]` after the argument list, so a bracket argument like
 * `old: [..]` isn't mistaken for it. String-aware.
 */
export function extractBodyBracket(text: string): string | null {
  const parenOpen = text.indexOf("(");
  let after = 0;
  if (parenOpen >= 0) {
    let depth = 0;
    let inStr = false;
    for (let i = parenOpen; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"' && text[i - 1] !== "\\") inStr = !inStr;
      else if (!inStr) {
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) {
            after = i + 1;
            break;
          }
        }
      }
    }
  }
  return extractBracketAfter(text, after);
}

const expandedFuncField = StateField.define<number | null>({
  create() { return null; },
  update(pos, tr) {
    let next = pos;
    if (tr.docChanged && next !== null) {
      next = tr.changes.mapPos(next, 1);
    }
    for (const e of tr.effects) {
      if (e.is(expandFunc)) {
        next = e.value;
        return next;
      }
      // After an external reload (e.g. a property edit), the mapped expanded
      // position is meaningless; clear it.
      if (e.is(rebuildVisualDecorations)) {
        return null;
      }
    }
    if (tr.selection && next !== null && next <= tr.state.doc.length) {
      // Keep the expansion open while the cursor is on any line of the call. A
      // revealed comment run has no brackets, so its end comes from the syntax
      // tree.
      const callEnd = commentRunStartingAt(tr.state, next)?.to
        ?? findCallEnd({ doc: tr.state.doc }, next);
      const startLine = tr.state.doc.lineAt(next).number;
      const endLine = tr.state.doc.lineAt(Math.min(callEnd, tr.state.doc.length)).number;
      let cursorNearby = false;
      for (const r of tr.state.selection.ranges) {
        const headLine = tr.state.doc.lineAt(r.head).number;
        if (headLine >= startLine && headLine <= endLine) {
          cursorNearby = true;
          break;
        }
      }
      if (!cursorNearby) next = null;
    }
    return next;
  },
});

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

const DECO_TRIGGER_CHARS = new Set(["*", "_", "\\", "$", "@", "#", "`", "/"]);

function cursorNearDecoTrigger(state: EditorState): boolean {
  for (const r of state.selection.ranges) {
    const line = state.doc.lineAt(r.head);
    const start = Math.max(line.from, r.head - 2);
    const end = Math.min(line.to, r.head + 2);
    const nearby = state.doc.sliceString(start, end);
    for (const ch of nearby) {
      if (DECO_TRIGGER_CHARS.has(ch)) return true;
    }
  }
  return false;
}

/**
 * Grow each dirty range to contain any `FuncCall` it overlaps. A block
 * element's decorations span several lines; rebuilding only some of them leaves
 * stale, conflicting decorations.
 */
function expandRangesToBlockElements(
  state: EditorState,
  ranges: { from: number; to: number }[],
): { from: number; to: number }[] {
  const tree = syntaxTree(state);
  const preamble = findStylePreamble(state);
  return ranges.map((r) => {
    let { from, to } = r;
    const grow = (nodeFrom: number, nodeTo: number) => {
      if (nodeFrom < from) from = nodeFrom;
      if (nodeTo > to) to = nodeTo;
    };
    // Grow to the call's corrected end (see `correctedFuncCallEnd`), which is
    // what the builder uses. A fenced code block's per-line edit styling must
    // also be rebuilt as one unit.
    const growCall = (n: { name: string; from: number; to: number }) => {
      if (n.name === "Raw" || n.name === "RawBlock") {
        grow(n.from, n.to);
        return;
      }
      // A comment run is one pill over several lines; rebuild it whole.
      if (n.name === "LineComment" || n.name === "BlockComment") {
        if (isCommentClosed(state, n.name, n.from, n.to)) {
          const run = commentRunAt(state, n.from, n.to);
          grow(run.replaceFrom, run.lockTo);
        }
        return;
      }
      if (n.name !== "FuncCall") return;
      const callFrom = (n.from > 0 && state.doc.sliceString(n.from - 1, n.from) === "#")
        ? n.from - 1 : n.from;
      grow(callFrom, correctedFuncCallEnd(state, callFrom, n.to));
    };
    // Enclosing calls at either edge of the range …
    for (const [pos, side] of [[r.from, 1], [r.to, -1]] as const) {
      let n: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side);
      while (n) {
        growCall(n);
        if (!n.parent) break;
        n = n.parent;
      }
    }
    // … plus any call that begins inside it.
    tree.iterate({
      from: r.from,
      to: r.to,
      enter(n) { growCall(n); },
    });
    // The style preamble is one block widget, so a dirty line inside it
    // rebuilds the whole range.
    if (preamble && r.from < preamble.to && r.to > preamble.from) {
      grow(preamble.from, preamble.to);
    }
    return { from, to };
  });
}

/**
 * Grow each dirty range to whole lines. Line decorations sit at the line start,
 * and a block inside a list item starts mid-line, so without this its line
 * decorations would be left stale.
 */
function snapRangesToLines(
  state: EditorState,
  ranges: { from: number; to: number }[],
): { from: number; to: number }[] {
  const len = state.doc.length;
  return ranges.map((r) => ({
    from: state.doc.lineAt(Math.min(r.from, len)).from,
    to: state.doc.lineAt(Math.min(r.to, len)).to,
  }));
}

function coalesceRanges(ranges: { from: number; to: number }[]): { from: number; to: number }[] {
  ranges.sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else merged.push({ from: r.from, to: r.to });
  }
  return merged;
}

function rebuildRanges(
  existing: DecorationSet,
  state: EditorState,
  dirtyRanges: { from: number; to: number }[],
): DecorationSet {
  // Coalesce, then grow to whole block elements, then out to whole lines, then
  // coalesce again (the growth can make formerly-separate ranges overlap).
  const merged = coalesceRanges(
    snapRangesToLines(state, expandRangesToBlockElements(state, coalesceRanges(dirtyRanges))),
  );

  if (merged.length === 0) return existing;

  const totalDirty = merged.reduce((s, r) => s + (r.to - r.from), 0);
  if (totalDirty > state.doc.length * 0.5) {
    return buildDecorations(state);
  }

  const newDecos = buildDecorations(state, merged);

  const kept: Range<Decoration>[] = [];
  const iter = existing.iter();
  while (iter.value) {
    let inDirty = false;
    for (const r of merged) {
      // Range decorations use half-open overlap. Point decorations count as
      // dirty at either end of the range, since ranges are whole lines;
      // otherwise stale copies at a boundary (a callout's line style, an image
      // preview, a deleted call's pill) would remain.
      const overlaps = iter.from < r.to && iter.to > r.from;
      const pointInRange = iter.from === iter.to && iter.from >= r.from && iter.from <= r.to;
      if (overlaps || pointInRange) {
        inDirty = true;
        break;
      }
    }
    if (!inDirty) {
      kept.push(iter.value.range(iter.from, iter.to));
    }
    iter.next();
  }

  const rebuilt: Range<Decoration>[] = [];
  const rebuiltIter = newDecos.iter();
  while (rebuiltIter.value) {
    rebuilt.push(rebuiltIter.value.range(rebuiltIter.from, rebuiltIter.to));
    rebuiltIter.next();
  }

  return RangeSet.of([...kept, ...rebuilt], true);
}

/**
 * Incremental rebuild for a cursor move: only the lines the caret left and
 * arrived on, grown to whole block elements. Exported for tests.
 */
export function rebuildDirtyLines(
  existing: DecorationSet,
  state: EditorState,
  oldCursorLines: Set<number>,
  newCursorLines: Set<number>,
): DecorationSet {
  const dirtyLines = new Set([...oldCursorLines, ...newCursorLines]);
  const dirtyRanges: { from: number; to: number }[] = [];
  for (const lineNum of dirtyLines) {
    if (lineNum < 1 || lineNum > state.doc.lines) continue;
    const line = state.doc.line(lineNum);
    dirtyRanges.push({ from: line.from, to: line.to });
  }
  return rebuildRanges(existing, state, dirtyRanges);
}

/**
 * Incremental rebuild for a document edit: the changed lines and caret lines
 * are rebuilt, the rest is mapped through the change. Exported for tests.
 */
export function rebuildDocChange(
  existing: DecorationSet,
  tr: { startState: EditorState; state: EditorState; changes: ChangeSet },
): DecorationSet {
  const mapped = existing.map(tr.changes);
  const dirtyRanges: { from: number; to: number }[] = [];
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const startLine = tr.state.doc.lineAt(fromB);
    const endLine = tr.state.doc.lineAt(Math.min(toB, tr.state.doc.length));
    dirtyRanges.push({ from: startLine.from, to: endLine.to });
  });
  for (const r of tr.state.selection.ranges) {
    const line = tr.state.doc.lineAt(r.head);
    dirtyRanges.push({ from: line.from, to: line.to });
  }
  const restructured = reparsedSpan(syntaxTree(tr.startState), syntaxTree(tr.state), tr.changes);
  if (restructured) {
    dirtyRanges.push({
      from: tr.state.doc.lineAt(restructured.from).from,
      to: tr.state.doc.lineAt(restructured.to).to,
    });
  }
  return rebuildRanges(mapped, tr.state, dirtyRanges);
}

/**
 * The span of the new document whose top-level parse differs from the old one,
 * or null.
 *
 * An edit can change how distant text parses: closing an unterminated bracket
 * or backtick releases the lines it swallowed. Those lines lie outside the
 * change set, so they are found by comparing top-level nodes from both ends.
 * Typing inside a line updates the tree in place, so there is only something to
 * compare after a structural reparse (see `typst-editor.ts`).
 */
function reparsedSpan(
  oldTree: ReturnType<typeof syntaxTree>,
  newTree: ReturnType<typeof syntaxTree>,
  changes: ChangeSet,
): { from: number; to: number } | null {
  if (oldTree === newTree) return null;
  const before = topLevelNodes(oldTree);
  const after = topLevelNodes(newTree);
  const unchanged = (a: TopLevelNode, b: TopLevelNode) =>
    a.name === b.name
    && !changes.touchesRange(a.from, a.to)
    && changes.mapPos(a.from) === b.from
    && changes.mapPos(a.to) === b.to;

  let head = 0;
  while (head < before.length && head < after.length && unchanged(before[head], after[head])) head++;
  let tail = 0;
  while (
    tail < before.length - head
    && tail < after.length - head
    && unchanged(before[before.length - 1 - tail], after[after.length - 1 - tail])
  ) tail++;
  if (head + tail >= after.length) return null;
  return { from: after[head].from, to: after[after.length - 1 - tail].to };
}

interface TopLevelNode { name: string; from: number; to: number }

function topLevelNodes(tree: ReturnType<typeof syntaxTree>): TopLevelNode[] {
  const nodes: TopLevelNode[] = [];
  const cursor = tree.cursor();
  if (!cursor.firstChild()) return nodes;
  do nodes.push({ name: cursor.name, from: cursor.from, to: cursor.to });
  while (cursor.nextSibling());
  return nodes;
}



// Forces `visualField` to rebuild from the current tree. Dispatched after an
// undo/redo once the parser catches up, and after a whole-document replacement,
// which otherwise leaves decorations from the old tree in place.
export const rebuildVisualDecorations = StateEffect.define<null>();

/**
 * Decoration update for `visualField`: a full or incremental rebuild depending
 * on what changed.
 */
function computeVisualDecorations(decos: DecorationSet, tr: Transaction): DecorationSet {
  // A cell editor covers a small range, so a full rebuild is cheapest.
  if (tr.state.facet(inlineOnlyFacet)) return buildDecorations(tr.state);
  for (const e of tr.effects) {
    if (e.is(rebuildVisualDecorations)) {
      return buildDecorations(tr.state);
    }
  }
  if (tr.docChanged) {
    const ep = tr.state.field(expandedFuncField, false) ?? null;
    if (ep !== null) return buildDecorations(tr.state);
    // Document edits are mapped and rebuilt incrementally.
    return rebuildDocChange(decos, tr);
  }
  if (syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
    // The tree changed without a document change (the async parser finished).
    // There is no change set to map, so rebuild fully.
    return buildDecorations(tr.state);
  }
  if (tr.startState.facet(autoExpandFacet) !== tr.state.facet(autoExpandFacet)) {
    return buildDecorations(tr.state);
  }
  const startExpanded = tr.startState.field(expandedFuncField, false) ?? null;
  const newExpanded = tr.state.field(expandedFuncField, false) ?? null;
  if (startExpanded !== newExpanded) {
    return buildDecorations(tr.state);
  }
  if (tr.selection) {
    const oldLines = cursorLines(tr.startState);
    const newLines = cursorLines(tr.state);
    if (!setsEqual(oldLines, newLines) || cursorNearDecoTrigger(tr.startState) || cursorNearDecoTrigger(tr.state)) {
      return rebuildDirtyLines(decos, tr.state, oldLines, newLines);
    }
  }
  return decos;
}

const visualField = StateField.define<DecorationSet>({
  create(state) {
    // A bad parse tree must not break editor setup; start with no decorations.
    try {
      return buildDecorations(state);
    } catch (err) {
      console.error("visual-plugin: initial decoration build failed; starting with no decorations", err);
      return Decoration.none;
    }
  },
  update(decos, tr) {
    // A throw here would remove the whole visual layer until the note is
    // reopened. Keep the previous decorations, mapped through any change, until
    // the next successful rebuild.
    try {
      return computeVisualDecorations(decos, tr);
    } catch (err) {
      console.error("visual-plugin: decoration rebuild failed; preserving previous decorations until the next clean parse", err);
      return tr.docChanged ? decos.map(tr.changes) : decos;
    }
  },
  provide(field) {
    return EditorView.decorations.from(field);
  },
});

// Rebuilds decorations one frame after each undo/redo, as a safeguard for state
// fields that depend on the syntax tree. The main fix is the `Prec.high`
// wrapping of typst's updateListener in typst-editor.ts.
const postHistoryRebuild = ViewPlugin.fromClass(class {
  pending: number | null = null;

  update(update: ViewUpdate) {
    if (!update.docChanged) return;
    let isHistory = false;
    for (const tr of update.transactions) {
      if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) {
        isHistory = true;
        break;
      }
    }
    if (!isHistory) return;

    const view = update.view;
    if (this.pending !== null) cancelAnimationFrame(this.pending);
    this.pending = requestAnimationFrame(() => {
      this.pending = null;
      view.dispatch({ effects: rebuildVisualDecorations.of(null) });
    });
  }

  destroy() {
    if (this.pending !== null) cancelAnimationFrame(this.pending);
  }
});

export const protectedRangesField = createProtectedRangesField(expandedFuncField, rebuildVisualDecorations);

const protectedCursorFilter = createProtectedCursorFilter(
  protectedRangesField, expandedFuncField, autoExpandFacet,
  BLOCK_WIDGET_FUNCS, extractFirstStringArgRange,
);
const protectedChangeFilter = createProtectedChangeFilter(protectedRangesField);
const tableEntryKeymap = createTableEntryKeymap(visualField);
const verseEntryKeymap = createVerseEntryKeymap(visualField);

// Atomic ranges over each hidden soft-break `\` and its newline. The caret
// can't land between them, and one Backspace or Delete removes both, so the
// break behaves like an ordinary line break.
class SoftBreakRange extends RangeValue {}
const softBreakMarker = new SoftBreakRange();

function computeSoftBreakRanges(state: EditorState): RangeSet<SoftBreakRange> {
  const ranges: Range<SoftBreakRange>[] = [];
  for (let i = 1; i <= state.doc.lines; i++) {
    const slashPos = softBreakSlashPos(state, state.doc.line(i));
    if (slashPos === null) continue;
    // Include the newline when there is one (not on the last line).
    ranges.push(softBreakMarker.range(slashPos, Math.min(slashPos + 2, state.doc.length)));
  }
  return RangeSet.of(ranges);
}

const softBreakRangesField = StateField.define<RangeSet<SoftBreakRange>>({
  create: (state) => computeSoftBreakRanges(state),
  update(value, tr) {
    // Recompute on the same triggers as `visualField`, so the hidden markers
    // and their atomic ranges stay in step.
    for (const e of tr.effects) if (e.is(rebuildVisualDecorations)) return computeSoftBreakRanges(tr.state);
    if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return computeSoftBreakRanges(tr.state);
    }
    return value;
  },
});

const softBreakAtomicRanges = EditorView.atomicRanges.of(
  (view) => view.state.field(softBreakRangesField, false) ?? RangeSet.empty,
);

// ── Atomic markup ranges ──
//
// Replacing decorations (pills, hidden markup, list markers, block widgets)
// should be crossed by one arrow press. CodeMirror doesn't make them atomic, so
// an atomic set is derived from the visual decorations: hidden and widget
// replaces, but not marks, whose text stays editable. Cached per decoration
// set.
class AtomicMarkupRange extends RangeValue {}
const atomicMarkupMarker = new AtomicMarkupRange();
const atomicMarkupCache = new WeakMap<DecorationSet, RangeSet<AtomicMarkupRange>>();

function atomicMarkupRanges(decos: DecorationSet | undefined): RangeSet<AtomicMarkupRange> {
  if (!decos) return RangeSet.empty;
  const cached = atomicMarkupCache.get(decos);
  if (cached) return cached;
  const ranges: Range<AtomicMarkupRange>[] = [];
  const iter = decos.iter();
  while (iter.value) {
    if (iter.from < iter.to && (iter.value === hide || iter.value.spec?.widget != null)) {
      ranges.push(atomicMarkupMarker.range(iter.from, iter.to));
    }
    iter.next();
  }
  const set = RangeSet.of(ranges);
  atomicMarkupCache.set(decos, set);
  return set;
}

const markupAtomicRanges = EditorView.atomicRanges.of(
  (view) => atomicMarkupRanges(view.state.field(visualField, false)),
);

// Markup hiding the start of a line. A caret sent to the line start belongs
// after it, since both positions are drawn in the same place.
//
// Markup replacing a whole line (a rendered verse, a collapsed callout) isn't
// included: the position in front of it is a real place on screen, and entering
// it is `blockBodyCaretEntry`'s job. An empty list item is the exception, since
// typing goes after its bullet.
const lineLeadingMarkupCache = new WeakMap<DecorationSet, RangeSet<AtomicMarkupRange>>();

function lineLeadingMarkupRanges(state: EditorState): RangeSet<AtomicMarkupRange> {
  const decos = state.field(visualField, false);
  if (!decos) return RangeSet.empty;
  const cached = lineLeadingMarkupCache.get(decos);
  if (cached) return cached;
  const ranges: Range<AtomicMarkupRange>[] = [];
  const iter = decos.iter();
  while (iter.value) {
    const replaced = iter.from < iter.to && (iter.value === hide || iter.value.spec?.widget != null);
    if (replaced) {
      const line = state.doc.lineAt(iter.from);
      const coversLine = iter.to >= line.to;
      const isBullet = iter.value.spec?.widget instanceof BulletWidget;
      if (iter.from === line.from && (!coversLine || isBullet)) {
        ranges.push(atomicMarkupMarker.range(iter.from, iter.to));
      }
    }
    iter.next();
  }
  const set = RangeSet.of(ranges);
  lineLeadingMarkupCache.set(decos, set);
  return set;
}

// Caret landing inside a rendered block element (see pill-boundary-nav.ts).
const blockBodyCaretEntry = createBlockBodyCaretEntry(visualField);

const lineStartCaretGuard = lineStartCaretFilter(lineLeadingMarkupRanges);

// Move the caret out of a rendered `#due(...)` pill to just after the call. The
// pill appears once the date is complete, with the caret still inside the call,
// where the next keystroke would corrupt it. A due date is only edited through
// its pill menu, so moving the caret is safe.
//
// This is a view plugin, not a transaction filter, because the pill appears a
// frame later after the async reparse.
const dueCursorRoundOut = ViewPlugin.fromClass(class {
  pending: number | null = null;

  update(u: ViewUpdate) {
    const decosChanged =
      u.startState.field(visualField, false) !== u.state.field(visualField, false);
    if (!u.docChanged && !u.selectionSet && !decosChanged) return;

    const { view } = u;
    const sel = view.state.selection.main;
    if (!sel.empty) return;
    const head = sel.head;
    const decos = view.state.field(visualField, false);
    if (!decos) return;
    const expandedPos = view.state.field(expandedFuncField, false) ?? null;

    let target: number | null = null;
    decos.between(head, head, (rFrom, rTo, value) => {
      if (
        value.spec?.widget instanceof DueWidget &&
        rFrom < head && head < rTo &&   // strictly inside the pill
        expandedPos !== rFrom            // not expanded for raw editing
      ) {
        target = rTo;
        return false;
      }
    });
    if (target === null) return;

    const dest = target;
    if (this.pending !== null) cancelAnimationFrame(this.pending);
    this.pending = requestAnimationFrame(() => {
      this.pending = null;
      const cur = view.state.selection.main;
      // Only nudge if the caret hasn't moved since (the user didn't type on).
      if (cur.empty && cur.head === head) {
        view.dispatch({ selection: { anchor: dest } });
      }
    });
  }

  destroy() {
    if (this.pending !== null) cancelAnimationFrame(this.pending);
  }
});

// CodeMirror keeps scrolling stable across decoration changes by anchoring on
// the top visible line. Don't add a plugin that anchors on the clicked line; if
// a click makes the page jump, a block's two states measure differently, and
// the fix belongs in its geometry (see the shared block variables in
// visual-theme.ts).
export function typstVisualMode(options?: { inlineOnly?: boolean }) {
  // The inline-only variant serves a table cell editor, so table/verse entry,
  // table clipboard routing and the post-undo rebuild are left out.
  if (options?.inlineOnly) {
    return [inlineOnlyFacet.of(true), expandedFuncField, protectedRangesField, protectedCursorFilter, protectedChangeFilter, lineStartCaretGuard, blockBodyCaretEntry, visualField, softBreakRangesField, softBreakAtomicRanges, markupAtomicRanges, visualTheme, linkClickHandler, urlTyping, pillBoundaryNav];
  }
  return [expandedFuncField, protectedRangesField, protectedCursorFilter, protectedChangeFilter, lineStartCaretGuard, blockBodyCaretEntry, dueCursorRoundOut, Prec.high(tableEntryKeymap), Prec.high(verseEntryKeymap), visualField, softBreakRangesField, softBreakAtomicRanges, markupAtomicRanges, postHistoryRebuild, visualTheme, caretLineErrorMute(), linkClickHandler, urlTyping, tableClipboardHandler, cellEditorSync, tableSearchSync, tableScrollHandler, pillBoundaryNav];
}

