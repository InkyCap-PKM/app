// Right-panel On This Date pane: every task and dated reminder in the notebox
// that falls on the open note's `date` property, the note's own included, done
// or not, with repeating reminders counted on the days they repeat. Rows are
// the Agenda's own (AgendaRow). Turned on in Settings > Behaviour.

import { Component, Show, For, createResource, createSignal } from "solid-js";
import * as ipc from "../lib/ipc";
import type { NoteDayAgenda } from "../lib/types";
import { attachListNav } from "../lib/list-nav";
import { localTodayISO } from "../lib/column-filter";
import { formatUserDate } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { indexReady, propertyVersion, fileTreeVersion } from "../stores/notebox";
import {
  AgendaRow,
  AgendaRowMenu,
  openAgendaItem,
  sortDayItems,
  type AgendaRowMenuState,
} from "./AgendaRow";

const NO_DATE: NoteDayAgenda = { date: null, items: [] };

const OnThisDatePanel: Component<{
  /** The open note's path. */
  path: string;
}> = (props) => {
  const t = useI18n();
  const [menu, setMenu] = createSignal<AgendaRowMenuState | null>(null);

  // Re-read when the note changes, when any note's properties or markers
  // change (`propertyVersion`), and on create, delete and rename
  // (`fileTreeVersion`). Waits for the index, which holds every note's date.
  const [day] = createResource(
    () =>
      indexReady()
        ? { path: props.path, pv: propertyVersion(), fv: fileTreeVersion() }
        : undefined,
    ({ path }) => ipc.getNoteDayAgenda(path).catch(() => NO_DATE),
  );
  const current = () => day.latest;

  return (
    <div class="right-panel__pane">
      <div class="right-panel__section-header">
        <span>
          {current()?.date
            ? t("onThisDate.titleWithDate", { date: formatUserDate(current()!.date!) })
            : t("onThisDate.title")}
        </span>
      </div>
      <div class="right-panel__pane-body">
        <Show
          when={current()}
          fallback={<p class="sidebar-hint">{t("common.loading")}</p>}
        >
          {(d) => (
            <Show
              when={d().date}
              fallback={<p class="sidebar-hint">{t("onThisDate.noDate")}</p>}
            >
              <Show
                when={d().items.length > 0}
                fallback={<p class="sidebar-hint">{t("onThisDate.empty")}</p>}
              >
                <div class="agenda__list" ref={attachListNav} aria-label={t("onThisDate.title")}>
                  <For each={sortDayItems(d().items)}>
                    {(item) => (
                      <AgendaRow
                        item={item}
                        today={localTodayISO()}
                        onOpen={openAgendaItem}
                        onContextMenu={(e, it) => setMenu({ x: e.clientX, y: e.clientY, item: it })}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          )}
        </Show>
      </div>
      <Show when={menu()}>
        {(m) => (
          <AgendaRowMenu menu={m()} onOpen={openAgendaItem} onClose={() => setMenu(null)} />
        )}
      </Show>
    </div>
  );
};

export default OnThisDatePanel;
