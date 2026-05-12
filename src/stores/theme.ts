// Theme store — manages dark/light/system theme switching.
// Reads initial preference from settings, applies via data-theme attribute.

import { createSignal } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { settings, updateSetting } from "./settings";
import { showToast } from "./toasts";
import * as ipc from "../lib/ipc";
import type { AccentSource, BgPalette } from "../lib/types";

export type ThemePreference = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const [resolvedTheme, setResolvedTheme] = createSignal<ResolvedTheme>("light");

let mediaQuery: MediaQueryList | null = null;
let mediaHandler: ((e: MediaQueryListEvent) => void) | null = null;
// Tauri's native window theme-change subscription. On Linux/WebKitGTK the
// browser-side `prefers-color-scheme` event doesn't always fire when the OS
// flips, so we listen on both channels and let whichever fires first win.
// Both call `applyTheme(resolveTheme("system"))`, which is idempotent.
let tauriThemeUnlisten: (() => void) | null = null;

/** Resolve "system" to the actual dark/light value. */
function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return pref;
}

/** Apply the resolved theme to the DOM. */
function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.setAttribute("data-theme", resolved);
  setResolvedTheme(resolved);
  // Re-apply the palette: the active value depends on which theme is
  // currently resolved, so flipping light↔dark may swap the palette too.
  applyPalette();
}

/** Apply the background palette appropriate to the currently resolved theme. */
function applyPalette() {
  const palette = resolvedTheme() === "dark"
    ? settings.appearance.bg_palette_dark
    : settings.appearance.bg_palette_light;
  if (palette === "default") {
    document.documentElement.removeAttribute("data-palette");
  } else {
    document.documentElement.setAttribute("data-palette", palette);
  }
}

/**
 * Apply the accent color according to the current `accent_source`:
 * - "default" — clear the inline `--accent-color` so the CSS fallback in
 *   themes.css (`var(--accent-color, #1D7874)`) takes effect.
 * - "custom"  — set inline `--accent-color` to the user-chosen hex.
 * - "os"      — query the OS accent via IPC; on `null` (unsupported DE)
 *   silently fall back to default and toast once.
 *
 * The "os" path is async; the call is fire-and-forget to keep the call
 * sites synchronous. We start by clearing the inline value so the user
 * never sees a stale custom color while the IPC roundtrip is in flight.
 */
function applyAccent() {
  const source = settings.appearance.accent_source;
  const root = document.documentElement;
  if (source === "custom") {
    root.style.setProperty("--accent-color", settings.appearance.accent_color);
    return;
  }
  // "default" or "os" — start from the CSS fallback.
  root.style.removeProperty("--accent-color");
  if (source === "os") {
    ipc
      .getOsAccentColor()
      .then((hex) => {
        // Re-check the source: the user may have switched away while the
        // call was in flight. If so, leave the DOM as the new source set it.
        if (settings.appearance.accent_source !== "os") return;
        if (hex) {
          root.style.setProperty("--accent-color", hex);
        } else {
          showToast(
            "info",
            "OS accent color isn't available on this desktop — using InkyCap's default.",
          );
        }
      })
      .catch((err) => {
        console.error("Failed to query OS accent color:", err);
      });
  }
}

/** Apply interface font as a CSS custom property. */
export function applyInterfaceFont(font: string) {
  document.documentElement.style.setProperty("--interface-font", font);
}

/** Apply monospace font as a CSS custom property. */
export function applyMonospaceFont(font: string) {
  document.documentElement.style.setProperty("--editor-font-mono", font);
}

/** Set up or tear down the system theme listeners. */
function setupSystemListener(pref: ThemePreference) {
  // Remove old listeners
  if (mediaQuery && mediaHandler) {
    mediaQuery.removeEventListener("change", mediaHandler);
    mediaHandler = null;
    mediaQuery = null;
  }
  if (tauriThemeUnlisten) {
    tauriThemeUnlisten();
    tauriThemeUnlisten = null;
  }

  // Add listeners if using system theme
  if (pref === "system") {
    mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaHandler = () => {
      applyTheme(resolveTheme("system"));
    };
    mediaQuery.addEventListener("change", mediaHandler);

    // Tauri-native fallback for platforms (notably Linux/WebKitGTK) where
    // `prefers-color-scheme` doesn't reliably fire on OS theme flips.
    getCurrentWindow()
      .onThemeChanged(() => {
        applyTheme(resolveTheme("system"));
      })
      .then((unlisten) => {
        // Guard against race: pref may have flipped away from "system" while
        // the promise was in flight. If so, drop the listener immediately.
        if (settings.appearance.theme !== "system") {
          unlisten();
          return;
        }
        tauriThemeUnlisten = unlisten;
      })
      .catch((err) => {
        console.error("Failed to subscribe to Tauri theme changes:", err);
      });
  }
}

/** Initialize theme on app startup — call once in App.tsx after settings load. */
export function initTheme() {
  const pref = settings.appearance.theme;
  setupSystemListener(pref);
  applyTheme(resolveTheme(pref));
  applyAccent();
  applyInterfaceFont(settings.appearance.interface_font);
  applyMonospaceFont(settings.appearance.monospace_font);
}

/**
 * Toggle between dark and light for this session only. When the persisted
 * preference is "system", the flip is visual-only — it doesn't overwrite
 * the stored setting, so on next launch the app resumes following the OS.
 * When the preference is already explicit ("light" or "dark"), the toggle
 * persists as before since the user has already opted out of auto-follow.
 */
export function toggleTheme() {
  const current = resolvedTheme();
  const next: ResolvedTheme = current === "dark" ? "light" : "dark";
  if (settings.appearance.theme === "system") {
    // Session-only flip: apply the visual change and tear down the system
    // listeners so the OS doesn't immediately flip it back, but don't
    // persist to settings. `initTheme()` on next launch will re-read the
    // stored "system" preference and resume auto-following.
    if (mediaQuery && mediaHandler) {
      mediaQuery.removeEventListener("change", mediaHandler);
      mediaHandler = null;
      mediaQuery = null;
    }
    if (tauriThemeUnlisten) {
      tauriThemeUnlisten();
      tauriThemeUnlisten = null;
    }
    applyTheme(next);
  } else {
    setThemePreference(next);
  }
}

/** Set a specific theme preference and persist to settings. */
export function setThemePreference(pref: ThemePreference) {
  updateSetting("appearance", "theme", pref);
  setupSystemListener(pref);
  applyTheme(resolveTheme(pref));
}

/**
 * Set a custom accent color and persist it. Selecting a color implies the
 * "custom" source — the segmented control and this setter stay in sync so
 * picking a color from the wheel doesn't silently fail to take effect when
 * the source happens to be "default" or "os".
 */
export function setAccentColor(color: string) {
  updateSetting("appearance", "accent_color", color);
  if (settings.appearance.accent_source !== "custom") {
    updateSetting("appearance", "accent_source", "custom");
  }
  applyAccent();
}

/**
 * Switch the accent source. "default" is also the reset — it clears any
 * inline custom color and lets the CSS fallback paint InkyCap's built-in
 * accent. "os" is accepted but, until PR 3 wires the OS-accent IPC call,
 * behaves like "default".
 */
export function setAccentSource(source: AccentSource) {
  updateSetting("appearance", "accent_source", source);
  applyAccent();
  if (source === "os") {
    showToast(
      "info",
      "If you change your OS accent color later, restart InkyCap to pick up the new color.",
    );
  }
}

/** Set the light-theme background palette and persist to settings. */
export function setBgPaletteLight(palette: BgPalette) {
  updateSetting("appearance", "bg_palette_light", palette);
  applyPalette();
}

/** Set the dark-theme background palette and persist to settings. */
export function setBgPaletteDark(palette: BgPalette) {
  updateSetting("appearance", "bg_palette_dark", palette);
  applyPalette();
}

/** Get the current resolved theme (always "dark" or "light"). */
export { resolvedTheme as theme };
