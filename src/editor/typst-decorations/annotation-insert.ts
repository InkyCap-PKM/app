// Build and insert `#annotation` / `#suggestion` markup with today's date
// (`on:`) and the notebox's commit author name (`by:`). Used by the Annotations
// pane toolbar and the `/` palette, both through `buildAnnotationInsert`.

import { EditorView } from "@codemirror/view";
import { commitAuthorName } from "../../stores/git";
import { expandFunc } from "./effects";

export type InsertKind = "insert" | "delete" | "replace" | "annotation";

export interface BuiltInsert {
  /** Markup to insert (the selection is already substituted in). */
  insert: string;
  /** Caret offset from the insertion start — lands inside the body bracket. */
  cursorOffset: number;
  /** Reveal the raw source (pill expand) after inserting. */
  expand: boolean;
}

/** Typst string-literal escape for a `"…"` argument value. */
function escapeStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Today's date as `YYYY-MM-DD` (local). */
function today(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * The author fields for a new mark: today's date, and `by:` from the notebox's
 * commit author name (cached in the git store), so collaborators see who
 * suggested what and a user's own suggestions are left out of their "Changes to
 * resolve". `by:` is omitted without a name (e.g. a non-collaborative notebox).
 */
function identity(): { by?: string; on: string } {
  const by = commitAuthorName().trim();
  return by ? { by, on: today() } : { on: today() };
}

/**
 * Build a `#suggestion(...)` call, keeping the body and old content as they
 * are. Used for new inserts and the widget's "Save comment" (an existing body
 * with a new `note`). Argument order matches Rust's `suggestion_call` (kind,
 * old, by, on), with `note` last.
 */
export function buildSuggestionCall(opts: {
  kind: "insert" | "delete" | "replace";
  body: string;
  oldText?: string;
  by?: string;
  on?: string;
  note?: string;
}): string {
  const args = [`kind: "${opts.kind}"`];
  if (opts.kind === "replace") args.push(`old: [${opts.oldText ?? ""}]`);
  if (opts.by && opts.by.trim()) args.push(`by: "${escapeStr(opts.by.trim())}"`);
  if (opts.on && opts.on.trim()) args.push(`on: "${escapeStr(opts.on.trim())}"`);
  if (opts.note && opts.note.trim()) args.push(`note: "${escapeStr(opts.note.trim())}"`);
  return `#suggestion(${args.join(", ")})[${opts.body}]`;
}

/** Build the markup + caret position for inserting a fresh annotation or
 *  suggestion, wrapping `sel` (the current selection text). */
export function buildAnnotationInsert(kind: InsertKind, sel: string): BuiltInsert {
  const id = identity();

  switch (kind) {
    case "annotation": {
      // `#annotation(by:.., on:..)[sel]` — body is the comment itself.
      const parts: string[] = [];
      if (id.by) parts.push(`by: "${escapeStr(id.by)}"`);
      parts.push(`on: "${id.on}"`);
      const insert = `#annotation(${parts.join(", ")})[${sel}]`;
      // The named args carry no `[`, so the first `[` is the body bracket.
      return { insert, cursorOffset: insert.indexOf("[") + 1, expand: true };
    }
    case "replace": {
      // `old:` carries the selection; the empty trailing `[]` is the new text.
      const insert = buildSuggestionCall({ kind, body: "", oldText: sel, ...id });
      // Caret in the empty body bracket. Expand the source (as for `annotation`
      // above) so the caret lands there; otherwise the markup collapses to the
      // atomic SuggestionWidget and the caret is moved past the `]`.
      return { insert, cursorOffset: insert.length - 1, expand: true };
    }
    case "insert":
    case "delete": {
      const insert = buildSuggestionCall({ kind, body: sel, ...id });
      // Caret just after the body's opening bracket. Expand the source so the
      // caret stays inside rather than at the widget's edge.
      return { insert, cursorOffset: insert.indexOf("[") + 1, expand: true };
    }
  }
}

/**
 * Insert annotation or suggestion markup at the selection, wrapping selected
 * text. Does nothing without an editor. Focuses the editor afterwards so typing
 * continues inside the markup.
 */
export function insertAnnotationMarkup(view: EditorView | undefined, kind: InsertKind): void {
  if (!view) return;
  const sel = view.state.selection.main;
  const selected = view.state.doc.sliceString(sel.from, sel.to);
  const { insert, cursorOffset, expand } = buildAnnotationInsert(kind, selected);
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + cursorOffset },
    effects: expand ? expandFunc.of(sel.from) : undefined,
  });
  view.focus();
}
