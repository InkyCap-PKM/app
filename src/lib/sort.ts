// Sort comparators shared by every note list (file tree, Links pane, search
// results, collections, tags, properties), so their ordering matches.

/**
 * The collator for every user-facing name sort.
 *
 * `numeric: true` sorts digit runs by value, so `2 Draft` comes before `10
 * Draft`; people number notes and folders to order them.
 *
 * Sensitivity stays at the default (`"variant"`): `"base"` would treat names
 * differing only in case as equal, leaving `Notes/` and `notes/` (possible on
 * case-sensitive file systems) in arbitrary order. The default still orders
 * `apple` before `Zebra`.
 *
 * Created once, since creating a collator is far slower than using one.
 */
const nameCollator = new Intl.Collator(undefined, { numeric: true });

/**
 * Compare two names for an ascending sort, with numbers ordered by value. For
 * descending order, swap the arguments rather than negating, so ties stay ties.
 *
 * Use for anything the user reads as a name: file and folder names, note
 * titles, tags, property keys and values, collection names, bibliography
 * titles, command titles.
 */
export function compareName(a: string, b: string): number {
  return nameCollator.compare(a, b);
}

/**
 * Compare two `zid` values in `dir` order. A zid (`#note(zid:)`) may contain
 * letters, so numbers inside are ordered by value (`z2` before `z10`). Notes
 * without a zid always sort last; two without one return 0, for the caller's
 * tiebreak (usually by name).
 */
export function compareZid(
  a: string | null | undefined,
  b: string | null | undefined,
  dir: "asc" | "desc",
): number {
  const az = a ?? "";
  const bz = b ?? "";
  if (!az && !bz) return 0;
  if (!az) return 1;
  if (!bz) return -1;
  const c = az.localeCompare(bz, undefined, { numeric: true, sensitivity: "base" });
  return dir === "asc" ? c : -c;
}

/**
 * Oldest first, as far as the notes show it: by ZID, then (for notes without
 * a ZID, which follow) by creation time, then by name. Creation times of 0
 * mean "unknown" and sort after real ones.
 */
export function compareChronological(
  a: { zid?: string | null; created_time: number; name: string },
  b: { zid?: string | null; created_time: number; name: string },
): number {
  const byZid = compareZid(a.zid, b.zid, "asc");
  if (byZid !== 0) return byZid;
  if (a.created_time !== b.created_time) {
    if (!a.created_time) return 1;
    if (!b.created_time) return -1;
    return a.created_time - b.created_time;
  }
  return compareName(a.name, b.name);
}
