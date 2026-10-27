// UI scale: scales the type and icon size tokens with the editor.font_size
// setting. themes.css defines them at font_size 15; this recalculates them when
// it changes, so Ctrl+/Ctrl- scales the whole interface.

const BASE_FONT_SIZE = 15;

const TOKEN_BASES: Record<string, number> = {
  "--text-2xs": 10,
  "--text-xs": 11,
  "--text-sm": 12,
  "--text-base": 13,
  "--text-md": 14,
  "--text-lg": 15,
  "--text-xl": 18,
  "--text-2xl": 22,
  "--text-3xl": 28,
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
