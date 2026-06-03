// Per-pill options registry (R10). Each function name maps to a builder
// that reads the current call source and returns the menu sections to
// display for that pill. Mutations dispatch via applyCallTransform with
// upsertNamedArg / replaceFirstPositionalString — keeping every change
// to a single argument so source ↔ visual round-trip is preserved (R11).
//
// See documentation/developer/visual-editor/pill-system.md for the
// canonical option set per pill.

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

// Callout kinds come straight from inkycap-notebox/lib.typ's
// `_callout-colors` dict. Keeping this list in lockstep with the notebox
// is the team's job — when a kind is added or removed there, update
// this constant too.
const CALLOUT_KINDS = [
  "note", "tip", "warning", "important", "caution", "example",
  "quote", "abstract", "info", "todo", "success", "question",
  "failure", "danger", "bug",
] as const;

// Five-color highlighter palette per the user-confirmed Stage 2 design.
// Each entry has a Typst-source representation (used in `fill: rgb(...)`)
// and a label. Keeping the rgb literal stable lets the round-trip detect
// "this is the yellow preset" reliably across re-saves.
interface HighlightColor {
  label: string;
  /** Typst expression that goes after `fill:`. */
  fill: string;
  /** Hex used to compare the current source value back to a preset. */
  hex: string;
}
const HIGHLIGHT_COLORS: HighlightColor[] = [
  { label: "Yellow", fill: 'rgb("#f2ed61")', hex: "#f2ed61" },
  { label: "Green",  fill: 'rgb("#c8f0c8")', hex: "#c8f0c8" },
  { label: "Blue",   fill: 'rgb("#c8dcff")', hex: "#c8dcff" },
  { label: "Pink",   fill: 'rgb("#ffd1e0")', hex: "#ffd1e0" },
  { label: "Orange", fill: 'rgb("#ffd6a8")', hex: "#ffd6a8" },
];

const LINE_STROKES: { label: string; literal: string; defaultMatch: boolean }[] = [
  { label: "Thin",   literal: "0.5pt", defaultMatch: false },
  { label: "Medium", literal: "1pt",   defaultMatch: true  },
  { label: "Thick",  literal: "2pt",   defaultMatch: false },
];

// Common `delimiter:` choices for `#csv(…)`. Each is the Typst string
// literal (quotes included). Comma is Typst's own default. We always write
// an explicit literal rather than dropping the arg, because the comma
// literal `","` contains a comma that the shared drop-path regex in
// `upsertNamedArg` can't safely excise.
const CSV_DELIMITERS: { label: string; literal: string; isDefault: boolean }[] = [
  { label: "Comma",     literal: '","',  isDefault: true  },
  { label: "Semicolon", literal: '";"',  isDefault: false },
  { label: "Tab",       literal: '"\\t"', isDefault: false },
];

// `row-type:` choices for `#csv(…)`. Array is Typst's default (cleared from
// source); dictionary keys each row by the header row's column names.
const CSV_ROW_TYPES: { label: string; value: string | null; help?: string }[] = [
  { label: "Array",      value: null,
    help: "Each row is a list of cell strings (the default)." },
  { label: "Dictionary", value: "dictionary",
    help: "Each row is keyed by the first row's column headers." },
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

/** Returns option sections for the named pill. Functions with a curated
 *  builder (image, callout, …) get their hand-designed menu; every other
 *  function falls back to `genericArgsOptions`, which surfaces whatever
 *  named arguments the user typed in source mode as editable fields. That
 *  keeps advanced Typst usage editable from the pill without burdening
 *  beginners — a call with no named args shows no parameter section.
 *  Verse is intentionally absent here — its options live on the widget
 *  itself (see VerseWidget). */
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

/** Split a call's `(...)` arg-list inner text into top-level argument
 *  segments, respecting nested parens/brackets and string literals so a
 *  comma inside `rgb("a,b")` or `(1, 2)` doesn't split an argument. */
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

/** Parse the named arguments (`name: value`) from a call's source, in
 *  source order. Positional arguments are skipped — they have no stable
 *  label to show and stay editable via "Edit source". */
function parseNamedArgs(callSource: string): { name: string; value: string }[] {
  const argsText = findArgListInSource(callSource);
  if (argsText === null) return [];
  const named: { name: string; value: string }[] = [];
  for (const seg of splitTopLevelArgs(argsText)) {
    // `name:` must be a bare identifier followed by a top-level colon. The
    // colon check below the match guards against `:` inside a value (e.g.
    // a dict) being mistaken for the arg separator.
    const m = seg.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*([\s\S]+)$/);
    if (!m) continue;
    named.push({ name: m[1], value: m[2].trim() });
  }
  return named;
}

/** Fallback options for any function without a curated builder: one text
 *  input per named argument the user already wrote, committing the raw
 *  Typst literal back via `upsertNamedArg`. Clearing a field drops the
 *  argument. Returns no section when the call has no named arguments. */
function genericArgsOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  const named = parseNamedArgs(src);
  if (named.length === 0) return [];
  return [{
    heading: "Parameters",
    items: named.map((arg) => ({
      label: arg.name,
      title: `Typst argument “${arg.name}” — edit the raw value`,
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

/** Strip the surrounding double-quotes from a Typst string-literal source
 *  fragment (e.g. `"hello"` → `hello`). Returns null if the input isn't
 *  a quoted string. Unescapes `\"` and `\\`. */
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

/** Return the inner text of the call's `(...)` arg list, or null if the
 *  call has no parens. Used by option builders that read positional
 *  non-string values (e.g. `#align(center)`). */
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

/** Replace the first positional keyword (unquoted identifier) inside a
 *  call's arg list. If the call has no arg list, inserts `(keyword)`
 *  before the body bracket. Used for `#align(center)`-style calls. */
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
  // Match leading whitespace + bare identifier (alignment keywords are
  // simple lowercase ids). Falls through if first arg is e.g. `center +
  // horizon` or a named arg — in those cases we replace just the leading
  // bare ident, preserving the rest.
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

function calloutOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  const currentKind = readFirstPositionalString(src) ?? "note";
  return [{
    heading: "Kind",
    items: CALLOUT_KINDS.map((kind) => ({
      label: kind,
      isActive: kind === currentKind,
      onSelect: () => applyCallTransform(view, from, (s) => replaceFirstPositionalString(s, kind)),
    })),
  }];
}

function quoteOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  const blockArg = readNamedArg(src, "block");
  // Typst's quote defaults to inline (block: false). We mirror Typst's
  // own default here so the pill's active state matches what the source
  // actually compiles to — `/quote` inserts inline, `/blockquote` inserts
  // explicit block:true.
  const isBlock = blockArg === "true";
  const attr = parseAttribution(readNamedArg(src, "attribution"));
  // URL field only applies to plain-text attribution. If the current
  // attribution is a bibkey label, linking is meaningless (the citation
  // already carries the bib entry). Disable the field so the user sees
  // the precedence rather than typing into a no-op input.
  const urlDisabled = attr.kind === "bibkey";
  return [{
    heading: "Style",
    items: [
      {
        label: "Block",
        isActive: isBlock,
        onSelect: () => applyCallTransform(view, from, (s) =>
          upsertNamedArg(s, "block", "true")),
      },
      {
        label: "Inline",
        isActive: !isBlock,
        title: "Attribution renders only in block mode",
        onSelect: () => applyCallTransform(view, from, (s) =>
          upsertNamedArg(s, "block", null)),
      },
    ],
  }, {
    items: [{
      label: "Attribution",
      title: !isBlock
        ? "Attribution is stored but renders only when Block is selected"
        : "Plain text, or a bibliography key as <key>",
      input: {
        value: attr.text,
        placeholder: "e.g. Albert Camus, or <camus1942>",
        onCommit: (v) => applyCallTransform(view, from, (s) => {
          // Re-read URL from the *just-edited* source so we don't clobber
          // a URL the user set in the same menu session. Reading from the
          // closed-over `attr` would race against rapid edits.
          const cur = parseAttribution(readNamedArg(s, "attribution"));
          const urlNow = cur.kind === "link" ? cur.url : "";
          return upsertNamedArg(s, "attribution", buildAttributionExpr(v, urlNow));
        }),
      },
    }, {
      label: "Link URL",
      title: urlDisabled
        ? "Disabled: bibkey attribution links to the bibliography entry already"
        : "Wraps attribution text in a link (e.g. license URL)",
      disabled: urlDisabled,
      input: {
        value: attr.kind === "link" ? attr.url : "",
        placeholder: "e.g. https://creativecommons.org/licenses/by-sa/4.0/",
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
//
// Typst's `attribution` accepts three meaningful shapes for our pill:
//   1. string literal:   attribution: "Albert Camus"
//   2. label (bibkey):   attribution: <camus1942>
//   3. link content:     attribution: link("https://…")[CC BY-SA]
// The pill exposes a text field and an optional URL field; the helpers
// below translate between the source form and that two-field UI.

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
  // link("url")[content] — capture the URL and the inner content as the
  // editable text. The inner content is treated as raw Typst markup so
  // round-trip preserves any inline formatting the user pasted in.
  const m = t.match(/^link\(\s*"((?:\\.|[^"\\])*)"\s*\)\s*\[([\s\S]*)\]$/);
  if (m) {
    const url = m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    return { text: m[2], url, kind: "link" };
  }
  // Anything else (raw content like `[…]`, function calls, complex
  // expressions) — surface verbatim so the user can still see and edit
  // it. The URL field stays empty/inert for this case.
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

/** Add, rewrite, or remove the `#align(...)` wrapper to place an image
 *  left / centre / right. `callFrom` is the pill anchor — the wrapper's `#`
 *  when already wrapped, else the image's `#`. Left is the natural default
 *  so it unwraps to a bare image; centre/right add or rewrite the wrapper. */
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
  // The pill may represent a bare `#image(...)` or an alignment-wrapped
  // `#align(kw)[#image(...)]`. When wrapped, the File/Alt/Width fields must
  // edit the inner image (at `imgFrom`), while the Alignment radio edits the
  // wrapper — so locate the inner image first.
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
  // R12: image is a call-only form (no body bracket), so every meaningful
  // argument must surface in the menu — including the positional path,
  // which would otherwise force the user into "Edit source" for a
  // routine swap. Path is first so it's the auto-focused input.
  return [{
    items: [{
      label: "File",
      title: "Path to the image file, relative to the note",
      input: {
        value: path,
        placeholder: "e.g. images/diagram.png",
        onCommit: (v) => {
          const trimmed = v.trim();
          if (trimmed === "") return;
          applyCallTransform(view, imgFrom, (s) => replaceFirstPositionalString(s, trimmed));
        },
      },
    }, {
      label: "Alt text",
      input: {
        value: alt,
        placeholder: "Describe the image",
        onCommit: (v) => applyCallTransform(view, imgFrom, (s) =>
          upsertNamedArg(s, "alt", v.trim() === "" ? null : quote(v))),
      },
    }, {
      label: "Width",
      // Typst's length units only. `px` is deliberately omitted — Typst has no
      // pixel unit, so it compiles cleanly in the preview but breaks the PDF.
      help: "A percentage scales to the page's text width — 50% is half the column. Absolute units set a fixed size: pt, cm, mm, in, or em (font-relative). Typst has no pixel unit, so px isn't supported.",
      input: {
        value: width,
        placeholder: "e.g. 50% or 8cm",
        onCommit: (v) => {
          const t = v.trim();
          applyCallTransform(view, imgFrom, (s) =>
            upsertNamedArg(s, "width", t === "" ? null : t));
        },
      },
    }],
  }, {
    heading: "Alignment",
    // Typst has no alignment argument on `image`; horizontal placement is
    // `#align(left|center|right)[…]` (CLAUDE.md Typst-first). The visual
    // editor mirrors the wrapper so the choice is reflected while authoring.
    items: ALIGNMENTS.map((a) => ({
      label: a.label,
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
  // `#csv(…)` is a call-only data form with no body bracket, so — like image
  // — every meaningful argument has to surface in the pill menu or the user
  // is forced into "Edit source" for routine tweaks. File is first so it's
  // the auto-focused input.
  return [{
    items: [{
      label: "File",
      title: "Path to the CSV file",
      help: "Paths are resolved from the notebox root, so a leading-slash path like /data/scores.csv is the most portable. A bare name resolves relative to the note.",
      input: {
        value: path,
        placeholder: "e.g. /data/scores.csv",
        onCommit: (v) => {
          const trimmed = v.trim();
          if (trimmed === "") return;
          applyCallTransform(view, from, (s) => replaceFirstPositionalString(s, trimmed));
        },
      },
    }],
  }, {
    heading: "Delimiter",
    items: CSV_DELIMITERS.map((opt) => ({
      label: opt.label,
      isActive: delimiter === opt.literal || (delimiter == null && opt.isDefault),
      onSelect: () => applyCallTransform(view, from, (s) =>
        upsertNamedArg(s, "delimiter", opt.literal)),
    })),
  }, {
    heading: "Row type",
    items: CSV_ROW_TYPES.map((opt) => ({
      label: opt.label,
      help: opt.help,
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
      label: "Length",
      title: "Accepts percentages (100%) or absolute units (5cm, 200pt)",
      input: {
        value: length,
        placeholder: "e.g. 100% or 5cm",
        onCommit: (v) => {
          const t = v.trim();
          applyCallTransform(view, from, (s) =>
            upsertNamedArg(s, "length", t === "" ? null : t));
        },
      },
    }],
  }, {
    heading: "Stroke",
    items: LINE_STROKES.map((opt) => ({
      label: opt.label,
      isActive: stroke === opt.literal || (stroke == null && opt.defaultMatch),
      onSelect: () => applyCallTransform(view, from, (s) =>
        upsertNamedArg(s, "stroke", opt.literal, { defaultValue: "1pt" })),
    })),
  }];
}

// Typst's #align() takes horizontal or 2-axis alignment keywords.
// Justification isn't an alignment value — that's `#set par(justify: true)`
// and the spec's "Justify" entry was mistaken. The radio covers the
// three horizontal options; vertical / combined alignments (e.g.
// `center + horizon`) fall back to "Edit source" via the simple/complex
// classifier.
const ALIGNMENTS = [
  { label: "Left",   keyword: "left"   },
  { label: "Center", keyword: "center" },
  { label: "Right",  keyword: "right"  },
];

function alignOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  // Read the first positional alignment keyword from the arg list.
  // align() accepts alignments like `left`, `center`, `right`, `top`,
  // `horizon`, `bottom`, plus `+`-combinations. Matching just the
  // leading bare keyword is sufficient for the radio UI; anything more
  // complex falls back to "Edit source" via R5.
  const argList = findArgListInSource(src);
  const current = argList ? (argList.match(/^\s*([a-z]+)/)?.[1] ?? null) : null;
  return [{
    heading: "Alignment",
    items: ALIGNMENTS.map((a) => ({
      label: a.label,
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
      label: "Caption",
      input: {
        value: caption,
        placeholder: "Figure caption",
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
      heading: "Form",
      items: (["normal", "prose", "full", "author", "year"] as const).map((f) => ({
        label: f,
        isActive: currentForm === f,
        onSelect: () => applyCallTransform(view, from, (s) =>
          upsertNamedArg(s, "form", f === "normal" ? null : `"${f}"`)),
      })),
    }];
  }
  const key = src.slice(1);
  return [{
    heading: "Citation",
    items: [{
      label: "Convert to #cite()",
      title: "Convert to function form for supplement, form, and other options",
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
    heading: "Colour",
    items: HIGHLIGHT_COLORS.map((c, idx) => {
      // Active when the current `fill:` matches this preset's literal,
      // OR when there's no fill arg AND this is the default (yellow).
      const isDefault = idx === 0;
      const isActive = fill === c.fill || (fill == null && isDefault);
      return {
        label: c.label,
        isActive,
        onSelect: () => applyCallTransform(view, from, (s) =>
          // Drop the arg entirely when picking yellow (the default), so
          // existing source like `#highlight[x]` stays clean.
          upsertNamedArg(s, "fill", isDefault ? null : c.fill)),
      };
    }),
  }];
}

// ── #task ───────────────────────────────────────────────────────────
//
// Body input + due-date input + Done toggle. Dates are written as quoted
// ISO strings (`due: "2026-06-23"`) — lib.typ's `_fmt-date` accepts both
// quoted strings and `datetime(...)` calls, and the quoted form is what
// any editing UI (this menu, a future date picker) writes back, keeping
// hand-edited source and pill-edited source visually identical.

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
      heading: "Task",
      items: [{
        label: "Task",
        input: {
          value: body,
          placeholder: "What needs doing?",
          onCommit: (v) =>
            applyCallTransform(view, from, (s) => replaceFirstPositionalString(s, v)),
        },
      }],
    },
    {
      heading: "Due date",
      items: [{
        label: "Due",
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
        label: isDone ? "Mark as not done" : "Mark as done",
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
//
// Date input (positional) + label input (named string). Same date-string
// convention as `#task`.

function dueOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  // The date is the first positional. It can be either a string or a
  // `datetime(...)` expression — read the raw arg-list snippet and run
  // `readDateLiteral` against it.
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
      heading: "Due date",
      items: [{
        label: "Date",
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
      heading: "Description",
      items: [{
        label: "Description",
        input: {
          value: labelArg,
          placeholder: "Optional caption",
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
//
// The inline tracked-change pill has NO curated parameters: its kind and date
// are already shown in the Annotations/Changes sidebar, the proposed/old text
// is edited via the standard "Edit source" / "Open in source editor" actions,
// and Accept/Reject/Comment live on the widget's own click dialogue. An empty
// section list keeps the pill menu to the standard actions and — crucially —
// suppresses `genericArgsOptions`, which would otherwise expose the raw `kind`
// keyword as an error-prone editable field.

function suggestionOptions(): PillMenuSection[] {
  return [];
}

// ── #sym.* ──────────────────────────────────────────────────────────
//
// A `#sym.<path>` reference isn't a parenthesized call, so it doesn't use the
// upsertNamedArg machinery — the option is a single name input that rewrites
// the whole reference. The input accepts any symbol path (e.g. `arrow.r`,
// `cc.by`), so the pill covers Typst's entire `sym` module, not just the
// curated quick-picks in the `/` menu.

function symOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  const path = src.replace(/^#?sym\./, "");
  return [
    {
      heading: "Symbol",
      items: [{
        label: "Name",
        title: "Symbol name after #sym. (e.g. arrow.r, copyright, cc.by)",
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

/** Replace (or insert) the first positional argument inside a call's
 *  `(...)` list with `literal`. Used for non-string positionals like
 *  `#due("2026-07-01")` where `replaceFirstPositionalString` would
 *  double-quote the already-quoted input. */
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
