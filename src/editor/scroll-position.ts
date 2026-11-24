// Converts between scroll offsets in an editor and source positions: the
// editor's side of scroll syncing (see lib/scroll-sync.ts).

import type { EditorView } from "@codemirror/view";

/** Distance from the top of the editor's scrolled content to its first line. */
function documentOffset(view: EditorView): number {
  return (
    view.documentTop - view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.scrollTop
  );
}

/** The source position (1-based line plus how far along it) at a scroll
 *  offset. A drawn block covering several lines is read in proportion. */
export function editorPositionAt(view: EditorView, offset: number): number {
  const { doc } = view.state;
  const height = offset - documentOffset(view);
  if (height <= 0) return 1;
  const block = view.lineBlockAtHeight(height);
  const along =
    block.height > 0 ? Math.max(0, Math.min(1, (height - block.top) / block.height)) : 0;
  if (block.length === 0) return doc.lineAt(block.from).number + along;
  const at = block.from + along * block.length;
  const line = doc.lineAt(Math.floor(at));
  return line.number + (line.length > 0 ? (at - line.from) / line.length : 0);
}

/** The scroll offset of a source position; the reverse of `editorPositionAt`. */
export function editorOffsetOf(view: EditorView, position: number): number {
  if (position <= 1) return 0;
  const { doc } = view.state;
  const lineNumber = Math.max(1, Math.min(doc.lines, Math.floor(position)));
  const along = Math.max(0, Math.min(1, position - lineNumber));
  const line = doc.line(lineNumber);
  const at = line.from + along * line.length;
  const block = view.lineBlockAt(Math.floor(at));
  const within = block.length > 0 ? (at - block.from) / block.length : along;
  return documentOffset(view) + block.top + within * block.height;
}
