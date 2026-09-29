// Module-level tracker of in-flight editor writes, keyed by file path,
// plus the requests that make open editors save or follow a moved file.
//
// When an editor instance unmounts with a pending save, the flush kicks
// off the write asynchronously. Two consumers need to coordinate with
// it:
//
//   - The next mount of the same path must wait for the write to land
//     before reading from disk — otherwise it sees stale content and a
//     subsequent edit overwrites the just-written changes.
//
//   - A notebox-switch flow must wait for ALL in-flight writes to land
//     before swapping the active notebox in the backend, because
//     `write_file_content` routes through the currently-active notebox
//     and would land in the wrong place after a switch.
//
// `trackWrite()` is the write-side registrar; `awaitPendingWrite()` is
// the read-side gate for a single path; `awaitAllPendingWrites()` is
// the global drain for the notebox-switch case. `flushEditorsAt()` makes
// editors save now, before a rename, move or property rewrite touches the
// file on disk.

import { normalizePath, pathStartsWith } from "../lib/paths";

// Writes in flight, keyed by canonical path. A path can have more than one
// (two panes showing the same note each save their own buffer).
const pendingWrites = new Map<string, Set<Promise<void>>>();

// Listeners notified when a user-initiated editor save begins. This is a clean
// "the user is changing files" signal: it fires only for editor flushes, never
// for backend-driven writes like a git checkout during sync (those bypass
// `trackWrite`). The git store uses it to drop the transient post-sync review
// notice once the user moves on to editing.
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

/** Wait for every in-flight editor write to settle. Used before a
 *  notebox switch so the backend's currently-active notebox is still
 *  the writes' intended destination when they land. */
export async function awaitAllPendingWrites(): Promise<void> {
  if (pendingWrites.size === 0) return;
  // Snapshot the values — new writes registered during the await will
  // be tracked separately and aren't the caller's concern.
  await Promise.allSettled([...pendingWrites.values()].flatMap((writes) => [...writes]));
}

/** Write every open editor's unsaved changes now, without waiting for the
 *  autosave delay, and wait for all writes to land. Used before anything
 *  that stops the app, such as installing an update. Each mounted editor
 *  answers the `inkycap:flush-all-editors` event by starting its write, which
 *  registers here synchronously, so the wait below covers it. */
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
