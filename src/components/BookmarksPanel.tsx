// Bookmarks panel: left sidebar mode for quick-access items.
// Supports Note, Search, Heading, and Collection bookmark types.

import { Component, createResource, For, Show, JSX } from "solid-js";
import * as ipc from "../lib/ipc";
import { openTab } from "../stores/tabs";
import type { Bookmark } from "../lib/types";
import { FileText, Search } from "lucide-solid";
import RuleIcon from "./RuleIcon";

interface BookmarksPanelProps {
  /** Trigger a refresh from the parent (e.g. after adding a bookmark). */
  refreshTick?: number;
}

const BookmarksPanel: Component<BookmarksPanelProps> = (props) => {
  const [bookmarks, { refetch }] = createResource(
    () => props.refreshTick,
    async () => ipc.listBookmarks(),
  );

  const [collections] = createResource(() => ipc.listCollections());

  function collectionIcon(path: string): string {
    const col = collections()?.find((c) => c.path === path || c.name === path);
    return col?.icon ?? "lucide:folder-pen";
  }

  function renderIcon(bm: Bookmark): JSX.Element {
    switch (bm.type) {
      case "Note":
      case "Heading":
        return <FileText size={14} />;
      case "Search":
        return <Search size={14} />;
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
        return bm.data.name ?? bm.data.path ?? "Untitled";
      case "Search":
        return bm.data.query ?? "Search";
      case "Heading":
        return `${bm.data.name ?? ""} > ${bm.data.heading ?? ""}`;
      default:
        return "Bookmark";
    }
  }

  function handleClick(bm: Bookmark) {
    switch (bm.type) {
      case "Note":
        openTab({
          type: "file",
          title: bm.data.name ?? "Note",
          path: bm.data.path,
        });
        break;
      case "Collection":
        openTab({
          type: "collection",
          title: bm.data.name ?? "Collection",
          path: bm.data.path,
        });
        break;
      case "Heading":
        // Open file and scroll to heading (simplified — just opens the file)
        openTab({
          type: "file",
          title: bm.data.name ?? "Note",
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
    <div class="bookmarks-panel">
      <Show
        when={bookmarks() && bookmarks()!.length > 0}
        fallback={
          <div class="bookmarks-panel__empty">
            No bookmarks yet. Right-click a file or collection to bookmark it.
          </div>
        }
      >
        <For each={bookmarks()}>
          {(bm) => (
            <div class="bookmark-item" onClick={() => handleClick(bm)}>
              <span class="bookmark-item__icon">{renderIcon(bm)}</span>
              <span class="bookmark-item__label">{getLabel(bm)}</span>
              <button
                class="bookmark-item__remove"
                onClick={(e) => handleRemove(e, bm)}
                title="Remove bookmark"
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
