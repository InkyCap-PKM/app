// "Show in file tree": ask the left sidebar to switch to the file tree, expand
// the folders above a path, and scroll its row into view.
//
// The request travels as a DOM event because the callers — the File Actions
// menu in the right panel, the attachment menu drawn by CodeMirror widgets —
// have no handle on the sidebar component. The sidebar subscribes on mount.

/** DOM event carrying the path to reveal as its `detail`. */
export const REVEAL_IN_FILE_TREE_EVENT = "inkycap:reveal-in-tree";

/** Reveal `path` (as the backend reports it) in the file tree. */
export function revealInFileTree(path: string): void {
  document.dispatchEvent(new CustomEvent(REVEAL_IN_FILE_TREE_EVENT, { detail: path }));
}
