/**
 * Platform detection for UI affordances.
 *
 * Kept narrow on purpose: this file exists to give cross-platform UI strings
 * (shortcut hints, modifier-aware click prompts, etc.) a single source of
 * truth instead of inlining `navigator.platform` regexes at each site.
 *
 * Detection runs against `navigator.platform` because Tauri exposes the OS
 * via `@tauri-apps/plugin-os` only behind an async call, which is overkill
 * for a synchronous string-rendering decision. The webview's `platform`
 * field is set by the host shell and stable across the session.
 */

/** True if the user is on macOS (or iPad / iPhone, treated the same way). */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

/**
 * Platform-correct primary modifier label for keyboard shortcut hints.
 *
 * Returns `⌘` on macOS, `Ctrl` elsewhere. Pair with explicit `+` / space
 * separators at the call site so the i18n string controls spelling
 * conventions (`⌘ + O` vs `⌘+O` vs `⌘O`) — the helper just supplies the
 * prefix.
 */
export function modifierKey(): string {
  return isMac() ? "⌘" : "Ctrl";
}
