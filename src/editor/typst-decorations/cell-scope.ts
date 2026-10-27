// Which part of the mirrored note a cell editor edits.
//
// A table cell is edited in its own CodeMirror view over a copy of the whole
// note (see table-cell-editor.ts), with everything outside the cell hidden and
// locked and decorations built for the cell alone. This holds the two pieces of
// state for that, without dependencies, so the decoration builder and the cell
// editor can both import it.

import { Facet, StateEffect, StateField } from "@codemirror/state";

/** A half-open source range `[from, to)`. */
export interface ScopeRange {
  from: number;
  to: number;
}

/**
 * On when decorations must stay inline: block constructs (the table itself,
 * callouts, verse, images, …) stay raw markup so they never replace the range
 * being edited.
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
