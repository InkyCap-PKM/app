// CM6 cursor-position tracker — publishes the primary cursor's line:column to
// a Solid signal for the status bar. Handy in Source Edit mode for jumping to a
// reported error location (e.g. the audit's "L55:28"). Mirrors the
// word-count tracker's pattern (a ViewPlugin updating a module-level signal).

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { createSignal } from "solid-js";

export interface CursorPosition {
  /** 1-based line number. */
  line: number;
  /** 1-based column (offset from the line start, in characters). */
  col: number;
}

const [cursorPosition, setCursorPosition] = createSignal<CursorPosition | null>(null);
export { cursorPosition };

function compute(state: EditorState): CursorPosition {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { line: line.number, col: head - line.from + 1 };
}

export const cursorPositionTracker = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      setCursorPosition(compute(view.state));
    }
    update(update: ViewUpdate) {
      // Recompute when the caret moves or the document changes (an edit can
      // shift the caret without a separate selection event).
      if (update.selectionSet || update.docChanged) {
        setCursorPosition(compute(update.state));
      }
    }
    destroy() {
      setCursorPosition(null);
    }
  },
);
