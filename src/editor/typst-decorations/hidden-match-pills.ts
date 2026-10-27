// Search matches hidden behind a pill.
//
// Some pills replace the source they stand for: an annotation's comment, a
// Typst comment, a `#set` rule, the style preamble, a `#sym` name. A match
// there would be marked on invisible text, so search would seem to find
// nothing. This marks the pill itself in the search match colour while its
// hidden source holds a notebox search match (search-matches.ts) or in-page
// find match (Ctrl+F), and more strongly for find's current match. Find marks
// only its current match unless "All" is on, and pills do the same. Revealing a
// pill keeps a selected match selected (see `runEditSource` in pill.ts).
//
// Pills declare what they hide with `hides` on `buildPillButton`. Tables and
// verses keep their content visible and handle this themselves (cell-search.ts
// and `verseSearchHighlighter` in widgets.ts).

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { getSearchQuery, searchPanelOpen } from "@codemirror/search";
import { pillHiddenRange, type SourceRange } from "./pill";
import { searchMatchRanges } from "./search-matches";
import { HIGHLIGHT_ALL_CLASS } from "../search-panel";

const MATCH_CLASS = "cm-typst-pill--search-match";
const CURRENT_CLASS = "cm-typst-pill--search-current";

type Hit = "none" | "match" | "current";

/** Whether either search is showing matches in the note. */
function searchActive(state: EditorState): boolean {
  return searchPanelOpen(state) || searchMatchRanges(state).length > 0;
}

/**
 * How the source `range` relates to the matches. `searchHits` are the notebox
 * search matches, read once per repaint; `findShowsAll` is whether find's "All"
 * is on.
 */
function hitIn(
  state: EditorState,
  range: SourceRange,
  searchHits: SourceRange[],
  findShowsAll: boolean,
): Hit {
  let hit: Hit = searchHits.some((r) => r.from < range.to && r.to > range.from) ? "match" : "none";
  if (!searchPanelOpen(state)) return hit;
  const query = getSearchQuery(state);
  if (!query.search || !query.valid) return hit;
  // The find panel puts the note's selection on its current match.
  const selection = state.selection.main;
  const cursor = query.getCursor(state, range.from, range.to);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    if (next.value.from === selection.from && next.value.to === selection.to) return "current";
    if (findShowsAll) hit = "match";
  }
  return hit;
}

export const hiddenMatchPills = ViewPlugin.fromClass(
  class {
    /** True while some pill carries a mark, so clearing the search can
     *  remove it; otherwise nothing runs while no search is active. */
    private marked = false;

    constructor(view: EditorView) {
      this.schedule(view);
    }

    update(update: ViewUpdate) {
      if (this.marked || searchActive(update.state)) this.schedule(update.view);
    }

    /** Repaint after CodeMirror has drawn the update, so pills rebuilt by it
     *  are the ones marked. */
    private schedule(view: EditorView) {
      view.requestMeasure({
        key: this,
        read: () => null,
        write: () => this.paint(view),
      });
    }

    private paint(view: EditorView) {
      const state = view.state;
      const active = searchActive(state);
      const searchHits = active ? searchMatchRanges(state) : [];
      const findShowsAll = view.dom.classList.contains(HIGHLIGHT_ALL_CLASS);
      let marked = false;
      for (const pill of view.contentDOM.querySelectorAll<HTMLElement>(".cm-typst-pill")) {
        const range = active ? pillHiddenRange(pill) : null;
        const hit = range ? hitIn(state, range, searchHits, findShowsAll) : "none";
        pill.classList.toggle(MATCH_CLASS, hit !== "none");
        pill.classList.toggle(CURRENT_CLASS, hit === "current");
        if (hit !== "none") marked = true;
      }
      this.marked = marked;
    }
  },
);
