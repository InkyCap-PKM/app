// Generic query-view pane — the host-provided renderer that backs a declarative
// plugin's "view" contribution (see src/lib/plugins.ts). A manifest supplies a
// notebox-search query string; this runs it and lists the matching notes,
// click-to-open. It is the in-tree consumer of the sidebar registry: a
// data-only plugin gets a real sidebar pane without shipping any code.

import { Component, createResource, For, Show } from "solid-js";
import * as ipc from "../lib/ipc";
import { openTab } from "../stores/tabs";
import { indexReady } from "../stores/notebox";
import { useI18n } from "../lib/i18n";

/** A saved query rendered as a sidebar pane. `query` uses the same syntax as
 *  the search panel (boolean operators, `tag:`/`file:`/`path:` filters, etc.). */
const QueryView: Component<{ query: string }> = (props) => {
  const t = useI18n();
  const [results] = createResource(
    () => ({ q: props.query, ready: indexReady() }),
    async ({ q, ready }) => {
      if (!q.trim() || !ready) return [];
      try {
        const resp = await ipc.noteboxSearch(q, 200, false);
        return resp.results;
      } catch {
        return [];
      }
    },
  );

  return (
    <div class="search-panel__results">
      <Show
        when={(results() ?? []).length > 0}
        fallback={<p class="sidebar-hint">{t("queryView.noResults")}</p>}
      >
        <For each={results()}>
          {(r) => (
            <div class="search-panel__file-group">
              <div
                class="search-panel__result-file"
                onClick={() =>
                  openTab(
                    { type: "file", title: r.file_name, path: r.path },
                    { forceNewTab: true },
                  )
                }
              >
                <span class="search-panel__file-label">{r.file_name}</span>
              </div>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
};

export default QueryView;
