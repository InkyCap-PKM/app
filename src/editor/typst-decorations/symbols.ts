// Curated subset of Typst's `sym` module — the symbols common enough to be
// worth a quick-pick in the `/` menu and a glyph preview on the visual-editor
// `#sym.*` pill.
//
// This is deliberately NOT a mirror of Typst's full symbol table (hundreds of
// entries). Reproducing that table in TypeScript would duplicate what Typst
// owns and drift as Typst evolves — exactly what CLAUDE.md's Typst-first
// principle warns against. The `#sym.*` pill falls back to showing the raw
// name for any symbol outside this set, and the pill's name input accepts any
// symbol, so coverage here only governs which ones get a glyph preview and a
// menu shortcut. Names + glyphs verified against the `codex` crate
// (codex/src/modules/sym.txt), the authoritative table Typst compiles from.

export interface CuratedSymbol {
  /** Dotted path after `#sym.` — e.g. "arrow.r", "trademark.registered". */
  name: string;
  /** The character the symbol produces (for previews). */
  char: string;
  /** Human-readable menu label. */
  label: string;
}

export const CURATED_SYMBOLS: CuratedSymbol[] = [
  // Legal / marks
  { name: "copyright", char: "©", label: "Copyright" },
  { name: "trademark", char: "™", label: "Trademark" },
  { name: "trademark.registered", char: "®", label: "Registered trademark" },
  { name: "trademark.service", char: "℠", label: "Service mark" },

  // Creative Commons
  { name: "cc", char: "🅭", label: "Creative Commons" },
  { name: "cc.by", char: "🅯", label: "CC Attribution (BY)" },
  { name: "cc.nc", char: "🄏", label: "CC NonCommercial (NC)" },
  { name: "cc.nd", char: "⊜", label: "CC NoDerivatives (ND)" },
  { name: "cc.public", char: "🅮", label: "CC Public Domain" },
  { name: "cc.sa", char: "🄎", label: "CC ShareAlike (SA)" },
  { name: "cc.zero", char: "🄍", label: "CC Zero (CC0)" },

  // Arrows
  { name: "arrow.r", char: "→", label: "Right arrow" },
  { name: "arrow.l", char: "←", label: "Left arrow" },
  { name: "arrow.l.r", char: "↔", label: "Left-right arrow" },

  // Punctuation
  { name: "section", char: "§", label: "Section sign" },
  { name: "pilcrow", char: "¶", label: "Pilcrow" },
  { name: "dagger", char: "†", label: "Dagger" },
  { name: "dagger.double", char: "‡", label: "Double dagger" },
  { name: "dagger.triple", char: "⹋", label: "Triple dagger" },
  { name: "floral", char: "❦", label: "Floral heart" },

  // Math / Greek
  { name: "infinity", char: "∞", label: "Infinity" },
  { name: "nothing", char: "∅", label: "Nothing" },
  { name: "therefore", char: "∴", label: "Therefore" },
  { name: "mu", char: "μ", label: "Mu (μ)" },
  { name: "phi", char: "φ", label: "Phi (φ)" },

  // Misc
  { name: "note.up", char: "🎜", label: "Note (up)" },
  { name: "note.down", char: "🎝", label: "Note (down)" },
];

const GLYPH_BY_NAME = new Map(CURATED_SYMBOLS.map((s) => [s.name, s.char]));

/** The glyph for a curated `sym` path (e.g. "arrow.r"), or null when the symbol
 *  isn't in the curated set — callers fall back to showing the raw name. */
export function symbolGlyph(name: string): string | null {
  return GLYPH_BY_NAME.get(name) ?? null;
}
