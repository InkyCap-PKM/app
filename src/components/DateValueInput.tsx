// A date-filter value editor that toggles between a fixed calendar date and a
// relative "today ± N days" offset.
//
// The relative form is stored as an `@today±N` token (see the relative-date
// helpers in column-filter.ts) and resolved to a concrete date only at
// evaluation time, so a saved filter such as "within the next 7 days" stays
// relative to the current day rather than freezing to the day it was created.
//
// It shares DatePicker's `value` / `withTime` / `onSave` shape, so it is a
// drop-in replacement everywhere a date *filter* value is edited (the Agenda
// date menu and the collection column-header popover).

import { Component, Show, createMemo } from "solid-js";
import { CalendarDays, CalendarClock } from "lucide-solid";
import DatePicker from "./DatePicker";
import { useI18n } from "../lib/i18n";
import {
  isRelativeDate,
  makeRelativeDate,
  relativeOffset,
  resolveRelativeDate,
} from "../lib/column-filter";
import { formatUserDate } from "../lib/dates";

export interface DateValueInputProps {
  /** A fixed `YYYY-MM-DD`, a relative `@today±N` token, or `""`. */
  value: string;
  /** Passed through to the fixed-date picker (datetime columns). */
  withTime: boolean;
  onSave: (value: string) => void;
}

const DateValueInput: Component<DateValueInputProps> = (props) => {
  const t = useI18n();
  const relative = createMemo(() => isRelativeDate(props.value));
  const offset = createMemo(() => relativeOffset(props.value) ?? 0);

  // The calendar date a relative offset resolves to today, shown as a live
  // preview so "+7 days" reads as the concrete date it currently means.
  const resolvedLabel = createMemo(() => formatUserDate(resolveRelativeDate(props.value)));

  // Switching to fixed keeps the day the token currently resolves to, so the
  // value stays meaningful and immediately editable in the calendar.
  const toFixed = () => props.onSave(resolveRelativeDate(props.value));
  const toRelative = () => props.onSave(makeRelativeDate(0)); // @today

  return (
    <span class="date-value">
      <button
        type="button"
        class="ui-icon-btn date-value__mode"
        aria-pressed={relative()}
        title={relative() ? t("dateValue.switchToFixed") : t("dateValue.switchToRelative")}
        aria-label={relative() ? t("dateValue.switchToFixed") : t("dateValue.switchToRelative")}
        onClick={() => (relative() ? toFixed() : toRelative())}
      >
        {/* The icon shows the mode you'll switch *to*, matching the tooltip. */}
        <Show when={relative()} fallback={<CalendarClock size={15} />}>
          <CalendarDays size={15} />
        </Show>
      </button>

      {/* Relative branch renders directly into `.date-value` (no wrapper) so the
          toggle, the compact offset field, and the unit share one flex row; the
          resolved-date preview wraps to its own line. */}
      <Show
        when={relative()}
        fallback={
          <DatePicker value={props.value} withTime={props.withTime} onSave={props.onSave} />
        }
      >
        {/* A plain text input (no number spinners) committing on change, not on
            every keystroke, so a partial "-" while typing a negative offset
            isn't clobbered. `inputmode` still hints a numeric keypad. */}
        <input
          class="property-editor__input date-value__offset"
          type="text"
          inputmode="numeric"
          value={offset()}
          onChange={(e) => {
            const n = parseInt(e.currentTarget.value, 10);
            props.onSave(makeRelativeDate(Number.isFinite(n) ? n : 0));
          }}
          aria-label={t("dateValue.offsetAria")}
        />
        {/* Unit and preview stacked so "= <date>" aligns under "days from
            today" rather than under the toggle/input. */}
        <span class="date-value__rel-text">
          <span class="date-value__rel-unit">{t("dateValue.daysFromToday")}</span>
          <span class="date-value__preview">= {resolvedLabel()}</span>
        </span>
      </Show>
    </span>
  );
};

export default DateValueInput;
