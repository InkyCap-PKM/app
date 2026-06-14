// The type-aware quick filter that drops from a collection column header.
//
// One popover, branching on the column's resolved filter kind (list / text /
// number / date / checkbox — see column-filter.ts). It owns only its in-flight
// editing state; committing a filter is the parent's job via `onApply`, which
// receives the lowered `FilterGroup` (or `null` to clear the column).
//
// Positioning reuses `anchorPanelMenu` (fixed-position, escapes the table's
// overflow) and dismissal reuses the `clickOutside` directive — the same
// machinery as the panel sort menus, so behaviour stays consistent.

import { Component, For, Show, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import type { FilterGroup } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { Dropdown } from "./Dropdown";
import DatePicker from "./DatePicker";
import { clickOutside } from "../lib/clickOutside";
import { anchorPanelMenu } from "../lib/uiMenu";
import {
  type CheckboxState,
  type ColumnFilterKind,
  type DateFilterState,
  type NumberFilterState,
  DATE_OPS,
  NUMBER_OPS,
  buildCheckboxFilter,
  buildDateFilter,
  buildMultiSelectFilter,
  buildNumberFilter,
  buildTextFilter,
  multiSelectOptions,
  parseCheckboxFilter,
  parseDateFilter,
  parseMultiSelectFilter,
  parseNumberFilter,
  parseTextFilter,
} from "../lib/column-filter";

// Keep the directive import from being tree-shaken (it's only referenced via
// the `use:clickOutside` JSX attribute, which the compiler can't see as a use).
void clickOutside;

export interface ColumnFilterPopoverProps {
  property: string;
  label: string;
  kind: ColumnFilterKind;
  /** Whether the date picker should also edit a time component. */
  withTime: boolean;
  current: FilterGroup | null;
  /** Distinct values present in the column, for the multi-select checklist. */
  availableValues: string[];
  /** The header button the popover anchors to, and whose clicks don't dismiss. */
  anchor: HTMLElement | undefined;
  onApply: (group: FilterGroup | null) => void;
  onClose: () => void;
}

const ColumnFilterPopover: Component<ColumnFilterPopoverProps> = (props) => {
  const t = useI18n();

  // ── Per-kind working state, seeded from the saved filter ──
  const isMulti = props.kind === "list" || props.kind === "commalist";
  const options = isMulti
    ? multiSelectOptions(props.availableValues, props.kind as "list" | "commalist")
    : [];

  const [selected, setSelected] = createSignal<Set<string>>(
    new Set(parseMultiSelectFilter(props.current)),
  );
  const [search, setSearch] = createSignal("");
  const [text, setText] = createSignal(parseTextFilter(props.current));
  const [num, setNum] = createSignal<NumberFilterState>(parseNumberFilter(props.current));
  const [date, setDate] = createSignal<DateFilterState>(parseDateFilter(props.current));
  const [checkbox, setCheckbox] = createSignal<CheckboxState>(parseCheckboxFilter(props.current));

  const filteredOptions = () => {
    const needle = search().trim().toLowerCase();
    return needle ? options.filter((o) => o.toLowerCase().includes(needle)) : options;
  };

  function toggleValue(v: string) {
    const next = new Set(selected());
    if (next.has(v)) next.delete(v);
    else next.add(v);
    setSelected(next);
  }

  function build(): FilterGroup | null {
    switch (props.kind) {
      case "list":
      case "commalist":
        return buildMultiSelectFilter(props.property, [...selected()], props.kind);
      case "text":
        return buildTextFilter(props.property, text());
      case "number":
        return buildNumberFilter(props.property, num());
      case "date":
        return buildDateFilter(props.property, date());
      case "checkbox":
        return buildCheckboxFilter(props.property, checkbox());
    }
  }

  const apply = () => props.onApply(build());
  const clear = () => props.onApply(null);

  const numNeedsValue = () => num().op !== "empty" && num().op !== "notEmpty";
  const dateNeedsDate = () => date().op !== "empty" && date().op !== "notEmpty";

  const CHECKBOX_OPTIONS: { value: CheckboxState; labelKey: string }[] = [
    { value: "any", labelKey: "columnFilter.checkbox.any" },
    { value: "checked", labelKey: "columnFilter.checkbox.checked" },
    { value: "unchecked", labelKey: "columnFilter.checkbox.unchecked" },
  ];

  return (
    <Portal>
      <div
        class="column-filter"
        ref={(el) => anchorPanelMenu(props.anchor, el)}
        use:clickOutside={{
          onDismiss: props.onClose,
          ignore: props.anchor,
          // The date picker portals its calendar to <body>; clicks there must
          // not dismiss this popover before the date is committed.
          ignoreSelector: ".date-picker__popup",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="column-filter__header">{props.label}</div>

        {/* ── List / commalist: multi-select checklist ── */}
        <Show when={isMulti}>
          <Show when={options.length > 8}>
            <input
              class="filter-builder__input column-filter__search"
              type="text"
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
              placeholder={t("columnFilter.searchValues")}
            />
          </Show>
          <div class="column-filter__options">
            <Show
              when={filteredOptions().length > 0}
              fallback={<div class="column-filter__empty">{t("columnFilter.noValues")}</div>}
            >
              <For each={filteredOptions()}>
                {(opt) => (
                  <label class="column-filter__option">
                    <input
                      type="checkbox"
                      checked={selected().has(opt)}
                      onChange={() => toggleValue(opt)}
                    />
                    <span>{opt}</span>
                  </label>
                )}
              </For>
            </Show>
          </div>
        </Show>

        {/* ── Text: contains ── */}
        <Show when={props.kind === "text"}>
          <input
            class="filter-builder__input column-filter__value"
            type="text"
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && apply()}
            placeholder={t("columnFilter.containsPlaceholder")}
          />
        </Show>

        {/* ── Number: operator + value(s) ── */}
        <Show when={props.kind === "number"}>
          <div class="column-filter__row">
            <Dropdown<string>
              class="dropdown--sm"
              value={num().op}
              options={NUMBER_OPS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
              onChange={(v) => setNum({ ...num(), op: v as NumberFilterState["op"] })}
              ariaLabel={t("columnFilter.operatorAria")}
            />
          </div>
          <Show when={numNeedsValue()}>
            <div class="column-filter__row">
              <input
                class="filter-builder__input column-filter__value"
                type="number"
                value={num().value}
                onInput={(e) => setNum({ ...num(), value: e.currentTarget.value })}
                onKeyDown={(e) => e.key === "Enter" && apply()}
                placeholder={t("columnFilter.valuePlaceholder")}
              />
              <Show when={num().op === "between"}>
                <span class="column-filter__between">{t("columnFilter.and")}</span>
                <input
                  class="filter-builder__input column-filter__value"
                  type="number"
                  value={num().value2}
                  onInput={(e) => setNum({ ...num(), value2: e.currentTarget.value })}
                  onKeyDown={(e) => e.key === "Enter" && apply()}
                  placeholder={t("columnFilter.valuePlaceholder")}
                />
              </Show>
            </div>
          </Show>
        </Show>

        {/* ── Date: operator + date picker(s) ── */}
        <Show when={props.kind === "date"}>
          <div class="column-filter__row">
            <Dropdown<string>
              class="dropdown--sm"
              value={date().op}
              options={DATE_OPS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
              onChange={(v) => setDate({ ...date(), op: v as DateFilterState["op"] })}
              ariaLabel={t("columnFilter.operatorAria")}
            />
          </div>
          <Show when={dateNeedsDate()}>
            <div class="column-filter__row column-filter__row--dates">
              <DatePicker
                value={date().date}
                withTime={props.withTime}
                onSave={(v) => setDate({ ...date(), date: v })}
              />
              <Show when={date().op === "within"}>
                <span class="column-filter__between">{t("columnFilter.and")}</span>
                <DatePicker
                  value={date().date2}
                  withTime={props.withTime}
                  onSave={(v) => setDate({ ...date(), date2: v })}
                />
              </Show>
            </div>
          </Show>
        </Show>

        {/* ── Checkbox: any / checked / unchecked ── */}
        <Show when={props.kind === "checkbox"}>
          <div class="column-filter__row">
            <Dropdown<string>
              class="dropdown--sm"
              value={checkbox()}
              options={CHECKBOX_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
              onChange={(v) => setCheckbox(v as CheckboxState)}
              ariaLabel={t("columnFilter.operatorAria")}
            />
          </div>
        </Show>

        <div class="column-filter__footer">
          <button class="btn btn--primary btn--sm" onClick={apply}>
            {t("common.apply")}
          </button>
          <Show when={props.current}>
            <button class="btn btn--secondary btn--sm" onClick={clear}>
              {t("columnFilter.clear")}
            </button>
          </Show>
          <button class="btn btn--secondary btn--sm" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </Portal>
  );
};

export default ColumnFilterPopover;
