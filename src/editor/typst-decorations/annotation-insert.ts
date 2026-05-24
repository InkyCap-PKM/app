// Insert `#annotation` / `#suggestion` markup at the active editor's cursor,
// wrapping any selected text. Used by the Annotations pane's bottom toolbar.
//
// The templates mirror the four InkyCap authoring entries in
// `command-palette.ts` ("Annotation", "Suggest insertion/deletion/
// replacement") — keep the two in sync.

import { EditorView } from "@codemirror/view";
import { expandFunc } from "./effects";

export type InsertKind = "insert" | "delete" | "replace" | "annotation";

interface InsertSpec {
  /** Template; `${sel}` is replaced with the current selection text. */
  template: string;
  /** Caret offset from the insertion start after applying. */
  cursorOffset: number;
  /** Reveal the raw source (pill expand) after inserting. */
  expand: boolean;
}

const SPECS: Record<InsertKind, InsertSpec> = {
  insert: { template: '#suggestion(kind: "insert")[${sel}]', cursorOffset: 28, expand: false },
  delete: { template: '#suggestion(kind: "delete")[${sel}]', cursorOffset: 28, expand: false },
  replace: {
    template: '#suggestion(kind: "replace", old: [${sel}])[]',
    cursorOffset: 35,
    expand: false,
  },
  annotation: { template: "#annotation[${sel}]", cursorOffset: 12, expand: true },
};

/** Insert annotation/suggestion markup at the editor's current selection,
 *  wrapping any selected text. No-op when there is no editor (so a toolbar
 *  click does nothing when the cursor isn't in an editing area). Focuses the
 *  editor afterward so typing continues inside the new markup. */
export function insertAnnotationMarkup(view: EditorView | undefined, kind: InsertKind): void {
  if (!view) return;
  const spec = SPECS[kind];
  const sel = view.state.selection.main;
  const selected = view.state.doc.sliceString(sel.from, sel.to);
  const insert = spec.template.replace("${sel}", selected);
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + spec.cursorOffset },
    effects: spec.expand ? expandFunc.of(sel.from) : undefined,
  });
  view.focus();
}
