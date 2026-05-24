// Build + insert `#annotation` / `#suggestion` markup, stamped with the
// current user's collaboration identity (`by:`) and today's date (`on:`) so
// every comment and tracked change carries authorship the moment it's made.
// Used by the Annotations pane's bottom toolbar and the `/` command palette —
// the single `buildAnnotationInsert` builder keeps the two surfaces in sync
// (they used to carry two copies of the same template strings).
//
// Identity is the user's *global* handle (Settings › Overview › Collaboration),
// not a per-collection pinned handle — the editor has no collection context at
// the cursor, and the global handle is the author's stable identity. When no
// handle is set we fall back to a filename-safe seed of the author name, and
// omit `by:` entirely if neither is set.

import { EditorView } from "@codemirror/view";
import { expandFunc } from "./effects";
import { settings } from "../../stores/settings";

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

/** Filename-safe seed of a display name (mirrors `identity::seed_handle`). */
function handleSeed(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The author handle to stamp on new annotations/suggestions: the global
 *  collaboration handle, else a seed of the author name, else "" (omit). */
function authorHandle(): string {
  const h = settings.collaboration.handle.trim();
  if (h) return h;
  return handleSeed(settings.collaboration.author_name);
}

/** Today's date as `YYYY-MM-DD` (local). */
function today(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** The current author identity to stamp on a fresh mark: the resolved handle
 *  (omitted when none is available) and today's date. */
function identity(): { by?: string; on: string } {
  const by = authorHandle();
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
      // Caret inside the empty trailing body bracket.
      return { insert, cursorOffset: insert.length - 1, expand: false };
    }
    case "insert":
    case "delete": {
      const insert = buildSuggestionCall({ kind, body: sel, ...id });
      // Caret right after the body's opening bracket (before the wrapped text).
      return { insert, cursorOffset: insert.indexOf("[") + 1, expand: false };
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
