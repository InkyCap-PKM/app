/**
 * Path utilities for notebox paths arriving from the Rust backend.
 *
 * The backend ships every outbound path through
 * `crate::storage::to_frontend_string` (see `src-tauri/src/storage/path.rs`),
 * which strips the Windows `\\?\` UNC verbatim prefix and converts `\` to
 * `/`. So in normal operation every path the frontend sees is already in a
 * canonical, forward-slash, no-UNC shape.
 *
 * `normalizePath` exists as a defensive double-check at *equality* sites —
 * the places where a single missed normalization in the backend would
 * silently break a comparison (status bar, "reveal in file tree", tab
 * lookups, graph node IDs). Calling it on already-canonical paths is a
 * no-op, so wrapping comparisons in it costs nothing and immunizes the
 * frontend against future regressions on either side of the IPC boundary.
 *
 * Do NOT use `normalizePath` to *transform* paths for sending back to the
 * backend — Rust handles either separator fine via `PathBuf::from`, and
 * mutating a user-facing path string for display can confuse other code
 * paths that expect the original. Read-only comparison helper only.
 */

/**
 * Return a canonical-shape copy of `path`: Windows `\\?\` UNC prefix stripped,
 * backslashes converted to forward slashes. Idempotent.
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
