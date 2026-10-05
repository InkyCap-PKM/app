import { Component, For, Show, createResource } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import * as ipc from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import { compareName } from "../lib/sort";
import { listenWhileMounted } from "../lib/listen-while-mounted";
import { thisWindowOnly } from "../lib/events";
import { showContextMenu } from "../lib/context-menu";
import { openTab } from "../stores/tabs";
import { NoteIcon } from "./icons";

/**
 * Right-panel pane for an attachment tab: the notes that use the file, each
 * opening the note on click. Ctrl/Cmd-click, middle-click, or the right-click
 * menu open it in a new tab instead. Follows the notebox index, so the list
 * updates as notes gain or drop the reference.
 */
const AttachmentPanel: Component<{ path: string }> = (props) => {
  const t = useI18n();
  const [users, { refetch }] = createResource(
    () => props.path,
    async (path) => {
      const links = await ipc.getAttachmentReferences(path);
      return links.sort((a, b) => compareName(a.name, b.name));
    },
  );

  listenWhileMounted(listen("notebox:index-updated", () => void refetch(), thisWindowOnly()));

  const openNote = (link: { path: string; name: string }, newTab: boolean) => {
    openTab(
      { type: "file", title: link.name, path: link.path },
      { forceNewTab: newTab, newTabAction: newTab },
    );
  };

  return (
    <div class="right-panel__pane">
      <div class="right-panel__section-header">
        <span>
          {t("attachmentPanel.usedIn")}
          <Show when={users()?.length}>
            <span class="right-panel__count"> ({users()!.length})</span>
          </Show>
        </span>
        <div class="right-panel__header-actions" />
      </div>
      <div class="right-panel__pane-body">
        <Show when={!users.loading || users()} fallback={<p class="sidebar-hint">{t("common.loading")}</p>}>
          <For
            each={users() ?? []}
            fallback={<p class="sidebar-hint">{t("attachmentPanel.unused")}</p>}
          >
            {(link) => (
              <div
                class="sidebar-item"
                role="button"
                tabindex="0"
                onClick={(e) => openNote(link, e.ctrlKey || e.metaKey)}
                onAuxClick={(e) => {
                  if (e.button !== 1) return;
                  e.preventDefault();
                  openNote(link, true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") openNote(link, e.ctrlKey || e.metaKey);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  showContextMenu(e.clientX, e.clientY, [
                    { label: t("wikilink.menu.openNewTab"), run: () => openNote(link, true) },
                  ]);
                }}
              >
                <span class="sidebar-item__icon">
                  <NoteIcon />
                </span>
                <span class="sidebar-item__label">{link.name}</span>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
};

export default AttachmentPanel;
