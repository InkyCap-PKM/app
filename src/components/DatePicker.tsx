import { Component, createSignal, createMemo, createEffect, Show, For, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { ChevronLeft, ChevronRight } from "lucide-solid";
import { useI18n, localeCode } from "../lib/i18n";

// A self-contained calendar date picker.
//
// This replaces the native `<input type="date">`, whose WebKitGTK
// implementation is unreliable inside the Tauri webview: it needs two
// clicks to open, does not close when a day is clicked, and ignores
// Enter. This component is a plain DOM popup, so its behaviour is
// identical on every platform: one click opens it, clicking a day
// commits and closes, Enter commits the keyboard cursor, Escape closes.

export interface DatePickerProps {
  /** "" | "YYYY-MM-DD" | "YYYY-MM-DDTHH:MM" */
  value: string;
  /** When true, the picker also edits a time component (datetime). */
  withTime: boolean;
  onSave: (value: string) => void;
}

interface YMD {
  y: number;
  m: number; // 0-based month
  d: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

function parseDate(v: string): YMD | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return null;
  const ymd = { y: +m[1], m: +m[2] - 1, d: +m[3] };
  if (ymd.m < 0 || ymd.m > 11 || ymd.d < 1 || ymd.d > 31) return null;
  return ymd;
}

function parseTime(v: string): string {
  const m = /T(\d{2}:\d{2})/.exec(v);
  return m ? m[1] : "";
}

function fmtDate({ y, m, d }: YMD): string {
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(y, m + 1, 0).getDate();
}

function clampDay({ y, m, d }: YMD): YMD {
  return { y, m, d: Math.min(d, daysInMonth(y, m)) };
}

function addMonths(ymd: YMD, delta: number): YMD {
  const total = ymd.y * 12 + ymd.m + delta;
  return clampDay({ y: Math.floor(total / 12), m: ((total % 12) + 12) % 12, d: ymd.d });
}

function addDays(ymd: YMD, delta: number): YMD {
  const dt = new Date(ymd.y, ymd.m, ymd.d + delta);
  return { y: dt.getFullYear(), m: dt.getMonth(), d: dt.getDate() };
}

function sameDay(a: YMD | null, b: YMD | null): boolean {
  return !!a && !!b && a.y === b.y && a.m === b.m && a.d === b.d;
}

// Locale-aware month/year heading and weekday labels, keyed off the active UI
// locale (not the system locale) so they switch with the language picker.
function monthFmt(locale: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" });
}
function weekdayLabels(locale: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
  // Sunday-2023-01-01 .. Saturday — a known week to pull weekday names from.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 0, 1 + i)));
}

const DatePicker: Component<DatePickerProps> = (props) => {
  const t = useI18n();
  let triggerRef: HTMLSpanElement | undefined;
  let popupRef: HTMLDivElement | undefined;

  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal<{ left: number; top: number }>({ left: 0, top: 0 });

  const selected = createMemo(() => parseDate(props.value));
  const isEmpty = () => !props.value;

  // The month currently shown in the grid, and the keyboard cursor.
  const today = (): YMD => {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth(), d: n.getDate() };
  };
  const [view, setView] = createSignal<YMD>(selected() ?? today());
  const [cursor, setCursor] = createSignal<YMD>(selected() ?? today());
  const [time, setTime] = createSignal(parseTime(props.value));

  // Keep the popup fully on screen. Width/height match the CSS box
  // (.date-picker__popup is a fixed 238px wide); the popup flips above
  // the trigger when it would overflow the bottom, and its left edge is
  // clamped into the viewport so it never spills off the right.
  const POPUP_WIDTH = 238;
  function place() {
    if (!triggerRef) return;
    const r = triggerRef.getBoundingClientRect();
    const popupHeight = props.withTime ? 344 : 300;
    const margin = 8;
    const below = r.bottom + 4;
    const flip = below + popupHeight > window.innerHeight && r.top > popupHeight;
    const top = flip ? Math.max(margin, r.top - popupHeight - 4) : below;
    const left = Math.max(
      margin,
      Math.min(r.left, window.innerWidth - POPUP_WIDTH - margin),
    );
    setPos({ left, top });
  }

  function openPicker() {
    const base = selected() ?? today();
    setView(base);
    setCursor(base);
    setTime(parseTime(props.value));
    place();
    setOpen(true);
  }

  function closePicker() {
    setOpen(false);
    triggerRef?.focus();
  }

  function commit(day: YMD) {
    let next = fmtDate(day);
    if (props.withTime) {
      next += `T${time() || "00:00"}`;
    }
    if (next !== props.value) props.onSave(next);
    setOpen(false);
  }

  function clearValue() {
    if (props.value) props.onSave("");
    setOpen(false);
  }

  function handleKeyDown(e: KeyboardEvent) {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        closePicker();
        break;
      case "Enter":
        e.preventDefault();
        commit(cursor());
        break;
      case "ArrowLeft":
        e.preventDefault();
        moveCursor(addDays(cursor(), -1));
        break;
      case "ArrowRight":
        e.preventDefault();
        moveCursor(addDays(cursor(), 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        moveCursor(addDays(cursor(), -7));
        break;
      case "ArrowDown":
        e.preventDefault();
        moveCursor(addDays(cursor(), 7));
        break;
      case "PageUp":
        e.preventDefault();
        moveCursor(addMonths(cursor(), -1));
        break;
      case "PageDown":
        e.preventDefault();
        moveCursor(addMonths(cursor(), 1));
        break;
    }
  }

  function moveCursor(next: YMD) {
    setCursor(next);
    setView({ ...next });
  }

  // Close on outside click and reposition on scroll/resize while open.
  createEffect(() => {
    if (!open()) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popupRef?.contains(t) || triggerRef?.contains(t)) return;
      setOpen(false);
    };
    const onReflow = () => place();
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    });
  });

  // Move keyboard focus into the popup so arrow keys / Enter work at once.
  createEffect(() => {
    if (open()) queueMicrotask(() => popupRef?.focus());
  });

  // The grid cells for the displayed month, padded with leading blanks so
  // the 1st lands under its weekday column.
  const cells = createMemo<(YMD | null)[]>(() => {
    const { y, m } = view();
    const lead = new Date(y, m, 1).getDay();
    const count = daysInMonth(y, m);
    const out: (YMD | null)[] = [];
    for (let i = 0; i < lead; i++) out.push(null);
    for (let d = 1; d <= count; d++) out.push({ y, m, d });
    while (out.length % 7 !== 0) out.push(null);
    return out;
  });

  const weekdays = createMemo(() => weekdayLabels(localeCode()));
  const headingLabel = () => {
    const { y, m } = view();
    return monthFmt(localeCode()).format(new Date(y, m, 1));
  };

  return (
    <span class="date-picker">
      <span
        ref={triggerRef}
        tabindex="0"
        class={`property-editor__value${isEmpty() ? " property-editor__value--empty" : ""}`}
        onClick={() => (open() ? setOpen(false) : openPicker())}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openPicker();
          }
        }}
      >
        {isEmpty() ? t("datePicker.empty") : props.value.replace("T", " ")}
      </span>

      <Show when={open()}>
        <Portal>
          <div
            ref={popupRef}
            class="date-picker__popup"
            tabindex="-1"
            style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
            onKeyDown={handleKeyDown}
          >
            <div class="date-picker__header">
              <button
                type="button"
                class="date-picker__nav"
                title={t("datePicker.prevMonth")}
                onClick={() => setView(addMonths(view(), -1))}
              >
                <ChevronLeft size={16} />
              </button>
              <span class="date-picker__heading">{headingLabel()}</span>
              <button
                type="button"
                class="date-picker__nav"
                title={t("datePicker.nextMonth")}
                onClick={() => setView(addMonths(view(), 1))}
              >
                <ChevronRight size={16} />
              </button>
            </div>

            <div class="date-picker__grid">
              <For each={weekdays()}>
                {(label) => <span class="date-picker__weekday">{label}</span>}
              </For>
              <For each={cells()}>
                {(cell) => (
                  <Show when={cell} fallback={<span class="date-picker__day date-picker__day--blank" />}>
                    {(day) => (
                      <button
                        type="button"
                        class={
                          "date-picker__day" +
                          (sameDay(day(), selected()) ? " date-picker__day--selected" : "") +
                          (sameDay(day(), cursor()) ? " date-picker__day--cursor" : "") +
                          (sameDay(day(), today()) ? " date-picker__day--today" : "")
                        }
                        onClick={() => commit(day())}
                      >
                        {day().d}
                      </button>
                    )}
                  </Show>
                )}
              </For>
            </div>

            <Show when={props.withTime}>
              <div class="date-picker__time-row">
                <input
                  class="property-editor__input"
                  type="time"
                  value={time()}
                  onInput={(e) => setTime(e.currentTarget.value)}
                />
              </div>
            </Show>

            <div class="date-picker__footer">
              <button type="button" class="date-picker__action" onClick={() => commit(today())}>
                {t("datePicker.today")}
              </button>
              <button type="button" class="date-picker__action" onClick={clearValue}>
                {t("datePicker.clear")}
              </button>
            </div>
          </div>
        </Portal>
      </Show>
    </span>
  );
};

export default DatePicker;
