// One row of the font picker UI. Presents a dropdown of modes
// (System / InkyCap / Typst default / Follow / Custom — caller picks
// which apply) and reveals the FontPicker beneath when "Custom" is
// selected.

import { Component, Show } from "solid-js";
import type { FontChoice, FontMode } from "../lib/types";
import { FontPicker } from "./FontPicker";
import { Dropdown } from "./Dropdown";

export interface FontRoleOption {
  value: FontMode;
  label: string;
}

interface Props {
  label: string;
  description: string;
  options: FontRoleOption[];
  choice: FontChoice;
  onChange: (next: FontChoice) => void;
  /** Optional placeholder for the custom font picker. */
  customPlaceholder?: string;
}

export const FontRoleRow: Component<Props> = (props) => {
  const handleMode = (mode: FontMode) => {
    props.onChange({ mode, custom: props.choice.custom });
  };
  const handleCustom = (custom: string) => {
    props.onChange({ mode: "custom", custom });
  };

  return (
    <div class="settings__row settings__row--column">
      <div class="settings__row-info">
        <label class="settings__label">{props.label}</label>
        <span class="settings__description">{props.description}</span>
      </div>
      <Dropdown<FontMode>
        value={props.choice.mode}
        options={props.options}
        onChange={handleMode}
        ariaLabel={props.label}
      />
      <Show when={props.choice.mode === "custom"}>
        <FontPicker
          value={props.choice.custom}
          onChange={handleCustom}
          placeholder={props.customPlaceholder}
        />
      </Show>
    </div>
  );
};
