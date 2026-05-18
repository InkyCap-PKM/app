/**
 * Dropdown — the app-wide replacement for the native HTML `<select>`.
 *
 * Native `<select>` popups are drawn by the OS (a native GTK widget under
 * WebKitGTK) and cannot be themed with CSS — they ignore the app's colours
 * entirely. This component renders the popup as ordinary HTML using the
 * shared `--popup-*` tokens, so every dropdown in InkyCap looks the same
 * and follows the active theme.
 *
 * The popup reuses the established `.context-menu` surface and is placed
 * with `anchorPanelMenu`, the same helper the sidebar sort menus use, so
 * it escapes parent `overflow: hidden` regions.
 */

import { createEffect, For, Show, createSignal, onCleanup } from "solid-js";
import { Check, ChevronDown } from "lucide-solid";
import { anchorPanelMenu } from "../lib/uiMenu";

export interface DropdownOption<T> {
  value: T;
  label: string;
  disabled?: boolean;
  /** Optional group heading. A non-selectable label is rendered above the
   *  first option of each new group — the equivalent of `<optgroup>`. */
  group?: string;
}

interface DropdownProps<T> {
  value: T;
  options: readonly DropdownOption<T>[];
  onChange: (value: T) => void;
  /** Extra class on the wrapper, for caller-specific sizing. Common
   *  modifiers: `dropdown--block` (fill width), `dropdown--sm` (compact). */
  class?: string;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  /** Shown on the trigger when no option matches `value`. */
  placeholder?: string;
}

export function Dropdown<T>(props: DropdownProps<T>) {
  const [open, setOpen] = createSignal(false);
  // Index of the keyboard-highlighted option while the menu is open.
  const [activeIdx, setActiveIdx] = createSignal(-1);
  let triggerRef: HTMLButtonElement | undefined;

  const selectedIndex = () =>
    props.options.findIndex((o) => Object.is(o.value, props.value));
  const label = () =>
    props.options[selectedIndex()]?.label ?? props.placeholder ?? "";

  function openMenu() {
    if (props.disabled) return;
    setActiveIdx(selectedIndex());
    setOpen(true);
  }
  function closeMenu() {
    setOpen(false);
    setActiveIdx(-1);
  }
  function choose(opt: DropdownOption<T>) {
    if (opt.disabled) return;
    props.onChange(opt.value);
    closeMenu();
    triggerRef?.focus();
  }
  function moveActive(dir: 1 | -1) {
    const n = props.options.length;
    if (n === 0) return;
    let i = activeIdx();
    for (let step = 0; step < n; step++) {
      i = (i + dir + n) % n;
      if (!props.options[i]?.disabled) {
        setActiveIdx(i);
        break;
      }
    }
  }

  // While open: dismiss on an outside pointer-down or a viewport resize
  // (the menu is fixed-positioned and would otherwise drift off its anchor).
  createEffect(() => {
    if (!open()) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest(".dropdown__menu")) return;
      if (triggerRef && (t === triggerRef || triggerRef.contains(t))) return;
      closeMenu();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", closeMenu);
    onCleanup(() => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", closeMenu);
    });
  });

  function onKeyDown(e: KeyboardEvent) {
    if (props.disabled) return;
    if (!open()) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
      triggerRef?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const opt = props.options[activeIdx()];
      if (opt) choose(opt);
    }
  }

  return (
    <div class={`dropdown${props.class ? ` ${props.class}` : ""}`}>
      <button
        type="button"
        ref={triggerRef}
        class="dropdown__trigger"
        classList={{ "dropdown__trigger--open": open() }}
        disabled={props.disabled}
        title={props.title}
        aria-label={props.ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => (open() ? closeMenu() : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span class="dropdown__value">{label()}</span>
        <ChevronDown size={14} class="dropdown__chevron" />
      </button>
      <Show when={open()}>
        <div
          class="context-menu dropdown__menu"
          role="listbox"
          ref={(el) => anchorPanelMenu(triggerRef, el)}
        >
          <For each={props.options}>
            {(opt, i) => (
              <>
                <Show
                  when={
                    opt.group &&
                    opt.group !== props.options[i() - 1]?.group
                  }
                >
                  <div class="dropdown__group">{opt.group}</div>
                </Show>
                <button
                  type="button"
                  role="option"
                  aria-selected={Object.is(opt.value, props.value)}
                  classList={{
                    "context-menu__item": true,
                    "dropdown__item": true,
                    "dropdown__item--highlight": i() === activeIdx(),
                    "dropdown__item--disabled": !!opt.disabled,
                  }}
                  onClick={() => choose(opt)}
                  onMouseEnter={() => setActiveIdx(i())}
                >
                  <span class="dropdown__item-label">{opt.label}</span>
                  <Show when={Object.is(opt.value, props.value)}>
                    <Check size={14} class="dropdown__check" />
                  </Show>
                </button>
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
