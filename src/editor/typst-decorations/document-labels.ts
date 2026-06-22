// Scans the current document for Typst `<label>` *definitions* and classifies
// each by the element it tags (heading / figure / equation / table). Drives the
// reference (`@`) suggestion popup's non-citation entries.
//
// Phase 1 of the reference system is deliberately *manual-labelling*: InkyCap
// never auto-creates labels, so the only referenceable targets are the ones the
// user has already tagged. This scanner therefore reports exactly what exists in
// the source — nothing is synthesized.
//
// Per CLAUDE.md's Typst-first principle this reads the `codemirror-lang-typst`
// syntax tree (the same parse the visual editor decorates), not a bespoke regex
// parser. Classification of the tagged element falls back to lightweight source
// inspection where the grammar doesn't make the relationship trivial — that only
// affects which *group* a label lands in, never the label name itself.

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

export type LabelKind = "heading" | "figure" | "equation" | "table" | "label";

export interface DocLabel {
  /** The label name as written between `<` and `>` — what `@name` references. */
  name: string;
  /** What the label tags, for grouping in the suggestion popup. */
  kind: LabelKind;
  /** Human-readable text to show: heading text for headings, else the name. */
  display: string;
}

/**
 * Collect every label *definition* in the document. Labels used as function
 * arguments (`#cite(<key>)`, `#ref(<key>)`, `#link(<key>)`) are references, not
 * definitions, and are skipped — they don't introduce a new referenceable
 * target. Results are de-duplicated by name, first occurrence wins.
 */
export function scanDocumentLabels(state: EditorState): DocLabel[] {
  const out: DocLabel[] = [];
  const seen = new Set<string>();

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Label") return;
      if (isReferenceArgument(state, node.from)) return;

      const raw = state.doc.sliceString(node.from, node.to);
      const name = raw.replace(/^</, "").replace(/>$/, "").trim();
      if (!name || seen.has(name)) return;
      seen.add(name);

      const { kind, display } = classify(state, node.node, name, node.from);
      out.push({ name, kind, display });
    },
  });

  return out;
}

/**
 * True when the `<` at `labelFrom` is preceded (ignoring inline spaces) by `(`
 * or `,` — i.e. the label sits in a function call's argument list and is a
 * *reference*, not a definition. Mirrors the heuristic in
 * [`findLabelDefinition`](./label-nav.ts).
 */
function isReferenceArgument(state: EditorState, labelFrom: number): boolean {
  let i = labelFrom - 1;
  for (; i >= 0; i--) {
    const ch = state.doc.sliceString(i, i + 1);
    if (ch === " " || ch === "\t") continue;
    return ch === "(" || ch === ",";
  }
  return false;
}

/** Classify a label definition by the element it tags. */
function classify(
  state: EditorState,
  node: ReturnType<typeof syntaxTree>["topNode"],
  name: string,
  labelFrom: number,
): { kind: LabelKind; display: string } {
  // `= Heading <intro>` — the grammar nests the Label inside the Heading.
  const parent = node.parent;
  if (parent?.name === "Heading") {
    const headingText = state.doc
      .sliceString(parent.from, labelFrom)
      .replace(/^=+\s*/, "")
      .trim();
    return { kind: "heading", display: headingText || name };
  }

  // Otherwise the label tags the element immediately before it. Inspect the
  // source rather than the grammar's sibling structure so multi-line figure
  // calls and block equations classify reliably.
  let i = labelFrom - 1;
  while (i >= 0 && /\s/.test(state.doc.sliceString(i, i + 1))) i--;
  const prevChar = i >= 0 ? state.doc.sliceString(i, i + 1) : "";

  // Block equation: `$ … $ <eq>`.
  if (prevChar === "$") return { kind: "equation", display: name };

  // A figure / table / image call. Scan back to the previous paragraph break so
  // a multi-line `#figure( … ) <fig>` is captured whole.
  const blockStart = lastParagraphBreak(state, labelFrom);
  const block = state.doc.sliceString(blockStart, labelFrom);
  if (/\btable\s*\(/.test(block)) return { kind: "table", display: name };
  if (/\b(?:figure|image)\s*\(/.test(block)) return { kind: "figure", display: name };

  return { kind: "label", display: name };
}

/** Byte offset just after the nearest `\n\n` before `pos`, or 0. */
function lastParagraphBreak(state: EditorState, pos: number): number {
  const text = state.doc.sliceString(0, pos);
  const idx = text.lastIndexOf("\n\n");
  return idx < 0 ? 0 : idx + 2;
}
