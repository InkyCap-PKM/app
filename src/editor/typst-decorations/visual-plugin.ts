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
import {
  CalloutBlockWidget,
  AnnotationBlockWidget,
  CodeBlockWidget,
  ImageBlockWidget,
  MediaBlockWidget,
  BlockquoteBlockWidget,
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
  CALLOUT_COLORS,
  createVerseEntryKeymap,
} from "./widgets";
import { TableWidget } from "./table-widget";
import { parseCanonicalTable } from "./table-parser";
import { fileList } from "../../stores/filelist";
import { getCachedBibKeys, activeReferenceSearchAt } from "./reference-suggest";
import { scanDocumentLabels, type DocLabel } from "./document-labels";
import { FuncPillWidget, FuncChipWidget, BulletWidget, ShorthandWidget, HrWidget, AngleBracketWarningWidget, ANGLE_BRACKET_TAGS, StylePreambleWidget, SetRuleWidget, SymWidget } from "./visual-widgets";
import { symbolGlyph } from "./symbols";
import { highlight, buildHighlightMark } from "./visual-colors";
import { visualTheme } from "./visual-theme";
import { computePreambleImportRanges, isLeadingLocaleDirective, commentHideRange, createProtectedRangesField, createProtectedCursorFilter, createProtectedChangeFilter, externalReload } from "./visual-protected";
export { externalReload } from "./visual-protected";
import { linkClickHandler } from "./visual-links";
import { tableClipboardHandler, tablePasteHandler, createTableEntryKeymap } from "./visual-tables";
import { createClickAnchorPlugin } from "./click-anchor";
import { pillBoundaryNav } from "./pill-boundary-nav";
import { leadingWhitespace } from "./list-scan";

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
// A standalone `@target` that resolves to neither a bibliography entry nor a
// document label — a dangling/typo reference. Flagged so the writer notices it
// won't resolve (the backend escapes it to literal text at compile time).
const refBrokenMark = Decoration.mark({ class: "cm-typst-ref-broken" });
// A small atomic widget that renders a fixed glyph in place of hidden markup —
// e.g. the inline-quote smart quotes over `#quote[` / `]`, or the `[[` `]]` `::`
// brackets that re-skin an editable `#wikilink(...)`. A widget (rather than CSS
// ::before/::after) gives the caret a definite edge to bind to: a caret at the
// boundary sits on the widget's near side, so it renders before/after the glyph
// as expected rather than being pushed past a trailing pseudo-element (the
// "cursor after the closing quote" bug).
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
// Editable-wikilink brackets: a cursor-adjacent `#wikilink("Name", label: "L")`
// is re-skinned as `[[Name::L]]`, hiding the call wrapper behind these widgets
// while the name/label stay as live source text the picker still operates on.
const openWikiBracket = Decoration.replace({ widget: new GlyphWidget("[[", "cm-typst-wikilink-bracket") });
const closeWikiBracket = Decoration.replace({ widget: new GlyphWidget("]]", "cm-typst-wikilink-bracket") });
const wikiHeadingSep = Decoration.replace({ widget: new GlyphWidget("::", "cm-typst-wikilink-bracket") });
// Styling for the editable note/heading text shown between the brackets.
const wikilinkEditMark = Decoration.mark({ class: "cm-typst-wikilink-edit" });
// Block #quote(block:true)[…] body while editing — italic + muted, bounded to
// the body so text trailing after the closing `]` on the same line is NOT
// styled as part of the quote (the bar + geometry come from the line deco).
const blockquoteBodyMark = Decoration.mark({ class: "cm-typst-blockquote-body" });

// `inclusiveEnd` so a replaced widget sitting at the heading's end boundary —
// e.g. the `]]` close-bracket of an editable wikilink whose call ends the line
// (`=== [[Name]]`), or a trailing inline `#tag`/`#footnote` — is drawn *inside*
// the heading span and inherits its font size. Without it, CM closes the
// heading span before that trailing widget, so it renders at base size while
// the rest of the heading stays large.
//
// NB: a line decoration (class on `.cm-line`) was tried here to fix a selection
// measurement glitch, but it broke the first body heading: the preamble's
// multi-line `Decoration.replace` swallows the line break just before it, so the
// heading's line decoration had no line of its own to attach to and was dropped.
// The mark has no such dependency on a real line break, so we keep it. The
// selection glitch is addressed at the selection-rendering layer instead.
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

/** Push a mark range only when the range is non-empty (from < to).
 *  CM6 throws "Mark decorations may not be empty" on zero-length marks. */
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
 * Line-number span of the lines that actually carry body content between
 * `from` and `to`, trimming any leading/trailing line that holds only
 * whitespace (e.g. a multi-line block whose closing `]` sits alone on its own
 * line, leaving `from..to` ending with a bare newline).
 *
 * The editing-mode border on blockquotes/callouts is a per-line decoration, so
 * without this clamp a `#callout(...)[…\n]` paints an extra `border-left`
 * segment on the structural `]`-only line below the text — the "nested"/doubled
 * bar the writer sees when the cursor sits on that trailing line. Clamping to
 * content lines keeps the bar flush with the visible body.
 */
export function contentLineSpan(state: EditorState, from: number, to: number): { start: number; end: number } {
  const text = state.doc.sliceString(from, to);
  let s = 0;
  while (s < text.length && /\s/.test(text[s])) s++;
  let e = text.length;
  while (e > s && /\s/.test(text[e - 1])) e--;
  if (e <= s) {
    // Body is entirely whitespace — collapse to the single opening line.
    const ln = state.doc.lineAt(Math.min(from, state.doc.length)).number;
    return { start: ln, end: ln };
  }
  return {
    start: state.doc.lineAt(from + s).number,
    end: state.doc.lineAt(from + e - 1).number,
  };
}

// Funcs whose `(...)` is never followed by a trailing `[...]` content block.
// Used by the call-end correction so the scanner doesn't sweep an unrelated
// `[` on a following line into the call.
const NO_TRAILING_BRACKET_FUNCS = new Set([
  "table", "note", "bibliography", "image", "video", "audio", "verse", "cite",
]);

/**
 * The true end offset of a `FuncCall` whose lezer node may be wrong.
 *
 * The lezer-typst parser truncates multi-line function calls at the first
 * inner `)`/`]`, so a block call's `node.to` can land in the middle of its
 * own arguments; conversely it can trail past the closing bracket. We recompute
 * the real end by balanced scanning from the first `(`, following an optional
 * trailing `[…]` content block.
 *
 * Crucially this is the SINGLE source of truth shared by the decoration builder
 * (which emits the widget / editing decorations over `funcFrom..funcTo`) and by
 * `expandRangesToBlockElements` (which decides how far to grow a dirty range on
 * a cursor move). If those two disagree on where a block call ends, a partial
 * rebuild grows the wrong line span and keeps a stale editing border behind the
 * freshly rendered widget — the doubled / "nested" bar. Sharing one answer
 * keeps every incremental rebuild covering the whole element.
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
            // Balance the content `[…]` while treating brackets inside inline
            // raw / behind `\`-escapes as literal, so a `[[` documented inside
            // a callout body's backticks doesn't run the call end past its `]`.
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
 * If `line` ends with a managed paragraph soft break — a single unescaped
 * trailing `\` outside any verbatim context — return the document position of
 * that `\`; otherwise null. This is the marker the visual editor inserts on
 * Enter (see `enterInsertsLineBreakFacet`): it is rendered invisibly and the
 * `\␤` pair is made atomic so the writer never sees or lands inside it. Source
 * mode does neither, so the `\` shows there as ordinary text. The
 * verbatim-context check is shared with the Enter keymap so insertion and
 * rendering agree on exactly which `\` are managed breaks.
 */
function softBreakSlashPos(state: EditorState, line: Line): number | null {
  const text = line.text;
  if (text.length === 0 || text[text.length - 1] !== "\\") return null;
  // An escaped backslash (`…\\`) is literal content, not a line break.
  if (text.length >= 2 && text[text.length - 2] === "\\") return null;
  const slashPos = line.from + text.length - 1;
  if (inVerbatimLineContext(state, slashPos)) return null;
  // A `\` trailing a code statement / heading / standalone block call is not a
  // managed soft break — leave it visible so the user can see (and fix) source
  // that would mis-render, rather than silently hiding it.
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
 * True when collapsing a call into a chip/widget that replaces its whole
 * source range would swallow the caret.
 *
 * `closeBrackets()` auto-inserts the `)` the moment the user types `(`, so a
 * half-written `#figure(` is already a *syntactically complete* call with the
 * caret parked between the parens. Replacing that range mid-keystroke makes
 * the call vanish before its arguments have been typed — the visual editor's
 * most jarring failure mode (issue #20).
 *
 * Proximity, not line, is the right granularity: these calls sit inline in
 * prose, so revealing the whole line's source (the `showPill` rule) would
 * churn the surrounding paragraph. The call re-collapses as soon as the caret
 * leaves. Every branch of {@link handleFuncCall} that replaces a call's full
 * range must consult this first.
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

// Top-level node names that are transparent while scanning for the style
// preamble: whitespace, the `#` markers that precede each code expression, and
// comments. They neither start nor end the run.
const PREAMBLE_TRANSPARENT_NODES = new Set([
  "Space", "Parbreak", "Hash", "LineComment", "BlockComment", "Comment",
]);

/**
 * Locate a contiguous *leading* run of `#set` / `#show` rules — the document
 * style preamble — returning its line-aligned range and rule count, or null
 * when there is none. The notebox import line and the `#note(...)` properties
 * call may precede the run; the first prose or other-content node before any
 * set/show rule means there is nothing to collapse. A `#set` that appears only
 * after content (a deliberate local style change) is intentionally left alone —
 * it never starts a preamble.
 *
 * Walks the flat top-level node sequence (Markup's children) rather than
 * scanning line by line: the `#note(...)` properties call spans several lines,
 * and a per-line scan misclassifies its inner/closing lines. The top-level
 * walk sees `note` as a single FuncCall node, so the run boundary is exact.
 */
export function findStylePreamble(state: EditorState): StylePreamble | null {
  const cur = syntaxTree(state).cursor();
  if (!cur.firstChild()) return null;
  let firstFrom = -1;
  let lastTo = -1;
  let count = 0;
  let sawNote = false;
  do {
    const name = cur.name;
    if (PREAMBLE_TRANSPARENT_NODES.has(name)) continue;
    // `#let` bindings join `#set`/`#show` in the collapsible setup run: they're
    // document setup (helper definitions, e.g. a doc's `#let demo(...) = …`),
    // not flowing content, so the visual editor folds them into the same
    // expandable chip rather than showing raw code. They stay fully visible and
    // editable in the source editor.
    if (name === "SetRule" || name === "ShowRule" || name === "LetBinding") {
      // A leading document-language directive (`#set text(lang/region)`) before
      // the `#note(...)` is locale typesetting machinery, not document setup:
      // it's hidden with the imports (see `computePreambleImportRanges`), so it
      // must neither start nor join this collapsible chip — otherwise it forms a
      // lone chip ahead of the note and strands the real setup block that
      // follows it. After the note (or once a real rule has anchored the run) a
      // lang change is ordinary setup and folds normally.
      if (firstFrom < 0 && !sawNote && name === "SetRule"
          && isLeadingLocaleDirective(state.doc.sliceString(cur.from, cur.to))) {
        continue;
      }
      if (firstFrom < 0) firstFrom = cur.from;
      lastTo = cur.to;
      count++;
      continue;
    }
    if (firstFrom < 0) {
      // Header items allowed before the run.
      if (name === "ModuleImport") continue;
      if (name === "FuncCall") {
        const head = state.doc.sliceString(cur.from, Math.min(cur.from + 8, cur.to));
        if (/^note\b/.test(head)) { sawNote = true; continue; }
      }
      return null; // some other leading construct — no collapsible preamble
    }
    break; // real content ends the run
  } while (cur.nextSibling());
  if (firstFrom < 0 || count < 1) return null;
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
 * Top-level named-argument keys of a function-call argument list, starting at
 * the `(` at `openParen`. Returns only depth-1 `name:` keys — nested keys
 * (`margin: (top: …)`) and positional args are skipped — so the set-rule label
 * names the property being configured, not the values. String literals are
 * treated as opaque so a `:` or `(` inside `"…"` never registers.
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
 * Friendly chip label for a standalone `#set` / `#show` rule, derived from its
 * source: the rule keyword, its target, and — for set rules — the property
 * being configured, so two `#set text(…)` rules read distinctly:
 * `#set text(size: 12pt)` → `set text: size`, `#set text(font: …)` → `set text:
 * font`. Up to two keys are shown (`…` beyond that); a rule with no recognizable
 * key, a `#show heading: …`, or a bare `#show: …` falls back to keyword+target
 * (or just the keyword). Kept literal — Typst identifiers aren't translatable,
 * matching how every other pill shows its raw `funcName`.
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
 * Display number for an ordered-list (`EnumMarker`) item, computed purely
 * from the document text so it is identical whether the whole document or a
 * single slice is being re-decorated.
 *
 * Typst accepts two ordered-list markers: an explicit number (`1.`) and the
 * auto-numbering `+`. We honour an explicit number verbatim — the writer
 * typed it, so we show exactly that — which is both predictable and correct
 * for `1. / 2.` lists. For `+` we count the run of consecutive enum items at
 * the same indent immediately above this one (a blank line, a shallower
 * item, or any non-enum line ends the run), giving the natural 1, 2, 3…
 * sequence. Counting locally — rather than threading a mutable counter across
 * the iteration and reseeding it from a pre-scan — is what keeps the number
 * stable when the cursor moves and only part of the document is rebuilt; the
 * old shared-counter approach drifted on every partial rebuild.
 */
function enumItemNumber(state: EditorState, markerFrom: number): string {
  const line = state.doc.lineAt(markerFrom);
  // Read the indent from the line text rather than from the marker's position.
  // A list marker is always the first thing on its line, so the two agree —
  // except in the moment after an edit, when the syntax tree may still hold
  // the marker's pre-edit position. Taking it from the text keeps the number
  // right through an indent, where a stale position made every item read as
  // nested and restart at 1.
  const indent = leadingWhitespace(line.text);
  const explicit = line.text.slice(indent).match(/^(\d+)\./);
  if (explicit) return `${explicit[1]}.`;

  // "+" marker: its position is the length of the same-indent enum run above.
  let count = 1;
  for (let n = line.number - 1; n >= 1; n--) {
    const m = state.doc.line(n).text.match(/^(\s*)(?:\+|\d+\.)(?:\s|$)/);
    if (!m) break;                      // non-enum line ends the list
    const prevIndent = m[1].length;
    if (prevIndent < indent) break;     // parent level — our run starts below it
    if (prevIndent > indent) continue;  // nested child — does not affect our number
    count++;
  }
  return `${count}.`;
}

/**
 * Amplify nested-list indentation in the visual editor so the levels are easy
 * to tell apart at a glance. Typst encodes nesting purely as leading
 * whitespace, which renders at the (narrow, proportional) space width of the
 * body font — too subtle to read as distinct levels, especially next to a tool
 * like Obsidian that indents by a fixed, generous step. We add left padding to
 * the list line proportional to its leading whitespace, which roughly doubles
 * the visual step per level without touching the source. The marker and text
 * still sit after the marker widget (which replaces the leading whitespace and
 * the marker together — see the `ListMarker`/`EnumMarker` cases), so editing
 * the raw line is unchanged; this is a display-only nicety (visual editor as a
 * friendliness tool — see CLAUDE.md). `LIST_INDENT_CH` is the amount added per
 * leading column, in `ch` units (wider than a proportional space, which is what
 * gives the amplification).
 *
 * The same line decoration also applies a hanging indent. The line carries
 * `padding-left` of (nesting + one bullet width), which pushes every *wrapped*
 * continuation line in to align with the item's text. The first line's bullet
 * is then pulled back under the marker by a negative `margin-left` of one bullet
 * width on the bullet widget itself (see `.cm-typst-list-bullet`) — NOT by a
 * negative `text-indent` on the line. WebKitGTK (the app's renderer) does not
 * reliably offset a leading inline-block by `text-indent`, so the indent and the
 * widget failed to cancel there and the bullet escaped a full bullet-width into
 * the left margin, landing outside the heading/text column. A negative margin on
 * the concrete widget element is honoured consistently. Because the marker widget
 * replaces the leading whitespace (the spaces are not laid out inline), the first
 * line and its wrapped continuations share one content-box edge, so the alignment
 * is exact at every nesting level — no proportional-space-width guesswork.
 */
const LIST_INDENT_CH = 1.2;

/**
 * The document range the bullet/number widget replaces for a list marker node.
 * Spans from the line start — swallowing the leading indentation so the bullet
 * stands alone at the content-box edge — through the marker's *single* separating
 * space, so the item's text begins exactly at the bullet box's end.
 *
 * Both ends matter for the hanging indent. Leaving the leading whitespace in
 * the flow would offset the first line from its wrapped continuations; leaving
 * the marker's one separator space in the flow would push the first line one
 * space-width right of those continuations (which have no such space). With both
 * folded into the widget, text starts at exactly `--list-bullet-width` past the
 * bullet on every visual row, so wrapped lines align precisely.
 *
 * Crucially, only ONE space is folded in — not the whole whitespace run. If the
 * caret sits at the start of the item text and the user types a space, that
 * extra space must stay in the flow and be visible; folding the entire run would
 * absorb each typed space back into the widget, making the keystroke look like a
 * no-op (the text never moves right).
 */
/**
 * Whether a list/enum marker is immediately followed by a separating space or
 * tab — the character that turns `-`/`+`/`N.` into an actual Typst list item.
 * A bare marker with no separator is just typed text, so the visual editor
 * leaves it undecorated until the writer types the space.
 */
function markerHasSeparator(state: EditorState, node: { to: number }): boolean {
  return /^[ \t]/.test(state.doc.sliceString(node.to, node.to + 1));
}

function markerReplaceRange(
  state: EditorState,
  node: { from: number; to: number },
): [number, number] {
  const lineFrom = state.doc.lineAt(node.from).from;
  // Callers only reach here for markers that have a separator (see the
  // ListMarker/EnumMarker cases), so the separator space is always folded in.
  return [lineFrom, node.to + (markerHasSeparator(state, node) ? 1 : 0)];
}

function pushListIndent(decos: Range<Decoration>[], state: EditorState, markerFrom: number) {
  const line = state.doc.lineAt(markerFrom);
  const cols = markerFrom - line.from; // leading-whitespace width, in chars
  const nest = cols > 0 ? `${(cols * LIST_INDENT_CH).toFixed(2)}ch + ` : "";
  decos.push(
    Decoration.line({
      attributes: {
        // padding-left sets the text column (and where wrapped lines align);
        // the bullet widget's own negative margin-left pulls the marker back to
        // the column edge for the hanging indent (see the doc comment above —
        // text-indent is unreliable for a leading inline-block on WebKitGTK).
        style: `padding-left: calc(${nest}var(--list-bullet-width))`,
      },
    }).range(line.from),
  );
}

function buildDecorations(state: EditorState, onlyRanges?: { from: number; to: number }[]): DecorationSet {
  const focused = cursorLines(state);
  const cursors = cursorPositions(state);
  const autoExpand = state.facet(autoExpandFacet);
  const expandedPos = state.field(expandedFuncField, false) ?? null;
  const decos: Range<Decoration>[] = [];

  // Document style preamble: a contiguous leading run of #set/#show rules is
  // collapsed to a single chip unless the cursor is inside it or it was clicked
  // open (expandFunc). Collapsing skips its inner nodes during iteration so the
  // raw markup isn't rendered behind the widget.
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
    // Inline replace spanning the block's lines — same recipe the cursor-away
    // callout/quote widgets use. The widget's root is a block-level element, so
    // it occupies its own line even though the decoration is inline.
    decos.push(
      Decoration.replace({
        widget: new StylePreambleWidget(stylePreamble.from, stylePreamble.to, stylePreamble.count),
      }).range(stylePreamble.from, stylePreamble.to),
    );
  }

  const escapeRanges = new Set<string>();
  const escapeDecos: { from: number; backslashEnd: number; charEnd: number }[] = [];
  const activeFormatting = { bold: false, italic: false, strike: false, highlight: false };
  let consumedUntil = -1;

  // Document labels, computed once per pass on first `@reference` encountered.
  // Must cover the whole document (not just `onlyRanges`): a reference inside an
  // incrementally-updated range can point at a label defined elsewhere.
  let docLabelMap: Map<string, DocLabel> | null = null;
  const getDocLabelMap = (): Map<string, DocLabel> => {
    if (!docLabelMap) {
      docLabelMap = new Map();
      for (const l of scanDocumentLabels(state)) docLabelMap.set(l.name, l);
    }
    return docLabelMap;
  };

  // Hide the leading import block — the notebox import plus any package
  // imports (e.g. `#import "@preview/mitex:…": …`) a user or template added.
  // They stay visible/editable in the source editor; here they're collapsed
  // away so the visual editor opens on the document body. (Locking is handled
  // by computeProtectedRanges, which covers the same ranges.)
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
            // Typst comments are source-only — collapse them away entirely in
            // the visual editor (the `hide` decoration is auto-atomic, and the
            // protected-range machinery locks + skips the cursor past them).
            const r = commentHideRange(state, node.from, node.to);
            decos.push(hide.range(r.from, r.to));
            return false;
          }
          case "Strong": {
            if (isCursorAdjacentOrInside(state, node.from, node.to, cursors)) return false;
            if (autoExpand && onCursor) return false;
            activeFormatting.bold = true;
            decos.push(hide.range(node.from, node.from + 1));
            decos.push(hide.range(node.to - 1, node.to));
            pushMark(decos, bold, node.from + 1, node.to - 1);
            break;
          }
          case "Emph": {
            if (isCursorAdjacentOrInside(state, node.from, node.to, cursors)) return false;
            if (autoExpand && onCursor) return false;
            activeFormatting.italic = true;
            decos.push(hide.range(node.from, node.from + 1));
            decos.push(hide.range(node.to - 1, node.to));
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
            // Only render the bullet once the marker is followed by a real
            // separating space — i.e. `- ` is a list item but a bare `-` is
            // just a typed character. Rendering a bullet on a bare marker made
            // the line *look* like a list before the writer had typed the
            // space, so their next keystroke produced `-text` (not a list) and
            // the bullet vanished. Gating on the space matches how markdown
            // editors form lists and keeps the display honest.
            if (!markerHasSeparator(state, node)) break;
            pushListIndent(decos, state, node.from);
            decos.push(
              Decoration.replace({ widget: new BulletWidget("•") }).range(...markerReplaceRange(state, node)),
            );
            return false;
          }
          case "EnumMarker": {
            if (!markerHasSeparator(state, node)) break;
            pushListIndent(decos, state, node.from);
            decos.push(
              Decoration.replace({ widget: new BulletWidget(enumItemNumber(state, node.from)) }).range(...markerReplaceRange(state, node)),
            );
            return false;
          }
          case "Raw": {
            const text = state.doc.sliceString(node.from, node.to);
            const isBlock = text.startsWith("```");
            if (!isBlock) {
              // Typst's parser is error-tolerant, so a lone or still-unclosed
              // backtick already parses as a Raw node. Hiding its delimiters
              // here would make the backtick the user just typed disappear the
              // moment the cursor moves off it. Only collapse the markup once a
              // real closing backtick exists (matched pair, at least two chars).
              const closed = text.length >= 2 && text.endsWith("`");
              if (!closed) return false;
              if (isCursorAdjacentOrInside(state, node.from, node.to, cursors)) return false;
              if (autoExpand && onCursor) return false;
              decos.push(hide.range(node.from, node.from + 1));
              decos.push(hide.range(node.to - 1, node.to));
              pushMark(decos, rawInline, node.from + 1, node.to - 1);
            } else {
              if (isCursorAdjacentOrInside(state, node.from, node.to, cursors)) {
                const startLine = state.doc.lineAt(node.from);
                const endLine = state.doc.lineAt(node.to);
                for (let ln = startLine.number; ln <= endLine.number; ln++) {
                  const line = state.doc.line(ln);
                  decos.push(
                    Decoration.line({ class: "cm-typst-codeblock-edit" }).range(line.from),
                  );
                }
                return false;
              }
              const firstNewline = text.indexOf("\n");
              const lang = firstNewline > 3 ? text.substring(3, firstNewline).trim() : "";
              const lastDelim = text.lastIndexOf("```");
              const codeStart = firstNewline >= 0 ? firstNewline + 1 : 3;
              const codeEnd = lastDelim > 3 ? lastDelim : text.length;
              const code = text.substring(codeStart, codeEnd).trimEnd();
              decos.push(
                Decoration.replace({
                  widget: new CodeBlockWidget(lang, code),
                }).range(node.from, node.to),
              );
            }
            return false;
          }
          case "Equation": {
            const text = state.doc.sliceString(node.from, node.to);
            const isDisplay = text.startsWith("$ ") || text.startsWith("$\n");
            if (isDisplay) {
              decos.push(mathDisplay.range(node.from, node.to));
            } else {
              if (isCursorAdjacentOrInside(state, node.from, node.to, cursors)) return false;
              if (autoExpand && onCursor) return false;
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
            if (isCursorAdjacentOrInside(state, node.from, node.to, cursors)) return false;
            const refText = state.doc.sliceString(node.from, node.to);
            if (refText.startsWith("@")) {
              // While this `@…` is the target of a live citation search, leave it
              // as plain editable text — pilling it mid-search (e.g. `@einstein`
              // while the writer is still typing `relativity` to find the paper)
              // would make a multi-word query feel like it had already resolved.
              if (activeReferenceSearchAt() === node.from) return false;
              // Typst's `@` is the universal reference operator: it resolves to a
              // bibliography entry (a citation) OR an in-document `<label>`
              // (heading, figure, equation, table). Decide which by consulting
              // both the cached bib keys and the document's labels.
              const key = refText.slice(1);
              const bibKeys = getCachedBibKeys();
              const label = getDocLabelMap().get(key);
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
                // Bibliography not loaded yet — render optimistically as a
                // citation so a real `@cite` doesn't flash a broken state before
                // entries arrive. Flips to its true form once the cache fills.
                decos.push(
                  Decoration.replace({
                    widget: new CitationWidget(key, node.from, node.to),
                    inclusiveStart: false,
                    inclusiveEnd: false,
                  }).range(node.from, node.to),
                );
              } else {
                // Resolves to neither a citation nor a label. Distinguish an
                // email's `@domain` (preceded by a word character — render as
                // plain text) from a standalone reference that didn't resolve
                // (preceded by whitespace/punctuation — flag it so the writer
                // sees it won't resolve).
                const before = node.from > 0 ? state.doc.sliceString(node.from - 1, node.from) : "";
                const attached = /[\p{L}\p{N}]/u.test(before);
                decos.push((attached ? refPlainMark : refBrokenMark).range(node.from, node.to));
              }
            } else {
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
            // `ghost` renders a dimmed placeholder for non-printing shorthands —
            // a soft hyphen is invisible in output, so we show a faint "-" to
            // mark the optional break point rather than letting the source
            // silently vanish in the visual editor.
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
            // `#sym.*` named-symbol references render as a glyph pill. The `#`
            // is a separate sibling Hash node, so a sym reference is a
            // FieldAccess whose preceding char is `#`. Only the outermost
            // FieldAccess is handled (we return false to skip the nested ones).
            // Any other field access falls through to default raw rendering.
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
            // A contiguous *leading* run of set/show rules is the document
            // style preamble, collapsed into a single StylePreambleWidget
            // above — skip those here (when that preamble is expanded for
            // editing we also want raw source, so returning false is correct
            // either way). A set/show rule that appears *after* content — e.g.
            // a local `#set text(…)` / `#set par(…)` inserted from the `/` Style
            // menu — reaches here and gets the same pill affordance as every
            // other Typst call instead of rendering as raw markup.
            if (stylePreamble && posWithinPreamble(node.from, stylePreamble)) return false;
            // A leading document-language directive (`#set text(lang/region)`)
            // is already collapsed with the imports above (see
            // computePreambleImportRanges) — it's preamble machinery, not a
            // body style change, so it must not also surface as a pill here. A
            // `#set text(lang: …)` placed later in the body is genuine style and
            // falls outside these ranges, so it still gets its pill.
            if (preambleImportRanges.some((r) => node.from >= r.from && node.from < r.to)) return false;
            const ruleFrom = (node.from > 0 && state.doc.sliceString(node.from - 1, node.from) === "#")
              ? node.from - 1 : node.from;
            // Reveal raw source when the cursor is on the rule's line or the
            // pill was clicked open — the standard collapse decision the other
            // block pills use, so the rule stays directly editable in place.
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
            // The lezer-typst parser truncates multi-line FuncCalls at the
            // first inner `)`/`]`, so `node.to` (and the `onCursor` computed
            // from it above) misses lines added by the user. Recompute the true
            // end via the shared correction so the cursor staying inside a
            // growing callout/quote body keeps the live-edit decoration stable,
            // and so the dirty-range expander agrees on the same bounds (see
            // correctedFuncCallEnd / expandRangesToBlockElements).
            const funcTo = correctedFuncCallEnd(state, funcFrom, node.to);
            const callOnCursor = isOnCursorLine(state, funcFrom, funcTo, focused);
            // Decorate this call defensively: a single malformed or unusual call
            // — e.g. a collaborator's `#suggestion(…)` tracked-change markup with
            // content the extractors don't expect — must not throw out of the
            // build and drop the *entire* visual layer, which renders the whole
            // note as raw source. On failure, discard any partial decorations
            // from this call and skip it (it falls back to raw source locally)
            // while the rest of the note still renders.
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
            const funcText = state.doc.sliceString(funcFrom, funcTo);
            const funcHashOff = funcText.startsWith("#") ? 1 : 0;
            const funcDelim = funcText.indexOf("(", funcHashOff);
            const funcBrack = funcText.indexOf("[", funcHashOff);
            const funcDIdx = (funcDelim >= 0 && funcBrack >= 0)
              ? Math.min(funcDelim, funcBrack)
              : (funcDelim >= 0 ? funcDelim : funcBrack);
            if (funcDIdx >= 0) {
              const fn = funcText.substring(funcHashOff, funcDIdx).trim();
              if (fn === "strike") activeFormatting.strike = true;
              else if (fn === "highlight") activeFormatting.highlight = true;
              else if (fn === "strong") activeFormatting.bold = true;
              else if (fn === "emph") activeFormatting.italic = true;
            }
            break;
          }
        }
    },
    leave(node) {
      if (node.name === "Strong") activeFormatting.bold = false;
      if (node.name === "Emph") activeFormatting.italic = false;
      if (node.name === "FuncCall") {
        activeFormatting.strike = false;
        activeFormatting.highlight = false;
      }
    },
  });

  // Text-level escape scan — fallback for cases where the parser doesn't
  // emit Escape nodes (e.g. \# may be parsed as code-mode entry instead).
  // Use escapeRanges (populated by tree-based Escape handler) to avoid doubles.
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
  // Fetched once for the raw/code-context check below; the tree is invariant
  // across this scan.
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

  // Hide trailing `\` paragraph-break markers in visual mode — always, even on
  // the cursor line. The `\` is meaningful in source mode and the compiled
  // output, but in the visual editor the line break itself is the feedback and
  // the marker only gets in the way of writing. We keep it invisible at all
  // times and instead make the `\␤` pair atomic (see `softBreakRangesField`)
  // so the writer edits across the break — type, backspace, delete — without
  // ever seeing or landing inside the `\`.
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

  decos.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  return RangeSet.of(decos);
}

const BLOCK_FUNCS = new Set([
  "callout", "quote", "verse", "note", "bibliography", "table",
]);

// These funcs always render as widgets even on cursor line — click navigates,
// edit via source mode or cursor-adjacent positioning.
// `task` and `due` are NOT in INTERACTIVE_FUNCS: they render as widgets,
// but on cursor-line they also surface a `FuncPillWidget` so the user can
// edit body/due/done/label through the standard pill menu (see
// pill-options.ts taskOptions / dueOptions). Their case branches handle
// both decorations explicitly, mirroring how `cite` combines a pill with
// the citation widget.
// `footnote` joins this set so it renders as its compact widget but reveals
// the raw `#footnote[…]` source the moment the cursor is adjacent or inside —
// the same temporary-expand-on-cursor affordance wikilinks use — instead of
// staying an opaque widget that can only be edited from source mode.
// `suggestion` is deliberately NOT here: like `task` it always renders its
// widget (click → Accept/Reject/Comment dialogue) and surfaces a standard
// FuncPillWidget on the cursor line — clicking the pill expands the raw source
// inline for editing. Its case below pushes both decorations.
const INTERACTIVE_FUNCS = new Set(["wikilink", "tag", "link", "footnote"]);

/** Best-effort extraction of an ISO `YYYY-MM-DD` date from a snippet of
 *  Typst source — recognizes a `datetime(...)` call (positional or named
 *  args) and a quoted `"YYYY-MM-DD"` string. Returns null when neither. */
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

/**
 * Decorate a single `#func(...)` / `#func[...]` call, pushing its decorations
 * onto `decos`. Returns true when the caller should keep traversing the call's
 * children (the body stays live source), false when this call owns its whole
 * range (a widget replaced it, or the raw markup is deliberately exposed).
 *
 * Deliberately parser-independent — it works off the sliced source text, not
 * the syntax tree — so the collapse rules can be unit-tested against a plain
 * `EditorState` with no language configured (see func-collapse.test.ts).
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
  formatting: { bold: boolean; italic: boolean; strike: boolean; highlight: boolean } = { bold: false, italic: false, strike: false, highlight: false },
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

  // `#align(left|center|right)[#image(...)]` is treated as a placed image —
  // it renders as the image block widget (with the alignment applied), not a
  // generic align pill. Any other `#align` use stays generic.
  const alignedImage = funcName === "align" ? parseAlignedImage(text) : null;

  if (INTERACTIVE_FUNCS.has(funcName)) {
    // wikilink stays interactive (no generic pill) but renders an editable
    // `[[Name]]` form on cursor instead of dropping to raw `#wikilink(...)`
    // source — handled in its case below, so it must not early-return here.
    if (funcName !== "wikilink" && isCursorAdjacentOrInside(state, from, to, cursors)) return false;
  } else if (BLOCK_WIDGET_FUNCS.has(funcName) || funcName === "callout" || funcName === "quote" || funcName === "annotation" || alignedImage) {
    // image, callout, quote, annotation use the pill-above-element pattern:
    // the element stays rendered; a pill is shown above it on cursor
    // entry; clicking the pill exposes the raw markup for editing while
    // the element re-renders as a block widget below. All handled in
    // the case below — no early return here.
  } else if (BLOCK_FUNCS.has(funcName)) {
    if (funcName === "table" && expandedPos === from) return false;
    // Verse always renders as its widget — the contentEditable canvas
    // inside owns the editing experience. Focus routing on insertion
    // is handled inside the widget's toDOM (auto-focus the canvas
    // when CM selection is inside the widget's body range).
  } else {
    const isExpanded = expandedPos === from;
    if (isExpanded || (autoExpand && onCursor)) return false;
  }

  // For inline pill-eligible funcs (strike/highlight/etc.): show pill
  // when cursor is on line, hide when far away. Block-element funcs
  // handle their pill placement themselves below.
  const showPill = onCursor && hashOffset === 1
    && !BLOCK_FUNCS.has(funcName) && !INTERACTIVE_FUNCS.has(funcName)
    && !BLOCK_WIDGET_FUNCS.has(funcName) && !alignedImage;

  // Decoration recipe for block elements (image, callout, quote)
  // that uses the pill-above-element pattern. Three states:
  //   • cursor away: replace [from..to] with the element widget.
  //   • cursor on line: same replace, but the widget renders a small
  //     pill row at its top (withPill = true). Element is pushed down
  //     by ~1 row but stays fully visible.
  //   • expanded (or autoExpand on cursor): drop the replace so raw
  //     markup is visible, and render the element as a block widget
  //     below via side: 1 at `to` (withPill = false there — the raw
  //     markup itself is the editing affordance).
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
      // R12 inline content-bracket pills: hide #fn[ and ] when cursor is
      // off the line (pill replaces the leading marker), apply a CSS
      // mark to the body so the visual representation matches the
      // function while keeping the body live-editable Typst source.
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
      // `#line(length: …, stroke: …)` takes arguments, so a hand-typed call
      // must stay editable while the caret is in it — the rule renders once
      // the caret leaves.
      if (collapseWouldSwallowCaret(state, from, to, cursors)) return false;
      if (/^#line\b/.test(text)) {
        decos.push(Decoration.replace({
          widget: showPill ? new FuncChipWidget(from, "line") : new HrWidget(),
        }).range(from, to));
      }
      return false;
    }
    case "callout": {
      const kind = extractFirstStringArg(text);
      const title = extractNamedStringArg(text, "title");
      if (!kind) return false;
      const bodyRange = bracketRangeAfterArgs(text, from);
      if (bodyRange === null) return false;
      // "Edit source": callout is an ALWAYS_EXPAND_PILL, so clicking its pill
      // (or the menu's "Edit source") dispatches expandFunc against `from`. The
      // in-place body editing below only exposes the body text — it can't reach
      // the kind/title/other args — so honour the expand request the same way
      // figure/bibliography/annotation do: drop all decorations and reveal the
      // raw `#callout(...)` markup. Re-collapses once the cursor leaves.
      // `autoExpand` (the "edit raw source in visual mode" setting) reveals it
      // on every cursor-line entry, like the other funcs.
      if (expandedPos === from || (autoExpand && onCursor)) return false;
      // Same model as block quote: a single rendered widget when the cursor is
      // away, and an in-place editable body (real text + callout styling, no
      // duplicate, no caret trap) when it's on. Replaces the old
      // pushBlockElement "source + side:1 preview" path that rendered twice.
      if (!onCursor) {
        const bodyText = state.doc.sliceString(bodyRange.from, bodyRange.to);
        decos.push(
          Decoration.replace({ widget: new CalloutBlockWidget(kind, title ?? "", bodyText, from, false, bodyRange.from) }).range(from, to),
        );
        return false;
      }
      const color = CALLOUT_COLORS[kind] ?? CALLOUT_COLORS.note;
      decos.push(
        Decoration.replace({ widget: new FuncPillWidget(from, "callout") }).range(from, bodyRange.from),
      );
      if (bodyRange.to < to) decos.push(hide.range(bodyRange.to, to));
      const calloutSpan = contentLineSpan(state, bodyRange.from, bodyRange.to);
      for (let ln = calloutSpan.start; ln <= calloutSpan.end; ln++) {
        decos.push(
          Decoration.line({
            class: "cm-typst-callout-line",
            attributes: { style: `border-left-color: ${color};` },
          }).range(state.doc.line(ln).from),
        );
      }
      // Tint only the body, not any text trailing after the closing `]`.
      if (bodyRange.from < bodyRange.to) {
        decos.push(
          Decoration.mark({
            attributes: { style: `background-color: color-mix(in srgb, ${color} 8%, transparent);` },
          }).range(bodyRange.from, bodyRange.to),
        );
      }
      return false;
    }
    case "annotation": {
      const bodyText = extractBracketContent(text);
      if (bodyText === null) return false;
      const by = extractNamedStringArg(text, "by");
      const on = extractNamedStringArg(text, "on");
      // Absolute offset where the `[…]` body begins, so an inline task's
      // checkbox can resolve its own call position (see renderTypstBody ctx).
      const bracketIdx = text.indexOf("[");
      const annBodyFrom = bracketIdx >= 0 ? from + bracketIdx + 1 : from;
      // Unlike callout/quote, a comment has nothing to preview while you edit
      // it, so we don't use the side:1 "source + preview" pattern (which would
      // show the annotation twice while editing). Expanded ⇒ raw source only;
      // collapsed ⇒ a single block widget (with a pill on the cursor line).
      const isExpanded = expandedPos === from || (autoExpand && onCursor);
      if (!isExpanded) {
        decos.push(
          Decoration.replace({
            widget: new AnnotationBlockWidget(bodyText, by ?? "", on ?? "", from, onCursor, annBodyFrom),
          }).range(from, to),
        );
      }
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
      // Pill shows even when the body is missing — an auto-paired `#task()`
      // (typed by hand, before a description exists) still gets the pill, so the
      // visual editor confirms "yes, this function exists" while the user is
      // still typing rather than staying silent until the call is fully formed.
      // Mirrors the `due` case; addresses issue #24.
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
        // Caret on/adjacent to the call → reveal the raw `#task("…")` source
        // for inline editing, the same temporary-expand-on-cursor affordance
        // footnote and wikilink use. The pill above stays available for the
        // done/due/label menu; moving the caret away collapses the source back
        // to the checkbox widget below.
        if (isCursorAdjacentOrInside(state, from, to, cursors)) return false;
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
      // Pill shows even when the date is missing — that's how the user
      // fills one in via the menu after a slash-inserted `#due()`.
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

      // Editing affordance: when the cursor is on/adjacent to the call, re-skin
      // it as an editable `[[Name]]` / `[[Name::label]]` instead of revealing
      // raw `#wikilink(...)`. The call's own source is untouched, so the
      // wikilink suggestion picker (which scans the source) keeps working; the
      // bracket/`::` widgets just hide the function wrapper, and the name/label
      // stay as live editable text between them.
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
      // `#link(<label>)[…]` — a label reference (intra-document anchor) rather
      // than a string URL. Render it as an internal link instead of letting it
      // fall through to raw source.
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
      // Same model as #task: the tracked-change marks always render as the
      // SuggestionWidget (click → Accept/Reject/Comment dialogue), and when the
      // cursor is on the line a standard FuncPillWidget appears. Clicking the
      // pill expands the raw `#suggestion(...)` source inline (the standard pill
      // behaviour), so multi-paragraph proposals are edited as real text rather
      // than crammed into a popup field; source mode remains available too.
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
      return false;
    }
    case "verse": {
      const range = extractFirstEscapedStringArgRange(text, from);
      if (range !== null) {
        const source = state.doc.sliceString(range.from, range.to);
        const alignArg = (text.match(/align-to\s*:\s*(left|center|right)\b/) ?? [])[1];
        const fontArg = extractNamedStringArg(text, "font");
        // weight: integer (the pill emits this) — named-string literals
        // like `"bold"` aren't surfaced by the pill but still parse fine
        // in lib.typ; we just don't reflect them in the chip's active
        // state.
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
      // Branch on `block:` so the visual editor matches what Typst
      // actually renders. Block form → display blockquote widget with
      // attribution. Inline form → mid-paragraph live-edit pill with
      // CSS smart-quote brackets (the inline form is essentially HTML
      // `<q>` — Typst doesn't render attribution inline either).
      const isBlock = /\bblock\s*:\s*true\b/.test(text);
      if (isBlock) {
        const bodyRange = bracketRangeAfterArgs(text, from);
        if (bodyRange === null) return false;
        // "Edit source": block quote is an ALWAYS_EXPAND_PILL, so its pill (and
        // the menu's "Edit source") dispatches expandFunc against `from`. The
        // in-place body editing below can't reach the attribution/other args, so
        // honour the expand request by revealing the raw `#quote(...)` markup —
        // matching callout/figure/bibliography. Re-collapses when the cursor leaves.
        // `autoExpand` (the "edit raw source" setting) reveals it on every
        // cursor-line entry, like the other funcs.
        if (expandedPos === from || (autoExpand && onCursor)) return false;
        // Edit in place when the cursor is on the quote; render a widget when
        // it's away. We deliberately do NOT use the old "raw source + side:1
        // preview widget" pattern: it rendered the quote twice and left a
        // block widget at `to` that trapped the caret. Instead we follow the
        // Tier-1 decoration model used by the inline content-bracket pills.
        if (!onCursor) {
          // Cursor away → one rendered blockquote widget. Single, atomic,
          // no trailing block widget, so nothing to duplicate or trap.
          const content = state.doc.sliceString(bodyRange.from, bodyRange.to);
          const attribution = extractAttributionDisplay(text);
          decos.push(
            Decoration.replace({ widget: new BlockquoteBlockWidget(content, attribution, from, false, bodyRange.from) }).range(from, to),
          );
          return false;
        }
        // Cursor on the quote → edit the body as real CodeMirror text: a
        // quote pill replaces the `#quote(block: true)[…]` opener, the
        // closing `]` is hidden, and the body's lines get blockquote styling.
        // Native cursor/undo, no contentEditable, no round-trip.
        decos.push(
          Decoration.replace({ widget: new FuncPillWidget(from, "quote") }).range(from, bodyRange.from),
        );
        if (bodyRange.to < to) decos.push(hide.range(bodyRange.to, to));
        const quoteSpan = contentLineSpan(state, bodyRange.from, bodyRange.to);
        for (let ln = quoteSpan.start; ln <= quoteSpan.end; ln++) {
          decos.push(
            Decoration.line({ class: "cm-typst-blockquote-line" }).range(state.doc.line(ln).from),
          );
        }
        // Italic/colour only over the body — keeps any text trailing after the
        // closing `]` on the same line looking like the ordinary text it is.
        if (bodyRange.from < bodyRange.to) {
          decos.push(blockquoteBodyMark.range(bodyRange.from, bodyRange.to));
        }
        return false;
      }
      // Inline: same content-bracket pill pattern as #strike, #emph, etc.
      // The body stays live-editable Typst source between two atomic smart-
      // quote widgets that stand in for the hidden `#quote[` opener and `]`
      // closer, so the visual representation tracks Typst's `<q>`-like
      // rendering. Widgets (rather than ::before/::after on the body) keep the
      // caret on the correct side of each quote — see QuoteGlyphWidget.
      // Note: "quote" is in BLOCK_FUNCS (for the block form), so the
      // generic showPill is always false. Compute it locally for inline.
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
      // When the user clicks the pill, expandedPos === from, exposing the
      // raw `#bibliography(...)` source for inspection or editing — same
      // pattern as other expandable funcs.
      if (expandedPos === from) return false;
      // Typing the path by hand must not be interrupted by the block widget
      // replacing the call out from under the caret.
      if (collapseWouldSwallowCaret(state, from, to, cursors)) return false;
      const path = extractFirstStringArg(text) ?? "";
      let replaceEnd = to;
      const docLen = state.doc.length;
      // Absorb a trailing newline + blank line so the line doesn't leave a
      // stray empty line above/below the pill.
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
      // Always render as a chip — figure's body is the first positional
      // arg (often `image(...)`), not a `[...]` bracket. The default
      // case's "first [ is the body" heuristic would mistakenly hide a
      // `caption: [...]`, so figure opts out and exposes the caption
      // through the menu instead (R7).
      //
      // When explicitly expanded — right after insertion (the slash
      // command dispatches `expandFunc`) or via the chip menu's "Edit
      // source" — drop the chip so the raw multi-line source is visible
      // and the cursor can land inside the body `[…]`. Re-collapses to
      // the chip once the cursor leaves, like the bibliography pill.
      //
      // "Always a chip" describes how the call reads when idle; it was written
      // assuming insertion via the `/` palette (which dispatches expandFunc, so
      // the source stays open). A hand-typed `#figure(` gets neither, so it
      // needs the same caret guard every other call has.
      if (expandedPos === from) return false;
      if (collapseWouldSwallowCaret(state, from, to, cursors)) return false;
      decos.push(Decoration.replace({
        widget: new FuncChipWidget(from, "figure"),
      }).range(from, to));
      return false;
    }
    case "align": {
      // A lone aligned image renders as the image block widget, with the
      // alignment applied. The pill anchors at `from` (the `#align`) so its
      // menu — built via imageOptions, which detects the wrapper — edits the
      // image's file/alt/width and the alignment together. Other `#align`
      // uses fall through to the generic content-bracket handling below.
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
      // An arguments-only call (`#func(…)`, no `[…]` body) collapses to a
      // chip — but not while the caret is inside it.
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
  // Find inner #func(...) calls by scanning the content text directly.
  // The syntax tree may have incorrect boundaries due to parser truncation,
  // so text scanning is more reliable here.
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
  // Empty content brackets (e.g. just-inserted "#highlight[]") return a
  // zero-width range. Callers need this so they can still hide the wrapping
  // markup and place the cursor in a clean typing slot — without it the
  // visual editor falls back to raw source the moment a slash-command or
  // shortcut produces an empty pair.
  return { from: nodeFrom + open + 1, to: nodeFrom + closeIdx };
}

/**
 * Range of the body content bracket that follows a call's argument list —
 * the `[…]` after `(…)`. Use this instead of {@link extractContentBracket}
 * when a named bracket argument can precede the body (e.g.
 * `#quote(block: true, attribution: [Smith])[body]`), where the first `[`
 * belongs to the argument, not the body. Quote- and depth-aware so a `)` or
 * `[` inside a string argument doesn't close the list early. Returns a
 * zero-width range for an empty body (`[]`), like extractContentBracket.
 */
/** Skip an inline raw span (`` `…` ``, `` ``…`` ``) whose opening backtick run
 *  starts at `i`. Returns the index just past the matching closing fence, or
 *  `end` when the span is unterminated within `[i, end)`. */
/** True when `pos` falls inside a Typst node where `\` is literal content, not
 *  an escape — inline/block raw (backticks), code blocks, comments, strings.
 *  The text-level escape scan must skip these so a backslash typed inside
 *  `` `\` `` (or code mode) survives instead of being hidden as an escape. */
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

function skipInlineRaw(text: string, i: number, end: number): number {
  let n = 0;
  while (i + n < end && text[i + n] === "`") n++;
  const fence = "`".repeat(n);
  const close = text.indexOf(fence, i + n);
  return close >= 0 && close < end ? close + n : end;
}

/** Index of the `]` that closes the `[` at `open`, balancing nested brackets
 *  but treating any `[`/`]` inside an inline raw span (`` `…` ``) or behind a
 *  `\`-escape as literal — Typst markup rules. -1 if unbalanced in `[open, end)`.
 *  This is what keeps a literal `[[` written inside backticks (e.g. a callout
 *  body that documents the wikilink shortcut) from unbalancing the call's `[…]`
 *  body and dropping the whole block back to raw source. */
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

/** A Typst label reference as the first argument: `#link(<my-label>)…`. This is
 *  the intra-document anchor form of a link, distinct from the string-URL form
 *  read by extractFirstStringArg. */
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

/** Like {@link extractFirstStringArgRange} but honors `\\X` escapes inside
 *  the string literal — needed for verse bodies, which routinely contain
 *  `\"`, `\\`, `\n`, and markup-escape pairs like `\*`. */
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

/** Recognize `#align(left|center|right)[ #image(...) ]` wrapping a lone
 *  image — the source form for a horizontally-placed image (CLAUDE.md
 *  Typst-first: `#align` is Typst's native placement primitive). Returns
 *  the keyword and the inner image source, or null for any other `#align`
 *  use (which keeps the generic content-bracket pill). */
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

/** Return a display string for `attribution: …` covering the four shapes
 *  the pill emits: string, label, `link("…")[…]`, raw bracket content.
 *  Returns "" if no attribution arg is present. */
function extractAttributionDisplay(text: string): string {
  const str = extractNamedStringArg(text, "attribution");
  if (str !== null) return str;
  // link("url")[Text] — show the inner Text, drop the URL (the visual
  // preview doesn't render the link styling either way).
  const linkMatch = text.match(
    /attribution\s*:\s*link\(\s*"(?:\\.|[^"\\])*"\s*\)\s*\[([\s\S]*?)\]/,
  );
  if (linkMatch) return linkMatch[1];
  // Label literal: attribution: <bibkey>. Show the literal so the author
  // can confirm which key they referenced; the rendered output is a
  // citation in the bibliography style.
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

/** Inner content of the trailing `[body]` content block — the `[...]` that
 *  follows the balanced `(...)` argument list (so a `old: [..]` inside the
 *  args isn't mistaken for it). String-aware so a `)` inside a quoted arg
 *  doesn't end the arg list early. */
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
      // External reloads (sidebar property edits) dispatch this effect to
      // force visualField to rebuild against a fresh tree. The mapped
      // expanded position is meaningless after a full-doc replace and would
      // otherwise leave the previous #note() (or similar) func expanded —
      // showing raw source until the user clicks elsewhere. Clear it.
      if (e.is(rebuildVisualDecorations)) {
        return null;
      }
    }
    if (tr.selection && next !== null && next <= tr.state.doc.length) {
      // The call may span multiple lines (a multi-paragraph callout, a
      // long quote). Treat any cursor on any line of the call as
      // "nearby" so editing the body doesn't auto-collapse the
      // expansion. findCallEnd walks the doc directly here — we don't
      // have a view in this StateField update fn.
      const callEnd = findCallEnd({ doc: tr.state.doc }, next);
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
 * Grow each dirty range so it fully contains any `FuncCall` it overlaps. A
 * block element (callout, quote, …) renders as several decorations spread
 * across its lines — a pill, hidden markup, a per-line style. If a partial
 * rebuild covered only some of those lines it would rebuild part of the set
 * and keep the rest stale, leaving self-contradictory decorations: a leftover
 * editing line-border doubling the rendered widget's bar, or a stale pill
 * replace overlapping a fresh whole-element widget so the body vanishes.
 * Rebuilding the whole element at once keeps its decoration set consistent.
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
    // Grow to a FuncCall's *corrected* bounds, not lezer's raw `n.from..n.to`.
    // The decoration builder renders each call over correctedFuncCallEnd(...);
    // growing to anything shorter would leave part of a multi-line block call
    // outside the rebuild, stranding a stale editing border behind the widget
    // (the doubled "nested" bar).
    const growCall = (n: { name: string; from: number; to: number }) => {
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
    // The style preamble collapses/expands as one multi-line block widget, so a
    // dirty line anywhere inside it must rebuild the whole range — otherwise a
    // partial rebuild leaves the block decoration half-applied.
    if (preamble && r.from < preamble.to && r.to > preamble.from) {
      grow(preamble.from, preamble.to);
    }
    return { from, to };
  });
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
  // Coalesce, then grow to whole block elements, then coalesce again (the
  // growth can make formerly-separate ranges overlap).
  const merged = coalesceRanges(expandRangesToBlockElements(state, coalesceRanges(dirtyRanges)));

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
      // Range decorations: standard half-open overlap.
      // Point decorations (Decoration.line lives at line.from, from === to):
      // a strict overlap test would judge one sitting exactly at the dirty
      // range's start (iter.to === r.from) as "not dirty" and keep it. That
      // strands a stale block-element line style — e.g. a callout/quote whose
      // call begins at column 0, so its first line decoration sits at the very
      // start of the expanded element range — behind the freshly rendered
      // widget, producing a doubled bar. Treat a point at [r.from, r.to) as
      // dirty so it is dropped and rebuilt with the rest of the element.
      const overlaps = iter.from < r.to && iter.to > r.from;
      const pointInRange = iter.from === iter.to && iter.from >= r.from && iter.from < r.to;
      // The symmetric end-boundary case: an expanded block element (image,
      // embed) renders its preview as a `side: 1` block widget anchored at the
      // element's *end* — a point sitting exactly at r.to, which the half-open
      // tests above exclude. Left in place, the stale widget survives while
      // buildDecorations re-emits a fresh copy at the same spot, doubling the
      // preview. Treat a block-widget point at r.to as dirty so it is rebuilt
      // (its FuncCall node still overlaps the range, so the rebuild re-adds it).
      const blockWidgetAtEnd =
        iter.from === iter.to && iter.from === r.to && iter.value.spec?.block === true;
      if (overlaps || pointInRange || blockWidgetAtEnd) {
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

function rebuildDirtyLines(
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

function rebuildDocChange(
  existing: DecorationSet,
  tr: { state: EditorState; changes: ChangeSet },
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
  return rebuildRanges(mapped, tr.state, dirtyRanges);
}



// Effect dispatched by the post-history-rebuild plugin (below) once the
// incremental parser has caught up after an undo/redo. Forces visualField
// to re-iterate the now-complete tree and rebuild decorations.
//
// Also dispatched externally after a wholesale buffer replacement (e.g.
// the right-panel "property changed" reload) — that path replaces the
// doc and runs `ensureSyntaxTree` synchronously, but neither step fires
// a follow-up transaction that visualField would treat as a "tree
// changed" trigger, so its decorations otherwise stay anchored to the
// pre-replace parse tree (with widget Replace ranges that mask the new
// content, producing a blank-looking editor).
export const rebuildVisualDecorations = StateEffect.define<null>();

/**
 * The visual-field decoration update, factored out so the field wrapper can
 * guard it (see below). Returns the decoration set for `tr.state`, choosing a
 * full rebuild or an incremental one depending on what changed.
 */
function computeVisualDecorations(decos: DecorationSet, tr: Transaction): DecorationSet {
  for (const e of tr.effects) {
    if (e.is(rebuildVisualDecorations)) {
      return buildDecorations(tr.state);
    }
  }
  if (tr.docChanged) {
    const ep = tr.state.field(expandedFuncField, false) ?? null;
    if (ep !== null) return buildDecorations(tr.state);
    // Document edits (including newline/paste/undo/redo) carry change sets we
    // can map decoration ranges against — handle them incrementally.
    return rebuildDocChange(decos, tr);
  }
  if (syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
    // Tree identity changed WITHOUT a doc change: the async (WASM) parser
    // finished re-parsing in a later transaction. There is no change set to
    // map old decoration ranges against, so an incremental update can't be
    // applied safely — a full rebuild against the freshly-available tree is
    // the correct (and only sound) response. Doc-driven edits never reach
    // here; they took the incremental `rebuildDocChange` path above.
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
    // A malformed/partial parse tree must never abort the field's creation —
    // that would throw out of the whole editor setup. Fall back to no
    // decorations; the next clean reparse rebuilds everything.
    try {
      return buildDecorations(state);
    } catch (err) {
      console.error("visual-plugin: initial decoration build failed; starting with no decorations", err);
      return Decoration.none;
    }
  },
  update(decos, tr) {
    // The decoration set is provided by this StateField, so a throw here would
    // tear down the ENTIRE visual layer — every wikilink, pill, and widget —
    // until the EditorView is recreated (i.e. the note is reopened). That is
    // exactly the "wikilinks stop working until I leave and come back" symptom
    // a transient parse error (e.g. a half-typed/corrupted table) can trigger.
    // The per-FuncCall guard in buildDecorations covers most of it, but a throw
    // anywhere else in the build (escape/angle-bracket scans, range math,
    // RangeSet assembly) would still escape. Catch at the field boundary and
    // keep the previous decorations — mapped through any doc change so their
    // positions stay valid — so the layer survives and the next successful
    // rebuild (a cursor move or async reparse) restores everything in place.
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

// Re-runs buildDecorations one frame after every undo/redo. The actual fix
// for stale-tree decorations is the Prec.high wrapping of typst's
// updateListener in typst-editor.ts (so its applyTreeEdit lands before
// Language.state.apply takes the tree). This rebuild is a belt-and-braces
// guard for any residual ordering quirk in other state fields (e.g.
// protectedRangesField) that depend on the syntax tree.
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
const clickAnchorPlugin = createClickAnchorPlugin(visualField);

// A trailing paragraph-break `\` is hidden in visual mode (see
// `buildDecorations`) and registered here as an atomic range spanning the `\`
// *and* the following newline. Atomicity makes CodeMirror treat the whole soft
// break as one unit: the cursor can't land between the `\` and its newline
// (which would otherwise let a keystroke insert text after the `\`, silently
// turning the line break into a literal `\x` escape), and a single
// Backspace/Delete at the break removes both characters at once, merging the
// lines exactly as the writer expects. So the marker behaves like a seamless
// line break even though the `\` is still present in the source.
class SoftBreakRange extends RangeValue {}
const softBreakMarker = new SoftBreakRange();

function computeSoftBreakRanges(state: EditorState): RangeSet<SoftBreakRange> {
  const ranges: Range<SoftBreakRange>[] = [];
  for (let i = 1; i <= state.doc.lines; i++) {
    const slashPos = softBreakSlashPos(state, state.doc.line(i));
    if (slashPos === null) continue;
    // Extend over the trailing newline when one exists (every line but the
    // last); a soft break on the final line covers just the `\`.
    ranges.push(softBreakMarker.range(slashPos, Math.min(slashPos + 2, state.doc.length)));
  }
  return RangeSet.of(ranges);
}

const softBreakRangesField = StateField.define<RangeSet<SoftBreakRange>>({
  create: (state) => computeSoftBreakRanges(state),
  update(value, tr) {
    // Recompute on doc edits, on async reparse (a trailing `\` can move
    // in/out of a verbatim context once the tree settles), and on the
    // explicit rebuild effect — the same triggers `visualField` uses, so the
    // hidden markers and their atomic ranges never drift apart.
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

// ── Atomic markup ranges ────────────────────────────────────────────
// Every *replacing* decoration — a pill, hidden markup like `#callout("…")[`
// or a closing `]`, a list marker, a block widget — should behave as a single
// unit under cursor motion: one arrow press crosses it, not one press per
// hidden character (which felt like the arrow key was stuck). CodeMirror does
// not make replace decorations atomic on its own, so we derive an atomic
// RangeSet from the visual decoration set: include the shared `hide` replace
// and any widget-bearing replace, but NOT mark decorations (bold / italic /
// highlight), whose text must stay editable. Memoised per decoration-set
// instance so cursor moves don't re-scan an unchanged set.
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

// Round the caret OUT of a rendered `#due(...)` pill to just past the call.
//
// The pill renders only once the date is a complete `YYYY-MM-DD` (see
// extractDateLiteral), so when the user finishes typing the date the call
// collapses to an atomic pill — but the caret, placed by that final keystroke,
// sits INSIDE the call (before the closing `")`). CM's atomicRanges only skip
// the caret during arrow-key motion, not after an insertion drops it inside, so
// it stays there and the next Enter/keystroke corrupts the call (pushing `")`
// onto the next line). A `#due` value is only ever edited via its pill menu, not
// by typing in the raw call, so pushing the caret to the call's end is safe.
//
// Implemented as a view plugin, NOT a transactionFilter: the WASM parser
// reparses asynchronously, so the DueWidget appears a frame AFTER the date-
// completing keystroke, in a later tree-driven decoration rebuild with no doc or
// selection change — a transactionFilter reading `tr.state` wouldn't see the
// pill yet. The plugin re-checks whenever the decoration set changes and, if the
// caret is sitting inside a freshly-rendered due pill, nudges it past the call
// (deferred out of the update cycle). Other interactive elements don't need
// this: wikilink/tag/link reveal editable raw markup when the caret is on them,
// so a caret inside is intentional.
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

export function typstVisualMode() {
  return [expandedFuncField, protectedRangesField, protectedCursorFilter, protectedChangeFilter, dueCursorRoundOut, Prec.high(tableEntryKeymap), Prec.high(verseEntryKeymap), visualField, softBreakRangesField, softBreakAtomicRanges, markupAtomicRanges, postHistoryRebuild, visualTheme, linkClickHandler, tableClipboardHandler, tablePasteHandler, clickAnchorPlugin, pillBoundaryNav];
}

