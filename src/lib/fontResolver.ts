// Frontend mirror of `src-tauri/src/font_resolver.rs`.
// Resolves a `FontChoice` to a concrete family name for CSS use.

import type { FontChoice, FontSettings, SystemFontDefaults } from "./types";
import { systemFontDefaults } from "./ipc";

// Must match `font_resolver::BUNDLED_*` constants in Rust.
export const BUNDLED_INTERFACE = "Inter";
export const BUNDLED_TEXT = "Junicode";

export type FontRole = "interface" | "editor" | "monospace" | "text" | "verse";

let cachedDefaults: SystemFontDefaults | null = null;

/** Fetch OS defaults from the backend once and cache. */
export async function getSystemFontDefaults(): Promise<SystemFontDefaults> {
  if (cachedDefaults) return cachedDefaults;
  try {
    cachedDefaults = await systemFontDefaults();
  } catch {
    cachedDefaults = { sans: "system-ui", serif: "serif", mono: "monospace" };
  }
  return cachedDefaults;
}

function bundledFor(role: FontRole, sys: SystemFontDefaults): string {
  if (role === "interface" || role === "editor") return BUNDLED_INTERFACE;
  // No bundled mono — defensive fallback to system for any migrated
  // settings that carry mode === "bundled" for the monospace row.
  if (role === "monospace") return sys.mono;
  return BUNDLED_TEXT;
}

function systemFor(role: FontRole, sys: SystemFontDefaults): string {
  if (role === "interface" || role === "editor") return sys.sans;
  if (role === "monospace") return sys.mono;
  return sys.serif;
}

function choiceFor(role: FontRole, fonts: FontSettings): FontChoice {
  switch (role) {
    case "interface": return fonts.interface;
    case "editor": return fonts.editor;
    case "monospace": return fonts.monospace;
    case "text": return fonts.text;
    case "verse": return fonts.verse;
  }
}

/**
 * Synchronous text-font resolution for callers that don't need OS
 * defaults (the Text row never offers "system"). Returns the family
 * name to use, or `undefined` for "typst-default" so callers can omit
 * the override entirely.
 */
export function resolveTextFontSync(fonts: FontSettings): string | undefined {
  const choice = fonts.text;
  switch (choice.mode) {
    case "bundled": return BUNDLED_TEXT;
    case "typst-default": return undefined;
    case "custom": {
      const t = choice.custom.trim();
      return t.length > 0 ? t : undefined;
    }
    // Defensive — "system"/"follow" aren't offered for text but if a
    // settings file carries one we treat it as "let CSS fall back".
    default: return undefined;
  }
}

/**
 * Resolve one role to a concrete family name. Returns `null` only for
 * text role with mode "typst-default" (caller should treat that as "use
 * Typst's built-in" — typically just omit the CSS variable).
 */
export function resolveRole(
  role: FontRole,
  fonts: FontSettings,
  sys: SystemFontDefaults,
): string | null {
  const choice = choiceFor(role, fonts);
  switch (choice.mode) {
    case "system": return systemFor(role, sys);
    case "bundled": return bundledFor(role, sys);
    case "typst-default": return null;
    case "follow":
      if (role === "editor") return resolveRole("interface", fonts, sys);
      if (role === "verse") return resolveRole("text", fonts, sys);
      return systemFor(role, sys);
    case "custom": {
      const trimmed = choice.custom.trim();
      return trimmed.length > 0 ? trimmed : systemFor(role, sys);
    }
    default:
      return systemFor(role, sys);
  }
}
