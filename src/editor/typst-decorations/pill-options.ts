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
  const isBlock = blockArg !== "false"; // quote defaults to block in our usage
  const attribution = unquote(readNamedArg(src, "attribution")) ?? "";
  return [{
    heading: "Style",
    items: [
      {
        label: "Block",
        isActive: isBlock,
        onSelect: () => applyCallTransform(view, from, (s) =>
          upsertNamedArg(s, "block", "true", { defaultValue: "true" })),
      },
      {
        label: "Inline",
        isActive: !isBlock,
        onSelect: () => applyCallTransform(view, from, (s) =>
          upsertNamedArg(s, "block", "false")),
      },
    ],
  }, {
    items: [{
      label: "Attribution",
      input: {
        value: attribution,
        placeholder: "e.g. Albert Camus",
        onCommit: (v) => applyCallTransform(view, from, (s) =>
          upsertNamedArg(s, "attribution", v.trim() === "" ? null : quote(v))),
      },
    }],
  }];
}

function imageOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  const alt = unquote(readNamedArg(src, "alt")) ?? "";
  const width = readNamedArg(src, "width") ?? "";
  return [{
    items: [{
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

function highlightOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = readCallSource(view, from, to);
  const fill = readNamedArg(src, "fill");
  return [{
    heading: "Color",
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
