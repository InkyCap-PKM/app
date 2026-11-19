// One agenda item as a list row, and the menu a right-click on it opens. Shared
// by every list of agenda items (the Agenda, a collection's Agenda view, the
// right panel's On This Date) so a task or date looks and behaves the same
// wherever it is listed.

import { Component, JSX, Show } from "solid-js";
import { CalendarClock, CheckSquare, ClockAlert, Repeat, Square } from "lucide-solid";
import type { AgendaItem } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { formatRecurrence } from "../lib/recurrence";
import { formatUserDate } from "../lib/dates";
import { clickOutside } from "../lib/clickOutside";
import { openTab } from "../stores/tabs";

void clickOutside; // used as the `use:clickOutside` directive below

/** How a row asks its list to open the item's note. `newTab` is set for
 *  Ctrl/Cmd-click, middle-click and the menu's "Open in new tab". */
export type AgendaOpenHandler = (item: AgendaItem, opts?: { newTab?: boolean }) => void;

/** Open an agenda item's note, in a new tab when asked. */
export const openAgendaItem: AgendaOpenHandler = (item, opts) =>
  openTab(
    { type: "file", title: item.note_title, path: item.note_path },
    opts?.newTab ? { forceNewTab: true, newTabAction: true } : undefined,
  );

/** One day's items in reading order: open tasks first, then by text, so the
 *  day's remaining work leads. */
export function sortDayItems(items: AgendaItem[]): AgendaItem[] {
  return [...items].sort(
    (a, b) => Number(a.done) - Number(b.done) || a.text.localeCompare(b.text),
  );
}

/**
 * An agenda row: checkbox or calendar icon, text, repeat summary and date. A
 * done task is crossed out, an unfinished one past its date is marked overdue,
 * and later occurrences of a repeating reminder are muted. The row must sit in
 * a list wired with `attachListNav`, which gives it keyboard access.
 */
export const AgendaRow: Component<{
  item: AgendaItem;
  /** Today as `YYYY-MM-DD`, for the overdue mark. */
  today: string;
  onOpen: AgendaOpenHandler;
  onContextMenu: (e: MouseEvent, item: AgendaItem) => void;
  /** Shown before the icon, such as the Agenda's caret for a repeating series. */
  leading?: JSX.Element;
}> = (props) => {
  const t = useI18n();
  const it = () => props.item;
  const overdue = () => !it().done && !!it().date && it().date! < props.today;
  return (
    <div
      data-list-item
      class="sidebar-item agenda__item"
      classList={{
        "agenda__item--done": it().done,
        // Later occurrences are muted so a frequent reminder doesn't
        // dominate; the next one stays at full strength.
        "agenda__item--recurrence-future": it().recurring && (it().occurrence_index ?? 0) > 0,
      }}
      onClick={(e) => props.onOpen(it(), { newTab: e.ctrlKey || e.metaKey })}
      onAuxClick={(e) => {
        if (e.button !== 1) return; // middle-click → new tab
        e.preventDefault();
        props.onOpen(it(), { newTab: true });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onContextMenu(e, it());
      }}
      title={
        it().recurring && it().recurrence
          ? `${it().note_title} · ${formatRecurrence(it().recurrence!)}`
          : it().note_title
      }
    >
      {props.leading}
      <span class="sidebar-item__icon">
        <Show when={it().is_task} fallback={<CalendarClock size={14} />}>
          {it().done ? <CheckSquare size={14} /> : <Square size={14} />}
        </Show>
      </span>
      <span class="agenda__item-body">
        <span class="agenda__item-text">{it().text}</span>
        {/* The rule summary on the current occurrence shows the cadence and
            end date in the list itself, so a changed rule is visible even
            when later occurrences fall outside the list. */}
        <Show when={it().recurring && (it().occurrence_index ?? 0) === 0 && it().recurrence}>
          <span class="agenda__recur-summary">{formatRecurrence(it().recurrence!)}</span>
        </Show>
      </span>
      <Show when={it().recurring}>
        <Repeat size={11} class="agenda__recur-icon" aria-hidden="true" />
      </Show>
      <Show when={it().date}>
        <span
          class="agenda__date"
          classList={{ "agenda__date--overdue": overdue() }}
          title={overdue() ? t("agenda.date.overdue") : undefined}
        >
          {/* An icon as well as the colour, so "overdue" doesn't depend on
              telling red apart. */}
          <Show when={overdue()}>
            <ClockAlert
              size={11}
              class="agenda__overdue-icon"
              role="img"
              aria-label={t("agenda.date.overdue")}
            />
          </Show>
          {formatUserDate(it().date!)}
        </span>
      </Show>
    </div>
  );
};

/** Where an agenda row's menu opens, and for which item. */
export interface AgendaRowMenuState {
  x: number;
  y: number;
  item: AgendaItem;
}

/** The right-click menu of an {@link AgendaRow}: Open, and Open in new tab. */
export const AgendaRowMenu: Component<{
  menu: AgendaRowMenuState;
  onOpen: AgendaOpenHandler;
  onClose: () => void;
}> = (props) => {
  const t = useI18n();
  return (
    <div
      class="context-menu"
      style={{ left: `${props.menu.x}px`, top: `${props.menu.y}px` }}
      use:clickOutside={{ onDismiss: props.onClose }}
    >
      <button
        class="context-menu__item"
        onClick={() => {
          props.onOpen(props.menu.item);
          props.onClose();
        }}
      >
        {t("common.open")}
      </button>
      <button
        class="context-menu__item"
        onClick={() => {
          props.onOpen(props.menu.item, { newTab: true });
          props.onClose();
        }}
      >
        {t("wikilink.menu.openNewTab")}
      </button>
    </div>
  );
};
