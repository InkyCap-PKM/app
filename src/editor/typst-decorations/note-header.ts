// The top of a note: the imports, the `#note(...)` call and other setup before
// the body. Read from the Typst syntax tree, so a multi-line `#note(...)` or a
// comment with brackets can't confuse it.
//
// Every question about where the header ends goes through `noteHeaderItems`.

import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { isCommentClosed } from "./comments";
import type { ProtectedRange } from "./visual-protected";

/**
 * Kind of header item. `locale` is a `#set text(...)` that only sets the
 * language (see {@link isLeadingLocaleDirective}); other set rules are `set`.
 */
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

/**
 * The note's header items in order, up to the first top-level node of another
 * kind (usually body text). Blank lines are skipped. Empty without a Typst
 * parser.
 */
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
 * Where the note's body begins: the first line after the header and the blank
 * lines after it, or the document end. New `#set` rules and dropped files go
 * here, below the imports and properties.
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
 * True for a language line: a `#set text(...)` with only `lang:` and/or
 * `region:`, e.g. `#set text(lang: "fr", region: "CA")`.
 *
 * It sets hyphenation, spacing and quotes for the note's language and is rarely
 * edited, so the visual editor hides it with the notebox `#import` (source mode
 * shows it). A `#set text(font: …)`, or any other argument, doesn't match: that
 * is document setup, shown in the setup chip. The `#` is optional, so a bare
 * `SetRule` node (whose `#` is a separate token) also matches.
 */
export function isLeadingLocaleDirective(text: string): boolean {
  const m = /^#?set\s+text\s*\((.*)\)\s*$/.exec(text.trim());
  if (!m) return false;
  const parts = m[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return false;
  return parts.every((arg) => /^(lang|region)\s*:/.test(arg));
}

/**
 * Ranges (whole lines with their newline) of the leading `#import` lines (the
 * notebox import and any package imports) and a language line among them, up to
 * the first other header item (usually `#note(...)`) or body line. Hidden and
 * locked in the visual editor; in source mode they're visible, and only the
 * notebox import is locked (`importLineGuard`).
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
