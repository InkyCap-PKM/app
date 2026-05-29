/**
 * Typst colour parsing and highlight-mark construction.
 *
 * Extracted from visual-plugin.ts so that colour logic can be reused
 * without pulling in the full decoration plugin.
 */

import { Decoration } from "@codemirror/view";

// ---------------------------------------------------------------------------
// Colour names → hex (matches Typst's built-in named colours)
// ---------------------------------------------------------------------------

const TYPST_COLORS: Record<string, string> = {
  black: "#000", gray: "#808080", silver: "#c0c0c0", white: "#fff",
  navy: "#001f3f", blue: "#2196f3", aqua: "#00bcd4", teal: "#009688",
  eastern: "#239dad", purple: "#9c27b0", fuchsia: "#e91e63",
  maroon: "#800000", red: "#f44336", orange: "#ff9800", yellow: "#ffeb3b",
  olive: "#808000", green: "#4caf50", lime: "#8fce00",
};

// ---------------------------------------------------------------------------
// parseTypstColor – resolve a Typst colour expression to a CSS colour string
// ---------------------------------------------------------------------------

/** Parse a Typst colour literal (named, `rgb(…)`, `luma(…)`) into a CSS
 *  colour string, or `null` if the value is unrecognised. */
export function parseTypstColor(raw: string): string | null {
  const trimmed = raw.trim();
  if (TYPST_COLORS[trimmed]) return TYPST_COLORS[trimmed];

  const hexMatch = trimmed.match(/^rgb\(\s*"(#[0-9a-fA-F]{3,8})"\s*\)$/);
  if (hexMatch) return hexMatch[1];

  const rgbMatch = trimmed.match(
    /^rgb\(\s*(\d+(?:\.\d+)?%?)\s*,\s*(\d+(?:\.\d+)?%?)\s*,\s*(\d+(?:\.\d+)?%?)\s*(?:,\s*(\d+(?:\.\d+)?%?)\s*)?\)$/,
  );
  if (rgbMatch) {
    const conv = (v: string) => v.endsWith("%") ? Math.round(parseFloat(v) * 2.55) : parseInt(v);
    const [, r, g, b, a] = rgbMatch;
    if (a != null) return `rgba(${conv(r)}, ${conv(g)}, ${conv(b)}, ${a.endsWith("%") ? parseFloat(a) / 100 : parseInt(a) / 255})`;
    return `rgb(${conv(r)}, ${conv(g)}, ${conv(b)})`;
  }

  const lumaMatch = trimmed.match(/^luma\(\s*(\d+)\s*\)$/);
  if (lumaMatch) { const v = lumaMatch[1]; return `rgb(${v}, ${v}, ${v})`; }

  return null;
}

// ---------------------------------------------------------------------------
// Highlight parameter extraction and mark construction
// ---------------------------------------------------------------------------

/** Base highlight decoration – applies the `.cm-typst-highlight` CSS class. */
export const highlight = Decoration.mark({ class: "cm-typst-highlight" });

/**
 * The fixed highlighter palette (see `HIGHLIGHT_COLORS` in pill-options.ts)
 * maps each preset fill to a themed CSS variable. The Typst source keeps the
 * literal light-mode colour — that is what compiles to PDF/HTML on white
 * paper — but the *editor* renders the preset through a `--hl-*` variable so
 * the dark theme can substitute a less-glaring equivalent. The visual editor
 * is a WYSIWYM authoring aid, not a faithful renderer, so a theme-tuned
 * appearance here is by design. Custom (non-preset) fills are rendered with
 * their literal value, unchanged.
 */
const PRESET_HIGHLIGHT_VARS: Record<string, string> = {
  "#f2ed61": "--hl-yellow",
  "#c8f0c8": "--hl-green",
  "#c8dcff": "--hl-blue",
  "#ffd1e0": "--hl-pink",
  "#ffd6a8": "--hl-orange",
};

/** Resolve a parsed fill colour to a themed `var(--hl-*, <literal>)`
 *  expression when it matches a palette preset, else the literal value. */
function themedHighlightFill(fill: string): string {
  const v = PRESET_HIGHLIGHT_VARS[fill.toLowerCase()];
  return v ? `var(${v}, ${fill})` : fill;
}

/** Extract `fill`, `stroke`, and `radius` parameters from the argument text
 *  of a `#highlight(…)[…]` call. */
export function extractHighlightParams(text: string): { fill?: string; stroke?: string; radius?: string } {
  const params: { fill?: string; stroke?: string; radius?: string } = {};

  // The value pattern allows either bare tokens (`red`, `#fff`) or a single
  // function call (`rgb("#fff3a3")`, `luma(80)`). The earlier `[^,)\]]+`
  // form stopped at the first `)`, so it captured `rgb("#fff3a3"` and
  // parseTypstColor's rgb regex (which requires a trailing `)`) failed
  // silently — every non-default colour fell through to the unparameterized
  // yellow mark. The paren-group alternative must come FIRST so the engine
  // tries it before the single-char one — otherwise the simple alternative
  // greedily eats the opening `(` (it's not in the exclusion set) and the
  // compound alternative never gets a chance to fire.
  const VALUE = /((?:\([^)]*\)|[^,)\]])+)/;

  const fillMatch = text.match(new RegExp(`fill\\s*:\\s*${VALUE.source}`));
  if (fillMatch) {
    const color = parseTypstColor(fillMatch[1]);
    if (color) params.fill = color;
  }

  const strokeMatch = text.match(new RegExp(`stroke\\s*:\\s*${VALUE.source}`));
  if (strokeMatch) {
    const color = parseTypstColor(strokeMatch[1]);
    if (color) params.stroke = color;
  }

  const radiusMatch = text.match(/radius\s*:\s*(\d+(?:\.\d+)?)(pt|em|%)/);
  if (radiusMatch) {
    const val = radiusMatch[1];
    const unit = radiusMatch[2] === "pt" ? "px" : radiusMatch[2];
    params.radius = `${val}${unit}`;
  }

  return params;
}

/** Build a `Decoration.mark` for a `#highlight(…)` call, applying inline
 *  styles for any custom fill/stroke/radius parameters. Falls back to the
 *  base `highlight` class mark when no parameters are present. */
export function buildHighlightMark(text: string): Decoration {
  const params = extractHighlightParams(text);
  if (!params.fill && !params.stroke && !params.radius) return highlight;

  const parts: string[] = [];
  // No explicit fill (e.g. only a radius/stroke set) means the default
  // yellow, same as the bare `.cm-typst-highlight` class.
  parts.push(`background-color: ${params.fill ? themedHighlightFill(params.fill) : "var(--hl-yellow)"}`);
  if (params.stroke) parts.push(`outline: 1px solid ${params.stroke}`);
  parts.push(`border-radius: ${params.radius ?? "2px"}`);
  parts.push("padding: 0 2px");
  // Pin dark text for readability on the light pastel fills (see
  // .cm-typst-highlight in the theme above). Custom user fills could
  // theoretically be dark, in which case this reads against the user;
  // the highlight palette itself is fixed-light so the trade-off is
  // worth making for the dark-mode common case.
  parts.push("color: #1a1a1a");

  return Decoration.mark({ attributes: { style: parts.join("; ") } });
}
