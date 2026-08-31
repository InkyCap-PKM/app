// Shared sort comparators used across every note-listing surface (file tree,
// Links pane, search results, collections, tag and property lists) so the
// same ordering rules don't drift between them.

/**
 * The one collator behind every user-facing name/label sort in the app.
 *
 * `numeric: true` is the load-bearing option: it gives digit runs inside a
 * string a *natural* ordering, so `2 Draft` sorts before `10 Draft` rather
 * than between `1 Draft` and `3 Draft`. Users number folders and notes to
 * impose an order, and lexicographic digit comparison silently defeats that.
 *
 * Sensitivity is left at its default (`"variant"`) on purpose. A collator
 * built with `sensitivity: "base"` reports two names differing only in case
 * as *equal*, which makes their relative order fall through to whatever the
 * input order happened to be — a real hazard on case-sensitive filesystems
 * where `Notes/` and `notes/` can coexist. The default still orders case as
 * a tertiary difference (`apple` before `Zebra`), it just breaks the tie
 * deterministically.
 *
 * Built once at module load rather than per comparison: a file tree or search
 * result list runs this O(n log n) times, and constructing an {@link
 * Intl.Collator} is far more expensive than invoking one.
 */
const nameCollator = new Intl.Collator(undefined, { numeric: true });

/**
 * Compare two names/labels for an *ascending* sort, with natural ordering of
 * embedded numbers. Callers wanting descending order swap the arguments
 * (`compareName(b.name, a.name)`) rather than negating, so a tie stays a tie.
 *
 * Use this for anything the user reads as a name: filenames, folder names,
 * note titles, tag names, property keys and values, collection names,
 * bibliography titles, command titles.
 */
export function compareName(a: string, b: string): number {
  return nameCollator.compare(a, b);
}

/**
 * Compare two `zid` values for a sort, in `dir` order.
 *
 * A `zid` (`#note(zid:)`) is user-definable and may be alphanumeric, not just
 * digits, so values are compared with a locale-aware *natural* ordering
 * ({@link Intl} numeric collation) — `z2` sorts before `z10` rather than
 * after it. Notes without a zid (null / undefined / empty) always sort to the
 * end regardless of direction. Returns 0 when both lack a zid, leaving the
 * caller to apply its own tiebreak (typically by name).
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
