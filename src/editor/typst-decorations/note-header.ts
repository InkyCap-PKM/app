// The top of a note: the imports, `#note(...)` properties call and other
// setup that come before its body. Read from the Typst syntax tree (Typst's
// own parser, via codemirror-lang-typst), so a multi-line `#note(...)` or a
// comment containing brackets can't mislead it the way a line scan could.
//
// Every question about where the header ends goes through `noteHeaderItems`;
// callers apply their own rule on top of that one list.

import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { isCommentClosed } from "./comments";
import type { ProtectedRange } from "./visual-protected";

/** What a header item is. `locale` is a `#set text(...)` that only sets the
 *  document language (see {@link isLeadingLocaleDirective}); other set rules
 *  are `set`. */
export type HeaderItemKind =
  | "comment"
  | "import"
  | "include"
  | "locale"
  | "note"
  | "set-notebox"
  | "bibliography"
  | "set"
  | "show"
  | "let";

export interface HeaderItem {
  kind: HeaderItemKind;
  /** Start of the item, including its leading `#`. */
  from: number;
  to: number;
}

/** The note's leading header items in document order, ending before the first
 *  top-level node that is none of the kinds above (usually body text). Blank
 *  lines between items are skipped. Empty when the state has no Typst parser. */
export function noteHeaderItems(state: EditorState): HeaderItem[] {
  const items: HeaderItem[] = [];
  const cur = syntaxTree(state).cursor();
  if (!cur.firstChild()) return items;
  let hashFrom = -1;
  do {
    const name = cur.name;
    if (name === "Space" || name === "Parbreak") continue;
    if (name === "Hash") {
      hashFrom = cur.from;
      continue;
    }
    const kind = headerItemKind(state, name, cur.from, cur.to);
    if (!kind) break;
    items.push({ kind, from: hashFrom >= 0 ? hashFrom : cur.from, to: cur.to });
    hashFrom = -1;
  } while (cur.nextSibling());
  return items;
}

const FUNCTION_ITEMS: Record<string, HeaderItemKind> = {
  note: "note",
  "set-notebox": "set-notebox",
  bibliography: "bibliography",
};

function headerItemKind(
  state: EditorState,
  name: string,
  from: number,
  to: number,
): HeaderItemKind | null {
  switch (name) {
    case "LineComment":
    case "BlockComment":
      // An unclosed `/*` runs to the end of the note; that's body, not header.
      return isCommentClosed(state, name, from, to) ? "comment" : null;
    case "ModuleImport":
      return "import";
    case "ModuleInclude":
      return "include";
    case "SetRule":
      return isLeadingLocaleDirective(state.doc.sliceString(from, to)) ? "locale" : "set";
    case "ShowRule":
      return "show";
    case "LetBinding":
      return "let";
    case "FuncCall": {
      const callee = /^[\p{L}_][\p{L}\p{N}_-]*/u.exec(state.doc.sliceString(from, Math.min(to, from + 40)));
      return (callee && FUNCTION_ITEMS[callee[0]]) ?? null;
    }
    default:
      return null;
  }
}

/** Header kinds that are top matter. Style rules (`#set`, `#show`, `#let`)
 *  are not: they start the body, since they apply to what follows them. */
const TOP_MATTER: ReadonlySet<HeaderItemKind> = new Set([
  "comment",
  "import",
  "include",
  "locale",
  "note",
  "set-notebox",
  "bibliography",
]);

/**
 * Offset where the note's body begins: the start of the first line after the
 * top matter and any blank lines that follow it, or the end of the document.
 * New `#set` rules and dropped files are placed here, so they sit below the
 * imports and properties rather than among them.
 */
export function noteBodyStart(state: EditorState): number {
  let headerEnd = 0;
  for (const item of noteHeaderItems(state)) {
    if (!TOP_MATTER.has(item.kind)) break;
    headerEnd = item.to;
  }
  const doc = state.doc;
  let firstLine = 1;
  if (headerEnd > 0) {
    const last = doc.lineAt(headerEnd);
    // Body text sharing the header's last line starts right after the header.
    if (doc.sliceString(headerEnd, last.to).trim() !== "") return headerEnd;
    firstLine = last.number + 1;
  }
  for (let n = firstLine; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (line.text.trim() !== "") return line.from;
  }
  return doc.length;
}

/**
 * True for a document-language directive line — a `#set text(...)` whose
 * arguments are *exclusively* `lang:` and/or `region:`, e.g.
 * `#set text(lang: "fr", region: "CA")`.
 *
 * This is locale typesetting machinery: a note whose prose is French (German,
 * …) carries it so Typst applies the right hyphenation, punctuation spacing,
 * and smart quotes. It is boilerplate the author rarely edits — analogous to
 * the notebox `#import` — so the visual editor folds it into the hidden,
 * locked leading-preamble block rather than surfacing it as raw source or a
 * "document setup" chip. (It stays fully visible and editable in source mode.)
 *
 * A `#set text(font: …)` — or any other key alongside lang/region — is genuine
 * document setup and deliberately does NOT match: it belongs in the visible
 * setup chip. The leading `#` is optional so this also matches a bare `SetRule`
 * syntax node (whose `#` is a separate token).
 */
export function isLeadingLocaleDirective(text: string): boolean {
  const m = /^#?set\s+text\s*\((.*)\)\s*$/.exec(text.trim());
  if (!m) return false;
  const parts = m[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return false;
  return parts.every((arg) => /^(lang|region)\s*:/.test(arg));
}

/**
 * Ranges (whole lines plus their trailing newline) of the leading run of
 * `#import` lines — the notebox import plus any package imports a user or a
 * template added — and a document-language directive among them. The run ends
 * at the first other header item (typically the `#note(...)` call) or body
 * line. These are hidden and locked in the visual editor so the note reads as
 * a clean document, while the source editor leaves them fully visible and
 * editable (only the notebox import is also locked in source, via
 * `importLineGuard`).
 */
export function computePreambleImportRanges(state: EditorState): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  const doc = state.doc;
  for (const item of noteHeaderItems(state)) {
    if (item.kind !== "import" && item.kind !== "locale") break;
    const from = doc.lineAt(item.from).from;
    const last = doc.lineAt(item.to);
    ranges.push({ from, to: last.to < doc.length ? last.to + 1 : last.to });
  }
  return ranges;
}
