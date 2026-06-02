// Module-level tracker of in-flight editor writes, keyed by
// notebox-relative file path.
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
// the global drain for the notebox-switch case.

const pendingWrites = new Map<string, Promise<void>>();

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
  pendingWrites.set(path, writePromise);
  for (const listener of writeListeners) listener(path);
  writePromise.finally(() => {
    if (pendingWrites.get(path) === writePromise) {
      pendingWrites.delete(path);
    }
  });
}

export async function awaitPendingWrite(path: string): Promise<void> {
  const pending = pendingWrites.get(path);
  if (pending) {
    try {
      await pending;
    } catch {
      // The write failed (toast surfaced at the write site); proceed
      // to read whatever is currently on disk.
    }
  }
}

/** Wait for every in-flight editor write to settle. Used before a
 *  notebox switch so the backend's currently-active notebox is still
 *  the writes' intended destination when they land. */
export async function awaitAllPendingWrites(): Promise<void> {
  if (pendingWrites.size === 0) return;
  // Snapshot the values — new writes registered during the await will
  // be tracked separately and aren't the caller's concern.
  await Promise.allSettled([...pendingWrites.values()]);
}
