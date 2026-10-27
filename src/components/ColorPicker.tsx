// Accent colour picker for Appearance settings: the native `<input
// type="color">` and a hex field, with a WCAG warning when the colour fails
// non-text contrast against either InkyCap background.

import { Show } from "solid-js";
import { passesNonTextContrast } from "../lib/contrast";
import { useI18n } from "../lib/i18n";

// Backgrounds the accent appears on. Must match `--bg-primary` for the light
// and dark default palettes in themes.css.
const LIGHT_BG = "#fafafa";
const DARK_BG = "#071e22";

export function ColorPicker(props: {
  value: string;
  onChange: (hex: string) => void;
}) {
  const t = useI18n();
  const failsLight = () => !passesNonTextContrast(props.value, LIGHT_BG);
  const failsDark = () => !passesNonTextContrast(props.value, DARK_BG);
  const showWarning = () => failsLight() || failsDark();
  const warningText = () => {
    if (failsLight() && failsDark()) {
      return t("colorPicker.warnBoth");
    }
    if (failsLight()) return t("colorPicker.warnLight");
    return t("colorPicker.warnDark");
  };

  return (
    <div class="color-picker">
      <div class="color-picker__custom">
        <input
          type="color"
          class="color-picker__wheel"
          value={props.value}
          onInput={(e) => props.onChange(e.currentTarget.value)}
          aria-label={t("colorPicker.ariaWheel")}
        />
        <input
          type="text"
          class="color-picker__hex"
          value={props.value}
          onChange={(e) => {
            const v = e.currentTarget.value.trim();
            if (/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v)) {
              props.onChange(v.startsWith("#") ? v : `#${v}`);
            } else {
              e.currentTarget.value = props.value;
            }
          }}
          spellcheck={false}
        />
      </div>
      <Show when={showWarning()}>
        <div class="color-picker__warning" role="alert">
          {warningText()}
        </div>
      </Show>
    </div>
  );
}
