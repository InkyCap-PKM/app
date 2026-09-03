// How InkyCap writes a cross-reference, and what a document currently allows.
//
// Typst's `@name` shorthand is `#ref(<name>)`, and `ref` renders the *number*
// of the element the label tags. Only numbered elements can be referenced that
// way: figures, tables, numbered equations, and headings once heading numbering
// is switched on. A label on ordinary prose has no number, so `@name` fails to
// compile with "cannot reference text".
//
// `#link(<name>)[text]` carries no such restriction — it points at any label and
// shows whatever words the writer chooses. The `@` suggestion popup and the
// compile-error quick-fix both fall back to that form, so the rules for picking
// between them live here once instead of in each caller.

import type { LabelKind } from "./document-labels";

/** The `#set` rule that turns on numbering for an element kind. Equations live
 *  under `math.equation` and conventionally number as "(1)"; headings as "1.". */
export function setRuleForElement(element: string): string {
  if (element === "equation") return '#set math.equation(numbering: "(1)")';
  return `#set ${element}(numbering: "1.")`;
}

/**
 * Label kinds `@name` can reference on its own. Headings are absent because
 * they only qualify once the document numbers them — ask
 * [`canReferenceWithAt`](#canReferenceWithAt) rather than this set directly.
 */
const ALWAYS_REFERENCEABLE: ReadonlySet<LabelKind> = new Set<LabelKind>([
  "figure",
  "equation",
  "table",
]);

/**
 * Whether `@name` compiles for a label of this kind. `headingsNumbered` comes
 * from [`documentNumbersHeadings`](#documentNumbersHeadings); the catch-all
 * `"label"` kind (a label on prose) can never be referenced with `@`.
 */
export function canReferenceWithAt(kind: LabelKind, headingsNumbered: boolean): boolean {
  if (kind === "heading") return headingsNumbered;
  return ALWAYS_REFERENCEABLE.has(kind);
}

/** Escape `[` / `]` so arbitrary text can sit inside a `#link[...]` content block. */
export function escapeLinkContent(text: string): string {
  return text.replace(/([[\]])/g, "\\$1");
}

/** A `#link(<name>)[display]` call, with the offsets of `display` inside it so
 *  the caller can select that text after inserting. */
export interface LinkReference {
  text: string;
  /** Offset of the first character of the display text within `text`. */
  displayFrom: number;
  /** Offset just past the display text within `text`. */
  displayTo: number;
}

/**
 * Build a `#link(<name>)[display]` cross-reference. Selecting the display range
 * after insertion lets the writer type over the placeholder wording immediately,
 * which matters most for prose labels where the label name is only a stand-in.
 */
export function linkReference(name: string, display: string): LinkReference {
  const body = escapeLinkContent(display);
  const prefix = `#link(<${name}>)[`;
  return {
    text: `${prefix}${body}]`,
    displayFrom: prefix.length,
    displayTo: prefix.length + body.length,
  };
}

// Matches a `#set heading(...)` rule and captures its argument list. The
// argument scan stops at the first `)`, so a numbering *function* spanning
// parentheses is not recognized; the only cost is offering a shortcut the
// document doesn't need, never a wrong reference.
const SET_HEADING_RE = /#set\s+heading\s*\(([^)]*)\)/g;
const NUMBERING_ARG_RE = /\bnumbering\s*:\s*([^,)]+)/;

/**
 * Whether this document numbers its headings, which is what `@heading-label`
 * needs to compile. Later rules win, so `numbering: none` after an enabling
 * rule correctly reads as "not numbered".
 */
export function documentNumbersHeadings(docText: string): boolean {
  SET_HEADING_RE.lastIndex = 0;
  let numbered = false;
  let match: RegExpExecArray | null;
  while ((match = SET_HEADING_RE.exec(docText)) !== null) {
    const arg = NUMBERING_ARG_RE.exec(match[1]);
    if (arg) numbered = arg[1].trim() !== "none";
  }
  return numbered;
}

/**
 * Offset where the document body begins — just past the leading run of blank
 * lines, comments, imports/includes, and a `#note(...)` / `#set-notebox(...)`
 * preamble block. New `#set` rules are inserted here so they sit with the
 * document's other top-matter rather than above the notebox import.
 */
export function findPreambleEnd(docText: string): number {
  const len = docText.length;
  let i = 0;
  while (i < len) {
    const lineEnd = docText.indexOf("\n", i);
    const stop = lineEnd < 0 ? len : lineEnd;
    const trimmed = docText.slice(i, stop).trim();

    if (
      trimmed === "" ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("#import") ||
      trimmed.startsWith("#include")
    ) {
      i = stop + 1;
      continue;
    }

    if (trimmed.startsWith("#note(") || trimmed.startsWith("#set-notebox(")) {
      // Consume the (possibly multi-line) call by balancing parentheses.
      let depth = 0;
      let started = false;
      let j = i;
      for (; j < len; j++) {
        const c = docText[j];
        if (c === "(") {
          depth++;
          started = true;
        } else if (c === ")") {
          depth--;
          if (started && depth === 0) {
            j++;
            break;
          }
        }
      }
      const nl = docText.indexOf("\n", j);
      i = nl < 0 ? len : nl + 1;
      continue;
    }

    break;
  }
  return Math.min(i, len);
}
