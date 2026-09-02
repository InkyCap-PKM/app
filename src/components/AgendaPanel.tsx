// Agenda panel: left-sidebar mode that aggregates tasks and dated reminders
// from across the whole notebox. Items come from two sources — document-level
// `#note(...)` properties (task / due) and inline `#task` /
// `#due` markers — flattened by the `get_agenda_items` backend command.
//
// This component is a thin data shell: it fetches and delegates rendering to
// the shared `AgendaList` (also used by the Collection Agenda view).

import { Component, createResource } from "solid-js";
import * as ipc from "../lib/ipc";
import type { AgendaItem } from "../lib/types";
import { openTab } from "../stores/tabs";
import { noteboxInfo, propertyVersion, fileTreeVersion } from "../stores/notebox";
import { t } from "../lib/i18n";
import AgendaList, { agendaFiltersKey } from "./AgendaList";

interface AgendaPanelProps {
  /** Bumped by the parent to force a refetch (e.g. after an edit). */
  refreshTick?: number;
}

const AgendaPanel: Component<AgendaPanelProps> = (props) => {
  const [items] = createResource(
    () => ({
      info: noteboxInfo(),
      tick: props.refreshTick,
      pv: propertyVersion(),
      // `fileTreeVersion` bumps on create/delete/rename — agenda items
      // are keyed by file path, so a rename has to refetch or the
      // sidebar keeps showing the old filename.
      fv: fileTreeVersion(),
    }),
    async ({ info }) => {
      if (!info) return [] as AgendaItem[];
      return ipc.getAgendaItems();
    },
  );

  return (
    <div class="left-sidebar__pane">
      <div class="left-sidebar__section-header">
        <span>{t("agenda.title")}</span>
      </div>
      <AgendaList
        items={items() ?? []}
        loading={items.loading}
        emptyMessage={t("agenda.noItems")}
        listClass="left-sidebar__pane-body"
        persistKey={noteboxInfo() ? agendaFiltersKey(noteboxInfo()!.path) : undefined}
        onSaveView={async (name, snapshot) => {
          const info = noteboxInfo();
          if (!info) return;
          await ipc.addBookmark({
            type: "AgendaView",
            data: { name, notebox: info.path, filter: JSON.stringify(snapshot) },
          });
          // Make the Bookmarks pane re-query (same channel SearchPanel uses).
          document.dispatchEvent(new CustomEvent("inkycap:bookmarks-changed"));
        }}
        onOpen={(it, opts) =>
          openTab(
            { type: "file", title: it.note_title, path: it.note_path },
            opts?.newTab ? { forceNewTab: true, newTabAction: true } : undefined,
          )
        }
      />
    </div>
  );
};

export default AgendaPanel;
