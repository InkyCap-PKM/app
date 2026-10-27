// A selection of Typst's `sym` symbols common enough for the `/` menu and a
// glyph preview on the `#sym.*` pill.
//
// Not a copy of Typst's full table (hundreds of symbols), which would duplicate
// what Typst owns. The pill shows the raw name for other symbols and its name
// field accepts any, so this only decides which get a preview and a menu entry.
// Names and glyphs checked against the `codex` crate
// (codex/src/modules/sym.txt), which Typst compiles from.

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
