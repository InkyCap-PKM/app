// Build + insert `#annotation` / `#suggestion` markup, stamped with today's
// date (`on:`) and the notebox's commit-author name (`by:`). Used by the
// Annotations pane's bottom toolbar and the `/` command palette — the single
// `buildAnnotationInsert` builder keeps the two surfaces in sync (they used to
// carry two copies of the same template strings).

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

/** The author identity to stamp on a fresh mark: today's date, plus `by:` from
 *  the notebox's commit-author name (cached in the git store on open) so
 *  collaborators see who proposed each change — and so a user's own suggestions
 *  can be excluded from their "Changes to resolve" list. `by:` is omitted when
 *  there's no identity (e.g. a non-collaborative notebox). */
function identity(): { by?: string; on: string } {
  const by = commitAuthorName().trim();
  return by ? { by, on: today() } : { on: today() };
}

/** Build a full `#suggestion(...)` call, preserving the body/old content
 *  verbatim. Shared by fresh inserts and by the widget's "Save comment" rebuild
 *  (which carries an existing body + an updated `note`). Argument order matches
 *  the Rust `suggestion_call` builder (kind, old, by, on) with `note` last. */
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
      // Caret inside the empty trailing body bracket. Expand the raw source
      // (like `annotation` above) so the caret actually lands there — otherwise
      // the markup collapses to the atomic SuggestionWidget and the atomic range
      // rounds the caret out past the `]`, so the new text isn't captured.
      return { insert, cursorOffset: insert.length - 1, expand: true };
    }
    case "insert":
    case "delete": {
      const insert = buildSuggestionCall({ kind, body: sel, ...id });
      // Caret right after the body's opening bracket (before the wrapped text).
      // Expand the raw source so the caret stays inside the bracket rather than
      // being rounded out to the atomic widget boundary.
      return { insert, cursorOffset: insert.indexOf("[") + 1, expand: true };
    }
  }
}

/** Insert annotation/suggestion markup at the editor's current selection,
 *  wrapping any selected text. No-op when there is no editor (so a toolbar
 *  click does nothing when the cursor isn't in an editing area). Focuses the
 *  editor afterward so typing continues inside the new markup. */
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
