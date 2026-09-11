// The scope of a cell editor: which slice of the mirrored note it edits.
//
// A table cell is edited in its own CodeMirror view over a copy of the whole
// note (see table-cell-editor.ts). Everything outside the cell is hidden and
// locked, and the visual decorations are built for the cell alone. This module
// holds the two pieces of state that make that work, kept dependency-free so
// both the decoration builder and the cell editor can import it.

import { Facet, StateEffect, StateField } from "@codemirror/state";

/** A half-open source range `[from, to)`. */
export interface ScopeRange {
  from: number;
  to: number;
}

/**
 * On when the visual decorations should stay inline: block constructs (the
 * table itself, callouts, verse, images, …) are left as raw markup so they
 * never replace the range being edited.
 */
export const inlineOnlyFacet = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});

/** The editable range a cell editor starts with. */
export const scopeRangeConfig = Facet.define<ScopeRange, ScopeRange | null>({
  combine: (values) => (values.length ? values[0] : null),
});

/** Replaces the editable range, after the table's source was rewritten. */
export const setScopeRange = StateEffect.define<ScopeRange>();

/**
 * The editable range, kept in step with edits. Text typed at either edge
 * lands inside the range: the start maps before an insertion, the end after.
 */
export const scopeRangeField = StateField.define<ScopeRange | null>({
  create: (state) => state.facet(scopeRangeConfig),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setScopeRange)) return e.value;
    }
    if (!value || !tr.docChanged) return value;
    return { from: tr.changes.mapPos(value.from, -1), to: tr.changes.mapPos(value.to, 1) };
  },
});
