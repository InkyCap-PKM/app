import { Annotation, EditorSelection, EditorState, StateField } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { expandFunc } from "./effects";

export interface ProtectedRange { from: number; to: number }

const CANONICAL_IMPORT_PREFIX = '#import "/.inkycap/notebox.typ"';
export function isNoteboxImportLine(text: string): boolean {
  return text.trimStart().startsWith(CANONICAL_IMPORT_PREFIX);
}

/** True for any `#import …` line (the notebox import, a `@preview/…`
 *  package, a local module — anything). The `\b` stops `#important`-style
 *  false matches. */
export function isImportLine(text: string): boolean {
  return /^#import\b/.test(text.trimStart());
}

/**
 * Byte ranges (line + trailing newline) of the leading run of `#import`
 * lines at the very top of the note — the notebox import plus any package
 * imports a user or a template added. Blank lines inside the run are
 * tolerated; the run ends at the first line that is neither blank nor an
 * import (typically the `#note(...)` properties call or the first body
 * line). These are hidden and locked in the visual editor so the preamble
 * reads as a clean document, while the source editor leaves them fully
 * visible and editable (only the notebox import is also locked in source,
 * via `importLineGuard`).
 */
export function computePreambleImportRanges(state: EditorState): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  const docLen = state.doc.length;
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);
    if (line.text.trim() === "") continue; // blank gap within the preamble
    if (!isImportLine(line.text)) break;   // first real content ends the run
    const to = line.to < docLen ? Math.min(line.to + 1, docLen) : line.to;
    ranges.push({ from: line.from, to });
  }
  return ranges;
}

/**
 * The range to collapse for a Typst comment node. When the comment is the only
 * thing on its line(s) it swallows the whole line including leading indentation
 * and the trailing newline, so a full-line comment leaves no blank gap in the
 * visual editor; a trailing comment (`code // note`) collapses only the comment
 * span. Used for both hiding (visual-plugin) and locking (here) so the two agree.
 */
export function commentHideRange(
  state: EditorState,
  from: number,
  to: number,
): ProtectedRange {
  const docLen = state.doc.length;
  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(to);
  const beforeBlank = state.doc.sliceString(startLine.from, from).trim() === "";
  const afterBlank = state.doc.sliceString(to, endLine.to).trim() === "";
  let f = from;
  let t = to;
  if (beforeBlank) f = startLine.from;
  if (beforeBlank && afterBlank) {
    t = endLine.to < docLen ? Math.min(endLine.to + 1, docLen) : endLine.to;
  }
  return { from: f, to: t };
}

export function computeProtectedRanges(
  state: EditorState,
  expandedPos: number | null,
): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  const docLen = state.doc.length;

  // Lock the whole leading import block (notebox import + any package
  // imports). Hidden in the visual editor; here it's also made uneditable.
  ranges.push(...computePreambleImportRanges(state));

  const maxScanLine = Math.min(state.doc.lines, 30);
  for (let i = 1; i <= maxScanLine; i++) {
    const line = state.doc.line(i);
    const trimmed = line.text.trimStart();

    const isNote = trimmed.startsWith("#note(");
    const isBibliography = trimmed.startsWith("#bibliography(");

    if (!isNote && !isBibliography) continue;

    let hideEnd = line.to;

    if (isNote || isBibliography) {
      let depth = 0;
      for (const ch of line.text) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      if (depth > 0) {
        for (let j = i + 1; j <= Math.min(state.doc.lines, i + 30); j++) {
          const nextLine = state.doc.line(j);
          for (const ch of nextLine.text) {
            if (ch === "(") depth++;
            else if (ch === ")") depth--;
          }
          hideEnd = nextLine.to;
          if (depth <= 0) break;
        }
      }
    }

    if (hideEnd < docLen) {
      hideEnd = Math.min(hideEnd + 1, docLen);
    }
    if (hideEnd < docLen) {
      const nextLine = state.doc.lineAt(hideEnd);
      if (nextLine.text.trim() === "") {
        hideEnd = Math.min(nextLine.to + 1, docLen);
      }
    }
    if (isBibliography && expandedPos !== null && expandedPos >= line.from && expandedPos < hideEnd) {
      continue;
    }
    ranges.push({ from: line.from, to: Math.min(hideEnd, docLen) });
  }

  syntaxTree(state).iterate({
    from: 0,
    to: docLen,
    enter(node) {
      // Typst comments are source-only — hidden and locked in the visual
      // editor. (These protected-range extensions are visual-mode-only, so the
      // source editor still shows and edits comments normally.) Syntax-tree
      // based, so a `//` line inside a raw/code block — not a comment node —
      // stays visible as example content.
      if (node.name === "LineComment" || node.name === "BlockComment") {
        ranges.push(commentHideRange(state, node.from, node.to));
        return;
      }
      if (node.name !== "FuncCall") return;
      if (node.from > docLen || node.to > docLen) return;
      const text = state.doc.sliceString(node.from, node.to);
      const match = text.match(/^#(\w[\w-]*)/);
      if (!match) return;
      const funcName = match[1];
      if (funcName !== "note" && funcName !== "bibliography") return;

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

export function isInProtectedRange(pos: number, ranges: ProtectedRange[]): boolean {
  for (const r of ranges) {
    if (pos >= r.from && pos < r.to) return true;
  }
  return false;
}

export function pushOutOfProtected(pos: number, ranges: ProtectedRange[]): number {
  for (const r of ranges) {
    if (pos >= r.from && pos < r.to) {
      return r.to;
    }
  }
  return pos;
}

export function createProtectedRangesField(
  expandedFuncField: StateField<number | null>,
  rebuildEffect: any,
) {
  return StateField.define<ProtectedRange[]>({
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
}

export const externalReload = Annotation.define<boolean>();

export function createProtectedChangeFilter(
  protectedRangesField: StateField<ProtectedRange[]>,
) {
  return EditorState.changeFilter.of((tr) => {
    if (tr.annotation(externalReload)) return true;
    const ranges = tr.startState.field(protectedRangesField, false);
    if (!ranges || ranges.length === 0) return true;

    let hasOverlap = false;
    let allContained = true;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      for (const r of ranges) {
        const isPureInsert = fromA === toA && inserted.length > 0;
        const overlaps = isPureInsert
          ? (fromA >= r.from && fromA < r.to)
          : (fromA < r.to && toA > r.from);
        if (overlaps) {
          hasOverlap = true;
          if (fromA >= r.from && toA <= r.to) {
            // entirely within — block
          } else {
            allContained = false;
          }
          return;
        }
      }
    });

    if (!hasOverlap) return true;
    if (allContained) return false;

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
}

export function createProtectedCursorFilter(
  protectedRangesField: StateField<ProtectedRange[]>,
  expandedFuncField: StateField<number | null>,
  autoExpandFacet: any,
  blockWidgetFuncs: Set<string>,
  extractFirstStringArgRange: (text: string, lineFrom: number) => { from: number; to: number } | null,
) {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.selection) return tr;
    if (tr.docChanged) return tr;

    const ranges = tr.startState.field(protectedRangesField, false);

    const hasExpandEffect = tr.effects?.some((e: any) => e.is(expandFunc));
    const expandedPos = tr.startState.field(expandedFuncField, false) ?? null;

    let needsUpdate = false;
    const newRanges = tr.selection.ranges.map((range) => {
      let newHead = range.head;
      let newAnchor = range.anchor;

      if (ranges && ranges.length > 0 && !hasExpandEffect) {
        newHead = pushOutOfProtected(newHead, ranges);
        newAnchor = range.empty ? newHead : pushOutOfProtected(newAnchor, ranges);
      }

      if (!hasExpandEffect) {
        const line = tr.startState.doc.lineAt(newHead);
        const lineExpanded = expandedPos !== null && expandedPos >= line.from && expandedPos <= line.to;
        const isAutoExpand = tr.startState.facet(autoExpandFacet);
        if (!lineExpanded && !isAutoExpand) {
          const adjusted = adjustBlockWidgetCursor(tr.startState, newHead, blockWidgetFuncs, extractFirstStringArgRange);
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
}

function adjustBlockWidgetCursor(
  state: EditorState,
  pos: number,
  blockWidgetFuncs: Set<string>,
  extractFirstStringArgRange: (text: string, lineFrom: number) => { from: number; to: number } | null,
): number | null {
  const line = state.doc.lineAt(pos);
  const lineText = line.text;
  for (const funcName of blockWidgetFuncs) {
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
