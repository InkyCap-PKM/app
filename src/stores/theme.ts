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
// Tauri's window theme-change event, alongside the `prefers-color-scheme`
// query. Both call the idempotent `applyTheme(resolveTheme("system"))`. On
// Linux the event never arrives (tao sends it with a window id Tauri doesn't
// match), so the query does the work; WebKitGTK updates it when the desktop
// changes and when `applyNativeWindowTheme` sets the window theme.
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

/** Apply the resolved theme to the DOM and to the native window frame. */
function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.setAttribute("data-theme", resolved);
  setResolvedTheme(resolved);
  // Re-apply the palette: the active value depends on which theme is
  // currently resolved, so flipping light↔dark may swap the palette too.
  applyPalette();
  applyNativeWindowTheme(resolved);
}

/**
 * Keep what the OS draws (Linux header bar, Windows title bar, macOS
 * appearance) on the same side as the app's theme, so a dark app on a light
 * desktop doesn't get a light title bar. Pass the resolved theme, not `null`
 * for "system": on Linux `null` means light until the next OS change.
 */
function applyNativeWindowTheme(resolved: ResolvedTheme) {
  getCurrentWindow()
    .setTheme(resolved)
    .catch((err) => {
      console.error("Failed to apply theme to the native window:", err);
    });
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

/** Switch the meaning-carrying colours to the colourblind-friendly set, or
 *  back. The set itself lives in themes.css under `data-colourblind`. */
function applyColourblindFriendly() {
  document.documentElement.toggleAttribute(
    "data-colourblind",
    settings.appearance.colourblind_friendly,
  );
}

/**
 * Apply the accent per `accent_source`:
 *   - "default": clear the inline `--accent-color`, so the fallback in
 *     themes.css applies.
 *   - "custom": set `--accent-color` to the chosen colour.
 *   - "os": ask the OS through IPC; on `null` (unsupported desktop) fall back
 *     to default and show a toast once.
 * The OS query is async and not awaited; the inline value is cleared first so
 * an old custom colour doesn't show meanwhile.
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

// InkyCap's bundled fonts (styles/bundled-fonts.css) as fallbacks before the
// generic keyword, in case the system reports a font that isn't installed.
const SANS_FALLBACK = '"Inter", system-ui, sans-serif';
const MONO_FALLBACK = '"JuliaMono", ui-monospace, monospace';

function quoteIfNeeded(family: string): string {
  const f = family.trim();
  if (!f) return f;
  if (/^["'].*["']$/.test(f)) return f;
  // Quote anything containing whitespace or commas; leaves bare
  // single-token names like `monospace` alone.
  return /[\s,]/.test(f) ? `"${f}"` : f;
}

/** Apply interface font as a CSS custom property. */
export function applyInterfaceFont(font: string) {
  document.documentElement.style.setProperty(
    "--interface-font",
    `${quoteIfNeeded(font)}, ${SANS_FALLBACK}`,
  );
}

/** Apply monospace font as a CSS custom property. */
export function applyMonospaceFont(font: string) {
  document.documentElement.style.setProperty(
    "--editor-font-mono",
    `${quoteIfNeeded(font)}, ${MONO_FALLBACK}`,
  );
}

/** Apply editor (body) font as a CSS custom property. */
export function applyEditorFont(font: string) {
  document.documentElement.style.setProperty("--md-body-font", font);
}

/**
 * Resolve the four CSS font roles from `FontSettings` (with cached OS defaults)
 * and set the root variables.
 */
export async function applyFontSettings(fonts: import("../lib/types").FontSettings) {
  const { resolveRole, getSystemFontDefaults } = await import("../lib/fontResolver");
  const sys = await getSystemFontDefaults();
  const ui = resolveRole("interface", fonts, sys) ?? sys.sans;
  const editor = resolveRole("editor", fonts, sys) ?? ui;
  const mono = resolveRole("monospace", fonts, sys) ?? sys.mono;
  // Verse: visual editor reads --verse-font; null = inherit body font,
  // so clear the variable in that case.
  const verse = resolveRole("verse", fonts, sys);
  applyInterfaceFont(ui);
  applyEditorFont(editor);
  applyMonospaceFont(mono);
  if (verse) {
    document.documentElement.style.setProperty("--verse-font", verse);
  } else {
    document.documentElement.style.removeProperty("--verse-font");
  }
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

    // Native window theme events. Not delivered on Linux; see
    // `tauriThemeUnlisten` above.
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
  applyColourblindFriendly();
  applyAccent();
  applyFontSettings(settings.fonts);
}

/**
 * Toggle dark and light. When the setting is "system", the change is for this
 * session only, so the next launch follows the OS again; with "light" or "dark"
 * set, the new value is saved.
 */
export function toggleTheme() {
  const current = resolvedTheme();
  const next: ResolvedTheme = current === "dark" ? "light" : "dark";
  if (settings.appearance.theme === "system") {
    // Session-only: apply the change and stop following the OS, without saving;
    // `initTheme()` resumes following it next launch.
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
 * Set and save a custom accent colour. Choosing a colour also switches the
 * source to "custom", so it takes effect.
 */
export function setAccentColor(color: string) {
  updateSetting("appearance", "accent_color", color);
  if (settings.appearance.accent_source !== "custom") {
    updateSetting("appearance", "accent_source", "custom");
  }
  applyAccent();
}

/**
 * Switch the accent source. "default" also clears any custom colour, letting
 * the CSS fallback apply.
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

/** Turn the colourblind-friendly colours on or off and persist the choice. */
export function setColourblindFriendly(enabled: boolean) {
  updateSetting("appearance", "colourblind_friendly", enabled);
  applyColourblindFriendly();
}

/** Get the current resolved theme (always "dark" or "light"). */
export { resolvedTheme as theme };
