// RecurrenceEditor: the "Repeat" control for a dated reminder. A toggle turns
// it on; then the user picks "every N day/week/month/year", weekdays (weekly
// only) and an optional "until" date. Emits a whole `Recurrence` (or `null`
// when off) and saves nothing itself, so it works wherever it's placed
// (currently the property panel).
//
// Only reminders recur, so it never shows for a checkbox task; the caller
// decides when to show it.
//
// Edits go into a local copy, which is reset from `props.value` only when that
// changes for another reason (a different note). Otherwise quick successive
// edits (a weekday, then an "until" date) would each start from a `props.value`
// not yet updated by the save, losing earlier changes.

import { Component, For, Show, createSignal, createEffect, untrack } from "solid-js";
import type { Recurrence } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { Dropdown } from "./Dropdown";
import DatePicker from "./DatePicker";
import {
  WEEKDAY_CODES,
  FREQ_OPTIONS,
  type Freq,
  defaultRecurrence,
  sortByDay,
  formatRecurrence,
} from "../lib/recurrence";

export interface RecurrenceEditorProps {
  /** Current persisted rule, or `null` when the item doesn't recur. */
  value: Recurrence | null;
  /** Called with the updated rule, or `null` to stop recurring. */
  onChange: (rec: Recurrence | null) => void;
  /** Render disabled (e.g. when there's no anchor date to recur from). */
  disabled?: boolean;
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

const RecurrenceEditor: Component<RecurrenceEditorProps> = (props) => {
  const t = useI18n();

  const [draft, setDraft] = createSignal<Recurrence | null>(props.value);
  // Reset only on an outside change (another note), never from our own save
  // coming back through a metadata refetch; comparing values keeps an edit from
  // being overwritten by the old props.
  createEffect(() => {
    const incoming = props.value;
    if (JSON.stringify(incoming) !== JSON.stringify(untrack(draft))) {
      setDraft(incoming);
    }
  });

  const enabled = () => draft() != null;

  function commit(next: Recurrence | null) {
    setDraft(next);
    props.onChange(next);
  }

  function toggle() {
    if (props.disabled) return;
    commit(enabled() ? null : defaultRecurrence());
  }

  function patch(p: Partial<Recurrence>) {
    const cur = draft();
    if (!cur) return;
    commit({ ...cur, ...p });
  }

  function setIntervalValue(raw: string) {
    patch({ interval: Math.max(1, Math.round(Number(raw) || 1)) });
  }

  function toggleDay(code: string) {
    const cur = draft()?.by_day ?? [];
    const next = cur.includes(code)
      ? cur.filter((c) => c !== code)
      : sortByDay([...cur, code]);
    patch({ by_day: next });
  }

  return (
    <div
      class="recurrence-editor"
      classList={{ "recurrence-editor--disabled": props.disabled }}
    >
      <label class="recurrence-editor__toggle">
        <input
          type="checkbox"
          checked={enabled()}
          disabled={props.disabled}
          onChange={toggle}
        />
        <span>{t("recurrence.repeat")}</span>
      </label>

      <Show when={draft()}>
        {(rec) => (
          <div class="recurrence-editor__body">
            <div class="recurrence-editor__row">
              <span class="recurrence-editor__label">{t("recurrence.every")}</span>
              <input
                class="recurrence-editor__interval"
                type="number"
                min="1"
                value={rec().interval}
                onChange={(e) => setIntervalValue(e.currentTarget.value)}
                aria-label={t("recurrence.interval")}
              />
              <Dropdown<Freq>
                class="dropdown--sm"
                value={rec().freq}
                options={FREQ_OPTIONS.map((f) => ({
                  value: f,
                  label: t(`recurrence.freq.${f}`),
                }))}
                onChange={(f) =>
                  // Leaving weekly clears the weekday selection (it only applies
                  // to weekly rules).
                  patch({ freq: f, by_day: f === "week" ? rec().by_day : [] })
                }
                ariaLabel={t("recurrence.frequency")}
              />
            </div>

            <Show when={rec().freq === "week"}>
              <div
                class="recurrence-editor__weekdays"
                role="group"
                aria-label={t("recurrence.weekdays")}
              >
                <For each={WEEKDAY_CODES}>
                  {(code) => (
                    <button
                      type="button"
                      class="recurrence-editor__weekday"
                      classList={{
                        "recurrence-editor__weekday--on": rec().by_day.includes(code),
                      }}
                      onClick={() => toggleDay(code)}
                      aria-pressed={rec().by_day.includes(code)}
                      title={t(`recurrence.weekdayShort.${code}`)}
                    >
                      {t(`recurrence.weekday.${code}`)}
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <div class="recurrence-editor__row">
              <label class="recurrence-editor__until-toggle">
                <input
                  type="checkbox"
                  checked={rec().until != null}
                  onChange={(e) =>
                    patch({ until: e.currentTarget.checked ? todayISO() : null })
                  }
                />
                <span>{t("recurrence.until")}</span>
              </label>
              <Show when={rec().until != null}>
                <DatePicker
                  value={rec().until ?? ""}
                  withTime={false}
                  onSave={(v) => patch({ until: v || null })}
                />
              </Show>
            </div>

            <p class="recurrence-editor__summary">{formatRecurrence(rec())}</p>
          </div>
        )}
      </Show>
    </div>
  );
};

export default RecurrenceEditor;
