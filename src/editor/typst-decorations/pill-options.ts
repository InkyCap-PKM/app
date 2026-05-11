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
  readNamedArg,
  readFirstPositionalString,
  replaceFirstPositionalString,
  upsertNamedArg,
  type PillMenuSection,
} from "./pill";

// Callout kinds come straight from inkycap-vault/0.1.0/lib.typ's
// `_callout-colors` dict. Keeping this list in lockstep with the vault
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
  { label: "Yellow", fill: 'rgb("#fff3a3")', hex: "#fff3a3" },
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
  align:     alignOptions,
  figure:    figureOptions,
};

/** Returns option sections for the named pill, or an empty array if the
 *  function has no registered options yet. Verse is intentionally absent
 *  here — its options live on the widget itself (see VerseWidget). */
export function getPillOptions(
  funcName: string,
  view: EditorView,
  callFrom: number,
  callTo: number,
): PillMenuSection[] {
  const builder = REGISTRY[funcName];
  return builder ? builder(view, callFrom, callTo) : [];
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

function imageOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  const path = readFirstPositionalString(src) ?? "";
  const alt = unquote(readNamedArg(src, "alt")) ?? "";
  const width = readNamedArg(src, "width") ?? "";
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
          applyCallTransform(view, from, (s) => replaceFirstPositionalString(s, trimmed));
        },
      },
    }, {
      label: "Alt text",
      input: {
        value: alt,
        placeholder: "Describe the image",
        onCommit: (v) => applyCallTransform(view, from, (s) =>
          upsertNamedArg(s, "alt", v.trim() === "" ? null : quote(v))),
      },
    }, {
      label: "Width",
      title: "Accepts percentages (80%) or absolute units (400px, 12cm, 30em)",
      input: {
        value: width,
        placeholder: "e.g. 80% or 400px",
        onCommit: (v) => {
          const t = v.trim();
          applyCallTransform(view, from, (s) =>
            upsertNamedArg(s, "width", t === "" ? null : t));
        },
      },
    }],
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
