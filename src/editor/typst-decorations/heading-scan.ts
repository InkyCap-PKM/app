// Finds a document's headings.
//
// Per CLAUDE.md's Typst-first principle the answer comes from Typst's parser
// (the editor's `syntaxTree`), not a line pattern, which can't tell an `=`
// inside a raw block, comment, string or math from a heading (issue #21). The
// parser emits `Heading` nodes only where Typst renders one.
//
// ── Index, then confirm ──
//
// Walking the whole tree is too slow per keystroke: the Typst tree's markup
// children are one long flat list, and lezer's traversal is linear in it. On a
// 277 KB note (8,000 lines, ~84,000 nodes), per scan:
//
//     tree.iterate over the document      ~230 ms
//     …pruned to heading containers       ~104 ms
//     one tree.resolveInner call            ~9 ms
//     line regex over the document          ~5 ms
//
// The heading fold rebuilds on every change, so a full walk would stall every
// keypress. Instead a line pattern proposes candidates and the tree confirms
// each, reached by binary search down the child lists (O(log n) per level). The
// parser still decides what is a heading.
//
// The backend answers the same question (book export, PDF/UA checks, heading
// completion, Markdown export) in
// `src-tauri/src/typst_pipeline/source_structure.rs` with the same parser.
//
// Only headings that start their own line are found. `#callout[= Aside]` is a
// heading to Typst, but both users (folding, the outline) work in whole lines.

import { syntaxTree } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";
import { Tree, type SyntaxNode } from "@lezer/common";

export interface HeadingSpan {
  /** Nesting depth: the number of `=` markers. Not clamped — Typst doesn't
   *  cap heading depth, so neither do we. */
  level: number;
  /** Position of the first `=` marker in the document. */
  from: number;
  /** End of the heading as the parser sees it: past its content, before any
   *  trailing `<label>` and before the line break. */
  to: number;
  /** Everything after the markers, still as Typst markup. Callers that show
   *  this to a reader run it through `headingDisplayText` first. */
  text: string;
}

/**
 * A line that might start a heading: `=` markers first on the line, then
 * whitespace or the end. Looser than Typst's rule; the tree decides.
 */
const CANDIDATE_RE = /^[ \t]*(=+)(?=[ \t]|$)/;

/** Strips the `=` markers and the whitespace separating them from the text. */
const MARKER_RE = /^=+[ \t]*/;

/**
 * Index of the child of `tree` containing `pos`, or -1 in a gap between
 * children. `positions` is ascending and children don't overlap, so this is a
 * binary search, which is the point of this module.
 */
function childIndexAt(tree: Tree, offset: number, pos: number): number {
  const { children, positions } = tree;
  let lo = 0;
  let hi = children.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const from = offset + positions[mid];
    if (pos < from) hi = mid - 1;
    else if (pos >= from + children[mid].length) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * The innermost node starting exactly at `pos` whose type is in `names`, or
 * null if the parser sees something else there (raw text, a comment, a string,
 * plain markup). Uses the same binary-search descent, so it is cheap even once
 * per line (see list-scan.ts). Other container types are descended into, so a
 * nested marker (a `ListMarker` in a `ListItem`) is found. A node in `names`
 * that doesn't start at `pos` gives null.
 */
export function nodeStartingAt(
  tree: Tree,
  pos: number,
  names: Set<string>,
): { name: string; from: number; to: number } | null {
  let node = tree;
  let offset = 0;
  for (;;) {
    const i = childIndexAt(node, offset, pos);
    if (i < 0) return null;
    const child = node.children[i];
    const from = offset + node.positions[i];
    // A `TreeBuffer` packs small subtrees differently. The Typst parser doesn't
    // produce them, but if it ever does, fall back to lezer's slower resolver.
    if (!(child instanceof Tree)) {
      let n: SyntaxNode | null = tree.resolveInner(pos, 1);
      while (n && !names.has(n.name)) n = n.parent;
      return n && n.from === pos ? { name: n.name, from: n.from, to: n.to } : null;
    }
    if (names.has(child.type.name)) {
      return from === pos ? { name: child.type.name, from, to: from + child.length } : null;
    }
    node = child;
    offset = from;
  }
}

const HEADING_NAMES = new Set(["Heading"]);

/** Every heading in `doc`, in document order, as `tree` sees them. */
export function headingsInTree(tree: Tree, doc: Text): HeadingSpan[] {
  const out: HeadingSpan[] = [];
  let pos = 0;
  for (const line of doc.iterLines()) {
    const candidate = CANDIDATE_RE.exec(line);
    if (candidate) {
      const markerFrom = pos + candidate[0].length - candidate[1].length;
      const node = nodeStartingAt(tree, markerFrom, HEADING_NAMES);
      if (node) {
        // Read the level off the node rather than the candidate match, so the
        // parser stays the authority on both halves of the answer.
        const raw = doc.sliceString(node.from, node.to);
        const markers = MARKER_RE.exec(raw);
        if (markers) {
          out.push({
            level: markers[0].trimEnd().length,
            from: node.from,
            to: node.to,
            text: raw.slice(markers[0].length),
          });
        }
      }
    }
    pos += line.length + 1;
  }
  return out;
}

/** Every heading in `state`'s document, in document order. */
export function scanHeadings(state: EditorState): HeadingSpan[] {
  return headingsInTree(syntaxTree(state), state.doc);
}
