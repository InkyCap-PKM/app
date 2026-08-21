// The one place InkyCap asks "where are this document's headings?".
//
// Per CLAUDE.md's Typst-first principle the answer comes from Typst's own
// parser — the `syntaxTree` the editor already keeps in sync — not from a line
// regex. A regex only sees the start of a line, so it can't know that the `=`
// it matched sits inside a raw block, a comment, a string, or a math block.
// That is how `= Not a headliner`, written inside a ``` fence, ended up in the
// outline pane and cut heading folding short (issue #21). The parser draws
// that boundary already: it emits a `Heading` node only where Typst itself
// renders one, so asking the tree retires the whole class of false positives
// rather than patching the fence case.
//
// ── Why the scan is index-then-confirm rather than a tree walk ──
//
// The obvious implementation — iterate the whole tree and collect `Heading`
// nodes — is too slow to run on a keystroke. The Typst parser hands CodeMirror
// a plain `Tree` whose markup children are one long flat list, and lezer's
// traversal helpers are linear in that list (`nextChild` scans siblings one by
// one, with a `MountedTree` WeakMap lookup each). Measured on a 277 KB note
// (8 000 lines, ~84 000 nodes), per scan:
//
//     tree.iterate over the document      ~230 ms
//     …pruned to heading containers       ~104 ms
//     one tree.resolveInner call            ~9 ms
//     line regex over the document          ~5 ms
//
// The heading fold rebuilds its decorations on every document change, so a
// full walk would put a ~100 ms stall on every keypress in a long note.
//
// So the scan splits the question in two. A line regex proposes *candidates*
// — cheap, and it only has to be permissive — and the tree *rules* on each
// one, reached by binary-searching the child lists down to the position
// instead of scanning them. Candidates are few, the descent is O(log n) per
// level, and the parser still decides what counts as a heading.
//
// The backend answers the same question for merged book export, PDF/UA
// linting, heading autocomplete, and Markdown export in
// `src-tauri/src/typst_pipeline/source_structure.rs`, against the same parser
// compiled natively.
//
// One consequence worth knowing: only headings that open their own line are
// indexed. `#callout[= Aside]` is a heading to Typst, but both callers work in
// whole lines — the fold hides a run of them, the outline scrolls to one — so
// a heading with no line of its own has nothing to offer either.

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

/** A line that *might* open a heading: `=` markers first thing on the line,
 *  followed by whitespace or nothing. Deliberately looser than Typst's rule —
 *  the tree decides; this only says where to look. */
const CANDIDATE_RE = /^[ \t]*(=+)(?=[ \t]|$)/;

/** Strips the `=` markers and the whitespace separating them from the text. */
const MARKER_RE = /^=+[ \t]*/;

/**
 * Index of the child of `tree` whose range contains `pos`, or -1 when `pos`
 * falls in a gap between children (lezer trees don't have to be gapless).
 *
 * `positions` is ascending and children don't overlap, so this is a binary
 * search — which is the entire performance argument for this module.
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

/** The `Heading` node starting exactly at `pos`, or null if the parser sees
 *  something else there — raw text, a comment, a string, plain markup. */
function headingNodeAt(tree: Tree, pos: number): { from: number; to: number } | null {
  let node = tree;
  let offset = 0;
  for (;;) {
    const i = childIndexAt(node, offset, pos);
    if (i < 0) return null;
    const child = node.children[i];
    const from = offset + node.positions[i];
    // A `TreeBuffer` packs small leaf subtrees into a flat array with a
    // different shape. The Typst parser builds its trees node by node and
    // emits none today; if that ever changes, lezer's own resolver is the
    // correct (if slower) answer rather than a wrong one.
    if (!(child instanceof Tree)) {
      let n: SyntaxNode | null = tree.resolveInner(pos, 1);
      while (n && n.name !== "Heading") n = n.parent;
      return n && n.from === pos ? { from: n.from, to: n.to } : null;
    }
    if (child.type.name === "Heading") {
      return from === pos ? { from, to: from + child.length } : null;
    }
    node = child;
    offset = from;
  }
}

/** Every heading in `doc`, in document order, as `tree` sees them. */
export function headingsInTree(tree: Tree, doc: Text): HeadingSpan[] {
  const out: HeadingSpan[] = [];
  let pos = 0;
  for (const line of doc.iterLines()) {
    const candidate = CANDIDATE_RE.exec(line);
    if (candidate) {
      const markerFrom = pos + candidate[0].length - candidate[1].length;
      const node = headingNodeAt(tree, markerFrom);
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
