import { Component, createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { createHoverGuard } from "../lib/picker-hover";

/**
 * The chips-and-dropdown control the Properties panel uses to pick several
 * values at once — tags, aliases, any list property, and collections.
 *
 * It is one component rather than one per property because the two are the
 * same control: a row of chips that opens a checkable list. Keeping them
 * together is also what makes the keyboard behaviour worth writing once —
 * every list here answers to the same keys:
 *
 *   Enter / Space / ↓ on the chips row  open the list
 *   ↑ ↓ Home End                        move the highlight
 *   Enter                               add or remove the highlighted value
 *   Escape                              close and return to the chips row
 *   Tab                                 close and carry on out of the panel
 *
 * The highlight is a signal, not DOM focus: focus stays in the filter box so
 * the writer can keep typing while arrowing through the matches (the usual
 * combobox arrangement, described to assistive tech with
 * `aria-activedescendant`). Where there is no filter box, the list itself
 * takes focus and answers the same keys.
 */

export interface MultiSelectPickerProps {
  /** Values shown as chips on the trigger row. */
  selected: string[];
  /** Values offered in the list, in display order and already filtered. */
  options: string[];
  onToggle: (value: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name for the chips row and the list. */
  label: string;
  /** Placeholder shown on the chips row when nothing is selected. */
  emptyLabel: string;
  /** Message shown in place of an empty list. */
  noOptionsLabel: string;

  // The filter box and its "add what I typed" row. These are separate props
  // rather than one `filter` object because Solid tracks each prop on its own:
  // a caller that rebuilds an object on every keystroke makes the whole
  // subtree — including the box being typed into — rebuild with it, which
  // takes the focus and the next character with it.

  /** Show a filter box above the list. */
  filterable?: boolean;
  filterValue?: string;
  filterPlaceholder?: string;
  onFilterChange?: (value: string) => void;
  /** Label for the last row, which adds the typed value; omit for no row. */
  createLabel?: string;
  onCreate?: () => void;
  /** Backspace on an empty filter box — usually "drop the last chip". */
  onBackspaceEmpty?: () => void;
}

let pickerSeq = 0;

const MultiSelectPicker: Component<MultiSelectPickerProps> = (props) => {
  const domId = `multi-select-${++pickerSeq}`;
  const hover = createHoverGuard();
  let wrapRef: HTMLDivElement | undefined;
  let triggerRef: HTMLDivElement | undefined;
  let inputRef: HTMLInputElement | undefined;
  let listRef: HTMLDivElement | undefined;
  let rowRefs: HTMLElement[] = [];

  const [highlight, setHighlight] = createSignal(0);

  const hasCreate = () => props.createLabel !== undefined;
  /** Index of the "add what I typed" row, or -1 when there isn't one. */
  const createIndex = () => (hasCreate() ? props.options.length : -1);
  /** Rows the highlight can move over: every option, then the create row. */
  const rowCount = createMemo(() => props.options.length + (hasCreate() ? 1 : 0));

  // Keep the highlight on a row that exists as the list is filtered down, and
  // drop refs to rows that are gone.
  createEffect(() => {
    const count = rowCount();
    rowRefs = rowRefs.slice(0, count);
    if (highlight() >= count) setHighlight(Math.max(0, count - 1));
  });

  // Follow the highlight when it moves past either end of the scrolling list.
  createEffect(() => {
    const row = rowRefs[highlight()];
    if (props.open && row) row.scrollIntoView({ block: "nearest" });
  });

  function open() {
    if (props.open) return;
    setHighlight(0);
    props.onOpenChange(true);
    // The list is rendered by this same update, so focus it on the next tick.
    setTimeout(() => (props.filterable ? inputRef : listRef)?.focus(), 0);
  }

  function close(returnFocus: boolean) {
    if (!props.open) return;
    props.onOpenChange(false);
    if (returnFocus) triggerRef?.focus();
  }

  /** Apply a row: toggle its value, or add the one the writer typed. */
  function activate(index: number) {
    if (index === createIndex()) props.onCreate?.();
    else {
      const value = props.options[index];
      if (value !== undefined) props.onToggle(value);
    }
    // Saving a value sends the panel back to the note's metadata, and the
    // redraw that follows can blur whatever had focus. Claim it back so the
    // writer can keep picking without reaching for the mouse.
    setTimeout(() => {
      if (props.open) (props.filterable ? inputRef : listRef)?.focus();
    }, 0);
  }

  function moveHighlight(delta: number) {
    const count = rowCount();
    if (count === 0) return;
    setHighlight(Math.max(0, Math.min(count - 1, highlight() + delta)));
  }

  function handleTriggerKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      open();
    }
  }

  function handleListKeyDown(e: KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveHighlight(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        moveHighlight(-1);
        return;
      case "Home":
        e.preventDefault();
        setHighlight(0);
        return;
      case "End":
        e.preventDefault();
        setHighlight(Math.max(0, rowCount() - 1));
        return;
      case "Enter":
        e.preventDefault();
        activate(highlight());
        return;
      case " ":
        // Only a list without a filter box claims Space; with one it is just
        // a character in the text being typed.
        if (props.filterable) return;
        e.preventDefault();
        activate(highlight());
        return;
      case "Escape":
        // Closing the list is all this Escape does; the next one is free to
        // leave the panel.
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      case "Tab":
        close(false);
        return;
      case "Backspace":
        if (props.filterable && !props.filterValue) props.onBackspaceEmpty?.();
        return;
    }
  }

  function handlePointerDownOutside(e: MouseEvent) {
    if (wrapRef && !wrapRef.contains(e.target as Node)) close(false);
  }

  createEffect(() => {
    if (props.open) document.addEventListener("mousedown", handlePointerDownOutside);
    else document.removeEventListener("mousedown", handlePointerDownOutside);
  });
  onCleanup(() => document.removeEventListener("mousedown", handlePointerDownOutside));

  const rowId = (index: number) => `${domId}-row-${index}`;

  return (
    <div class="multi-select" ref={wrapRef}>
      <div
        class="property-editor__tags"
        ref={triggerRef}
        tabindex="0"
        role="combobox"
        aria-expanded={props.open}
        aria-controls={`${domId}-list`}
        aria-label={props.label}
        onClick={() => (props.open ? close(false) : open())}
        onKeyDown={handleTriggerKeyDown}
      >
        <For each={props.selected}>
          {(item) => <span class="badge badge--accent">{item}</span>}
        </For>
        <Show when={props.selected.length === 0}>
          <span class="property-editor__value property-editor__value--empty">
            {props.emptyLabel}
          </span>
        </Show>
      </div>

      <Show when={props.open}>
        <div class="multi-select__dropdown">
          <Show when={props.filterable}>
            <input
              class="property-editor__input multi-select__filter"
              type="text"
              placeholder={props.filterPlaceholder}
              value={props.filterValue ?? ""}
              aria-controls={`${domId}-list`}
              aria-activedescendant={rowCount() > 0 ? rowId(highlight()) : undefined}
              onInput={(e) => {
                props.onFilterChange?.(e.currentTarget.value);
                setHighlight(0);
              }}
              onKeyDown={handleListKeyDown}
              ref={(el) => (inputRef = el)}
            />
          </Show>

          <div
            id={`${domId}-list`}
            class="multi-select__list"
            role="listbox"
            aria-multiselectable="true"
            aria-label={props.label}
            tabindex={props.filterable ? -1 : 0}
            /* Bound unconditionally on purpose. A handler written as a
               conditional expression makes Solid rebuild this whole block
               whenever anything that expression reads changes — which would
               replace the filter box mid-keystroke. Nothing double-handles:
               the filter box is a sibling, so its keys never reach here. */
            onKeyDown={handleListKeyDown}
            ref={(el) => (listRef = el)}
          >
            <For each={props.options} fallback={
              <Show when={!hasCreate()}>
                <span class="multi-select__empty">{props.noOptionsLabel}</span>
              </Show>
            }>
              {(value, index) => (
                <div
                  id={rowId(index())}
                  ref={(el) => (rowRefs[index()] = el)}
                  class="multi-select__option"
                  classList={{ "multi-select__option--active": highlight() === index() }}
                  role="option"
                  aria-selected={props.selected.includes(value)}
                  onClick={() => props.onToggle(value)}
                  onMouseMove={(e) => hover.move(e, () => setHighlight(index()))}
                >
                  {/* Decorative: the row itself carries the state for assistive
                      tech, and the keyboard drives it through the list. */}
                  <input
                    type="checkbox"
                    checked={props.selected.includes(value)}
                    tabindex="-1"
                    aria-hidden="true"
                    onChange={() => props.onToggle(value)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span>{value}</span>
                </div>
              )}
            </For>

            <Show when={hasCreate()}>
              <button
                id={rowId(createIndex())}
                ref={(el) => (rowRefs[createIndex()] = el)}
                class="multi-select__option multi-select__create"
                classList={{ "multi-select__option--active": highlight() === createIndex() }}
                type="button"
                tabindex="-1"
                onClick={() => props.onCreate?.()}
                onMouseMove={(e) => hover.move(e, () => setHighlight(createIndex()))}
              >
                {props.createLabel}
              </button>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default MultiSelectPicker;
