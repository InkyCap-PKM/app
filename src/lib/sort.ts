// Shared sort comparators used across note-listing surfaces (file tree,
// Links pane) so the same ordering rules don't drift between them.

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
