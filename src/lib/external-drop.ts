// Tracks which file-tree folder a drag from outside the app (files from the
// system file manager) is over, so the tree can highlight it and the drop
// handlers can copy the files into that folder instead of into the editor.
//
// Folder targets are marked in the DOM with a `data-drop-folder` attribute
// holding the folder's path. Drags that begin inside the app (moving tree
// rows, tabs, editor text) fire `dragstart` in this document; drags from
// outside never do, which is how the two are told apart.

import { createSignal } from "solid-js";

const [externalDropFolder, setExternalDropFolder] = createSignal<string | null>(null);

/** The folder an outside drag is currently over, or `null`. */
export { externalDropFolder };

/** Where the pointer was at the last `dragover`, for native drops (Linux and
 *  macOS) whose own coordinates don't reliably match page coordinates. */
let lastPos: { x: number; y: number; time: number } | null = null;
let internalDrag = false;

/** The folder marked at page coordinates (`x`, `y`), or `null` if that point
 *  isn't over a folder target. */
export function dropFolderAt(x: number, y: number): string | null {
  const target = document
    .elementFromPoint(x, y)
    ?.closest<HTMLElement>("[data-drop-folder]");
  return target?.dataset.dropFolder ?? null;
}

/**
 * The folder under the pointer when a native drop landed, or `null` when it
 * landed elsewhere (e.g. in the editor). Clears the highlight.
 */
export function takeNativeDropFolder(): string | null {
  setExternalDropFolder(null);
  if (!lastPos || Date.now() - lastPos.time > 2000) return null;
  return dropFolderAt(lastPos.x, lastPos.y);
}

/** Clear the highlight (the drag left the window or ended). */
export function clearExternalDrop(): void {
  setExternalDropFolder(null);
}

const onDragStart = () => {
  internalDrag = true;
};
const onDragEnd = () => {
  internalDrag = false;
  setExternalDropFolder(null);
};
const onDragOver = (e: DragEvent) => {
  if (internalDrag) return;
  lastPos = { x: e.clientX, y: e.clientY, time: Date.now() };
  setExternalDropFolder(dropFolderAt(e.clientX, e.clientY));
};
const onDragLeave = (e: DragEvent) => {
  // `relatedTarget` is null when the pointer leaves the window entirely.
  if (e.relatedTarget === null) setExternalDropFolder(null);
};
const onDrop = () => {
  internalDrag = false;
  setExternalDropFolder(null);
};

/** Start tracking. Listeners run in the capture phase so handlers that stop
 *  propagation (the editor, tree rows) don't hide drag positions from us. */
export function installExternalDropTracking(): void {
  window.addEventListener("dragstart", onDragStart, true);
  window.addEventListener("dragend", onDragEnd, true);
  window.addEventListener("dragover", onDragOver, true);
  window.addEventListener("dragleave", onDragLeave, true);
  window.addEventListener("drop", onDrop, true);
}

/** Stop tracking (undoes {@link installExternalDropTracking}). */
export function uninstallExternalDropTracking(): void {
  window.removeEventListener("dragstart", onDragStart, true);
  window.removeEventListener("dragend", onDragEnd, true);
  window.removeEventListener("dragover", onDragOver, true);
  window.removeEventListener("dragleave", onDragLeave, true);
  window.removeEventListener("drop", onDrop, true);
  setExternalDropFolder(null);
}
