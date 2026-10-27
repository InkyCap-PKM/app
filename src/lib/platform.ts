/**
 * Platform detection for UI text (shortcut hints, modifier-aware click
 * prompts), so `navigator.platform` checks aren't repeated everywhere.
 *
 * Uses `navigator.platform` because Tauri's `@tauri-apps/plugin-os` is async,
 * and these are synchronous rendering decisions. The value doesn't change
 * during a session.
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
 * True on Linux, where the webview is WebKitGTK. Defined as "neither macOS nor
 * Windows", so other Unix systems count too. Used for behaviour WebKitGTK lacks
 * but WKWebView and WebView2 have, currently file tree auto-scroll while
 * dragging.
 */
export function isLinux(): boolean {
  if (typeof navigator === "undefined") return false;
  return !isMac() && !isWindows();
}

/**
 * The primary modifier for shortcut hints: `⌘` on macOS, `Ctrl` elsewhere.
 * Separators come from the i18n string (`⌘ + O`, `⌘+O` or `⌘O`); this gives
 * only the key name.
 */
export function modifierKey(): string {
  return isMac() ? "⌘" : "Ctrl";
}
