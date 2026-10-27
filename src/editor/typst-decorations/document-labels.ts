// Finds Typst `<label>` definitions in the document and classifies each by what
// it labels (heading, figure, equation, table), for the non-citation entries of
// the `@` reference popup. InkyCap never creates labels, so these are exactly
// the user's own.
//
// Per CLAUDE.md's Typst-first principle this reads the `codemirror-lang-typst`
// syntax tree, not a separate parser. Where the tree doesn't make it obvious
// what a label tags, the source is inspected; that only affects a label's group,
// never its name.

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
 * Every label definition in the document. Labels passed as arguments
 * (`#cite(<key>)`, `#ref(<key>)`, `#link(<key>)`) are references and are
 * skipped. Duplicates are dropped; the first wins.
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
 * True when the `<` at `labelFrom` follows `(` or `,` (ignoring spaces), so the
 * label is a function argument, a reference rather than a definition. Same rule
 * as [`findLabelDefinition`](./label-nav.ts).
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
  // `= Heading <intro>`: the parser makes the label the heading's sibling, so
  // the heading is found by stepping back over the space (as
  // `source_structure::trailing_label` does in the backend).
  const heading = precedingHeadingOnSameLine(state, node, labelFrom);
  if (heading) {
    const headingText = state.doc
      .sliceString(heading.from, heading.to)
      .replace(/^=+\s*/, "")
      .trim();
    return { kind: "heading", display: headingText || name };
  }

  // Otherwise the label tags the element just before it. The source is read
  // rather than the tree so multi-line figures and block equations classify
  // reliably.
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

/**
 * The heading this label tags, or null. Only a label on the heading's own line
 * belongs to it.
 */
function precedingHeadingOnSameLine(
  state: EditorState,
  node: ReturnType<typeof syntaxTree>["topNode"],
  labelFrom: number,
) {
  let prev = node.prevSibling;
  // Whitespace between the heading and its label is a node of its own.
  while (prev && prev.name === "Space") prev = prev.prevSibling;
  if (!prev || prev.name !== "Heading") return null;
  if (state.doc.sliceString(prev.to, labelFrom).includes("\n")) return null;
  return prev;
}

/** Byte offset just after the nearest `\n\n` before `pos`, or 0. */
function lastParagraphBreak(state: EditorState, pos: number): number {
  const text = state.doc.sliceString(0, pos);
  const idx = text.lastIndexOf("\n\n");
  return idx < 0 ? 0 : idx + 2;
}
