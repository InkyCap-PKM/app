/**
 * Helpers for notebox paths from the backend.
 *
 * The backend sends every path through `crate::storage::to_frontend_string`
 * (see `src-tauri/src/storage/path.rs`), which removes the Windows `\\?\`
 * prefix and uses `/`, so paths normally arrive in that form already.
 *
 * `normalizePath` is a safety check where paths are compared (status bar,
 * "reveal in file tree", tab lookups, graph node ids), where one missed
 * conversion would quietly break the comparison. It does nothing to an
 * already-canonical path.
 *
 * Don't use it to change paths sent back to the backend (Rust accepts either
 * separator) or for display; it is for comparisons only.
 */

/**
 * `path` in canonical form: Windows `\\?\` prefix removed, backslashes turned
 * into forward slashes. Applying it twice changes nothing.
 */
export function normalizePath(path: string): string {
  if (!path) return path;
  let s = path;
  // `\\?\UNC\server\share\...` → `\\server\share\...` (then slashes flip).
  if (s.startsWith("\\\\?\\UNC\\")) {
    s = "\\\\" + s.slice("\\\\?\\UNC\\".length);
  } else if (s.startsWith("\\\\?\\")) {
    s = s.slice("\\\\?\\".length);
  }
  return s.replace(/\\/g, "/");
}

/** Path-aware equality: equal in canonical shape. */
export function pathEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return a === b;
  return normalizePath(a) === normalizePath(b);
}

/** `child` lives at or under `parent`. Both compared in canonical shape. */
export function pathStartsWith(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith("/") ? p : p + "/");
}
