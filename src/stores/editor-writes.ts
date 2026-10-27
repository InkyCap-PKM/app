// Tracks editor writes in progress, by file path, and lets other code make open
// editors save or follow a moved file.
//
// An editor that unmounts with unsaved changes starts its write asynchronously.
// Two things must wait for it:
//
//   - The next editor opened on the same path, which would otherwise read stale
//     content and then overwrite the new changes.
//   - A notebox switch, which must wait for all writes, since
//     `write_file_content` goes to whichever notebox is active.
//
// `trackWrite()` registers a write; `awaitPendingWrite()` waits for one path;
// `awaitAllPendingWrites()` waits for all (notebox switch). `flushEditorsAt()`
// makes editors save now, before a rename, move or property rewrite touches the
// file.

import { normalizePath, pathStartsWith } from "../lib/paths";

// Writes in flight, keyed by canonical path. A path can have more than one
// (two panes showing the same note each save their own buffer).
const pendingWrites = new Map<string, Set<Promise<void>>>();

// Listeners called when an editor save starts. Only editor saves, never backend
// writes such as a git checkout during sync (those don't go through
// `trackWrite`). The git store uses it to dismiss its post-sync notice once the
// user starts editing.
type WriteListener = (path: string) => void;
const writeListeners = new Set<WriteListener>();

/** Subscribe to user-initiated editor writes. Returns an unsubscribe fn. */
export function onEditorWrite(listener: WriteListener): () => void {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
}

export function trackWrite(path: string, writePromise: Promise<void>) {
  const key = normalizePath(path);
  let writes = pendingWrites.get(key);
  if (!writes) {
    writes = new Set();
    pendingWrites.set(key, writes);
  }
  writes.add(writePromise);
  for (const listener of writeListeners) listener(path);
  const settled = writes;
  const forget = () => {
    settled.delete(writePromise);
    if (settled.size === 0 && pendingWrites.get(key) === settled) {
      pendingWrites.delete(key);
    }
  };
  // Handle both outcomes here: the writer reports its own failures, and a
  // bare `finally` would re-raise them as unhandled rejections.
  void writePromise.then(forget, forget);
}

/** Wait for the in-flight writes of every path at or under `path`. A failed
 *  write already showed its own toast, so failures are not rethrown. */
async function awaitWritesUnder(path: string, includeChildren: boolean): Promise<void> {
  const key = normalizePath(path);
  const waits: Promise<void>[] = [];
  for (const [writePath, writes] of pendingWrites) {
    if (writePath === key || (includeChildren && pathStartsWith(writePath, key))) {
      waits.push(...writes);
    }
  }
  if (waits.length > 0) await Promise.allSettled(waits);
}

export async function awaitPendingWrite(path: string): Promise<void> {
  await awaitWritesUnder(path, false);
}

/**
 * Wait for every editor write in progress, so they land before a notebox
 * switch.
 */
export async function awaitAllPendingWrites(): Promise<void> {
  if (pendingWrites.size === 0) return;
  // Snapshot the values — new writes registered during the await will
  // be tracked separately and aren't the caller's concern.
  await Promise.allSettled([...pendingWrites.values()].flatMap((writes) => [...writes]));
}

/**
 * Save every open editor's changes now, without the autosave delay, and wait
 * for the writes. Used before anything that stops the app, such as installing
 * an update. Each editor answers the `inkycap:flush-all-editors` event by
 * starting its write, which registers here at once, so the wait covers it.
 */
export async function flushAllEditors(): Promise<void> {
  document.dispatchEvent(new CustomEvent("inkycap:flush-all-editors"));
  await awaitAllPendingWrites();
}

/** Event an open editor answers by saving its buffer now when its note is at
 *  or under `detail.path`. Use {@link flushEditorsAt} rather than dispatching
 *  it directly. */
export const FLUSH_EDITOR_EVENT = "inkycap:flush-editor";

/** Event telling open editors that the note at `detail.from` now lives at
 *  `detail.to`, so their next save goes to the new path. Sent by
 *  `renameTabPath` before the tab switches paths. */
export const EDITOR_PATH_MOVED_EVENT = "inkycap:editor-path-moved";

/** Write the unsaved changes of every open editor whose note is `path` or
 *  inside the folder `path`, and wait for those writes to land. Call it
 *  before anything that reads, rewrites, renames or moves the file on disk,
 *  so the operation sees the user's latest text. */
export async function flushEditorsAt(path: string): Promise<void> {
  document.dispatchEvent(new CustomEvent(FLUSH_EDITOR_EVENT, { detail: { path } }));
  await awaitWritesUnder(path, true);
}

/** Point open editors of `from` at `to` (see {@link EDITOR_PATH_MOVED_EVENT}). */
export function moveOpenEditors(from: string, to: string): void {
  document.dispatchEvent(new CustomEvent(EDITOR_PATH_MOVED_EVENT, { detail: { from, to } }));
}
