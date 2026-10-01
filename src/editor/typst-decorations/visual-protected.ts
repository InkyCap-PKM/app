import { Annotation, EditorSelection, EditorState, StateField } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { expandFunc } from "./effects";
import { commentRunAt, isCommentClosed, isCommentRunExpanded } from "./comments";
import { noteHeaderItems, computePreambleImportRanges } from "./note-header";

export interface ProtectedRange {
  from: number;
  to: number;
  /** The caret may sit at `from`, and text typed there lands before the range
   *  (a comment after text on the same line). Otherwise `from` is locked too. */
  caretBefore?: boolean;
}

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

  // Typst comments sit behind a pill in the visual editor and are locked
  // until the pill is clicked to reveal them. (These protected-range
  // extensions are visual-mode-only, so the source editor still shows and
  // edits comments normally.) Syntax-tree based, so a `//` line inside a
  // raw/code block — not a comment node — stays visible as example content.
  let runEnd = -1;
  syntaxTree(state).iterate({
    from: 0,
    to: docLen,
    enter(node) {
      if (node.name !== "LineComment" && node.name !== "BlockComment") return;
      if (node.from < runEnd) return;
      if (!isCommentClosed(state, node.name, node.from, node.to)) return;
      const run = commentRunAt(state, node.from, node.to);
      runEnd = run.lockTo;
      if (!isCommentRunExpanded(run, expandedPos)) {
        ranges.push({ from: run.replaceFrom, to: run.lockTo, caretBefore: run.caretBefore });
      }
    },
  });

  return ranges;
}

/** Whether a range forbids the caret (or an insertion) at `pos`. */
function locksPosition(r: ProtectedRange, pos: number): boolean {
  return pos < r.to && (r.caretBefore ? pos > r.from : pos >= r.from);
}

export function isInProtectedRange(pos: number, ranges: ProtectedRange[]): boolean {
  return ranges.some((r) => locksPosition(r, pos));
}

/**
 * Move `pos` out of the protected range it falls in, in the direction the
 * caret was travelling (`dir`: -1 backward, 1 forward). Backward lands on the
 * position just before the range (or on `from` itself when the caret may sit
 * there); forward, or backward when nothing comes before, lands on the range's
 * end. Pushing the caret the way it came would leave it stuck: arrowing left
 * from below a range steps onto the range's last line, and a forward push puts
 * it straight back. Repeats in case the new position falls in a neighbouring
 * range.
 */
export function pushOutOfProtected(pos: number, ranges: ProtectedRange[], dir: -1 | 1 = 1): number {
  for (let step = 0; step <= ranges.length; step++) {
    const r = ranges.find((range) => locksPosition(range, pos));
    if (!r) return pos;
    if (dir < 0) {
      const before = r.caretBefore ? r.from : r.from - 1;
      if (before >= 0) {
        pos = before;
        continue;
      }
      dir = 1;
    }
    pos = r.to;
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
          ? locksPosition(r, fromA)
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
    const newRanges = tr.selection.ranges.map((range, i) => {
      let newHead = range.head;
      let newAnchor = range.anchor;

      if (ranges && ranges.length > 0 && !hasExpandEffect) {
        const prevHead = tr.startState.selection.ranges[i]?.head ?? range.head;
        const dir = range.head < prevHead ? -1 : 1;
        newHead = pushOutOfProtected(newHead, ranges, dir);
        newAnchor = range.empty ? newHead : pushOutOfProtected(newAnchor, ranges, dir);
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
