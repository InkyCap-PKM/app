// Menu options for each pill. Each function name maps to a builder that reads
// the call's source and returns the menu sections. Changes go through
// applyCallTransform with upsertNamedArg / replaceFirstPositionalString,
// touching one argument at a time so the rest of the source is unchanged.
//
// See documentation/developer/visual-editor/pill-system.md for each pill's
// options.

import { type EditorView } from "@codemirror/view";
import {
  applyCallTransform,
  findCallEnd,
  readNamedArg,
  readFirstPositionalString,
  replaceFirstPositionalString,
  upsertNamedArg,
  type PillMenuSection,
} from "./pill";
import { t } from "../../lib/i18n";
import {
  CALLOUT_KINDS,
  calloutColor,
  calloutColorLiteral,
  calloutKindLabel,
  parseCalloutColorLiteral,
} from "./callout-kinds";

// Highlighter colours in rainbow order: the Typst literal written to `fill:
// rgb(...)` and a label. The literal stays fixed so a preset is recognized
// after saving.
//
// A note keeps the fill it was written with; a colour from an older palette
// still renders, with no swatch shown as active, and picking one writes the
// current literal.
interface HighlightColor {
  /** i18n key for the user-visible colour name. */
  labelKey: string;
  /** Typst expression that goes after `fill:`. */
  fill: string;
  /** Hex used to compare the current source value back to a preset. */
  hex: string;
  /** Colour a bare `#highlight[…]` renders as. Exactly one entry sets it;
   *  picking it drops the `fill:` argument instead of writing it. */
  isDefault?: true;
}
const HIGHLIGHT_COLORS: HighlightColor[] = [
  { labelKey: "pill.highlight.color.red",    fill: 'rgb("#ff9f97")', hex: "#ff9f97" },
  { labelKey: "pill.highlight.color.orange", fill: 'rgb("#ffd6a8")', hex: "#ffd6a8" },
  { labelKey: "pill.highlight.color.yellow", fill: 'rgb("#f2ed61")', hex: "#f2ed61", isDefault: true },
  { labelKey: "pill.highlight.color.green",  fill: 'rgb("#c8f0c8")', hex: "#c8f0c8" },
  { labelKey: "pill.highlight.color.blue",   fill: 'rgb("#b3dfff")', hex: "#b3dfff" },
  { labelKey: "pill.highlight.color.violet", fill: 'rgb("#e0c8f0")', hex: "#e0c8f0" },
  { labelKey: "pill.highlight.color.pink",   fill: 'rgb("#ffd1e0")', hex: "#ffd1e0" },
];

const LINE_STROKES: { labelKey: string; literal: string; defaultMatch: boolean }[] = [
  { labelKey: "pill.stroke.thin",   literal: "0.5pt", defaultMatch: false },
  { labelKey: "pill.stroke.medium", literal: "1pt",   defaultMatch: true  },
  { labelKey: "pill.stroke.thick",  literal: "2pt",   defaultMatch: false },
];

// Common `delimiter:` values for `#csv(…)`, as Typst literals; comma is Typst's
// default. The literal is always written, since `upsertNamedArg`'s removal
// can't safely remove `","`.
const CSV_DELIMITERS: { labelKey: string; literal: string; isDefault: boolean }[] = [
  { labelKey: "pill.csv.delimiter.comma",     literal: '","',  isDefault: true  },
  { labelKey: "pill.csv.delimiter.semicolon", literal: '";"',  isDefault: false },
  { labelKey: "pill.csv.delimiter.tab",       literal: '"\\t"', isDefault: false },
];

// `row-type:` choices for `#csv(…)`. Array is Typst's default (cleared from
// source); dictionary keys each row by the header row's column names.
const CSV_ROW_TYPES: { labelKey: string; value: string | null; helpKey?: string }[] = [
  { labelKey: "pill.csv.rowType.array",      value: null,
    helpKey: "pill.csv.rowType.array.help" },
  { labelKey: "pill.csv.rowType.dictionary", value: "dictionary",
    helpKey: "pill.csv.rowType.dictionary.help" },
];

// ── Lookup ──────────────────────────────────────────────────────────

export type PillOptionsBuilder = (
  view: EditorView,
  callFrom: number,
  callTo: number,
) => PillMenuSection[];

const REGISTRY: Record<string, PillOptionsBuilder> = {
  callout:   calloutOptions,
  quote:     quoteOptions,
  image:     imageOptions,
  line:      lineOptions,
  highlight: highlightOptions,
  csv:       csvOptions,
  align:     alignOptions,
  figure:    figureOptions,
  cite:      citeOptions,
  task:      taskOptions,
  due:       dueOptions,
  sym:       symOptions,
  suggestion: suggestionOptions,
};

/**
 * Option sections for a pill. Functions with their own builder (image, callout,
 * …) get a designed menu; others fall back to `genericArgsOptions`, which
 * offers the named arguments already in the source as fields. Verse's options
 * live on its widget (see VerseWidget).
 */
export function getPillOptions(
  funcName: string,
  view: EditorView,
  callFrom: number,
  callTo: number,
): PillMenuSection[] {
  const builder = REGISTRY[funcName];
  if (builder) return builder(view, callFrom, callTo);
  return genericArgsOptions(view, callFrom, callTo);
}

/**
 * Split an argument list into top-level arguments, so commas inside
 * `rgb("a,b")` or `(1, 2)` don't split.
 */
function splitTopLevelArgs(argsText: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i];
    if (ch === '"' && argsText[i - 1] !== "\\") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      out.push(argsText.slice(start, i));
      start = i + 1;
    }
  }
  out.push(argsText.slice(start));
  return out;
}

/**
 * Named arguments (`name: value`) in source order. Positional arguments are
 * skipped; they stay editable through "Edit source".
 */
function parseNamedArgs(callSource: string): { name: string; value: string }[] {
  const argsText = findArgListInSource(callSource);
  if (argsText === null) return [];
  const named: { name: string; value: string }[] = [];
  for (const seg of splitTopLevelArgs(argsText)) {
    // A bare identifier and a top-level colon, so a `:` inside a value isn't
    // taken as the separator.
    const m = seg.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*([\s\S]+)$/);
    if (!m) continue;
    named.push({ name: m[1], value: m[2].trim() });
  }
  return named;
}

/**
 * Fallback options: a text field per named argument already written, committing
 * the Typst literal through `upsertNamedArg`. Clearing a field removes the
 * argument. No section if there are none.
 */
function genericArgsOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  const named = parseNamedArgs(src);
  if (named.length === 0) return [];
  return [{
    heading: t("pill.params.heading"),
    items: named.map((arg) => ({
      label: arg.name,
      title: t("pill.params.argTitle", { name: arg.name }),
      input: {
        value: arg.value,
        placeholder: arg.name,
        onCommit: (v) => {
          const t = v.trim();
          applyCallTransform(view, from, (s) =>
            upsertNamedArg(s, arg.name, t === "" ? null : t));
        },
      },
    })),
  }];
}

// ── Helpers ─────────────────────────────────────────────────────────

function readCallSource(view: EditorView, from: number, to: number): string {
  const len = view.state.doc.length;
  return view.state.doc.sliceString(
    Math.max(0, Math.min(from, len)),
    Math.max(0, Math.min(to, len)),
  );
}

/**
 * The content of a quoted Typst string (`"hello"` → `hello`), unescaping `\"`
 * and `\\`, or null.
 */
function unquote(literal: string | null): string | null {
  if (literal == null) return null;
  const t = literal.trim();
  if (!(t.startsWith('"') && t.endsWith('"') && t.length >= 2)) return null;
  return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** Wrap a string in double-quotes for Typst source. Escapes `"` and `\`. */
function quote(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * The text inside the call's `(...)`, or null without parens. For positional
 * non-string values like `#align(center)`.
 */
function findArgListInSource(callSource: string): string | null {
  const open = callSource.indexOf("(");
  if (open < 0) return null;
  const firstBracket = callSource.indexOf("[");
  if (firstBracket >= 0 && firstBracket < open) return null;
  let depth = 0;
  let inStr = false;
  for (let i = open; i < callSource.length; i++) {
    const ch = callSource[i];
    if (ch === '"' && callSource[i - 1] !== "\\") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return callSource.substring(open + 1, i);
    }
  }
  return null;
}

/**
 * Replace the first positional keyword in the argument list, adding `(keyword)`
 * before the body if there is none. For `#align(center)`-style calls.
 */
function replaceFirstPositionalKeyword(callSource: string, keyword: string): string {
  const openIdx = callSource.indexOf("(");
  const firstBracket = callSource.indexOf("[");
  if (openIdx < 0 || (firstBracket >= 0 && firstBracket < openIdx)) {
    // No arg list yet — insert one before the body bracket if any,
    // otherwise append at the end of the call.
    const insertAt = firstBracket >= 0 ? firstBracket : callSource.length;
    return callSource.slice(0, insertAt) + `(${keyword})` + callSource.slice(insertAt);
  }
  // Find matching close, then check if the first arg is a bare keyword.
  let depth = 0;
  let inStr = false;
  let close = -1;
  for (let i = openIdx; i < callSource.length; i++) {
    const ch = callSource[i];
    if (ch === '"' && callSource[i - 1] !== "\\") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close < 0) return callSource;
  const argsText = callSource.substring(openIdx + 1, close);
  // Replace only a leading bare identifier, keeping the rest (`center +
  // horizon`, named arguments).
  const m = argsText.match(/^(\s*)([a-z][a-z0-9_-]*)/);
  if (m) {
    const newArgs = m[1] + keyword + argsText.substring(m[0].length);
    return callSource.substring(0, openIdx + 1) + newArgs + callSource.substring(close);
  }
  // No leading positional — prepend.
  const newArgs = argsText.trimStart().length === 0 ? keyword : `${keyword}, ${argsText.trimStart()}`;
  return callSource.substring(0, openIdx + 1) + newArgs + callSource.substring(close);
}

// ── Option builders ─────────────────────────────────────────────────

/**
 * Kind, then its two overrides: the heading word (`title:`) and the colour
 * (`color:`). The kind stays in the source, so clearing the title or choosing
 * "Match the kind" returns to its defaults. Changing the kind keeps an
 * override, which was an explicit choice.
 */
function calloutOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  const currentKind = readFirstPositionalString(src) ?? "note";
  const title = unquote(readNamedArg(src, "title")) ?? "";
  const customColor = parseCalloutColorLiteral(readNamedArg(src, "color"));
  return [
    {
      heading: t("callout.kind.heading"),
      items: CALLOUT_KINDS.map((kind) => ({
        label: t("callout.kind." + kind),
        isActive: kind === currentKind,
        onSelect: () => applyCallTransform(view, from, (s) => replaceFirstPositionalString(s, kind)),
      })),
    },
    {
      heading: t("callout.title.heading"),
      items: [{
        label: t("callout.title.label"),
        input: {
          value: title,
          // The kind's own word, so an empty field shows what it falls back to.
          placeholder: calloutKindLabel(currentKind),
          onCommit: (value) => applyCallTransform(view, from, (s) =>
            upsertNamedArg(s, "title", value.trim() === "" ? null : quote(value)),
          ),
        },
      }],
    },
    {
      heading: t("callout.colour.heading"),
      items: [
        {
          label: t("callout.colour.matchKind"),
          isActive: customColor === null,
          onSelect: () => applyCallTransform(view, from, (s) => upsertNamedArg(s, "color", null)),
        },
        {
          label: t("callout.colour.custom"),
          input: {
            type: "color",
            // With no override, the picker opens on the kind's own colour, so
            // the writer starts from what they can see rather than from black.
            value: calloutColor(currentKind, customColor),
            onCommit: (value) => applyCallTransform(view, from, (s) =>
              upsertNamedArg(s, "color", calloutColorLiteral(value)),
            ),
          },
        },
      ],
    },
  ];
}

function quoteOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  const blockArg = readNamedArg(src, "block");
  // Typst quotes are inline by default; `/quote` inserts inline and
  // `/blockquote` adds `block: true`.
  const isBlock = blockArg === "true";
  const attr = parseAttribution(readNamedArg(src, "attribution"));
  // A URL only applies to text attribution; a bibkey attribution already links
  // to its entry, so the field is disabled.
  const urlDisabled = attr.kind === "bibkey";
  return [{
    heading: t("pill.quote.style"),
    items: [
      {
        label: t("pill.quote.block"),
        isActive: isBlock,
        onSelect: () => applyCallTransform(view, from, (s) =>
          upsertNamedArg(s, "block", "true")),
      },
      {
        label: t("pill.quote.inline"),
        isActive: !isBlock,
        title: t("pill.quote.inline.title"),
        onSelect: () => applyCallTransform(view, from, (s) =>
          upsertNamedArg(s, "block", null)),
      },
    ],
  }, {
    items: [{
      label: t("pill.quote.attribution"),
      title: !isBlock
        ? t("pill.quote.attribution.title.inline")
        : t("pill.quote.attribution.title.block"),
      input: {
        value: attr.text,
        placeholder: t("pill.quote.attribution.placeholder"),
        onCommit: (v) => applyCallTransform(view, from, (s) => {
          // Read the URL from the current source, not `attr`, so a URL set
          // earlier in this menu isn't lost.
          const cur = parseAttribution(readNamedArg(s, "attribution"));
          const urlNow = cur.kind === "link" ? cur.url : "";
          return upsertNamedArg(s, "attribution", buildAttributionExpr(v, urlNow));
        }),
      },
    }, {
      label: t("pill.quote.linkUrl"),
      title: urlDisabled
        ? t("pill.quote.linkUrl.title.disabled")
        : t("pill.quote.linkUrl.title"),
      disabled: urlDisabled,
      input: {
        value: attr.kind === "link" ? attr.url : "",
        placeholder: t("pill.quote.linkUrl.placeholder"),
        onCommit: (v) => applyCallTransform(view, from, (s) => {
          const cur = parseAttribution(readNamedArg(s, "attribution"));
          if (cur.kind === "bibkey") return s; // disabled in UI; defensive
          return upsertNamedArg(s, "attribution", buildAttributionExpr(cur.text, v));
        }),
      },
    }],
  }];
}

// ── Attribution value helpers ───────────────────────────────────────
// The `attribution` forms the pill handles:
//   1. string:     attribution: "Albert Camus"
//   2. bibkey:     attribution: <camus1942>
//   3. link:       attribution: link("https://…")[CC BY-SA]
// These helpers convert between the source and the pill's text and URL fields.

interface AttributionParts {
  /** User-visible text (input value). For bibkey, the literal `<key>`
   *  is shown so the user sees what they typed and can edit it back. */
  text: string;
  /** URL when the source uses `link("…")[…]`, else "". */
  url: string;
  /** How the source encodes the attribution; drives URL-field state. */
  kind: "string" | "bibkey" | "link" | "raw" | "none";
}

function parseAttribution(src: string | null): AttributionParts {
  if (src == null) return { text: "", url: "", kind: "none" };
  const t = src.trim();
  if (t === "") return { text: "", url: "", kind: "none" };
  if (t.startsWith('"') && t.endsWith('"')) {
    return { text: unquote(t) ?? "", url: "", kind: "string" };
  }
  // Typst label literals: `<` … `>` with no whitespace or angle brackets
  // inside. Matches both `<bibkey>` and `<some-id>` forms.
  if (/^<[^\s<>]+>$/.test(t)) {
    return { text: t, url: "", kind: "bibkey" };
  }
  // `link("url")[content]`: the URL and the content, kept as Typst markup so
  // its formatting survives.
  const m = t.match(/^link\(\s*"((?:\\.|[^"\\])*)"\s*\)\s*\[([\s\S]*)\]$/);
  if (m) {
    const url = m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    return { text: m[2], url, kind: "link" };
  }
  // Anything else is shown as is, with the URL field inactive.
  return { text: t, url: "", kind: "raw" };
}

function buildAttributionExpr(text: string, url: string): string | null {
  const t = text.trim();
  if (t === "") return null; // dropping the attribution arg entirely
  // Bibkey label: emit unquoted, ignore URL (the citation already links).
  if (/^<[^\s<>]+>$/.test(t)) return t;
  const u = url.trim();
  if (u !== "") return `link(${quote(u)})[${t}]`;
  return quote(t);
}

/** Slice the `#image(...)` call out of a wrapper source, given the offset
 *  of its leading `#`. Balanced-paren aware; image has no trailing `[]`. */
function sliceImageCallSource(src: string, start: number): string {
  const open = src.indexOf("(", start);
  if (open < 0) return src.slice(start);
  let depth = 0;
  let inStr = false;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' && src[i - 1] !== "\\") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return src.slice(start);
}

/**
 * Add, change or remove the `#align(...)` wrapper to place an image left,
 * centre or right. `callFrom` is the pill's anchor (the wrapper's `#`, or the
 * image's). Left unwraps to a bare image.
 */
function applyImageAlignment(
  view: EditorView,
  callFrom: number,
  wrapped: boolean,
  keyword: string,
): void {
  const len = view.state.doc.length;
  const safeFrom = Math.max(0, Math.min(callFrom, len));
  const safeTo = Math.max(safeFrom, Math.min(findCallEnd(view, safeFrom), len));
  const cur = view.state.doc.sliceString(safeFrom, safeTo);

  let next: string;
  if (keyword === "left") {
    if (!wrapped) return; // already a bare (left-aligned) image
    const idx = cur.indexOf("#image");
    if (idx < 0) return;
    next = sliceImageCallSource(cur, idx); // unwrap to the bare image
  } else if (wrapped) {
    next = replaceFirstPositionalKeyword(cur, keyword); // swap the keyword only
  } else {
    next = `#align(${keyword})[${cur}]`; // wrap the bare image
  }
  if (next === cur) return;
  view.dispatch({ changes: { from: safeFrom, to: safeTo, insert: next } });
  view.focus();
}

function imageOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  // For an aligned image, File, Alt and Width edit the inner image (at
  // `imgFrom`) and Alignment edits the wrapper.
  const wrapped = /^\s*#align\b/.test(src);
  let imgFrom = from;
  let imgSrc = src;
  let currentAlign: "left" | "center" | "right" = "left";
  if (wrapped) {
    const kw = src.match(/^\s*#align\s*\(\s*([a-z]+)/)?.[1];
    currentAlign = kw === "center" || kw === "right" ? kw : "left";
    const idx = src.indexOf("#image");
    if (idx >= 0) {
      imgFrom = from + idx;
      imgSrc = sliceImageCallSource(src, idx);
    }
  }
  const path = readFirstPositionalString(imgSrc) ?? "";
  const alt = unquote(readNamedArg(imgSrc, "alt")) ?? "";
  const width = readNamedArg(imgSrc, "width") ?? "";
  // An image has no body, so every argument is in the menu, including the path,
  // which comes first and gets focus.
  return [{
    items: [{
      label: t("pill.image.file"),
      title: t("pill.image.file.title"),
      input: {
        value: path,
        placeholder: t("pill.image.file.placeholder"),
        onCommit: (v) => {
          const trimmed = v.trim();
          if (trimmed === "") return;
          applyCallTransform(view, imgFrom, (s) => replaceFirstPositionalString(s, trimmed));
        },
      },
    }, {
      label: t("pill.image.alt"),
      input: {
        value: alt,
        placeholder: t("pill.image.alt.placeholder"),
        onCommit: (v) => applyCallTransform(view, imgFrom, (s) =>
          upsertNamedArg(s, "alt", v.trim() === "" ? null : quote(v))),
      },
    }, {
      label: t("pill.image.width"),
      // Typst's length units only. `px` is deliberately omitted — Typst has no
      // pixel unit, so it compiles cleanly in the preview but breaks the PDF.
      help: t("pill.image.width.help"),
      input: {
        value: width,
        placeholder: t("pill.image.width.placeholder"),
        onCommit: (v) => {
          const t = v.trim();
          applyCallTransform(view, imgFrom, (s) =>
            upsertNamedArg(s, "width", t === "" ? null : t));
        },
      },
    }],
  }, {
    heading: t("pill.align.heading"),
    // Typst's `image` has no alignment argument; placement is
    // `#align(left|center|right)[…]`.
    items: ALIGNMENTS.map((a) => ({
      label: t(a.labelKey),
      isActive: currentAlign === a.keyword,
      onSelect: () => applyImageAlignment(view, from, wrapped, a.keyword),
    })),
  }];
}

function csvOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  const path = readFirstPositionalString(src) ?? "";
  const delimiter = readNamedArg(src, "delimiter");
  const rowType = readNamedArg(src, "row-type");
  // `#csv(…)` has no body, so every argument is in the menu; the file comes
  // first and gets focus.
  return [{
    items: [{
      label: t("pill.csv.file"),
      title: t("pill.csv.file.title"),
      help: t("pill.csv.file.help"),
      input: {
        value: path,
        placeholder: t("pill.csv.file.placeholder"),
        onCommit: (v) => {
          const trimmed = v.trim();
          if (trimmed === "") return;
          applyCallTransform(view, from, (s) => replaceFirstPositionalString(s, trimmed));
        },
      },
    }],
  }, {
    heading: t("pill.csv.delimiter.heading"),
    items: CSV_DELIMITERS.map((opt) => ({
      label: t(opt.labelKey),
      isActive: delimiter === opt.literal || (delimiter == null && opt.isDefault),
      onSelect: () => applyCallTransform(view, from, (s) =>
        upsertNamedArg(s, "delimiter", opt.literal)),
    })),
  }, {
    heading: t("pill.csv.rowType.heading"),
    items: CSV_ROW_TYPES.map((opt) => ({
      label: t(opt.labelKey),
      help: opt.helpKey ? t(opt.helpKey) : undefined,
      isActive: rowType === opt.value || (rowType == null && opt.value == null),
      onSelect: () => applyCallTransform(view, from, (s) =>
        upsertNamedArg(s, "row-type", opt.value)),
    })),
  }];
}

function lineOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  const length = readNamedArg(src, "length") ?? "";
  const stroke = readNamedArg(src, "stroke");
  return [{
    items: [{
      label: t("pill.line.length"),
      title: t("pill.line.length.title"),
      input: {
        value: length,
        placeholder: t("pill.line.length.placeholder"),
        onCommit: (v) => {
          const val = v.trim();
          applyCallTransform(view, from, (s) =>
            upsertNamedArg(s, "length", val === "" ? null : val));
        },
      },
    }],
  }, {
    heading: t("pill.line.stroke.heading"),
    items: LINE_STROKES.map((opt) => ({
      label: t(opt.labelKey),
      isActive: stroke === opt.literal || (stroke == null && opt.defaultMatch),
      onSelect: () => applyCallTransform(view, from, (s) =>
        upsertNamedArg(s, "stroke", opt.literal, { defaultValue: "1pt" })),
    })),
  }];
}

// Horizontal alignments. Combined ones (`center + horizon`) are edited through
// "Edit source". Justification is `#set par(justify: true)`, not an alignment.
const ALIGNMENTS = [
  { labelKey: "pill.align.left",   keyword: "left"   },
  { labelKey: "pill.align.center", keyword: "center" },
  { labelKey: "pill.align.right",  keyword: "right"  },
];

function alignOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  // The leading keyword is enough for the radio; anything more complex is
  // edited through "Edit source".
  const argList = findArgListInSource(src);
  const current = argList ? (argList.match(/^\s*([a-z]+)/)?.[1] ?? null) : null;
  return [{
    heading: t("pill.align.heading"),
    items: ALIGNMENTS.map((a) => ({
      label: t(a.labelKey),
      isActive: current === a.keyword,
      onSelect: () => applyCallTransform(view, from, (s) => replaceFirstPositionalKeyword(s, a.keyword)),
    })),
  }];
}

function figureOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  const captionRaw = readNamedArg(src, "caption");
  // caption: [Hello] — strip surrounding brackets, then unescape \] and \\.
  const caption = captionRaw && captionRaw.startsWith("[") && captionRaw.endsWith("]")
    ? captionRaw.slice(1, -1).replace(/\\\]/g, "]").replace(/\\\\/g, "\\")
    : "";
  return [{
    items: [{
      label: t("pill.figure.caption"),
      input: {
        value: caption,
        placeholder: t("pill.figure.caption.placeholder"),
        onCommit: (v) => {
          const t = v.trim();
          const literal = t === "" ? null : "[" + t.replace(/\\/g, "\\\\").replace(/\]/g, "\\]") + "]";
          applyCallTransform(view, from, (s) => upsertNamedArg(s, "caption", literal));
        },
      },
    }],
  }];
}

function citeOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  const isShorthand = src.startsWith("@");
  if (!isShorthand) {
    const form = readNamedArg(src, "form");
    const currentForm = form ?? "normal";
    return [{
      heading: t("pill.cite.form"),
      items: (["normal", "prose", "full", "author", "year"] as const).map((f) => ({
        label: t("pill.cite.form." + f),
        isActive: currentForm === f,
        onSelect: () => applyCallTransform(view, from, (s) =>
          upsertNamedArg(s, "form", f === "normal" ? null : `"${f}"`)),
      })),
    }];
  }
  const key = src.slice(1);
  return [{
    heading: t("pill.cite.citation"),
    items: [{
      label: t("pill.cite.convert"),
      title: t("pill.cite.convert.title"),
      onSelect: () => {
        view.dispatch({
          changes: { from, to, insert: `#cite(<${key}>)` },
          selection: { anchor: from + `#cite(<${key}>)`.length },
        });
        view.focus();
      },
    }],
  }];
}

function highlightOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  const fill = readNamedArg(src, "fill");
  return [{
    heading: t("pill.highlight.colour"),
    items: HIGHLIGHT_COLORS.map((c) => {
      // Active when the current `fill:` matches this preset's literal,
      // OR when there's no fill arg AND this is the default (yellow).
      const isActive = fill === c.fill || (fill == null && c.isDefault === true);
      return {
        label: t(c.labelKey),
        isActive,
        onSelect: () => applyCallTransform(view, from, (s) =>
          // Drop the arg entirely when picking yellow (the default), so
          // existing source like `#highlight[x]` stays clean.
          upsertNamedArg(s, "fill", c.isDefault ? null : c.fill)),
      };
    }),
  }];
}

// ── #task ───────────────────────────────────────────────────────────
// Body, due date and Done. Dates are written as quoted ISO strings (`due:
// "2026-06-23"`); lib.typ's `_fmt-date` also accepts `datetime(...)`.

/** Read a date from a Typst-source literal, returning `YYYY-MM-DD`. Handles
 *  both `datetime(year: ..., month: ..., day: ...)` and `"YYYY-MM-DD"`. */
function readDateLiteral(literal: string | null): string {
  if (literal == null) return "";
  const dt = literal.match(
    /datetime\(\s*(?:year\s*:\s*)?(\d{1,4})\s*,\s*(?:month\s*:\s*)?(\d{1,2})\s*,\s*(?:day\s*:\s*)?(\d{1,2})/,
  );
  if (dt) {
    return `${dt[1].padStart(4, "0")}-${dt[2].padStart(2, "0")}-${dt[3].padStart(2, "0")}`;
  }
  const s = literal.trim().match(/^"(\d{4}-\d{2}-\d{2})"$/);
  return s ? s[1] : "";
}

/** Validate a free-text date input as ISO `YYYY-MM-DD`. Returns the
 *  normalized string, or null if it can't be parsed. */
function normalizeDateInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (!m) return null;
  const y = m[1];
  const mo = m[2].padStart(2, "0");
  const d = m[3].padStart(2, "0");
  // Sanity-check ranges so the user doesn't accidentally save `2026-13-99`.
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
  return `${y}-${mo}-${d}`;
}

function taskOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  const body = readFirstPositionalString(src) ?? "";
  const dueRaw = readNamedArg(src, "due");
  const dueIso = readDateLiteral(dueRaw);
  const isDone = /\bdone\s*:\s*true\b/.test(src);

  return [
    {
      heading: t("pill.task.heading"),
      items: [{
        label: t("pill.task.label"),
        input: {
          value: body,
          placeholder: t("pill.task.placeholder"),
          onCommit: (v) =>
            applyCallTransform(view, from, (s) => replaceFirstPositionalString(s, v)),
        },
      }],
    },
    {
      heading: t("pill.due.heading"),
      items: [{
        label: t("pill.task.due.label"),
        input: {
          value: dueIso,
          placeholder: "YYYY-MM-DD",
          onCommit: (v) => {
            const norm = normalizeDateInput(v);
            if (norm === null) return; // invalid: leave source alone
            applyCallTransform(view, from, (s) =>
              upsertNamedArg(s, "due", norm === "" ? null : quote(norm)),
            );
          },
        },
      }],
    },
    {
      items: [{
        label: isDone ? t("pill.task.markNotDone") : t("pill.task.markDone"),
        isActive: isDone,
        onSelect: () =>
          applyCallTransform(view, from, (s) =>
            // `done: false` is the default — drop the arg entirely on
            // un-check so the source stays minimal.
            upsertNamedArg(s, "done", isDone ? "false" : "true", {
              defaultValue: "false",
            }),
          ),
      }],
    },
  ];
}

// ── #due ────────────────────────────────────────────────────────────
// Date (positional) and label. Dates as in `#task`.

function dueOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  // The date may be a string or a `datetime(...)`; read it with
  // `readDateLiteral`.
  const args = findArgListInSource(src) ?? "";
  // First arg up to the first top-level comma (skipping commas inside
  // nested parens — datetime(...)'s commas would otherwise trip us up).
  const firstArg = (() => {
    let depth = 0;
    let inStr = false;
    for (let i = 0; i < args.length; i++) {
      const ch = args[i];
      if (ch === '"' && args[i - 1] !== "\\") { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) return args.slice(0, i).trim();
    }
    return args.trim();
  })();
  const dateIso = readDateLiteral(firstArg);
  const labelArg = unquote(readNamedArg(src, "label")) ?? "";

  return [
    {
      heading: t("pill.due.heading"),
      items: [{
        label: t("pill.due.date"),
        input: {
          value: dateIso,
          placeholder: "YYYY-MM-DD",
          onCommit: (v) => {
            const norm = normalizeDateInput(v);
            if (norm === null || norm === "") return; // #due requires a date
            applyCallTransform(view, from, (s) =>
              replaceFirstPositional(s, quote(norm)),
            );
          },
        },
      }],
    },
    {
      heading: t("pill.due.description"),
      items: [{
        label: t("pill.due.description.label"),
        input: {
          value: labelArg,
          placeholder: t("pill.due.description.placeholder"),
          onCommit: (v) =>
            applyCallTransform(view, from, (s) =>
              upsertNamedArg(s, "label", v.trim() === "" ? null : quote(v)),
            ),
        },
      }],
    },
  ];
}

// ── #suggestion(...) ────────────────────────────────────────────────
// No options of its own: kind and date show in the sidebar, the text is edited
// through "Edit source", and Accept/Reject/Comment are on the widget. The empty
// list also keeps `genericArgsOptions` from offering `kind` as a field.

function suggestionOptions(): PillMenuSection[] {
  return [];
}

// ── #sym.* ──────────────────────────────────────────────────────────
// `#sym.<path>` isn't a call with arguments, so the option is a name field that
// rewrites the whole reference. Any symbol path works (`arrow.r`, `cc.by`).

function symOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  const path = src.replace(/^#?sym\./, "");
  return [
    {
      heading: t("pill.sym.heading"),
      items: [{
        label: t("pill.sym.name"),
        title: t("pill.sym.name.title"),
        input: {
          value: path,
          placeholder: "arrow.r",
          onCommit: (v) => {
            const name = v.trim();
            if (name === "" || name === path) return;
            const len = view.state.doc.length;
            const safeFrom = Math.max(0, Math.min(from, len));
            const safeTo = Math.max(safeFrom, Math.min(to, len));
            view.dispatch({ changes: { from: safeFrom, to: safeTo, insert: `#sym.${name}` } });
          },
        },
      }],
    },
  ];
}

/**
 * Replace or insert the first positional argument with `literal`, for
 * non-string values like `#due("2026-07-01")` where
 * `replaceFirstPositionalString` would add a second pair of quotes.
 */
function replaceFirstPositional(callSource: string, literal: string): string {
  const open = callSource.indexOf("(");
  const firstBracket = callSource.indexOf("[");
  if (open < 0 || (firstBracket >= 0 && firstBracket < open)) {
    // No arg list — insert one.
    const insertAt = firstBracket >= 0 ? firstBracket : callSource.length;
    return callSource.slice(0, insertAt) + `(${literal})` + callSource.slice(insertAt);
  }
  // Find matching `)`.
  let depth = 0;
  let inStr = false;
  let close = -1;
  for (let i = open; i < callSource.length; i++) {
    const ch = callSource[i];
    if (ch === '"' && callSource[i - 1] !== "\\") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close < 0) return callSource;

  const args = callSource.substring(open + 1, close);
  // Find the end of the first top-level arg.
  let argEnd = args.length;
  depth = 0; inStr = false;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === '"' && args[i - 1] !== "\\") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) { argEnd = i; break; }
  }

  // If the first arg is named (contains a `:` at depth 0 before argEnd),
  // there is no positional to replace — prepend the new positional.
  let colonAtDepth0 = -1;
  depth = 0; inStr = false;
  for (let i = 0; i < argEnd; i++) {
    const ch = args[i];
    if (ch === '"' && args[i - 1] !== "\\") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === ":" && depth === 0) { colonAtDepth0 = i; break; }
  }

  let newArgs: string;
  if (colonAtDepth0 >= 0 || args.trim().length === 0) {
    // No positional currently — prepend.
    newArgs = args.trim().length === 0
      ? literal
      : `${literal}, ${args.trimStart()}`;
  } else {
    newArgs = literal + args.substring(argEnd);
  }

  return callSource.substring(0, open + 1) + newArgs + callSource.substring(close);
}
