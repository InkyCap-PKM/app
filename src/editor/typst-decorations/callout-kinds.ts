// The callout kinds: their order, their colours, and how a callout's heading
// and accent colour are resolved.
//
// A callout is InkyCap's own construct, not a Typst built-in: `#callout(kind,
// title: none, color: none)[…]` lives in inkycap-notebox/lib.typ, and the kind
// selects a default colour and a default heading word there. This module is
// the editor's copy of that table, used to draw the visual-editor preview and
// to build the pill menu, and `callout-kinds.test.ts` fails if the two copies
// ever disagree.
//
// Both defaults can be overridden per callout: `title:` replaces the word,
// `color:` replaces the colour. The kind still travels with the note, so a
// callout that overrides both keeps a sensible fallback if the override is
// removed.

import { t } from "../../lib/i18n";

/** Every kind, in the order the pill menu lists them. */
export const CALLOUT_KINDS = [
  "note", "tip", "warning", "important", "caution", "example",
  "quote", "abstract", "info", "todo", "success", "question",
  "failure", "danger", "bug",
] as const;

export type CalloutKind = (typeof CALLOUT_KINDS)[number];

/** The colour each kind uses when a callout carries no `color:` override.
 *  Must match `_callout-colors` in inkycap-notebox/lib.typ. */
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

/** Heading shown for a callout: an explicit `title` wins, otherwise the
 *  localized kind label (falling back to a capitalized kind for any kind not
 *  in the known set). Shared by the visual-editor callout widgets and the pill
 *  menu so the editor decoration and the menu always agree on the wording, and
 *  both follow the UI language. The compiled reading view / export localizes
 *  from the document language in inkycap-notebox/lib.typ. */
export function calloutKindLabel(kind: string, title?: string | null): string {
  if (title) return title;
  return (CALLOUT_KINDS as readonly string[]).includes(kind)
    ? t("callout.kind." + kind)
    : kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * The hex colour in a `color: rgb("#rrggbb")` argument.
 *
 * Null when there is no colour argument, or when it is written in some other
 * form — a named Typst colour, a gradient, a `cmyk(…)` call. The compiled note
 * still honours whatever is written there; only this preview falls back to the
 * kind's own colour, since the editor does not evaluate Typst expressions.
 *
 * `argsText` must be the call's argument list, not the whole call: a body that
 * mentions `color:` is prose, not an argument.
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
