import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { type ChangeSet, EditorState, Facet, type Line, Prec, type Range, RangeSet, RangeValue, StateEffect, StateField } from "@codemirror/state";
import { expandFunc } from "./effects";
import { inVerbatimLineContext } from "./keymaps";
import { findCallEnd } from "./pill";
import { syntaxTree } from "@codemirror/language";
import {
  CalloutBlockWidget,
  AnnotationBlockWidget,
  CodeBlockWidget,
  ImageBlockWidget,
  BlockquoteBlockWidget,
  BibliographyBlockWidget,
  TagWidget,
  TaskWidget,
  DueWidget,
  WikilinkWidget,
  LinkWidget,
  CitationWidget,
  VerseWidget,
  FootnoteWidget,
  SuggestionWidget,
  type SuggestionKind,
  CALLOUT_COLORS,
} from "./widgets";
import { TableWidget } from "./table-widget";
import { parseCanonicalTable } from "./table-parser";
import { fileList } from "../../stores/filelist";
import { getCachedBibKeys } from "./citation-suggest";
import { FuncPillWidget, FuncChipWidget, BulletWidget, ShorthandWidget, HrWidget, AngleBracketWarningWidget, ANGLE_BRACKET_TAGS } from "./visual-widgets";
import { highlight, buildHighlightMark } from "./visual-colors";
import { visualTheme } from "./visual-theme";
import { isNoteboxImportLine, createProtectedRangesField, createProtectedCursorFilter, createProtectedChangeFilter, externalReload } from "./visual-protected";
export { externalReload } from "./visual-protected";
import { linkClickHandler } from "./visual-links";
import { tableClipboardHandler, tablePasteHandler, createTableEntryKeymap } from "./visual-tables";
import { createClickAnchorPlugin } from "./click-anchor";
import { pillBoundaryNav } from "./pill-boundary-nav";

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
// Inline #quote[…] body — adds smart-quote brackets via ::before/::after.
const quoteInlineMark = Decoration.mark({ class: "cm-typst-quote-inline" });
// Block #quote(block:true)[…] body while editing — italic + muted, bounded to
// the body so text trailing after the closing `]` on the same line is NOT
// styled as part of the quote (the bar + geometry come from the line deco).
const blockquoteBodyMark = Decoration.mark({ class: "cm-typst-blockquote-body" });

const headingMarks = [
  Decoration.mark({ class: "cm-typst-h1" }),
  Decoration.mark({ class: "cm-typst-h2" }),
  Decoration.mark({ class: "cm-typst-h3" }),
  Decoration.mark({ class: "cm-typst-h4" }),
  Decoration.mark({ class: "cm-typst-h5" }),
  Decoration.mark({ class: "cm-typst-h6" }),
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

function nodeOverlapsRanges(from: number, to: number, ranges: { from: number; to: number }[]): boolean {
  for (const r of ranges) {
    if (from < r.to && to > r.from) return true;
  }
  return false;
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
  const indent = markerFrom - line.from;
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

function buildDecorations(state: EditorState, onlyRanges?: { from: number; to: number }[]): DecorationSet {
  const focused = cursorLines(state);
  const cursors = cursorPositions(state);
  const autoExpand = state.facet(autoExpandFacet);
  const expandedPos = state.field(expandedFuncField, false) ?? null;
  const decos: Range<Decoration>[] = [];

  const escapeRanges = new Set<string>();
  const escapeDecos: { from: number; backslashEnd: number; charEnd: number }[] = [];
  const activeFormatting = { bold: false, italic: false, strike: false, highlight: false, headingLevel: 0 };
  let consumedUntil = -1;

  for (let i = 1; i <= Math.min(state.doc.lines, 5); i++) {
    const line = state.doc.line(i);
    if (isNoteboxImportLine(line.text)) {
      let hideEnd = line.to;
      if (hideEnd < state.doc.length) {
        hideEnd = Math.min(hideEnd + 1, state.doc.length);
      }
      if (!onlyRanges || nodeOverlapsRanges(line.from, hideEnd, onlyRanges)) {
        decos.push(hide.range(line.from, hideEnd));
      }
    }
  }

  syntaxTree(state).iterate({
    from: onlyRanges ? onlyRanges[0].from : 0,
    to: onlyRanges ? onlyRanges[onlyRanges.length - 1].to : state.doc.length,
    enter(node) {
        if (node.from > state.doc.length || node.to > state.doc.length) return;
        if (node.from < consumedUntil) return false;
        if (onlyRanges && !nodeOverlapsRanges(node.from, node.to, onlyRanges)) return;
        const onCursor = isOnCursorLine(state, node.from, node.to, focused);

        switch (node.name) {
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
            activeFormatting.headingLevel = level + 1;
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
            decos.push(
              Decoration.replace({ widget: new BulletWidget("•") }).range(node.from, node.to),
            );
            return false;
          }
          case "EnumMarker": {
            decos.push(
              Decoration.replace({ widget: new BulletWidget(enumItemNumber(state, node.from)) }).range(node.from, node.to),
            );
            return false;
          }
          case "Raw": {
            const text = state.doc.sliceString(node.from, node.to);
            const isBlock = text.startsWith("```");
            if (!isBlock) {
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
              const key = refText.slice(1);
              const bibKeys = getCachedBibKeys();
              if (bibKeys.size === 0 || bibKeys.has(key)) {
                decos.push(
                  Decoration.replace({
                    widget: new CitationWidget(key, node.from, node.to),
                    inclusiveStart: false,
                    inclusiveEnd: false,
                  }).range(node.from, node.to),
                );
              } else {
                // Not in bibliography — override syntax highlighting so
                // email addresses render as plain text, not link-colored.
                decos.push(refPlainMark.range(node.from, node.to));
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
            if (text === "---") replacement = "—";
            else if (text === "--") replacement = "–";
            else if (text === "~") replacement = " ";
            if (replacement) {
              decos.push(
                Decoration.replace({
                  widget: new ShorthandWidget(replacement, text),
                }).range(node.from, node.to),
              );
            }
            return false;
          }
          case "SmartQuote": {
            return false;
          }
          case "FuncCall": {
            const funcFrom = (node.from > 0 && state.doc.sliceString(node.from - 1, node.from) === "#")
              ? node.from - 1 : node.from;
            let funcTo = node.to;
            const lastChar = state.doc.sliceString(funcTo - 1, funcTo);
            if (lastChar !== ")" && lastChar !== "]") return false;
            // Parser truncation defense: the incremental parser may truncate
            // multi-line function calls at an inner `)` or `]`. When the
            // delimiters aren't balanced, scan forward for the real end.
            const rawCheck = state.doc.sliceString(funcFrom, funcTo);
            const hashOff = rawCheck.startsWith("#") ? 1 : 0;
            const firstParen = rawCheck.indexOf("(", hashOff);
            if (firstParen >= 0) {
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
                if (ch === '"' && (i === 0 || scanText[i - 1] !== '\\')) { inStr = !inStr; continue; }
                if (inStr) continue;
                if (ch === '(') parenDepth++;
                else if (ch === ')') {
                  parenDepth--;
                  if (parenDepth === 0 && bracketDepth === 0) {
                    realEnd = scanStart + i + 1;
                    // Check for trailing content bracket [...] — only for
                    // functions that actually use content brackets after ().
                    // Block funcs like table/note/bibliography/image
                    // never have trailing brackets; without this guard the
                    // scanner can consume unrelated lines after the func.
                    const funcNameForBracket = rawCheck.match(/^#?(\w[\w-]*)/);
                    const fnb = funcNameForBracket ? funcNameForBracket[1] : null;
                    const NO_TRAILING_BRACKET = new Set([
                      "table", "note", "bibliography", "image", "verse", "cite",
                    ]);
                    if (!fnb || !NO_TRAILING_BRACKET.has(fnb)) {
                      const afterParen = state.doc.sliceString(realEnd, Math.min(realEnd + 100, state.doc.length)).trimStart();
                      if (afterParen.startsWith("[")) {
                        const bStart = realEnd + (state.doc.sliceString(realEnd, Math.min(realEnd + 100, state.doc.length)).length - afterParen.length);
                        const bScan = state.doc.sliceString(bStart, Math.min(bStart + 50000, state.doc.length));
                        let bd = 0;
                        for (let j = 0; j < bScan.length; j++) {
                          if (bScan[j] === '[') bd++;
                          else if (bScan[j] === ']') { bd--; if (bd === 0) { realEnd = bStart + j + 1; break; } }
                        }
                      }
                    }
                    balanced = true;
                    break;
                  }
                } else if (ch === '[') bracketDepth++;
                else if (ch === ']') bracketDepth--;
              }
              if (balanced && realEnd > funcTo) {
                funcTo = realEnd;
              }
            }
            // The lezer-typst parser truncates multi-line FuncCalls at the
            // first inner `)`/`]`, so the outer `node.from..node.to` used
            // for `onCursor` above misses lines added by the user. Recompute
            // against the corrected funcFrom..funcTo so the cursor staying
            // inside a growing callout/quote body keeps the live-edit
            // decoration stable across Enter presses.
            const callOnCursor = isOnCursorLine(state, funcFrom, funcTo, focused);
            const traverseChildren = handleFuncCall(state, funcFrom, funcTo, decos, callOnCursor, cursors, autoExpand, expandedPos, activeFormatting);
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
      if (node.name === "Heading") activeFormatting.headingLevel = 0;
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
  for (const i of escScanLines) {
    const line = state.doc.line(i);
    if (autoExpand && isOnCursorLine(state, line.from, line.to, focused)) continue;
    const text = line.text;
    let idx = text.indexOf("\\");
    while (idx >= 0 && idx < text.length - 1) {
      const nextChar = text[idx + 1];
      if (ESCAPE_CHARS.includes(nextChar)) {
        const absFrom = line.from + idx;
        const key = `${absFrom}:${absFrom + 2}`;
        if (!escapeRanges.has(key)) {
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
    let match: RegExpExecArray | null;
    ANGLE_BRACKET_TAGS.lastIndex = 0;
    while ((match = ANGLE_BRACKET_TAGS.exec(docText)) !== null) {
      const pos = match.index;
      const tree = syntaxTree(state);
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
const INTERACTIVE_FUNCS = new Set(["wikilink", "tag", "link", "suggestion"]);

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
const BLOCK_WIDGET_FUNCS = new Set(["image"]);

function handleFuncCall(
  state: EditorState,
  from: number,
  to: number,
  decos: Range<Decoration>[],
  onCursor: boolean,
  cursors: Set<number>,
  autoExpand: boolean,
  expandedPos: number | null,
  formatting: { bold: boolean; italic: boolean; strike: boolean; highlight: boolean; headingLevel: number } = { bold: false, italic: false, strike: false, highlight: false, headingLevel: 0 },
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

  if (INTERACTIVE_FUNCS.has(funcName)) {
    if (isCursorAdjacentOrInside(state, from, to, cursors)) return false;
  } else if (BLOCK_WIDGET_FUNCS.has(funcName) || funcName === "callout" || funcName === "quote" || funcName === "annotation") {
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
    && !BLOCK_WIDGET_FUNCS.has(funcName);

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
      // Same model as block quote: a single rendered widget when the cursor is
      // away, and an in-place editable body (real text + callout styling, no
      // duplicate, no caret trap) when it's on. Replaces the old
      // pushBlockElement "source + side:1 preview" path that rendered twice.
      if (!onCursor) {
        const bodyText = state.doc.sliceString(bodyRange.from, bodyRange.to);
        decos.push(
          Decoration.replace({ widget: new CalloutBlockWidget(kind, title ?? "", bodyText, from, false) }).range(from, to),
        );
        return false;
      }
      const color = CALLOUT_COLORS[kind] ?? CALLOUT_COLORS.note;
      decos.push(
        Decoration.replace({ widget: new FuncPillWidget(from, "callout") }).range(from, bodyRange.from),
      );
      if (bodyRange.to < to) decos.push(hide.range(bodyRange.to, to));
      const startLine = state.doc.lineAt(bodyRange.from);
      const endLine = state.doc.lineAt(bodyRange.to);
      for (let ln = startLine.number; ln <= endLine.number; ln++) {
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
      // Unlike callout/quote, a comment has nothing to preview while you edit
      // it, so we don't use the side:1 "source + preview" pattern (which would
      // show the annotation twice while editing). Expanded ⇒ raw source only;
      // collapsed ⇒ a single block widget (with a pill on the cursor line).
      const isExpanded = expandedPos === from || (autoExpand && onCursor);
      if (!isExpanded) {
        decos.push(
          Decoration.replace({
            widget: new AnnotationBlockWidget(bodyText, by ?? "", on ?? "", from, onCursor),
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
      if (body !== null && body !== undefined) {
        const done = /\bdone\s*:\s*true\b/.test(text);
        // Look for the due date only after the `due:` keyword so a date
        // inside the body string can't be mistaken for it.
        const dueIdx = text.search(/\bdue\s*:/);
        const due = dueIdx >= 0 ? extractDateLiteral(text.slice(dueIdx)) : null;
        if (showPill) {
          decos.push(
            Decoration.widget({ widget: new FuncPillWidget(from, "task"), side: -1 }).range(from),
          );
        }
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
      const display = extractNamedStringArg(text, "display");
      const label = extractNamedStringArg(text, "label");
      if (target) {
        const files = fileList();
        const normalizedTarget = target.toLowerCase().replace(/\.typ$/, "");
        const exists = files.some(f => f.name.replace(/\.typ$/, "").toLowerCase() === normalizedTarget);
        decos.push(
          Decoration.replace({
            widget: new WikilinkWidget(target, display ?? "", formatting.bold, formatting.italic, formatting.strike, formatting.highlight, formatting.headingLevel, label ?? "", exists),
            inclusiveStart: false,
            inclusiveEnd: false,
          }).range(from, to),
        );
      }
      return false;
    }
    case "link": {
      const url = extractFirstStringArg(text);
      if (url) {
        const display = extractBracketContent(text);
        decos.push(
          Decoration.replace({
            widget: new LinkWidget(url, display ?? ""),
            inclusiveStart: false,
            inclusiveEnd: false,
          }).range(from, to),
        );
      }
      return false;
    }
    case "suggestion": {
      // Interactive widget (no pill): the marks render always; cursor-adjacent
      // reveals raw source for editing the proposed text (handled by the
      // INTERACTIVE_FUNCS early-return above).
      const kind = (extractNamedStringArg(text, "kind") ?? "insert") as SuggestionKind;
      const by = extractNamedStringArg(text, "by") ?? "";
      const on = extractNamedStringArg(text, "on") ?? "";
      const note = extractNamedStringArg(text, "note") ?? "";
      const body = extractBodyBracket(text) ?? "";
      const oldText = kind === "replace" ? (extractNamedBracket(text, "old") ?? "") : "";
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
            Decoration.replace({ widget: new BlockquoteBlockWidget(content, attribution, from, false) }).range(from, to),
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
        const startLine = state.doc.lineAt(bodyRange.from);
        const endLine = state.doc.lineAt(bodyRange.to);
        for (let ln = startLine.number; ln <= endLine.number; ln++) {
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
      // The body stays live-editable Typst source; `quoteInlineMark`
      // wraps it in smart quotes via ::before / ::after so the visual
      // representation tracks Typst's `<q>`-like rendering. We span the
      // whole body with a single mark (rather than addSplitMarks) so the
      // smart quotes appear once around the entire content, not per
      // segment broken up by inner function-call replace widgets.
      // Note: "quote" is in BLOCK_FUNCS (for the block form), so the
      // generic showPill is always false. Compute it locally for inline.
      const inlineShowPill = onCursor && hashOffset === 1;
      const content = extractContentBracket(text, from);
      if (content) {
        decos.push((inlineShowPill
          ? Decoration.replace({ widget: new FuncPillWidget(from, "quote") })
          : hide
        ).range(from, content.from));
        decos.push(hide.range(content.to, to));
        if (content.from < content.to) {
          pushMark(decos, quoteInlineMark, content.from, content.to);
        }
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
      decos.push(Decoration.replace({
        widget: new FuncChipWidget(from, "figure"),
      }).range(from, to));
      return false;
    }
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
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") {
      depth--;
      if (depth === 0) return { from: nodeFrom + open + 1, to: nodeFrom + i };
    }
  }
  return null;
}

function extractFirstStringArg(text: string): string | null {
  const m = text.match(/\(\s*"([^"]*)"/) ?? text.match(/\(\s*'([^']*)'/);
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
  return ranges.map((r) => {
    let { from, to } = r;
    const grow = (nodeFrom: number, nodeTo: number) => {
      if (nodeFrom < from) from = nodeFrom;
      if (nodeTo > to) to = nodeTo;
    };
    // Enclosing calls at either edge of the range …
    for (const [pos, side] of [[r.from, 1], [r.to, -1]] as const) {
      let n: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side);
      while (n) {
        if (n.name === "FuncCall") grow(n.from, n.to);
        if (!n.parent) break;
        n = n.parent;
      }
    }
    // … plus any call that begins inside it.
    tree.iterate({
      from: r.from,
      to: r.to,
      enter(n) { if (n.name === "FuncCall") grow(n.from, n.to); },
    });
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

const visualField = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state);
  },
  update(decos, tr) {
    for (const e of tr.effects) {
      if (e.is(rebuildVisualDecorations)) {
        return buildDecorations(tr.state);
      }
    }
    if (tr.docChanged) {
      const ep = tr.state.field(expandedFuncField, false) ?? null;
      if (ep !== null) return buildDecorations(tr.state);
      return rebuildDocChange(decos, tr);
    }
    if (syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
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

export function typstVisualMode() {
  return [expandedFuncField, protectedRangesField, protectedCursorFilter, protectedChangeFilter, Prec.high(tableEntryKeymap), visualField, softBreakRangesField, softBreakAtomicRanges, markupAtomicRanges, postHistoryRebuild, visualTheme, linkClickHandler, tableClipboardHandler, tablePasteHandler, clickAnchorPlugin, pillBoundaryNav];
}

