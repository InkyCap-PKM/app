// UI scale system — scales all type-scale and icon-size tokens
// proportionally based on the editor.font_size setting.
//
// The CSS tokens in themes.css define the baseline at font_size=15.
// This module recalculates them when font_size changes so that
// Ctrl+/Ctrl- scales the entire interface uniformly.

const BASE_FONT_SIZE = 15;

const TOKEN_BASES: Record<string, number> = {
  "--text-2xs": 10,
  "--text-xs": 11,
  "--text-sm": 12,
  "--text-base": 13,
  "--text-md": 14,
  "--text-lg": 15,
  "--text-xl": 17,
  "--text-2xl": 19,
  "--text-3xl": 25,
  "--icon-sm": 18,
  "--icon-md": 20,
  "--icon-lg": 24,
};

export function applyUiScale(fontSize: number) {
  const scale = fontSize / BASE_FONT_SIZE;
  const root = document.documentElement;
  root.style.setProperty("--ui-scale", String(scale));
  for (const [token, base] of Object.entries(TOKEN_BASES)) {
    root.style.setProperty(token, `${Math.round(base * scale)}px`);
  }
}
