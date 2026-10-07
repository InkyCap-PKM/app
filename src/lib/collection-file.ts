import type { CollectionFile } from "./types";
import * as ipc from "./ipc";

/**
 * Apply a partial change to a `.collection` file without clobbering fields
 * edited elsewhere.
 *
 * The table saves filters and columns while the right panel saves settings,
 * each from its own loaded copy, so either copy can be stale by the time the
 * other writes. Re-reading the file from disk just before merging the change
 * keeps whatever the other side just wrote.
 */
export async function patchCollectionFile(
  path: string,
  patch: Partial<CollectionFile>,
): Promise<void> {
  const fresh = await ipc.getCollectionFile(path);
  await ipc.saveCollectionFile(path, { ...fresh, ...patch });
}
