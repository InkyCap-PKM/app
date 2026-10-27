// How InkyCap writes cross-references, and what the document allows.
//
// `@name` is `#ref(<name>)`, which shows the referenced element's number, so it
// only works for numbered elements: figures, tables, numbered equations, and
// headings when numbering is on. A label on prose has no number and fails with
// "cannot reference text". `#link(<name>)[text]` works for any label with any
// words; the `@` popup and the compile-error quick fix fall back to it, using
// the rules here.

import type { LabelKind } from "./document-labels";

/** The `#set` rule that turns on numbering for an element kind. Equations live
 *  under `math.equation` and conventionally number as "(1)"; headings as "1.". */
export function setRuleForElement(element: string): string {
  if (element === "equation") return '#set math.equation(numbering: "(1)")';
  return `#set ${element}(numbering: "1.")`;
}

/**
 * Label kinds `@name` can always reference. Headings only qualify when
 * numbered; use [`canReferenceWithAt`](#canReferenceWithAt).
 */
const ALWAYS_REFERENCEABLE: ReadonlySet<LabelKind> = new Set<LabelKind>([
  "figure",
  "equation",
  "table",
]);

/**
 * Whether `@name` compiles for this kind of label. `headingsNumbered` comes
 * from [`documentNumbersHeadings`](#documentNumbersHeadings); the `"label"`
 * kind (prose) never can.
 */
export function canReferenceWithAt(kind: LabelKind, headingsNumbered: boolean): boolean {
  if (kind === "heading") return headingsNumbered;
  return ALWAYS_REFERENCEABLE.has(kind);
}

// Typst reads `@` as a reference wherever a label character follows, even
// mid-word, so `athena@inkycap.org` is text plus a reference to
// `<inkycap.org>`. InkyCap treats it as an email address or handle everywhere:
// no `@` popup, plain text in the visual editor, escaped when compiling. ASCII
// only, since email local parts are ASCII and a citation right after a CJK word
// (`参见@smith2020`) must still work.
const EMAIL_LOCAL_PART_TAIL_RE = /[A-Za-z0-9._+-]/;

/**
 * Whether an `@` after `charBefore` joins an email address or handle rather
 * than starting a reference. `charBefore` is the character before the `@`, or
 * "" at the start of the document.
 */
export function isEmailLikeAt(charBefore: string): boolean {
  return charBefore.length > 0 && EMAIL_LOCAL_PART_TAIL_RE.test(charBefore);
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
 * A `#link(<name>)[display]` reference. The display text is selected after
 * insertion so it can be typed over, which matters for prose labels whose name
 * is only a stand-in.
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

// A `#set heading(...)` rule and its arguments. The scan stops at the first
// `)`, so a numbering function with parentheses isn't recognized; that only
// offers an unneeded shortcut, never a wrong reference.
const SET_HEADING_RE = /#set\s+heading\s*\(([^)]*)\)/g;
const NUMBERING_ARG_RE = /\bnumbering\s*:\s*([^,)]+)/;

/**
 * Whether the document numbers headings, which `@heading-label` needs. Later
 * rules win, so `numbering: none` after an enabling rule means not numbered.
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

