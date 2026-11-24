// Citations in the visual editor. `@key`, `@key[p. 64]` and `#cite(<key>, …)`
// all render as one pill; clicking it opens the pill menu, where the page or
// other location (Typst's `supplement`) and the citation's form are set.
//
// The source keeps the form the writer chose. `@key` gains `[…]` for a page
// and becomes `#cite(...)` only when an option needs it (a form other than
// normal); a `#cite(...)` is never turned back into `@key`, and options change
// one argument at a time so the rest of the call stays as written.

import { type EditorView, WidgetType } from "@codemirror/view";
import {
  buildPillButton,
  contentBlockLiteral,
  contentBlockText,
  findCallEnd,
  readNamedArg,
  upsertNamedArg,
  type PillMenuSection,
} from "./pill";
import { t } from "../../lib/i18n";

/** The forms Typst's `cite` accepts, in menu order. `normal` is the default
 *  and is never written out. */
export const CITATION_FORMS = ["normal", "prose", "full", "author", "year"] as const;
export type CitationForm = (typeof CITATION_FORMS)[number];

/** What a citation's source says. */
export interface CitationParts {
  key: string;
  /** Written as `@key`, not `#cite(...)`. */
  shorthand: boolean;
  /** The supplement as the writer sees it (`p. 64`), or null without one. */
  supplement: string | null;
  /** The supplement exactly as written in the source (`[p. 64]`). */
  supplementLiteral: string | null;
  /** The form, or null for the default (normal). */
  form: string | null;
}

/** Read a citation's source: `@key`, `@key[…]` or `#cite(<key>, …)`. Null
 *  for anything else. */
export function parseCitation(src: string): CitationParts | null {
  if (src.startsWith("@")) {
    const open = src.indexOf("[");
    const key = open >= 0 ? src.slice(1, open) : src.slice(1);
    if (!key) return null;
    const supplementLiteral = open >= 0 ? src.slice(open) : null;
    return {
      key,
      shorthand: true,
      supplement: contentBlockText(supplementLiteral),
      supplementLiteral,
      form: null,
    };
  }
  const m = src.match(/^#cite\s*\(\s*<([^>]+)>/);
  if (!m) return null;
  const supplementLiteral = readNamedArg(src, "supplement");
  const form = readNamedArg(src, "form");
  return {
    key: m[1],
    shorthand: false,
    supplement: contentBlockText(supplementLiteral),
    supplementLiteral,
    form: form ? form.replace(/^"|"$/g, "") : null,
  };
}

/** The citation with its supplement set to `text`, or removed when `text` is
 *  blank. */
export function withSupplement(src: string, text: string): string {
  const parts = parseCitation(src);
  if (!parts) return src;
  const literal = contentBlockLiteral(text);
  if (parts.shorthand) return `@${parts.key}${literal ?? ""}`;
  return upsertNamedArg(src, "supplement", literal);
}

/** The citation in `form`. A shorthand `@key` becomes `#cite(...)` for any
 *  form but normal, keeping its supplement as written. */
export function withForm(src: string, form: CitationForm): string {
  const parts = parseCitation(src);
  if (!parts) return src;
  const literal = form === "normal" ? null : `"${form}"`;
  if (!parts.shorthand) return upsertNamedArg(src, "form", literal);
  if (literal === null) return src;
  const supplement = parts.supplementLiteral ? `, supplement: ${parts.supplementLiteral}` : "";
  return `#cite(<${parts.key}>, form: ${literal}${supplement})`;
}

/** Characters Typst allows in a reference's key. */
const KEY_CHAR = /[\p{L}\p{N}_\-.:]/u;

/**
 * The end of the shorthand citation `@key` or `@key[…]` starting at `start` in
 * `text`, by the rule Typst's lexer uses: the key runs over letters, digits,
 * `_`, `-`, `.` and `:` but doesn't end in `.` or `:` (a full stop after a
 * citation belongs to the sentence), and a `[` right after it opens the
 * supplement, which runs to its matching `]`. Returns `start` if there is no
 * key.
 */
export function shorthandCitationEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && KEY_CHAR.test(text[i])) i++;
  while (i > start + 1 && (text[i - 1] === "." || text[i - 1] === ":")) i--;
  if (i === start + 1) return start;
  if (text[i] !== "[") return i;
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (ch === "\\") { j++; continue; }
    if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return j + 1;
  }
  // An unclosed supplement isn't one: the citation is just the key.
  return i;
}

/**
 * The citation starting at `from`, read from the live document. Menu options
 * capture `from` when the menu opens and an earlier change can alter the
 * citation's length, so its end is found again each time, from the text: right
 * after a change the editor's syntax tree may not cover the new text yet.
 */
export function liveCitationRange(view: EditorView, from: number): { from: number; to: number } | null {
  const doc = view.state.doc;
  if (from < 0 || from >= doc.length) return null;
  const first = doc.sliceString(from, from + 1);
  if (first === "#") return { from, to: findCallEnd(view, from) };
  if (first !== "@") return null;
  const text = doc.sliceString(from, Math.min(doc.length, from + 4096));
  const end = shorthandCitationEnd(text, 0);
  return end > 0 ? { from, to: from + end } : null;
}

/** Replace the citation at `from` with `transform` of its source, if that
 *  changes it. */
function applyCitationTransform(view: EditorView, from: number, transform: (src: string) => string): void {
  const range = liveCitationRange(view, from);
  if (!range) return;
  const current = view.state.doc.sliceString(range.from, range.to);
  const next = transform(current);
  if (next === current) return;
  view.dispatch({ changes: { from: range.from, to: range.to, insert: next } });
}

/** The citation pill's own menu sections: the supplement field and the form
 *  choices. */
export function citationOptions(view: EditorView, from: number): PillMenuSection[] {
  const range = liveCitationRange(view, from);
  if (!range) return [];
  const parts = parseCitation(view.state.doc.sliceString(range.from, range.to));
  if (!parts) return [];
  const currentForm = parts.form ?? "normal";
  return [
    {
      items: [{
        label: t("pill.cite.supplement"),
        help: t("pill.cite.supplement.help"),
        input: {
          value: parts.supplement ?? "",
          placeholder: t("pill.cite.supplement.placeholder"),
          onCommit: (v) => applyCitationTransform(view, from, (s) => withSupplement(s, v)),
        },
      }],
    },
    {
      heading: t("pill.cite.form"),
      items: CITATION_FORMS.map((form) => ({
        label: t(`pill.cite.form.${form}`),
        title: t(`pill.cite.form.${form}.title`),
        isActive: currentForm === form,
        onSelect: () => applyCitationTransform(view, from, (s) => withForm(s, form)),
      })),
    },
  ];
}

/** Longest supplement shown on the pill before it is cut short. */
const MAX_LABEL_SUPPLEMENT = 24;

/** The pill's text: the key, then the supplement if there is one. */
export function citationPillLabel(key: string, supplement: string | null): string {
  if (!supplement) return `@${key}`;
  const shown = supplement.length > MAX_LABEL_SUPPLEMENT
    ? supplement.slice(0, MAX_LABEL_SUPPLEMENT - 1) + "…"
    : supplement;
  return `@${key}, ${shown}`;
}

/** A citation (`@key[…]` or `#cite(...)`) shown as a pill that stands in for
 *  its source from `from` to `to`. */
export class CitationWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly supplement: string | null,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }

  eq(other: WidgetType) {
    return other instanceof CitationWidget
      && this.key === other.key
      && this.supplement === other.supplement
      && this.from === other.from
      && this.to === other.to;
  }

  toDOM(view: EditorView) {
    return buildPillButton("cite", view, () => ({
      funcName: "cite",
      callFrom: this.from,
      callTo: liveCitationRange(view, this.from)?.to ?? this.to,
      optionSections: citationOptions(view, this.from),
    }), {
      label: citationPillLabel(this.key, this.supplement),
      title: t("widget.citation.title", { key: this.key }),
      hides: () => ({ from: this.from, to: this.to }),
    });
  }

  ignoreEvent() {
    return true;
  }
}
