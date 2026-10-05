// Bookmarks panel: left sidebar mode for quick-access items.
// Supports Note, Search, Heading, and Collection bookmark types.

import { Component, createMemo, createResource, For, Show, JSX } from "solid-js";
import * as ipc from "../lib/ipc";
import { pathEquals } from "../lib/paths";
import { attachListNav } from "../lib/list-nav";
import { createDragReorder, reorderIndex } from "../lib/drag-reorder";
import { openTab } from "../stores/tabs";
import { noteboxInfo } from "../stores/notebox";
import { setRequestedAgendaView } from "../stores/agendaView";
import type { Bookmark } from "../lib/types";
import type { AgendaFilterSnapshot } from "./AgendaList";
import { FileText, Search, CalendarClock } from "lucide-solid";
import RuleIcon from "./RuleIcon";
import { useI18n } from "../lib/i18n";

interface BookmarksPanelProps {
  /** Trigger a refresh from the parent (e.g. after adding a bookmark). */
  refreshTick?: number;
}

const BookmarksPanel: Component<BookmarksPanelProps> = (props) => {
  const t = useI18n();
  const [bookmarks, { refetch }] = createResource(
    () => props.refreshTick,
    async () => ipc.listBookmarks(),
  );

  // Drag the icon to reorder. Indices are taken from the full
  // `bookmarks()` list, which is the order the backend stores.
  const drag = createDragReorder(async (fromId, targetId, position) => {
    const list = bookmarks() ?? [];
    const fromIndex = list.findIndex((b) => b.id === fromId);
    const targetIndex = list.findIndex((b) => b.id === targetId);
    if (fromIndex < 0 || targetIndex < 0) return;
    const toIndex = reorderIndex(fromIndex, targetIndex, position);
    if (toIndex === null) return;
    try {
      await ipc.reorderBookmarks(fromIndex, toIndex);
      refetch();
    } catch (err) {
      console.error("Failed to reorder bookmark:", err);
    }
  });

  // Hide saved Agenda views from other noteboxes — their tag/task-list
  // selections don't apply here. Every other kind is global. Reorder math still
  // runs against the full `bookmarks()` list, so hidden rows keep stable
  // backend indices.
  const visibleBookmarks = createMemo(() => {
    const path = noteboxInfo()?.path;
    return (bookmarks() ?? []).filter(
      (bm) => bm.type !== "AgendaView" || (path != null && pathEquals(bm.data.notebox, path)),
    );
  });

  const [collections] = createResource(() => ipc.listCollections());

  function collectionIcon(path: string): string {
    const col = collections()?.find((c) => pathEquals(c.path, path) || c.name === path);
    return col?.icon ?? "lucide:folder-pen";
  }

  function renderIcon(bm: Bookmark): JSX.Element {
    switch (bm.type) {
      case "Note":
      case "Heading":
        return <FileText size={14} />;
      case "Search":
        return <Search size={14} />;
      case "AgendaView":
        return <CalendarClock size={14} />;
      case "Collection":
        return <RuleIcon iconEmoji={collectionIcon(bm.data.path ?? bm.data.name)} name={bm.data.name ?? "Collection"} size={14} />;
      default:
        return <FileText size={14} />;
    }
  }

  function getLabel(bm: Bookmark): string {
    switch (bm.type) {
      case "Note":
      case "Collection":
        return bm.data.name ?? bm.data.path ?? t("bookmarks.untitled");
      case "Search":
        return bm.data.query ?? t("bookmarks.searchFallback");
      case "AgendaView":
        return bm.data.name ?? t("bookmarks.untitled");
      case "Heading":
        return `${bm.data.name ?? ""} > ${bm.data.heading ?? ""}`;
      default:
        return t("bookmarks.bookmarkFallback");
    }
  }

  function handleClick(bm: Bookmark) {
    switch (bm.type) {
      case "Note":
        openTab({
          type: "file",
          title: bm.data.name ?? t("bookmarks.noteFallback"),
          path: bm.data.path,
        });
        break;
      case "Collection":
        openTab({
          type: "collection",
          title: bm.data.name ?? t("collection.defaultName"),
          path: bm.data.path,
        });
        break;
      case "Heading":
        // Open file and scroll to heading (simplified — just opens the file)
        openTab({
          type: "file",
          title: bm.data.name ?? t("bookmarks.noteFallback"),
          path: bm.data.path,
        });
        break;
      case "Search":
        // Open search mode with the query
        document.dispatchEvent(
          new CustomEvent("inkycap:open-search", {
            detail: { query: bm.data.query },
          }),
        );
        break;
      case "AgendaView": {
        // Hand the snapshot to the (about-to-mount) Agenda panel, then switch
        // the sidebar to Agenda mode. The signal holds the request across the
        // mode switch; a corrupt payload is ignored.
        try {
          setRequestedAgendaView(JSON.parse(bm.data.filter) as AgendaFilterSnapshot);
        } catch {
          /* corrupt bookmark payload — switch anyway */
        }
        document.dispatchEvent(new CustomEvent("inkycap:open-agenda"));
        break;
      }
    }
  }

  async function handleRemove(e: MouseEvent, bm: Bookmark) {
    e.stopPropagation();
    try {
      await ipc.removeBookmark(bm.id);
      refetch();
    } catch (err) {
      console.error("Failed to remove bookmark:", err);
    }
  }

  return (
    <div class="bookmarks-panel" ref={attachListNav} aria-label={t("leftSidebar.bookmarks")}>
      <Show
        when={visibleBookmarks().length > 0}
        fallback={
          <div class="bookmarks-panel__empty">
            {t("bookmarks.empty")}
          </div>
        }
      >
        <For each={visibleBookmarks()}>
          {(bm) => (
            <div
              data-list-item
              classList={{
                "bookmark-item": true,
                "reorder--dragging": drag.draggingId() === bm.id,
                "reorder--drop-above":
                  drag.dragOverId() === bm.id && drag.dropPosition() === "before",
                "reorder--drop-below":
                  drag.dragOverId() === bm.id && drag.dropPosition() === "after",
              }}
              onDragOver={(e) => drag.onDragOver(e, bm.id)}
              onDrop={(e) => drag.onDrop(e, bm.id)}
              onDragLeave={() => drag.onDragLeave(bm.id)}
              onClick={() => handleClick(bm)}
            >
              {/* The icon doubles as the drag handle \u2014 only this span is
                  draggable so the row's onClick (open the bookmark) stays
                  responsive. A draggable row with its own onClick is
                  flaky on WebKitGTK; same pattern as RightPanel's
                  property-row reorder. */}
              <span
                class="bookmark-item__icon"
                title={t("bookmarks.dragToReorder")}
                draggable={true}
                onDragStart={(e) => drag.onDragStart(e, bm.id)}
                onDragEnd={drag.onDragEnd}
              >
                {renderIcon(bm)}
              </span>
              <span class="bookmark-item__label">{getLabel(bm)}</span>
              <button
                class="bookmark-item__remove"
                onClick={(e) => handleRemove(e, bm)}
                title={t("bookmarks.remove")}
              >
                {"\u00D7"}
              </button>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
};

export default BookmarksPanel;
