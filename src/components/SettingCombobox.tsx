import { createSignal, For, Show } from "solid-js";

interface SettingComboboxProps {
  label: string;
  description: string;
  value: number;
  presets: number[];
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  placeholder?: string;
}

export function SettingCombobox(props: SettingComboboxProps) {
  const [open, setOpen] = createSignal(false);
  const [flipUp, setFlipUp] = createSignal(false);
  const step = () => props.step ?? 1;
  let comboRef: HTMLDivElement | undefined;

  function handleInput(raw: string) {
    const n = parseFloat(raw);
    if (!isNaN(n)) {
      props.onChange(Math.max(props.min, Math.min(props.max, n)));
    }
  }

  function selectPreset(v: number) {
    props.onChange(v);
    setOpen(false);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(props.max, props.value + step());
      props.onChange(next);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.max(props.min, props.value - step());
      props.onChange(next);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div class="settings__row">
      <div class="settings__row-info">
        <label class="settings__label">{props.label}</label>
        <span class="settings__description">{props.description}</span>
      </div>
      <div
        class="settings__combobox"
        ref={comboRef}
        onFocusOut={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setOpen(false);
          }
        }}
      >
        <input
          type="text"
          inputMode="decimal"
          class="settings__combobox-input"
          value={props.value}
          placeholder={props.placeholder}
          onInput={(e) => handleInput(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (comboRef) {
              const rect = comboRef.getBoundingClientRect();
              setFlipUp(window.innerHeight - rect.bottom < 200);
            }
            setOpen(true);
          }}
        />
        <button
          type="button"
          class="settings__combobox-toggle"
          tabIndex={-1}
          onClick={() => {
            if (!open() && comboRef) {
              const rect = comboRef.getBoundingClientRect();
              setFlipUp(window.innerHeight - rect.bottom < 200);
            }
            setOpen(!open());
          }}
          aria-label="Show presets"
        >
          <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
            <path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <Show when={open()}>
          <div class="settings__combobox-dropdown" classList={{ "is-flipped": flipUp() }}>
            <For each={props.presets}>
              {(preset) => (
                <button
                  type="button"
                  class="settings__combobox-option"
                  classList={{ "is-selected": preset === props.value }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectPreset(preset);
                  }}
                >
                  {preset}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
