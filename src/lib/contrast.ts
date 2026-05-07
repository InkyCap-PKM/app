// WCAG 2.1 contrast helpers. Used by the accent color picker to warn the
// user when their pick fails AA contrast against InkyCap's light or dark
// background. Math follows the W3C "relative luminance" definition.
//
// Reference: https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Parse a `#rgb` or `#rrggbb` hex string. Returns null on malformed input. */
export function parseHex(hex: string): RGB | null {
  const m = hex.trim().toLowerCase().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** WCAG relative luminance for an sRGB color in 0..255. */
export function relativeLuminance({ r, g, b }: RGB): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two sRGB colors. Range 1..21. */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Whether `fg` against `bg` clears WCAG AA for normal-size body text (4.5).
 * Inputs are hex strings; malformed inputs return `false` (treated as failing
 * so the warning is shown — better to over-warn than miss a real fail).
 */
export function passesAA(fg: string, bg: string): boolean {
  const f = parseHex(fg);
  const b = parseHex(bg);
  if (!f || !b) return false;
  return contrastRatio(f, b) >= 4.5;
}

/**
 * Whether two colors clear WCAG SC 1.4.11 "Non-text contrast" (3.0). This is
 * the right bar for UI accent surfaces — buttons, focus rings, badges — where
 * text contrast (4.5) doesn't apply. The accent picker uses this threshold:
 * holding accents to 4.5 against both InkyCap's near-white and near-black
 * backgrounds is mathematically infeasible for any saturated color.
 */
export function passesNonTextContrast(fg: string, bg: string): boolean {
  const f = parseHex(fg);
  const b = parseHex(bg);
  if (!f || !b) return false;
  return contrastRatio(f, b) >= 3.0;
}
