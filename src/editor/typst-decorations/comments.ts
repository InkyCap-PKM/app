// Typst comments in the visual editor: whether one is complete, and the run of
// comments one pill stands for. Used by the decorations (the pill), the
// protected ranges (locking the comments) and the note header scan.

import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

/**
 * Whether a comment has its closing delimiter. Typst's parser tolerates errors,
 * so an unclosed `/*` opens a comment running to the end of the document;
 * hiding and locking it would make the rest of the note vanish as soon as `/*`
 * is typed. Line comments end at the line break, so they're always complete.
 *
 * Block comments nest, as in Typst's lexer: each opening delimiter goes one
 * level deeper and each closing one comes back out, and a comment is complete
 * only at depth zero. Checking only the last two characters would accept an
 * unclosed `/*` above a closed comment at the end of the note.
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

interface CommentSpan {
  from: number;
  to: number;
}

/**
 * A run of comments shown as one pill: comments that each fill their own lines
 * on consecutive lines form one run, so several `//` lines are one pill. A
 * comment sharing its line with text is its own run.
 */
export interface CommentRun {
  /** Start of the first comment: where the pill's source begins and the
   *  position `expandFunc` uses to reveal the run for editing. */
  from: number;
  /** End of the last comment. */
  to: number;
  /** The span the pill replaces: whole lines for a run that stands alone,
   *  otherwise just the comment. */
  replaceFrom: number;
  replaceTo: number;
  /**
   * End of the locked span while the run is collapsed. A standalone run
   * includes its line break, so the caret can't sit beside the pill. So does a
   * `//` comment after text, since it runs to the line end and anything typed
   * there would join it.
   */
  lockTo: number;
  /** The caret may sit right before the run, and text typed there goes ahead
   *  of it. True for a comment that shares its line with other text. */
  caretBefore: boolean;
  /** Number of document lines the run covers. */
  lines: number;
}

function isCommentNode(name: string): boolean {
  return name === "LineComment" || name === "BlockComment";
}

/** The complete comment touching `pos` on the given side, if any. */
function closedCommentAt(state: EditorState, pos: number, side: -1 | 1): CommentSpan | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
    if (isCommentNode(n.name)) {
      return isCommentClosed(state, n.name, n.from, n.to) ? { from: n.from, to: n.to } : null;
    }
  }
  return null;
}

/** Whether a comment is the only thing on the line(s) it covers. */
function standsAlone(state: EditorState, c: CommentSpan): boolean {
  const startLine = state.doc.lineAt(c.from);
  const endLine = state.doc.lineAt(c.to);
  return state.doc.sliceString(startLine.from, c.from).trim() === ""
    && state.doc.sliceString(c.to, endLine.to).trim() === "";
}

/**
 * The run containing the complete comment `from..to`, extended over
 * neighbouring lines holding only a complete comment; a blank line or other
 * text ends it.
 */
export function commentRunAt(state: EditorState, from: number, to: number): CommentRun {
  const doc = state.doc;
  const own: CommentSpan = { from, to };
  if (!standsAlone(state, own)) {
    const endsLine = doc.sliceString(from, from + 2) === "//" && to < doc.length;
    return {
      from, to, replaceFrom: from, replaceTo: to,
      lockTo: endsLine ? to + 1 : to,
      caretBefore: true,
      lines: 1,
    };
  }

  let first = own;
  for (let ln = doc.lineAt(first.from).number - 1; ln >= 1;) {
    const line = doc.line(ln);
    const end = line.from + line.text.trimEnd().length;
    if (end === line.from) break;
    const c = closedCommentAt(state, end, -1);
    if (!c || c.to !== end || !standsAlone(state, c)) break;
    first = c;
    ln = doc.lineAt(c.from).number - 1;
  }

  let last = own;
  for (let ln = doc.lineAt(last.to).number + 1; ln <= doc.lines;) {
    const line = doc.line(ln);
    const start = line.from + (line.text.length - line.text.trimStart().length);
    if (start === line.to) break;
    const c = closedCommentAt(state, start, 1);
    if (!c || c.from !== start || !standsAlone(state, c)) break;
    last = c;
    ln = doc.lineAt(c.to).number + 1;
  }

  const startLine = doc.lineAt(first.from);
  const endLine = doc.lineAt(last.to);
  return {
    from: first.from,
    to: last.to,
    replaceFrom: startLine.from,
    replaceTo: endLine.to,
    lockTo: endLine.to < doc.length ? endLine.to + 1 : endLine.to,
    caretBefore: false,
    lines: endLine.number - startLine.number + 1,
  };
}

/** The run whose first comment starts exactly at `pos`, or null. Lets the
 *  expanded-call tracking treat a revealed run as one multi-line unit. */
export function commentRunStartingAt(state: EditorState, pos: number): CommentRun | null {
  const c = closedCommentAt(state, pos, 1);
  if (!c || c.from !== pos) return null;
  return commentRunAt(state, c.from, c.to);
}

/** Whether `expandedPos` (the call revealed for editing) falls within a run. */
export function isCommentRunExpanded(run: CommentRun, expandedPos: number | null): boolean {
  return expandedPos !== null && expandedPos >= run.from && expandedPos <= run.to;
}
