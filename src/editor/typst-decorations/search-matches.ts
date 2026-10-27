// Highlights every notebox search match in the opened note, not only the
// clicked one. When a result is opened, the SearchPanel gives the editor all of
// that file's match ranges, and this field marks them, so `journ* AND canad*`
// shows both `journal` and `canada`.
//
// Separate from Ctrl+F find (search-panel.ts), which uses CodeMirror's
// `.cm-searchMatch`; this decoration is fed from the backend's match positions.

import { EditorView, Decoration, type DecorationSet } from "@codemirror/view";
import { StateField, StateEffect, RangeSetBuilder, type EditorState } from "@codemirror/state";

/** A match to highlight, in the search result's shape: 1-based line plus
 *  line-relative start/end offsets (mirrors `scrollToMatch`'s inputs). */
export interface SearchMatchRange {
  line: number;
  charStart: number;
  charEnd: number;
}

/** Replace the highlighted set. Pass `[]` to clear. */
export const setSearchMatches = StateEffect.define<SearchMatchRange[]>();

const matchMark = Decoration.mark({ class: "cm-search-match-hit" });

const searchMatchField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    // A real edit invalidates the indexed positions — drop the highlights
    // rather than let mapping drift them onto unrelated text.
    if (tr.docChanged) deco = Decoration.none;

    for (const effect of tr.effects) {
      if (!effect.is(setSearchMatches)) continue;
      const doc = tr.state.doc;
      const ranges = effect.value
        .map((r) => {
          const lineNo = Math.max(1, Math.min(r.line, doc.lines));
          const line = doc.line(lineNo);
          const lineLen = line.to - line.from;
          const from = line.from + Math.max(0, Math.min(r.charStart, lineLen));
          const to = line.from + Math.max(0, Math.min(r.charEnd, lineLen));
          return { from, to };
        })
        .filter((r) => r.to > r.from)
        .sort((a, b) => a.from - b.from || a.to - b.to);

      const builder = new RangeSetBuilder<Decoration>();
      // RangeSetBuilder requires ascending, non-overlapping input; skip any
      // overlap defensively (distinct search terms don't normally overlap).
      let lastTo = -1;
      for (const r of ranges) {
        if (r.from < lastTo) continue;
        builder.add(r.from, r.to, matchMark);
        lastTo = r.to;
      }
      deco = builder.finish();
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** The notebox-search matches highlighted in the note, in document order. */
export function searchMatchRanges(state: EditorState): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const deco = state.field(searchMatchField, false);
  deco?.between(0, state.doc.length, (from, to) => {
    out.push({ from, to });
  });
  return out;
}

const matchTheme = EditorView.baseTheme({
  ".cm-search-match-hit": {
    backgroundColor: "var(--bg-search-match)",
    borderRadius: "var(--radius-xs)",
  },
});

/** Extension bundle: the highlight field + its theme. */
export const searchMatchHighlight = [searchMatchField, matchTheme];
