// Callout kinds: their order and colours, and how a callout's heading and
// colour are worked out.
//
// `#callout(kind, title: none, color: none)[…]` is defined in
// inkycap-notebox/lib.typ, where the kind picks a default colour and heading.
// This is the editor's copy of that table, for the visual editor preview and
// the pill menu; `callout-kinds.test.ts` fails if the two differ.
//
// `title:` and `color:` override the defaults per callout. The kind is still
// kept, so removing an override falls back sensibly.

import { t } from "../../lib/i18n";

/** Every kind, in the order the pill menu lists them. */
export const CALLOUT_KINDS = [
  "note", "tip", "warning", "important", "caution", "example",
  "quote", "abstract", "info", "todo", "success", "question",
  "failure", "danger", "bug",
] as const;

export type CalloutKind = (typeof CALLOUT_KINDS)[number];

/**
 * Each kind's colour when there's no `color:`. Must match `_callout-colors` in
 * inkycap-notebox/lib.typ. They are document colours (shown in any Typst tool),
 * not app colours, so they aren't theme tokens.
 */
export const CALLOUT_COLORS: Record<string, string> = {
  note: "#448aff",
  tip: "#00bfa5",
  warning: "#ff9100",
  important: "#ff5252",
  caution: "#ff6d00",
  example: "#7c4dff",
  quote: "#9e9e9e",
  abstract: "#00b0ff",
  info: "#2196f3",
  todo: "#ff6d00",
  success: "#00c853",
  question: "#64dd17",
  failure: "#ff1744",
  danger: "#d50000",
  bug: "#f50057",
};

/** Colour used for a kind nobody knows — a word the writer made up, or one
 *  from a newer version of the notebox library. Matches lib.typ's fallback. */
export const CALLOUT_FALLBACK_COLOR = CALLOUT_COLORS.note;

/**
 * A callout's heading: `title` if given, otherwise the translated kind name (or
 * the capitalized kind for unknown kinds). Shared by the callout widgets and
 * the pill menu, so both match and follow the UI language. The compiled note
 * translates from the document language in inkycap-notebox/lib.typ.
 */
export function calloutKindLabel(kind: string, title?: string | null): string {
  if (title) return title;
  return (CALLOUT_KINDS as readonly string[]).includes(kind)
    ? t("callout.kind." + kind)
    : kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * The hex colour in a `color: rgb("#rrggbb")` argument.
 *
 * Null with no colour argument, or one written another way (a named colour, a
 * gradient, `cmyk(…)`). The compiled note still uses it; only this preview
 * falls back to the kind's colour, since the editor doesn't evaluate Typst.
 *
 * `argsText` must be the argument list, not the whole call: `color:` in the
 * body is text, not an argument.
 */
export function readCalloutColorArg(argsText: string): string | null {
  const m = argsText.match(/\bcolor\s*:\s*(rgb\(\s*"#[0-9a-fA-F]{3,8}"\s*\))/);
  return m ? parseCalloutColorLiteral(m[1]) : null;
}

/** The hex in a colour argument's value on its own, as the pill menu reads it
 *  (`rgb("#448aff")` → `#448aff`). Null for any other expression. */
export function parseCalloutColorLiteral(literal: string | null): string | null {
  const m = literal?.trim().match(/^rgb\(\s*"(#[0-9a-fA-F]{3,8})"\s*\)$/);
  return m ? m[1] : null;
}

/** The Typst literal written for a chosen colour. Kept free of commas so the
 *  pill menu's "remove this argument" path can excise it cleanly. */
export function calloutColorLiteral(hex: string): string {
  return `rgb("${hex}")`;
}

/** The colour a callout actually draws in: its `color:` override if it has a
 *  readable one, otherwise its kind's colour. */
export function calloutColor(kind: string, colorArg: string | null): string {
  return colorArg ?? CALLOUT_COLORS[kind] ?? CALLOUT_FALLBACK_COLOR;
}
