/**
 * Typst colour parsing and highlight marks, separate from visual-plugin.ts so
 * they can be used without the whole plugin.
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
 * Preset highlight fills (see `HIGHLIGHT_COLORS` in pill-options.ts) mapped to
 * themed `--hl-*` variables. The source keeps the light colour, which is what
 * prints, while the editor uses the variable so dark mode can show a softer
 * one. Custom fills use their literal value.
 */
const PRESET_HIGHLIGHT_VARS: Record<string, string> = {
  "#ff9f97": "--hl-red",
  "#ffd6a8": "--hl-orange",
  "#f2ed61": "--hl-yellow",
  "#c8f0c8": "--hl-green",
  "#b3dfff": "--hl-blue",
  "#e0c8f0": "--hl-violet",
  "#ffd1e0": "--hl-pink",
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

  // A value is a bare token (`red`, `#fff`) or one function call
  // (`rgb("#fff3a3")`, `luma(80)`). The parenthesized alternative comes first,
  // or the simple one would consume the `(`.
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

/**
 * Inline CSS for a `#highlight(…)` call's fill, stroke and radius; `text` is
 * the call or its argument list. Null without any, so the caller uses the plain
 * `.cm-typst-highlight` class. `pinTextColor` forces near-black text on the
 * light fills (see `.cm-typst-highlight` in visual-theme.ts); link-like
 * elements pass false to keep their colour.
 */
export function highlightInlineStyle(text: string, pinTextColor: boolean): string | null {
  const params = extractHighlightParams(text);
  if (!params.fill && !params.stroke && !params.radius) return null;

  const parts: string[] = [];
  // No explicit fill (e.g. only a radius/stroke set) means the default
  // yellow, same as the bare `.cm-typst-highlight` class.
  parts.push(`background-color: ${params.fill ? themedHighlightFill(params.fill) : "var(--hl-yellow)"}`);
  if (params.stroke) parts.push(`outline: 1px solid ${params.stroke}`);
  parts.push(`border-radius: ${params.radius ?? "2px"}`);
  parts.push("padding: 0 2px");
  if (pinTextColor) {
    // A custom fill could be dark, but the presets are all light, so this suits
    // the usual case.
    parts.push("color: #1a1a1a");
  }

  return parts.join("; ");
}

/**
 * A `Decoration.mark` for a `#highlight(…)` call with any custom fill, stroke
 * or radius, or the plain highlight mark without them.
 */
export function buildHighlightMark(text: string): Decoration {
  const style = highlightInlineStyle(text, true);
  return style ? Decoration.mark({ attributes: { style } }) : highlight;
}

/**
 * Highlight state passed to a replace widget (wikilink, link, …), which renders
 * outside the highlight's mark and must paint itself. `null`: not highlighted;
 * empty string: the default yellow (class only); otherwise the inline CSS from
 * `highlightInlineStyle`.
 */
export type WidgetHighlight = string | null;

/** Read the highlight state a widget inside this `#highlight(…)` call should
 *  carry. Never null — the call itself is the highlight. */
export function widgetHighlightFor(callText: string): WidgetHighlight {
  return highlightInlineStyle(callText, false) ?? "";
}

/**
 * Paint a widget as highlighted: the shared class (default colour,
 * `::selection` rules), then any custom styling. Nothing if not highlighted.
 */
export function applyWidgetHighlight(el: HTMLElement, highlight: WidgetHighlight): void {
  if (highlight === null) return;
  el.classList.add("cm-typst-highlight");
  if (highlight) el.style.cssText += `;${highlight}`;
}
