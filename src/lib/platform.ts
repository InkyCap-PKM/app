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

/** True if the user is on Windows. */
export function isWindows(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Win/.test(navigator.platform);
}

/**
 * True if the user is on Linux — i.e. the Tauri webview is WebKitGTK.
 *
 * Defined as "neither macOS nor Windows" so any other Unix the WebKitGTK
 * webview runs on (BSD, etc.) is treated the same way. Used to opt into
 * behaviour WebKitGTK lacks that WKWebView (macOS) and WebView2 (Windows)
 * provide natively — currently drag auto-scroll of the file tree.
 */
export function isLinux(): boolean {
  if (typeof navigator === "undefined") return false;
  return !isMac() && !isWindows();
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
