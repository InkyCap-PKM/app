/**
 * LengthInput — a number field paired with a unit dropdown, for entering
 * Typst lengths (font size, line spacing, indents, …) without making the user
 * remember to type the unit.
 *
 * The control owns no canonical state of its own: it parses the incoming
 * string value into a number + unit for display, and emits a recombined
 * `"<number><unit>"` string on every edit. An empty number emits `""`, which
 * the style editor treats as "inherit" (the override is removed). The chosen
 * unit is remembered locally so clearing the number doesn't lose it.
 */

import { Component, createSignal, createEffect } from "solid-js";
import { Dropdown } from "./Dropdown";

const DEFAULT_UNITS = ["pt", "em", "cm", "mm", "in"] as const;

/** A bare number optionally followed by a unit (pt, em, cm, …). */
const LENGTH_RE = /^\s*(-?\d*\.?\d+)\s*([a-z%]+)?\s*$/i;

function parseLength(value: string, fallbackUnit: string): { num: string; unit: string } {
  const m = value.match(LENGTH_RE);
  if (m) return { num: m[1], unit: m[2] ?? fallbackUnit };
  return { num: "", unit: fallbackUnit };
}

export const LengthInput: Component<{
  value: string;
  onChange: (value: string) => void;
  /** Selectable units; the first is the default when the value carries none. */
  units?: readonly string[];
  /** Placeholder for the number field (e.g. "Inherit"). */
  placeholder?: string;
}> = (props) => {
  const units = () => props.units ?? DEFAULT_UNITS;
  const defaultUnit = () => units()[0];

  // Unit is held locally so an empty number still remembers the user's choice;
  // it re-syncs whenever an external value arrives carrying its own unit.
  const [unit, setUnit] = createSignal(parseLength(props.value, defaultUnit()).unit);
  createEffect(() => {
    if (props.value) setUnit(parseLength(props.value, defaultUnit()).unit);
  });

  const num = () => parseLength(props.value, defaultUnit()).num;

  const emit = (rawNum: string, u: string) => {
    const trimmed = rawNum.trim();
    props.onChange(trimmed === "" ? "" : `${trimmed}${u}`);
  };

  return (
    <div class="length-input">
      <input
        type="number"
        step="any"
        class="settings__number-input length-input__num"
        value={num()}
        placeholder={props.placeholder}
        onInput={(e) => emit(e.currentTarget.value, unit())}
      />
      <Dropdown<string>
        class="dropdown--sm"
        value={unit()}
        options={units().map((u) => ({ value: u, label: u }))}
        onChange={(u) => {
          setUnit(u);
          emit(num(), u);
        }}
        ariaLabel="Unit"
      />
    </div>
  );
};
