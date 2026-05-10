import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { Annotation, EditorState, EditorSelection, Facet, Prec, type Range, RangeSet, StateEffect, StateField } from "@codemirror/state";
import { expandFunc } from "./effects";
import { buildPillButton, findCallEnd } from "./pill";
import { getPillOptions } from "./pill-options";
import { syntaxTree } from "@codemirror/language";
import {
  CalloutBlockWidget,
  CodeBlockWidget,
  ImageBlockWidget,
  EmbedBlockWidget,
  BlockquoteBlockWidget,
  BibliographyBlockWidget,
  TagWidget,
  WikilinkWidget,
  LinkWidget,
  CitationWidget,
  VerseWidget,
  FootnoteWidget,
} from "./widgets";
import { TableWidget } from "./table-widget";
import { type TableData, type TableCell, parseCanonicalTable, serializeTable, parseClipboardAsGrid } from "./table-parser";
import { selectionToolbar } from "./selection-toolbar";
import { commandPalette } from "./command-palette";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { fileList } from "../../stores/filelist";

const escapedChar = Decoration.mark({ class: "cm-typst-escaped" });
const bold = Decoration.mark({ class: "cm-typst-bold" });
const italic = Decoration.mark({ class: "cm-typst-italic" });
const strikethrough = Decoration.mark({ class: "cm-typst-strike" });
const highlight = Decoration.mark({ class: "cm-typst-highlight" });
const rawInline = Decoration.mark({ class: "cm-typst-raw-inline" });
const linkMark = Decoration.mark({ class: "cm-typst-link" });
const mathInline = Decoration.mark({ class: "cm-typst-math-inline" });
const mathDisplay = Decoration.mark({ class: "cm-typst-math-display" });
const labelMark = Decoration.mark({ class: "cm-typst-label" });
const refMark = Decoration.mark({ class: "cm-typst-ref" });

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

// ── Pill system: collapsed func-call affordance ──────────

export { expandFunc } from "./effects";

export const autoExpandFacet = Facet.define<boolean, boolean>({
  combine: values => values.length > 0 ? values[values.length - 1] : false,
});

// FuncPillWidget and FuncChipWidget were two near-duplicate pill widgets.
// They now both build the unified pill button (see pill.ts) which opens
// the super-context-menu on click. Kept as separate names for the
// existing call sites; both delegate to buildPillButton.
// FuncPillWidget and FuncChipWidget were two near-duplicate pill widgets.
// They now both build the unified pill button (see pill.ts) which opens
// the super-context-menu on click. Per-pill options are looked up from
// the pill-options registry so each function gets its widget-specific
// menu section without per-widget plumbing.
class FuncPillWidget extends WidgetType {
  constructor(readonly pos: number, readonly funcName: string) { super(); }
  eq(other: FuncPillWidget) { return this.pos === other.pos && this.funcName === other.funcName; }
  toDOM(view: EditorView) {
    return buildPillButton(this.funcName, view, () => {
      const callTo = findCallEnd(view, this.pos);
      return {
        funcName: this.funcName,
        callFrom: this.pos,
        callTo,
        optionSections: getPillOptions(this.funcName, view, this.pos, callTo),
      };
    });
  }
  ignoreEvent() { return true; }
}

class FuncChipWidget extends WidgetType {
  constructor(readonly pos: number, readonly funcName: string) { super(); }
  eq(other: FuncChipWidget) { return this.pos === other.pos && this.funcName === other.funcName; }
  toDOM(view: EditorView) {
    return buildPillButton(this.funcName, view, () => {
      const callTo = findCallEnd(view, this.pos);
      return {
        funcName: this.funcName,
        callFrom: this.pos,
        callTo,
        optionSections: getPillOptions(this.funcName, view, this.pos, callTo),
      };
    });
  }
  ignoreEvent() { return true; }
}

class BulletWidget extends WidgetType {
  constructor(readonly marker: string) { super(); }
  eq(other: BulletWidget) { return this.marker === other.marker; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-typst-list-bullet";
    el.textContent = this.marker;
    return el;
  }
}

class ShorthandWidget extends WidgetType {
  constructor(readonly rendered: string, readonly raw: string) { super(); }
  eq(other: ShorthandWidget) { return this.rendered === other.rendered; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-typst-shorthand";
    el.textContent = this.rendered;
    el.title = this.raw;
    return el;
  }
}

class HrWidget extends WidgetType {
  toDOM() {
    const el = document.createElement("hr");
    el.className = "cm-typst-hr";
    return el;
  }
}

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

// The auto-injected vault library import. We accept both the canonical
// version-less path and the legacy `/.inkycap/packages/inkycap-vault/<v>/`
// path so notes from older vaults still hide their import line cleanly.
const CANONICAL_IMPORT_PREFIX = '#import "/.inkycap/vault.typ"';
const LEGACY_IMPORT_PREFIX = '#import "/.inkycap/packages/inkycap-vault/';
function isVaultImportLine(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith(CANONICAL_IMPORT_PREFIX) || t.startsWith(LEGACY_IMPORT_PREFIX)
  );
}

const ANGLE_BRACKET_TAGS = /(?<!\\)<(script|style|iframe|object|embed|form|input|link|meta|base)(?:\s|>|\/)/gi;

class AngleBracketWarningWidget extends WidgetType {
  constructor(readonly from: number, readonly to: number, readonly tag: string) { super(); }
  eq(other: AngleBracketWarningWidget) { return this.from === other.from && this.tag === other.tag; }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "cm-typst-angle-bracket-warning";
    el.title = `Bare <${this.tag}> is ambiguous in Typst — click to escape as \\<${this.tag}>`;
    el.textContent = "⚠";
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = view.state.doc.sliceString(this.from, this.to);
      const escaped = text.replace(/</g, "\\<");
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: escaped },
      });
    });
    return el;
  }
  ignoreEvent() { return true; }
}

function buildDecorations(state: EditorState): DecorationSet {
  const focused = cursorLines(state);
  const cursors = cursorPositions(state);
  const autoExpand = state.facet(autoExpandFacet);
  const expandedPos = state.field(expandedFuncField, false) ?? null;
  const decos: Range<Decoration>[] = [];

  let enumCounter = 0;
  let lastEnumLine = -1;
  let lastEnumIndent = -1;
  const escapeRanges = new Set<string>();
  const escapeDecos: { from: number; backslashEnd: number; charEnd: number }[] = [];
  const activeFormatting = { bold: false, italic: false, strike: false, highlight: false, headingLevel: 0 };
  let consumedUntil = -1;

  for (let i = 1; i <= Math.min(state.doc.lines, 5); i++) {
    const line = state.doc.line(i);
    if (isVaultImportLine(line.text)) {
      let hideEnd = line.to;
      if (hideEnd < state.doc.length) {
        hideEnd = Math.min(hideEnd + 1, state.doc.length);
      }
      decos.push(hide.range(line.from, hideEnd));
    }
  }

  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
        if (node.from > state.doc.length || node.to > state.doc.length) return;
        if (node.from < consumedUntil) return false;
        const onCursor = isOnCursorLine(state, node.from, node.to, focused);

        switch (node.name) {
          case "Strong": {
            if (isCursorAdjacentOrInside(state, node.from, node.to, cursors)) return false;
            if (autoExpand && onCursor) return false;
            activeFormatting.bold = true;
            decos.push(hide.range(node.from, node.from + 1));
            decos.push(hide.range(node.to - 1, node.to));
            decos.push(bold.range(node.from + 1, node.to - 1));
            break;
          }
          case "Emph": {
            if (isCursorAdjacentOrInside(state, node.from, node.to, cursors)) return false;
            if (autoExpand && onCursor) return false;
            activeFormatting.italic = true;
            decos.push(hide.range(node.from, node.from + 1));
            decos.push(hide.range(node.to - 1, node.to));
            decos.push(italic.range(node.from + 1, node.to - 1));
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
            const line = state.doc.lineAt(node.from);
            const indent = node.from - line.from;
            if (indent !== lastEnumIndent || line.number > lastEnumLine + 1) {
              enumCounter = 1;
            } else {
              enumCounter++;
            }
            lastEnumLine = line.number;
            lastEnumIndent = indent;
            decos.push(
              Decoration.replace({ widget: new BulletWidget(`${enumCounter}.`) }).range(node.from, node.to),
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
              decos.push(rawInline.range(node.from + 1, node.to - 1));
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
              decos.push(mathInline.range(node.from + 1, node.to - 1));
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
              decos.push(
                Decoration.replace({ widget: new CitationWidget(key) }).range(node.from, node.to),
              );
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
              decos.push(termKey.range(node.to, colonAbs));
              decos.push(termSep.range(colonAbs, colonAbs + 1));
            } else {
              decos.push(hide.range(node.from, node.to));
              decos.push(termKey.range(node.to, line.to));
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
                    // Block funcs like table/note/bibliography/image/embed
                    // never have trailing brackets; without this guard the
                    // scanner can consume unrelated lines after the func.
                    const funcNameForBracket = rawCheck.match(/^#?(\w[\w-]*)/);
                    const fnb = funcNameForBracket ? funcNameForBracket[1] : null;
                    const NO_TRAILING_BRACKET = new Set([
                      "table", "note", "bibliography", "image", "embed", "verse", "cite",
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
            const traverseChildren = handleFuncCall(state, funcFrom, funcTo, decos, onCursor, cursors, autoExpand, expandedPos, activeFormatting);
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
  // Also skip positions inside hidden ranges (import lines, #note blocks, etc.).
  const ESCAPE_CHARS = "#*_$=~`\\";
  for (let i = 1; i <= state.doc.lines; i++) {
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
  // Add escape decorations, skipping any whose position overlaps with an
  // existing replace decoration (hide or widget) to avoid CM6 range conflicts.
  if (escapeDecos.length > 0) {
    const takenPositions = new Set<number>();
    for (const d of decos) {
      // Any replace decoration (hide or widget) at this position would conflict.
      // Check by seeing if the decoration has a widget or is our `hide` const.
      if (d.from < d.to && (d.value === hide || d.value.spec?.widget != null)) {
        for (let p = d.from; p < d.to; p++) takenPositions.add(p);
      }
    }
    for (const esc of escapeDecos) {
      if (!takenPositions.has(esc.from)) {
        decos.push(hide.range(esc.from, esc.backslashEnd));
        decos.push(escapedChar.range(esc.backslashEnd, esc.charEnd));
      }
    }
  }

  // Detect bare HTML-like tags (e.g. <script>) that are ambiguous in Typst
  const docText = state.doc.toString();
  let match: RegExpExecArray | null;
  ANGLE_BRACKET_TAGS.lastIndex = 0;
  while ((match = ANGLE_BRACKET_TAGS.exec(docText)) !== null) {
    const pos = match.index;
    // Skip if inside a raw block or code block (check syntax tree node)
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

    // Find the full tag extent (from < to > or end of tag name)
    const tagEnd = docText.indexOf(">", pos);
    const end = tagEnd !== -1 ? tagEnd + 1 : pos + match[0].length;
    decos.push(
      Decoration.widget({
        widget: new AngleBracketWarningWidget(pos, end, match[1]),
        side: -1,
      }).range(pos),
    );
  }

  decos.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  return RangeSet.of(decos);
}

const BLOCK_FUNCS = new Set([
  "callout", "quote", "verse", "note", "bibliography", "table",
]);

// These funcs always render as widgets even on cursor line — click navigates,
// edit via source mode or cursor-adjacent positioning.
const INTERACTIVE_FUNCS = new Set(["wikilink", "tag", "link"]);

// Block widgets that collapse to pill + editable value when cursor is on line.
const BLOCK_WIDGET_FUNCS = new Set(["image", "embed"]);

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
  } else if (BLOCK_WIDGET_FUNCS.has(funcName) || funcName === "callout" || funcName === "quote") {
    // image, embed, callout, quote use the pill-above-element pattern:
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

  // Decoration recipe for block elements (image, embed, callout, quote)
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
      const bodyText = extractBracketContent(text);
      if (!kind) return false;
      pushBlockElement((withPill) =>
        new CalloutBlockWidget(kind, title ?? "", bodyText ?? "", from, withPill),
      );
      return false;
    }
    case "image": {
      const path = extractFirstStringArg(text);
      if (!path) return false;
      pushBlockElement((withPill) => new ImageBlockWidget(path, from, withPill));
      return false;
    }
    case "embed": {
      const name = extractFirstStringArg(text);
      if (!name) return false;
      pushBlockElement((withPill) => new EmbedBlockWidget(name, from, withPill));
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
    case "cite": {
      const keyMatch = text.match(/<([^>]+)>/);
      if (keyMatch) {
        decos.push(
          Decoration.replace({ widget: new CitationWidget(keyMatch[1]) }).range(from, to),
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
        decos.push(
          Decoration.replace({
            widget: new VerseWidget({
              source,
              bodyFrom: range.from,
              bodyTo: range.to,
              callFrom: from,
              align: (alignArg as "left" | "center" | "right") ?? "left",
              font: fontArg ?? null,
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
      const content = extractBracketContent(text);
      const attribution = extractNamedStringArg(text, "attribution")
        ?? extractNamedBracketArg(text, "attribution");
      if (content === null) return false;
      pushBlockElement((withPill) =>
        new BlockquoteBlockWidget(content, attribution ?? "", from, withPill),
      );
      return false;
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

function extractNamedStringArg(text: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*:\\s*"([^"]*)"`);
  const m = text.match(re);
  return m ? m[1] : null;
}

function extractNamedBracketArg(text: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*:\\s*\\[([^\\]]*)\\]`);
  const m = text.match(re);
  return m ? m[1] : null;
}

function extractBracketContent(text: string): string | null {
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

const TYPST_COLORS: Record<string, string> = {
  black: "#000", gray: "#808080", silver: "#c0c0c0", white: "#fff",
  navy: "#001f3f", blue: "#2196f3", aqua: "#00bcd4", teal: "#009688",
  eastern: "#239dad", purple: "#9c27b0", fuchsia: "#e91e63",
  maroon: "#800000", red: "#f44336", orange: "#ff9800", yellow: "#ffeb3b",
  olive: "#808000", green: "#4caf50", lime: "#8fce00",
};

function parseTypstColor(raw: string): string | null {
  const trimmed = raw.trim();
  if (TYPST_COLORS[trimmed]) return TYPST_COLORS[trimmed];

  const hexMatch = trimmed.match(/^rgb\(\s*"(#[0-9a-fA-F]{3,8})"\s*\)$/);
  if (hexMatch) return hexMatch[1];

  const rgbMatch = trimmed.match(
    /^rgb\(\s*(\d+(?:\.\d+)?%?)\s*,\s*(\d+(?:\.\d+)?%?)\s*,\s*(\d+(?:\.\d+)?%?)\s*(?:,\s*(\d+(?:\.\d+)?%?)\s*)?\)$/,
  );
  if (rgbMatch) {
    const conv = (v: string) => v.endsWith("%") ? Math.round(parseFloat(v) * 2.55) : parseInt(v);
    const [, r, g, b, a] = rgbMatch;
    if (a != null) return `rgba(${conv(r)}, ${conv(g)}, ${conv(b)}, ${a.endsWith("%") ? parseFloat(a) / 100 : parseInt(a) / 255})`;
    return `rgb(${conv(r)}, ${conv(g)}, ${conv(b)})`;
  }

  const lumaMatch = trimmed.match(/^luma\(\s*(\d+)\s*\)$/);
  if (lumaMatch) { const v = lumaMatch[1]; return `rgb(${v}, ${v}, ${v})`; }

  return null;
}

function extractHighlightParams(text: string): { fill?: string; stroke?: string; radius?: string } {
  const params: { fill?: string; stroke?: string; radius?: string } = {};

  // The value pattern allows either bare tokens (`red`, `#fff`) or a single
  // function call (`rgb("#fff3a3")`, `luma(80)`). The earlier `[^,)\]]+`
  // form stopped at the first `)`, so it captured `rgb("#fff3a3"` and
  // parseTypstColor's rgb regex (which requires a trailing `)`) failed
  // silently — every non-default colour fell through to the unparameterized
  // yellow mark. The paren-group alternative must come FIRST so the engine
  // tries it before the single-char one — otherwise the simple alternative
  // greedily eats the opening `(` (it's not in the exclusion set) and the
  // compound alternative never gets a chance to fire.
  const VALUE = /((?:\([^)]*\)|[^,)\]])+)/;

  const fillMatch = text.match(new RegExp(`fill\\s*:\\s*${VALUE.source}`));
  if (fillMatch) {
    const color = parseTypstColor(fillMatch[1]);
    if (color) params.fill = color;
  }

  const strokeMatch = text.match(new RegExp(`stroke\\s*:\\s*${VALUE.source}`));
  if (strokeMatch) {
    const color = parseTypstColor(strokeMatch[1]);
    if (color) params.stroke = color;
  }

  const radiusMatch = text.match(/radius\s*:\s*(\d+(?:\.\d+)?)(pt|em|%)/);
  if (radiusMatch) {
    const val = radiusMatch[1];
    const unit = radiusMatch[2] === "pt" ? "px" : radiusMatch[2];
    params.radius = `${val}${unit}`;
  }

  return params;
}

function buildHighlightMark(text: string): Decoration {
  const params = extractHighlightParams(text);
  if (!params.fill && !params.stroke && !params.radius) return highlight;

  const parts: string[] = [];
  parts.push(`background-color: ${params.fill ?? "var(--bg-search-match)"}`);
  if (params.stroke) parts.push(`outline: 1px solid ${params.stroke}`);
  parts.push(`border-radius: ${params.radius ?? "2px"}`);
  parts.push("padding: 0 2px");

  return Decoration.mark({ attributes: { style: parts.join("; ") } });
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
      const expandedLine = tr.state.doc.lineAt(next).number;
      let cursorNearby = false;
      for (const r of tr.state.selection.ranges) {
        if (tr.state.doc.lineAt(r.head).number === expandedLine) {
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

// ── Protected ranges: hidden, non-editable regions ─────
// Import lines and #note()/#bibliography() blocks are hidden in visual mode.
// These ranges must also reject cursor entry and edits.

interface ProtectedRange { from: number; to: number }

function computeProtectedRanges(state: EditorState, expandedPos: number | null): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  const docLen = state.doc.length;

  // Import lines and #note()/#bibliography() calls in the first few lines
  // (text-based, works before the syntax tree is ready)
  const maxScanLine = Math.min(state.doc.lines, 10);
  for (let i = 1; i <= maxScanLine; i++) {
    const line = state.doc.line(i);
    const trimmed = line.text.trimStart();

    const isImport = isVaultImportLine(line.text);
    const isNote = trimmed.startsWith("#note(");
    const isBibliography = trimmed.startsWith("#bibliography(");

    if (!isImport && !isNote && !isBibliography) continue;

    let hideEnd = line.to;

    // For multi-line #note() calls, scan forward to find the closing paren
    if (isNote && !trimmed.includes(")")) {
      for (let j = i + 1; j <= Math.min(state.doc.lines, i + 20); j++) {
        const nextLine = state.doc.line(j);
        hideEnd = nextLine.to;
        if (nextLine.text.includes(")")) break;
      }
    }

    // Include trailing newline
    if (hideEnd < docLen) {
      hideEnd = Math.min(hideEnd + 1, docLen);
    }
    // Absorb a following blank line
    if (hideEnd < docLen) {
      const nextLine = state.doc.lineAt(hideEnd);
      if (nextLine.text.trim() === "") {
        hideEnd = Math.min(nextLine.to + 1, docLen);
      }
    }
    // Skip bibliography while it's expanded so the cursor can land inside.
    if (isBibliography && expandedPos !== null && expandedPos >= line.from && expandedPos < hideEnd) {
      continue;
    }
    ranges.push({ from: line.from, to: Math.min(hideEnd, docLen) });
  }

  // Also check via syntax tree for #note()/#bibliography() that may appear
  // beyond the first few lines (e.g. bibliography at end of file)
  syntaxTree(state).iterate({
    from: 0,
    to: docLen,
    enter(node) {
      if (node.name !== "FuncCall") return;
      if (node.from > docLen || node.to > docLen) return;
      const text = state.doc.sliceString(node.from, node.to);
      const match = text.match(/^#(\w[\w-]*)/);
      if (!match) return;
      const funcName = match[1];
      if (funcName !== "note" && funcName !== "bibliography") return;

      // Skip if already covered by text-based scan
      const alreadyCovered = ranges.some(
        (r) => node.from >= r.from && node.to <= r.to,
      );
      if (alreadyCovered) return;

      let hideEnd = node.to;
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
      if (funcName === "bibliography" && expandedPos !== null
          && expandedPos >= node.from && expandedPos < hideEnd) {
        return;
      }
      ranges.push({ from: node.from, to: Math.min(hideEnd, docLen) });
    },
  });

  return ranges;
}

const protectedRangesField = StateField.define<ProtectedRange[]>({
  create(state) {
    const expanded = state.field(expandedFuncField, false) ?? null;
    return computeProtectedRanges(state, expanded);
  },
  update(ranges, tr) {
    const startExpanded = tr.startState.field(expandedFuncField, false) ?? null;
    const newExpanded = tr.state.field(expandedFuncField, false) ?? null;
    if (tr.docChanged
        || syntaxTree(tr.state) !== syntaxTree(tr.startState)
        || startExpanded !== newExpanded) {
      return computeProtectedRanges(tr.state, newExpanded);
    }
    return ranges;
  },
});

function isInProtectedRange(pos: number, ranges: ProtectedRange[]): boolean {
  for (const r of ranges) {
    if (pos >= r.from && pos < r.to) return true;
  }
  return false;
}

function pushOutOfProtected(pos: number, ranges: ProtectedRange[]): number {
  for (const r of ranges) {
    if (pos >= r.from && pos < r.to) {
      return r.to;
    }
  }
  return pos;
}

function adjustBlockWidgetCursor(state: EditorState, pos: number): number | null {
  const line = state.doc.lineAt(pos);
  const lineText = line.text;
  for (const funcName of BLOCK_WIDGET_FUNCS) {
    const prefix = `#${funcName}(`;
    if (lineText.startsWith(prefix)) {
      const argRange = extractFirstStringArgRange(lineText, line.from);
      if (!argRange) continue;
      if (pos >= line.from && pos < argRange.from) {
        return argRange.from;
      }
      if (pos > argRange.to && pos < line.to) {
        return argRange.to;
      }
    }
  }
  return null;
}

const protectedCursorFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection) return tr;
  // When the document is changing (typing, paste, etc.), selection positions
  // are in the new document's coordinate space while protected ranges and
  // block-widget positions are in the old document's space.  Skip cursor
  // adjustments for doc-changing transactions — they only matter for
  // navigation (arrow keys, clicks).
  if (tr.docChanged) return tr;

  const ranges = tr.startState.field(protectedRangesField, false);

  const hasExpandEffect = tr.effects?.some((e: any) => e.is(expandFunc));
  const expandedPos = tr.startState.field(expandedFuncField, false) ?? null;

  let needsUpdate = false;
  const newRanges = tr.selection.ranges.map((range) => {
    let newHead = range.head;
    let newAnchor = range.anchor;

    // When an expandFunc effect fires, the user is intentionally moving the
    // cursor into the function call (e.g. clicked the bibliography pill).
    // Don't push them back out — the protected-ranges field will recompute
    // on the next transaction with the new expandedFuncField and exclude
    // the range, but for THIS transaction the old ranges still include it.
    if (ranges && ranges.length > 0 && !hasExpandEffect) {
      newHead = pushOutOfProtected(newHead, ranges);
      newAnchor = range.empty ? newHead : pushOutOfProtected(newAnchor, ranges);
    }

    if (!hasExpandEffect) {
      const line = tr.startState.doc.lineAt(newHead);
      const lineExpanded = expandedPos !== null && expandedPos >= line.from && expandedPos <= line.to;
      const isAutoExpand = tr.startState.facet(autoExpandFacet);
      if (!lineExpanded && !isAutoExpand) {
        const adjusted = adjustBlockWidgetCursor(tr.startState, newHead);
        if (adjusted !== null) {
          newHead = adjusted;
          if (range.empty) newAnchor = newHead;
        }
      }
    }

    if (newHead !== range.head || newAnchor !== range.anchor) {
      needsUpdate = true;
      return EditorSelection.range(newAnchor, newHead);
    }
    return range;
  });

  if (!needsUpdate) return tr;
  return [tr, { selection: EditorSelection.create(newRanges, tr.selection.mainIndex) }];
});

// Annotated by external reloads (sidebar property edits) so the protected-
// range filter knows to step out of the way. Protected ranges exist to keep
// the user from accidentally deleting through a widget while typing — they
// must NOT preserve stale source against a wholesale buffer replacement.
export const externalReload = Annotation.define<boolean>();

const protectedChangeFilter = EditorState.changeFilter.of((tr) => {
  if (tr.annotation(externalReload)) return true;
  const ranges = tr.startState.field(protectedRangesField, false);
  if (!ranges || ranges.length === 0) return true;

  let hasOverlap = false;
  let allContained = true;
  tr.changes.iterChanges((fromA, toA) => {
    for (const r of ranges) {
      if (fromA < r.to && toA > r.from) {
        hasOverlap = true;
        if (fromA >= r.from && toA <= r.to) {
          // Change entirely within a protected range — block it
        } else {
          // Change spans beyond a protected range (e.g. select-all + delete)
          allContained = false;
        }
        return;
      }
    }
  });

  if (!hasOverlap) return true;
  if (allContained) return false;

  // For changes that span protected ranges (like select-all + delete),
  // return the protected sub-ranges so CodeMirror filters them OUT of the
  // change — i.e. leaves them untouched. The returned array is a flat list
  // of from/to pairs of ranges that must not be modified.
  const filtered: number[] = [];
  tr.changes.iterChanges((fromA, toA) => {
    for (const r of ranges) {
      if (r.from >= toA) break;
      if (r.to <= fromA) continue;
      filtered.push(Math.max(fromA, r.from), Math.min(toA, r.to));
    }
  });
  return filtered;
});

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
    if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
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
      if (!setsEqual(oldLines, newLines)) {
        return buildDecorations(tr.state);
      }
      if (cursorNearDecoTrigger(tr.startState) || cursorNearDecoTrigger(tr.state)) {
        return buildDecorations(tr.state);
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

export const visualTheme = EditorView.theme({
  ".cm-scroller": { overflowAnchor: "none" },
  ".cm-cursor": { maxHeight: "1.5em" },
  ".cm-gutters": {
    display: "none !important",
  },
  ".cm-typst-bold": { fontWeight: "bold" },
  ".cm-typst-italic": { fontStyle: "italic", color: "inherit" },
  ".cm-typst-strike": { textDecoration: "line-through", color: "var(--syntax-strike)" },
  ".cm-typst-highlight": {
    backgroundColor: "var(--bg-search-match)",
    borderRadius: "2px",
    padding: "0 2px",
  },
  ".cm-typst-raw-inline": {
    fontFamily: "var(--editor-font-mono, monospace)",
    backgroundColor: "var(--syntax-mono-bg)",
    borderRadius: "3px",
    padding: "1px 4px",
  },
  ".cm-typst-link": {
    color: "var(--syntax-link)",
    textDecoration: "underline",
  },
  ".cm-typst-link-external-icon": {
    display: "inline-block",
    verticalAlign: "baseline",
    marginLeft: "2px",
    opacity: "0.5",
    position: "relative",
    top: "1px",
  },
  ".cm-link-hover": {
    cursor: "pointer",
  },
  ".cm-typst-math-inline": {
    fontFamily: "var(--editor-font-mono, monospace)",
    color: "var(--syntax-string)",
  },
  ".cm-typst-math-display": {
    fontFamily: "var(--editor-font-mono, monospace)",
    color: "var(--syntax-string)",
    display: "block",
    padding: "0.5em 0",
  },
  ".cm-typst-label": {
    color: "var(--syntax-type)",
    opacity: "0.6",
  },
  ".cm-typst-ref": {
    color: "var(--syntax-type)",
    cursor: "pointer",
  },
  ".cm-typst-h1, .cm-typst-h2, .cm-typst-h3, .cm-typst-h4, .cm-typst-h5, .cm-typst-h6": {
    color: "var(--fg-primary)",
  },
  ".cm-typst-h1 span, .cm-typst-h2 span, .cm-typst-h3 span, .cm-typst-h4 span, .cm-typst-h5 span, .cm-typst-h6 span": {
    color: "inherit !important",
  },
  ".cm-typst-h1": { fontSize: "1.8em", fontWeight: "bold", lineHeight: "1.3" },
  ".cm-typst-h2": { fontSize: "1.5em", fontWeight: "bold", lineHeight: "1.3" },
  ".cm-typst-h3": { fontSize: "1.3em", fontWeight: "bold", lineHeight: "1.3" },
  ".cm-typst-h4": { fontSize: "1.15em", fontWeight: "bold", lineHeight: "1.3" },
  ".cm-typst-h5": { fontSize: "1.05em", fontWeight: "bold", lineHeight: "1.3" },
  ".cm-typst-h6": { fontSize: "1em", fontWeight: "bold", fontStyle: "italic", lineHeight: "1.3" },
  ".cm-typst-escaped, .cm-typst-escaped span": {
    color: "inherit !important",
    fontWeight: "inherit !important",
    fontStyle: "inherit !important",
  },
  ".cm-typst-term-key": {
    fontWeight: "bold",
  },
  ".cm-typst-term-sep": {
    color: "var(--fg-dim)",
    marginRight: "0.3em",
  },
  ".cm-typst-shorthand": {
    color: "inherit",
  },
  ".cm-typst-list-bullet": {
    color: "var(--accent)",
    display: "inline-block",
    width: "1.2em",
    textAlign: "center",
  },
  ".cm-typst-hr": {
    border: "none",
    borderTop: "2px solid var(--border-primary)",
    margin: "1em 0",
    display: "block",
  },
  ".cm-typst-callout": {
    borderLeft: "3px solid var(--accent)",
    borderRadius: "4px",
    padding: "8px 12px",
    margin: "4px 0",
    display: "block",
  },
  ".cm-typst-callout-heading": {
    fontWeight: "bold",
    fontSize: "0.95em",
    marginBottom: "4px",
  },
  ".cm-typst-callout-body": {
    fontSize: "0.95em",
    lineHeight: "1.5",
  },
  ".cm-typst-codeblock": {
    fontFamily: "var(--editor-font-mono, monospace)",
    backgroundColor: "var(--bg-secondary)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "6px",
    padding: "0",
    margin: "4px 0",
    display: "block",
    overflow: "hidden",
  },
  ".cm-typst-codeblock-header": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "6px",
    padding: "2px 6px 2px 10px",
    borderBottom: "1px solid var(--border-subtle)",
    backgroundColor: "var(--bg-hover)",
    minHeight: "22px",
  },
  ".cm-typst-codeblock-lang": {
    fontSize: "0.75em",
    color: "var(--fg-dim)",
    fontFamily: "var(--editor-font-mono, monospace)",
  },
  ".cm-typst-codeblock-copy": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "22px",
    height: "22px",
    padding: "0",
    border: "none",
    borderRadius: "4px",
    background: "transparent",
    color: "var(--fg-dim)",
    cursor: "pointer",
    transition: "background-color 0.12s, color 0.12s",
    fontFamily: "inherit",
  },
  ".cm-typst-codeblock-copy:hover": {
    backgroundColor: "var(--bg-tertiary, var(--bg-secondary))",
    color: "var(--fg-primary)",
  },
  ".cm-typst-codeblock-copy.is-copied": {
    color: "var(--accent-color, #1D7874)",
  },
  ".cm-typst-codeblock pre": {
    margin: "0",
    padding: "8px 10px",
    overflow: "auto",
    fontSize: "0.9em",
    lineHeight: "1.5",
    fontFamily: "inherit",
  },
  ".cm-typst-codeblock code": {
    fontFamily: "inherit",
  },
  // Edit-mode lines: when the cursor enters the code block we show the raw
  // source instead of the widget. Just the monospace font + a tighter size;
  // no surrounding frame, since the visible delimiters (` ``` `) already
  // mark the block boundaries while editing.
  ".cm-typst-codeblock-edit": {
    fontFamily: "var(--editor-font-mono, monospace) !important",
    fontSize: "0.9em",
  },
  ".cm-typst-block-pill-row": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "1px 0",
    margin: "0",
    lineHeight: "1.4",
  },
  ".cm-typst-image-block": {
    display: "block",
    position: "relative",
    margin: "0",
    textAlign: "center" as any,
  },
  ".cm-typst-image-block-path": {
    fontFamily: "var(--editor-font-mono, monospace)",
    fontSize: "0.85em",
    color: "var(--fg-dim)",
    marginLeft: "4px",
  },
  ".cm-typst-embed-block": {
    display: "block",
    position: "relative",
    margin: "0",
  },
  ".cm-typst-embed-block-name": {
    fontFamily: "var(--editor-font-mono, monospace)",
    fontSize: "0.85em",
    color: "var(--fg-dim)",
    marginLeft: "4px",
  },
  ".cm-typst-callout-block": {
    display: "block",
    position: "relative",
    margin: "0",
  },
  ".cm-typst-blockquote-block": {
    display: "block",
    position: "relative",
    margin: "0",
  },
  ".cm-typst-bibliography-block": {
    display: "block",
    position: "relative",
    margin: "0",
  },
  ".cm-typst-bibliography-block-path": {
    fontFamily: "var(--editor-font-mono, monospace)",
    fontSize: "0.85em",
    color: "var(--fg-dim)",
    marginLeft: "6px",
    opacity: "0.8",
  },
  ".cm-typst-block-collapsed-body": {
    fontSize: "0.9em",
    color: "var(--fg-dim)",
    marginLeft: "4px",
  },
  ".cm-typst-image": {
    display: "block",
    position: "relative",
    margin: "4px 0",
    textAlign: "center" as any,
  },
  ".cm-typst-image-img": {
    maxWidth: "100%",
    maxHeight: "400px",
    borderRadius: "4px",
    display: "block",
    margin: "0 auto",
  },
  ".cm-typst-image-label": {
    fontFamily: "var(--editor-font-mono, monospace)",
    fontSize: "0.75em",
    color: "var(--fg-dim)",
    padding: "2px 6px",
    textAlign: "center" as any,
  },
  ".cm-typst-embed": {
    display: "block",
    position: "relative",
    backgroundColor: "var(--bg-secondary)",
    border: "1px solid var(--border-subtle)",
    borderLeft: "3px solid var(--accent, #1D7874)",
    borderRadius: "4px",
    margin: "4px 0",
    overflow: "hidden",
  },
  ".cm-typst-embed-header": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "6px 10px",
    fontSize: "0.9em",
    fontWeight: "600",
    color: "var(--accent-text)",
    borderBottom: "1px solid var(--border-subtle)",
    backgroundColor: "var(--bg-hover)",
  },
  ".cm-typst-embed-icon": {
    fontSize: "1em",
    color: "var(--fg-dim)",
  },
  ".cm-typst-embed-label": {
    color: "var(--accent-text)",
  },
  ".cm-typst-embed-nav-btn": {
    marginLeft: "auto",
    cursor: "pointer",
    opacity: "0.4",
    display: "flex",
    alignItems: "center",
    padding: "2px",
    borderRadius: "3px",
    transition: "opacity 0.15s",
  },
  ".cm-typst-embed-nav-btn:hover": {
    opacity: "1",
    backgroundColor: "var(--bg-hover)",
  },
  ".cm-typst-embed-preview": {
    padding: "8px 10px",
    fontSize: "0.85em",
    lineHeight: "1.5",
    color: "var(--fg-muted)",
    whiteSpace: "pre-line",
    maxHeight: "6em",
    overflow: "hidden",
  },
  ".cm-typst-embed-preview--error": {
    fontStyle: "italic",
    color: "var(--fg-dim)",
  },
  ".cm-typst-tag": {
    display: "inline-block",
    backgroundColor: "var(--accent-purple-bg)",
    color: "var(--accent-text)",
    borderRadius: "3px",
    padding: "1px 6px",
    fontSize: "0.85em",
    cursor: "pointer",
  },
  ".cm-typst-wikilink": {
    display: "inline",
    color: "var(--syntax-link)",
    textDecoration: "underline",
    textDecorationStyle: "solid",
    cursor: "pointer",
  },
  ".cm-typst-wikilink.cm-typst-wikilink--unresolved": {
    textDecorationStyle: "dotted",
    opacity: "0.85",
  },
  ".cm-typst-wikilink.cm-typst-strike": {
    textDecoration: "underline line-through",
  },
  ".cm-typst-wikilink.cm-typst-highlight": {
    backgroundColor: "var(--bg-search-match)",
    borderRadius: "2px",
    padding: "0 2px",
  },
  ".cm-typst-wikilink-sep": {
    color: "var(--fg-dim)",
    opacity: "0.6",
  },
  ".cm-typst-wikilink-label": {
    fontSize: "0.85em",
    fontWeight: "300",
    opacity: "0.7",
  },
  ".cm-typst-footnote": {
    color: "var(--syntax-link)",
    cursor: "help",
    fontSize: "0.8em",
    verticalAlign: "super",
    fontWeight: "bold",
  },
  ".cm-typst-blockquote": {
    display: "block",
    borderLeft: "3px solid var(--border-primary)",
    padding: "8px 16px",
    margin: "8px 0",
    fontStyle: "italic",
    color: "var(--fg-muted)",
  },
  ".cm-typst-blockquote-text": {
    lineHeight: "1.6",
  },
  ".cm-typst-blockquote-attr": {
    marginTop: "4px",
    fontSize: "0.9em",
    fontStyle: "normal",
    color: "var(--fg-dim)",
  },
  // ── Pills (R1–R3) ──
  // Single visual identity for every pill in the visual editor. Inline,
  // block-row, and embedded sites all use this class. See
  // documentation/developer/visual-editor/pill-system.md.
  // .cm-typst-func-chip is kept as an alias so legacy call sites that
  // still reference it pick up the same styles during the staged rollout.
  ".cm-typst-pill, .cm-typst-func-chip": {
    display: "inline-flex",
    alignItems: "center",
    gap: "3px",
    backgroundColor: "var(--bg-secondary)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "12px",
    padding: "1px 8px 1px 4px",
    fontSize: "0.85em",
    fontFamily: "var(--editor-font-mono, monospace)",
    color: "var(--fg-muted)",
    cursor: "pointer",
    verticalAlign: "middle",
    userSelect: "none",
    // Reset native button visuals so a <button> matches a <span>.
    font: "inherit",
    lineHeight: "1.4",
    margin: "0",
  },
  ".cm-typst-pill:hover, .cm-typst-func-chip:hover, .cm-typst-pill:focus-visible, .cm-typst-func-chip:focus-visible": {
    color: "var(--fg-primary)",
    borderColor: "var(--accent)",
    outline: "none",
  },
  ".cm-typst-pill-hash, .cm-typst-func-chip-hash": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.18em",
    height: "1.18em",
    borderRadius: "50%",
    backgroundColor: "var(--accent, #1D7874)",
    color: "var(--pill-fg, #fff)",
    fontSize: "inherit",
    lineHeight: "0",
    transition: "background-color 0.12s ease",
  },
  ".cm-typst-pill-hash::after, .cm-typst-func-chip-hash::after": {
    content: "'#'",
    fontSize: "0.76em",
    fontWeight: "bold",
    lineHeight: "1",
  },
  // ── Pill super-context-menu (R6) ──
  ".cm-typst-pill-menu": {
    backgroundColor: "var(--bg-primary)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "6px",
    padding: "4px 0",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.18)",
    zIndex: "1000",
    minWidth: "200px",
    fontSize: "0.9em",
    fontFamily: "var(--editor-font-body, inherit)",
  },
  ".cm-typst-pill-menu-heading": {
    padding: "4px 12px 2px",
    fontSize: "0.78em",
    fontWeight: "600",
    letterSpacing: "0.3px",
    color: "var(--fg-muted)",
  },
  ".cm-typst-pill-menu-sep": {
    height: "1px",
    margin: "4px 0",
    backgroundColor: "var(--border-subtle)",
  },
  ".cm-typst-pill-menu-item": {
    display: "flex",
    alignItems: "center",
    width: "100%",
    padding: "5px 12px",
    fontSize: "inherit",
    fontFamily: "inherit",
    color: "var(--fg-primary)",
    backgroundColor: "transparent",
    border: "none",
    textAlign: "left",
    cursor: "pointer",
    gap: "8px",
  },
  ".cm-typst-pill-menu-item:hover, .cm-typst-pill-menu-item:focus-visible": {
    backgroundColor: "var(--bg-hover)",
    outline: "none",
  },
  ".cm-typst-pill-menu-item.is-disabled": {
    color: "var(--fg-dim)",
    cursor: "not-allowed",
  },
  ".cm-typst-pill-menu-item.is-active": {
    color: "var(--accent)",
  },
  ".cm-typst-pill-menu-label": {
    flex: "1",
  },
  // Sits to the right of the label (the label's flex:1 pushes it there).
  // Keep a small left margin so it doesn't crowd long labels.
  ".cm-typst-pill-menu-check": {
    marginLeft: "8px",
    color: "var(--accent)",
    fontSize: "0.95em",
    lineHeight: "1",
  },
  ".cm-typst-pill-menu-input-row": {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "5px 12px",
    cursor: "default",
  },
  ".cm-typst-pill-menu-input-label": {
    fontSize: "0.92em",
    color: "var(--fg-muted)",
    minWidth: "70px",
    cursor: "text",
  },
  ".cm-typst-pill-menu-input": {
    flex: "1",
    minWidth: "0",
    padding: "3px 6px",
    fontSize: "inherit",
    fontFamily: "inherit",
    color: "var(--fg-primary)",
    backgroundColor: "var(--bg-input, var(--bg-secondary))",
    border: "1px solid var(--border-subtle)",
    borderRadius: "3px",
  },
  ".cm-typst-pill-menu-input:focus": {
    outline: "none",
    borderColor: "var(--accent)",
  },
  ".cm-typst-citation": {
    display: "inline-block",
    backgroundColor: "var(--bg-secondary)",
    color: "var(--syntax-type)",
    borderRadius: "3px",
    padding: "1px 5px",
    fontSize: "0.9em",
    fontFamily: "var(--editor-font-mono, monospace)",
  },
  // ── Verse ──
  // First-class verse element: an open canvas, not a code-block. The
  // pill at top-left identifies it and exposes alignment options; the
  // canvas itself is contentEditable with inline formatting rendered.
  ".cm-typst-verse": {
    display: "block",
    position: "relative",
    margin: "10px 0",
    padding: "0",
    // Subtle dotted top/bottom rules demark the verse region without
    // making it feel boxed-in. Pill at top-left identifies it.
    borderTop: "1px dotted var(--border-subtle)",
    borderBottom: "1px dotted var(--border-subtle)",
    "--verse-active-font": "var(--verse-font, var(--editor-font-body, var(--md-body-font, serif)))",
  },
  // Verse uses the standard .cm-typst-pill class (R1). The verse-specific
  // rule only sets positioning so the pill anchors to the canvas's
  // top-left corner; sizing/colors come from the unified pill rule above.
  ".cm-typst-verse-pill": {
    position: "absolute",
    top: "0",
    left: "0",
    zIndex: "2",
  },
  ".cm-typst-verse-canvas": {
    display: "block",
    minHeight: "1.6em",
    padding: "32px 12px 12px 12px",
    fontFamily: "var(--verse-active-font)",
    fontSize: "inherit",
    lineHeight: "1.7",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    color: "var(--fg-primary)",
    outline: "none",
    caretColor: "var(--accent)",
    "-webkit-user-select": "text",
    userSelect: "text",
  },
  ".cm-typst-verse-canvas:focus": {
    backgroundColor: "var(--bg-hover-subtle, transparent)",
  },
  ".cm-typst-verse-canvas mark": {
    backgroundColor: "var(--highlight-bg, #fff3a3)",
    color: "inherit",
    padding: "0 2px",
    borderRadius: "2px",
  },
  // (Verse alignment popover replaced by the universal pill super-menu.
  // Verse alignment options now live as a section in that menu — see
  // VerseWidget.buildOptionSections in widgets.ts.)
  // ── Table widget ──
  ".cm-typst-table-wrap": {
    display: "block",
    position: "relative",
    margin: "8px 0",
    outline: "none",
  },
  ".cm-typst-table": {
    borderCollapse: "collapse",
    fontSize: "0.9em",
  },
  ".cm-typst-table th, .cm-typst-table td": {
    border: "1px solid var(--border-subtle)",
    padding: "0",
    position: "relative",
  },
  ".cm-typst-table th": {
    backgroundColor: "var(--bg-hover)",
    fontWeight: "bold",
    textAlign: "left",
  },

  // ── Editable cell ──
  ".cm-typst-table-cell": {
    minHeight: "1.6em",
    padding: "4px 8px",
    outline: "none",
    lineHeight: "1.5",
    cursor: "default",
    "-webkit-user-select": "text",
    userSelect: "text",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  ".cm-typst-table-cell:focus, .cm-typst-table-cell.cm-typst-table-cell--editing": {
    boxShadow: "inset 0 0 0 2px var(--accent)",
    cursor: "text",
  },
  ".cm-typst-table-cell::selection, .cm-typst-table-cell *::selection": {
    background: "var(--bg-selection, Highlight) !important",
    color: "inherit",
  },
  ".cm-typst-table-cell--selected": {
    backgroundColor: "var(--bg-search-match, rgba(59, 130, 246, 0.15))",
  },

  // ── Column/row selection highlight ──
  ".cm-table-col--selected": {
    backgroundColor: "rgba(59, 130, 246, 0.08)",
    boxShadow: "inset 0 0 0 1.5px var(--accent)",
  },
  ".cm-table-row--selected": {
    backgroundColor: "rgba(59, 130, 246, 0.08)",
  },
  ".cm-table-row--selected td, .cm-table-row--selected th": {
    boxShadow: "inset 0 0 0 1.5px var(--accent)",
  },

  // ── Drop indicators during drag reorder ──
  ".cm-table-drop-before": {
    borderLeft: "2.5px solid var(--accent) !important",
  },
  ".cm-table-drop-after": {
    borderRight: "2.5px solid var(--accent) !important",
  },
  "tr.cm-table-drop-before": {
    borderLeft: "none !important",
    borderTop: "2.5px solid var(--accent) !important",
  },
  "tr.cm-table-drop-after": {
    borderRight: "none !important",
    borderBottom: "2.5px solid var(--accent) !important",
  },

  // ── Control row (column handles above data) ──
  ".cm-table-control-row": {
    opacity: "0",
    transition: "opacity 0.15s",
  },
  ".cm-typst-table-wrap:hover .cm-table-control-row, .cm-typst-table-wrap:focus-within .cm-table-control-row": {
    opacity: "1",
  },
  ".cm-table-control-row td": {
    border: "none !important",
    padding: "0 !important",
    height: "16px",
    position: "relative",
  },
  ".cm-table-corner-cell": {
    width: "18px",
    minWidth: "18px",
    maxWidth: "18px",
    border: "none !important",
  },
  ".cm-table-col-header-cell": {
    textAlign: "center",
    position: "relative",
  },
  ".cm-table-col-handle": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: "100%",
    fontSize: "var(--text-xs)",
    color: "var(--fg-dim)",
    cursor: "grab",
    userSelect: "none",
    borderRadius: "2px",
  },
  ".cm-table-row-handle": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: "100%",
    fontSize: "var(--text-xs)",
    color: "var(--fg-dim)",
    cursor: "grab",
    userSelect: "none",
    borderRadius: "2px",
  },
  ".cm-table-col-handle:hover, .cm-table-row-handle:hover": {
    backgroundColor: "var(--bg-hover)",
    color: "var(--fg-primary)",
  },
  ".cm-table-col-handle.cm-table-handle--dragging, .cm-table-row-handle.cm-table-handle--dragging": {
    opacity: "0.4",
    cursor: "grabbing",
  },

  ".cm-table-handle-grip": {
    pointerEvents: "none",
    lineHeight: "1",
    letterSpacing: "0px",
  },

  // ── Row handle cells (left column) ──
  ".cm-table-row-handle-cell": {
    width: "18px",
    minWidth: "18px",
    maxWidth: "18px",
    border: "none !important",
    padding: "0 !important",
    position: "relative",
    verticalAlign: "middle",
    opacity: "0",
    transition: "opacity 0.15s",
  },
  ".cm-typst-table-wrap:hover .cm-table-row-handle-cell, .cm-typst-table-wrap:focus-within .cm-table-row-handle-cell": {
    opacity: "1",
  },

  // ── Add (+) buttons at edges ──
  ".cm-table-add-btn": {
    position: "absolute",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    opacity: "0",
    transition: "opacity 0.1s",
    userSelect: "none",
    zIndex: "3",
  },
  ".cm-table-add-btn:hover": {
    opacity: "1 !important",
  },
  ".cm-table-add-btn span": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "16px",
    height: "16px",
    borderRadius: "50%",
    backgroundColor: "var(--accent)",
    color: "var(--pill-fg, #fff)",
    fontSize: "var(--text-base)",
    fontWeight: "bold",
    lineHeight: "1",
  },
  ".cm-table-add-btn--col": {
    top: "0",
    bottom: "0",
    width: "16px",
    marginLeft: "-8px",
  },
  ".cm-table-col-header-cell .cm-table-add-btn--col:first-child": {
    left: "-1px",
  },
  ".cm-table-col-header-cell .cm-table-add-btn--col:last-child": {
    right: "-9px",
  },
  ".cm-table-add-btn--row": {
    left: "0",
    right: "0",
    height: "16px",
    marginTop: "-8px",
  },
  ".cm-table-row-handle-cell .cm-table-add-btn--row:first-child": {
    top: "-1px",
  },
  ".cm-table-row-handle-cell .cm-table-add-btn--row:last-child": {
    bottom: "-9px",
    top: "auto",
    marginTop: "0",
  },

  // ── Angle bracket warning ──
  ".cm-typst-angle-bracket-warning": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.1em",
    height: "1.1em",
    fontSize: "0.8em",
    color: "var(--warn-fg, #d97706)",
    cursor: "pointer",
    verticalAlign: "middle",
    marginRight: "2px",
    userSelect: "none",
    borderRadius: "3px",
    backgroundColor: "var(--warn-bg-alpha, color-mix(in srgb, #d97706 12%, transparent))",
  },

  // Context menu styles are inline — the menu is appended to document.body
  // which is outside the CM6 editor, so theme-scoped CSS doesn't apply.
});

function findLinkAtPos(state: EditorState, pos: number): { url: string } | null {
  let cur = syntaxTree(state).resolveInner(pos, 0);
  while (cur) {
    if (cur.name === "Link") {
      const text = state.doc.sliceString(cur.from, cur.to);
      if (/^https?:\/\//.test(text)) return { url: text };
    }
    if (cur.name === "FuncCall") {
      const funcFrom = (cur.from > 0 && state.doc.sliceString(cur.from - 1, cur.from) === "#")
        ? cur.from - 1 : cur.from;
      const text = state.doc.sliceString(funcFrom, cur.to);
      const hashOffset = text.startsWith("#") ? 1 : 0;
      const nameEnd = text.indexOf("(", hashOffset);
      if (nameEnd >= 0) {
        const funcName = text.substring(hashOffset, nameEnd).trim();
        if (funcName === "link") {
          const url = extractFirstStringArg(text);
          if (url) return { url };
        }
      }
    }
    if (!cur.parent) break;
    cur = cur.parent;
  }
  return null;
}

const linkClickHandler = EditorView.domEventHandlers({
  click(event: MouseEvent, view: EditorView) {
    if (!event.ctrlKey && !event.metaKey) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    const link = findLinkAtPos(view.state, pos);
    if (!link) return false;
    shellOpen(link.url);
    event.preventDefault();
    return true;
  },
  mousemove(event: MouseEvent, view: EditorView) {
    const hasModifier = event.ctrlKey || event.metaKey;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) {
      view.contentDOM.classList.remove("cm-link-hover");
      return false;
    }
    const link = hasModifier ? findLinkAtPos(view.state, pos) : null;
    if (link) {
      view.contentDOM.classList.add("cm-link-hover");
      const el = event.target as HTMLElement;
      const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
      el.title = `${isMac ? "⌘" : "Ctrl"}+Click to follow link`;
    } else {
      view.contentDOM.classList.remove("cm-link-hover");
    }
    return false;
  },
  keyup(event: KeyboardEvent, view: EditorView) {
    if (event.key === "Control" || event.key === "Meta") {
      view.contentDOM.classList.remove("cm-link-hover");
    }
    return false;
  },
});

const tableClipboardHandler = EditorView.domEventHandlers({
  copy(event: ClipboardEvent, view: EditorView) {
    const selected = view.dom.querySelectorAll(".cm-typst-table-cell--selected");
    if (selected.length === 0) return false;

    const wrap = selected[0].closest<HTMLElement>(".cm-typst-table-wrap");
    if (!wrap) return false;

    event.preventDefault();
    const allRows = Array.from(wrap.querySelectorAll<HTMLElement>("tr[data-logical-row]"));
    const lines: string[] = [];
    for (const row of allRows) {
      const cells = Array.from(row.querySelectorAll<HTMLElement>(".cm-typst-table-cell--selected"));
      if (cells.length > 0) {
        lines.push(cells.map(c => c.textContent ?? "").join("\t"));
      }
    }
    event.clipboardData!.setData("text/plain", lines.join("\n"));
    return true;
  },
});

const tablePasteHandler = EditorView.domEventHandlers({
  paste(event: ClipboardEvent, view: EditorView) {
    const target = event.target as HTMLElement;
    if (target.closest?.(".cm-typst-table-wrap")) return false;

    const grid = parseClipboardAsGrid(event);
    if (!grid || grid.length === 0) return false;

    const colCount = Math.max(...grid.map(r => r.length));
    if (colCount <= 1) return false;

    event.preventDefault();

    const data: TableData = {
      columns: Array(colCount).fill("auto"),
      align: null,
      header: null,
      rows: grid.map(r => {
        const cells: TableCell[] = [];
        for (let i = 0; i < colCount; i++) {
          cells.push({ content: r[i] ?? "", relFrom: 0, relTo: 0 });
        }
        return cells;
      }),
      sourceText: "",
    };

    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    view.dispatch({
      changes: { from: line.to, insert: "\n" + serializeTable(data) + "\n" },
    });

    return true;
  },
});


export { protectedRangesField };

function findTableWrapNear(view: EditorView, pos: number, direction: "up" | "down"): HTMLElement | null {
  const decos = view.state.field(visualField, false);
  if (!decos) return null;
  let tableFrom = -1;
  let tableTo = -1;
  decos.between(0, view.state.doc.length, (f, t, deco) => {
    if (!(deco.spec?.widget instanceof TableWidget)) return;
    if (direction === "up" && t <= pos && t > tableTo) {
      tableFrom = f;
      tableTo = t;
    }
    if (direction === "down" && f >= pos && (tableFrom < 0 || f < tableFrom)) {
      tableFrom = f;
      tableTo = t;
    }
  });
  if (tableFrom < 0) return null;
  const line = view.state.doc.lineAt(pos);
  const adjacentLine = direction === "up"
    ? (line.number > 1 ? view.state.doc.line(line.number - 1) : null)
    : (line.number < view.state.doc.lines ? view.state.doc.line(line.number + 1) : null);
  if (!adjacentLine) return null;
  if (direction === "up" && !(tableTo > adjacentLine.from && tableFrom <= adjacentLine.to)) return null;
  if (direction === "down" && !(tableFrom <= adjacentLine.to && tableTo >= adjacentLine.from)) return null;

  const allWraps = view.dom.querySelectorAll<HTMLElement>(".cm-typst-table-wrap");
  for (const w of allWraps) {
    try {
      const p = view.posAtDOM(w);
      if (p >= tableFrom && p <= tableTo) return w;
    } catch { /* posAtDOM can throw for unmounted nodes */ }
  }
  return null;
}

const tableEntryKeymap = keymap.of([
  {
    key: "ArrowUp",
    run(view) {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      // On a wrapped line, only enter the table when the cursor is on
      // the first visual line — otherwise let normal cursor movement
      // navigate within the wrapped line first.
      const headCoords = view.coordsAtPos(head);
      const lineStartCoords = view.coordsAtPos(line.from);
      if (headCoords && lineStartCoords && headCoords.top > lineStartCoords.top + 2) {
        return false;
      }
      const wrap = findTableWrapNear(view, head, "up");
      if (!wrap) return false;
      wrap.focus();
      const cells = wrap.querySelectorAll<HTMLElement>(".cm-typst-table-cell");
      if (cells.length > 0) {
        cells[cells.length - 1].classList.add("cm-typst-table-cell--selected");
      }
      return true;
    },
  },
  {
    key: "ArrowDown",
    run(view) {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      // On a wrapped line, only enter the table when the cursor is on
      // the last visual line.
      const headCoords = view.coordsAtPos(head);
      const lineEndCoords = view.coordsAtPos(line.to);
      if (headCoords && lineEndCoords && headCoords.top < lineEndCoords.top - 2) {
        return false;
      }
      const wrap = findTableWrapNear(view, head, "down");
      if (!wrap) return false;
      wrap.focus();
      const cells = wrap.querySelectorAll<HTMLElement>(".cm-typst-table-cell");
      if (cells.length > 0) {
        cells[0].classList.add("cm-typst-table-cell--selected");
      }
      return true;
    },
  },
]);

// Click-anchored scroll preservation.
//
// Many visual-editor interactions reshape the document around the user's
// click: clicking an image collapses it to a pill, clicking a pill expands
// it to raw source. Each changes line heights and shifts every line below
// — and at the bottom of a document the browser also clamps scrollTop.
//
// To keep the click target visually stable, this plugin captures the doc
// position under each mousedown along with that position's pre-click
// `coordsAtPos.top`. After CM applies an update that changes the visual
// decoration set, we measure the same position again and nudge scrollTop
// by the difference so the position stays at the same y. We compare the
// SAME quantity on both sides so plain-text clicks (where the line
// doesn't actually move) yield delta ≈ 0 and don't introduce drift —
// using mouse clientY here would bias every click by the offset between
// the line top and the pointer position.
//
// If the desired scrollTop would be clamped (e.g. an at-bottom widget
// collapsed and the doc shrank below where we'd want to land), we bail
// rather than partially compensate. The user sees a one-time jump on
// that click instead of accumulating residue across subsequent clicks.
const clickAnchorPlugin = ViewPlugin.fromClass(class {
  pending: { pos: number; oldTop: number; deadline: number } | null = null;

  constructor(view: EditorView) {
    view.scrollDOM.addEventListener("mousedown", (e) => {
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return;
      const coords = view.coordsAtPos(pos);
      if (!coords) return;
      this.pending = { pos, oldTop: coords.top, deadline: performance.now() + 250 };
    }, true);
  }

  update(update: ViewUpdate) {
    if (!this.pending) return;
    if (performance.now() > this.pending.deadline) {
      this.pending = null;
      return;
    }
    const hasExpandEffect = update.transactions.some(tr =>
      tr.effects.some((e: any) => e.is(expandFunc)),
    );
    if (hasExpandEffect) {
      this.pending = null;
      return;
    }
    const oldDecos = update.startState.field(visualField, false);
    const newDecos = update.state.field(visualField, false);
    if (oldDecos === newDecos) return;

    const { pos, oldTop } = this.pending;
    this.pending = null;
    const view = update.view;
    // Layout reads (coordsAtPos) are forbidden during the update phase.
    // Defer to CM6's measure cycle so the read happens after the DOM
    // catches up — calling coordsAtPos directly here throws "Reading
    // the editor layout isn't allowed during an update", which CM
    // surfaces as a plugin crash and disables the plugin for the
    // remainder of the session, breaking decoration refresh on
    // subsequent edits.
    const clamped = Math.min(pos, view.state.doc.length);
    view.requestMeasure({
      read(v) { return v.coordsAtPos(clamped); },
      write(coords, v) {
        if (!coords) return;
        const delta = coords.top - oldTop;
        if (Math.abs(delta) < 0.5) return;
        const scroller = v.scrollDOM;
        const target = scroller.scrollTop + delta;
        const max = scroller.scrollHeight - scroller.clientHeight;
        if (target < -0.5 || target > max + 0.5) return;
        scroller.scrollTop = target;
      },
    });
  }
});

export function typstVisualMode() {
  return [expandedFuncField, protectedRangesField, protectedCursorFilter, protectedChangeFilter, Prec.high(tableEntryKeymap), visualField, postHistoryRebuild, visualTheme, linkClickHandler, tableClipboardHandler, tablePasteHandler, commandPalette, selectionToolbar, clickAnchorPlugin];
}
