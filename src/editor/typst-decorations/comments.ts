// Typst comments in the visual editor: whether a comment is complete, and the
// span to hide for it. Shared by the decorations (which hide comments), the
// protected ranges (which lock them) and the note header scan.

import type { EditorState } from "@codemirror/state";
import type { ProtectedRange } from "./visual-protected";

/**
 * Whether a comment node has its closing delimiter. Typst's parser is
 * error-tolerant, so an unclosed `/*` opens a BlockComment that runs to the end
 * of the document; hiding and locking that would make the rest of the note
 * vanish the moment those two characters are typed. Line comments end at the
 * line break, so they are always complete.
 *
 * Block comments nest, the way Typst's lexer reads them: every opening
 * delimiter inside one deepens it and every closing delimiter closes one
 * level, so a comment is complete only when the depth returns to zero at its
 * end. Checking just the last two characters would accept an unclosed `/*`
 * typed above a note that already ends with a closed comment.
 */
export function isCommentClosed(
  state: EditorState,
  name: string,
  from: number,
  to: number,
): boolean {
  if (name !== "BlockComment") return true;
  const text = state.doc.sliceString(from, to);
  if (!text.startsWith("/*")) return false;
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("/*", i)) {
      depth++;
      i += 2;
    } else if (text.startsWith("*/", i)) {
      depth--;
      i += 2;
      if (depth === 0) return i === text.length;
    } else {
      i++;
    }
  }
  return false;
}

/**
 * The range to collapse for a Typst comment node. When the comment is the only
 * thing on its line(s) it swallows the whole line including leading indentation
 * and the trailing newline, so a full-line comment leaves no blank gap in the
 * visual editor; a trailing comment (`code // note`) collapses only the comment
 * span. Used for both hiding (visual-plugin) and locking (here) so the two agree.
 */
export function commentHideRange(
  state: EditorState,
  from: number,
  to: number,
): ProtectedRange {
  const docLen = state.doc.length;
  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(to);
  const beforeBlank = state.doc.sliceString(startLine.from, from).trim() === "";
  const afterBlank = state.doc.sliceString(to, endLine.to).trim() === "";
  let f = from;
  let t = to;
  if (beforeBlank) f = startLine.from;
  if (beforeBlank && afterBlank) {
    t = endLine.to < docLen ? Math.min(endLine.to + 1, docLen) : endLine.to;
  }
  return { from: f, to: t };
}
