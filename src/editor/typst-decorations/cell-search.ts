// The in-page find (Ctrl+F) matches that fall inside one table cell.
//
// A table renders as a single atomic widget, so CodeMirror's own search-match
// decorations land on source the reader never sees: a find inside a table
// highlights nothing, and the caret appears not to move when stepping through
// matches. Table cells are painted by hand (see table-cell-editor.ts), so the
// matches are painted with them — using CodeMirror's own query and cursor, so
// no search logic is reimplemented here.

import { type EditorState } from "@codemirror/state";
import { getSearchQuery, searchPanelOpen } from "@codemirror/search";

/** One match inside a cell. `current` marks the one the find panel is on. */
export interface CellMatch {
  from: number;
  to: number;
  current: boolean;
}

/**
 * Every match of the current find query inside `[from, to)`. Empty while the
 * find panel is closed — matches are only shown as long as the user is
 * searching, exactly as in the note body.
 */
export function cellSearchMatches(state: EditorState, from: number, to: number): CellMatch[] {
  if (from >= to || !searchPanelOpen(state)) return [];
  const query = getSearchQuery(state);
  if (!query.search || !query.valid) return [];
  const selection = state.selection.main;
  const matches: CellMatch[] = [];
  const cursor = query.getCursor(state, from, to);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    const match = next.value;
    if (match.from < from || match.to > to) continue;
    matches.push({
      from: match.from,
      to: match.to,
      // The find panel puts the note's selection on the current match, even
      // though it sits inside the atomic table widget and cannot be seen.
      current: match.from === selection.from && match.to === selection.to,
    });
  }
  return matches;
}

/**
 * A value that differs whenever the highlights painted for a cell would, so
 * a cell is only repainted when its matches actually change. Offsets are
 * counted from the cell's own start (`from`): typing earlier in the note
 * moves the whole cell without changing how it looks, and must not force a
 * repaint.
 */
export function cellMatchKey(matches: CellMatch[], from: number): string {
  return matches.map((m) => `${m.from - from}-${m.to - from}${m.current ? "*" : ""}`).join(",");
}
