/**
 * Standard Lucide-style `<svg>` attributes shared by InkyCap's hand-authored
 * icon components, so a custom glyph renders identically alongside the
 * `lucide-solid` icons used across the app: 24×24 viewBox, 2px round
 * `currentColor` stroke, no fill. Spread onto an `<svg>` element:
 *
 *   <svg {...lucideFrame(size)}>…</svg>
 */
export const lucideFrame = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 2,
  "stroke-linecap": "round" as const,
  "stroke-linejoin": "round" as const,
});
