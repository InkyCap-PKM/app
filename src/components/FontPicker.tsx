import { createSignal, createResource, For, Show, onCleanup } from "solid-js";
import * as ipc from "../lib/ipc";

let fontCache: string[] | null = null;

async function fetchFonts(): Promise<string[]> {
  if (fontCache) return fontCache;
  fontCache = await ipc.listSystemFonts();
  return fontCache;
}

interface FontPickerProps {
  value: string;
  onChange: (font: string) => void;
  placeholder?: string;
}

export function FontPicker(props: FontPickerProps) {
  const [fonts] = createResource(fetchFonts);
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  // When the input doesn't have enough space below to show the dropdown
  // (e.g. near the bottom of the settings panel), flip it above the input.
  const [dropUp, setDropUp] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;
  let inputRef: HTMLInputElement | undefined;

  // Match the CSS rule below: `max-height: 240px`. Keep these in sync.
  const DROPDOWN_MAX_HEIGHT = 240;
  const MARGIN = 8;

  function chooseDirection() {
    if (!inputRef) return;
    const rect = inputRef.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - MARGIN;
    const spaceAbove = rect.top - MARGIN;
    // Prefer below; flip up only if below is genuinely short and above is
    // taller. This avoids flipping for menus that fit fine below.
    setDropUp(spaceBelow < DROPDOWN_MAX_HEIGHT && spaceAbove > spaceBelow);
  }

  const filtered = () => {
    const list = fonts() ?? [];
    const q = query().toLowerCase();
    if (!q) return list.slice(0, 100);
    return list.filter((f) => f.toLowerCase().includes(q)).slice(0, 100);
  };

  function handleInput(value: string) {
    setQuery(value);
    props.onChange(value);
    setSelectedIndex(0);
    if (!open()) openMenu();
  }

  function selectFont(name: string) {
    props.onChange(name);
    setQuery("");
    setOpen(false);
  }

  function openMenu() {
    chooseDirection();
    setOpen(true);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (!open()) {
      if (e.key === "ArrowDown") {
        openMenu();
        e.preventDefault();
      }
      return;
    }

    const items = filtered();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
      scrollSelectedIntoView();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
      scrollSelectedIntoView();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[selectedIndex()];
      if (item) selectFont(item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  function scrollSelectedIntoView() {
    requestAnimationFrame(() => {
      const el = containerRef?.querySelector(".is-selected");
      el?.scrollIntoView({ block: "nearest" });
    });
  }

  function handleClickOutside(e: MouseEvent) {
    if (containerRef && !containerRef.contains(e.target as Node)) {
      setOpen(false);
    }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("mousedown", handleClickOutside);
    onCleanup(() => document.removeEventListener("mousedown", handleClickOutside));
  }

  return (
    <div class="settings__font-picker" ref={containerRef}>
      <input
        ref={inputRef}
        type="text"
        class="settings__text-input"
        value={props.value}
        placeholder={props.placeholder ?? "Search fonts…"}
        onInput={(e) => handleInput(e.currentTarget.value)}
        onFocus={() => { setQuery(""); openMenu(); }}
        onKeyDown={handleKeyDown}
      />
      <Show when={open() && filtered().length > 0}>
        <div
          class="settings__font-dropdown"
          classList={{ "settings__font-dropdown--up": dropUp() }}
        >
          <For each={filtered()}>
            {(name, i) => (
              <button
                type="button"
                class="settings__font-option"
                classList={{ "is-selected": i() === selectedIndex() }}
                style={{ "font-family": `"${name}", sans-serif` }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectFont(name);
                }}
                onMouseEnter={() => setSelectedIndex(i())}
              >
                {name}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
