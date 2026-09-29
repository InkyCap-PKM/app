import { Annotation, EditorSelection, EditorState, StateField } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { expandFunc } from "./effects";
import { commentHideRange, isCommentClosed } from "./comments";
import { noteHeaderItems, computePreambleImportRanges } from "./note-header";

export interface ProtectedRange { from: number; to: number }

const CANONICAL_IMPORT_PREFIX = '#import "/.inkycap/notebox.typ"';
export function isNoteboxImportLine(text: string): boolean {
  return text.trimStart().startsWith(CANONICAL_IMPORT_PREFIX);
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

  // Lock the header's `#note(...)` properties call (edited through the
  // properties panel) and a header `#bibliography(...)`, each with the line
  // break and one blank line after it. A bibliography the user has opened for
  // editing (`expandedPos` inside it) stays editable.
  for (const item of noteHeaderItems(state)) {
    if (item.kind !== "note" && item.kind !== "bibliography") continue;
    const from = state.doc.lineAt(item.from).from;
    let hideEnd = state.doc.lineAt(item.to).to;
    if (hideEnd < docLen) hideEnd = Math.min(hideEnd + 1, docLen);
    if (hideEnd < docLen) {
      const nextLine = state.doc.lineAt(hideEnd);
      if (nextLine.text.trim() === "") hideEnd = Math.min(nextLine.to + 1, docLen);
    }
    const isOpen = expandedPos !== null && expandedPos >= from && expandedPos < hideEnd;
    if (item.kind === "bibliography" && isOpen) continue;
    ranges.push({ from, to: hideEnd });
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
        if (isCommentClosed(state, node.name, node.from, node.to)) {
          ranges.push(commentHideRange(state, node.from, node.to));
        }
      }
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
