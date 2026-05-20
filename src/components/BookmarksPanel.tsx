// Bookmarks panel: left sidebar mode for quick-access items.
// Supports Note, Search, Heading, and Collection bookmark types.

import { Component, createResource, createSignal, For, Show, JSX } from "solid-js";
import * as ipc from "../lib/ipc";
import { pathEquals } from "../lib/paths";
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

  // Drag/drop state mirrors the right-panel property-row pattern: track
  // the dragged id, the hovered target id, and whether the drop indicator
  // sits above or below the target row.
  const [draggingId, setDraggingId] = createSignal<string | null>(null);
  const [dragOverId, setDragOverId] = createSignal<string | null>(null);
  const [dropPosition, setDropPosition] = createSignal<"before" | "after">("before");

  function handleDragStart(e: DragEvent, id: string) {
    setDraggingId(id);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      // Non-empty data is required in some browsers for drag to start.
      e.dataTransfer.setData("text/plain", id);
    }
  }

  function handleDragEnd() {
    setDraggingId(null);
    setDragOverId(null);
  }

  function handleDragOver(e: DragEvent, id: string) {
    if (!draggingId() || draggingId() === id) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    setDropPosition(e.clientY < midpoint ? "before" : "after");
    setDragOverId(id);
  }

  async function handleDrop(e: DragEvent, targetId: string) {
    e.preventDefault();
    const src = draggingId();
    setDragOverId(null);
    setDraggingId(null);
    if (!src || src === targetId) return;

    const list = bookmarks() ?? [];
    const fromIndex = list.findIndex((b) => b.id === src);
    const targetIndex = list.findIndex((b) => b.id === targetId);
    if (fromIndex < 0 || targetIndex < 0) return;

    // Compute the destination index in the original list. `before` lands
    // on the target row's slot; `after` lands one row past it. When the
    // source is above the target, removing it before insertion shifts
    // the target up by one — adjust so the visual drop position matches.
    let toIndex = dropPosition() === "before" ? targetIndex : targetIndex + 1;
    if (fromIndex < toIndex) toIndex -= 1;
    if (toIndex === fromIndex) return;

    try {
      await ipc.reorderBookmarks(fromIndex, toIndex);
      refetch();
    } catch (err) {
      console.error("Failed to reorder bookmark:", err);
    }
  }

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
            <div
              classList={{
                "bookmark-item": true,
                "bookmark-item--dragging": draggingId() === bm.id,
                "bookmark-item--drop-above":
                  dragOverId() === bm.id && dropPosition() === "before",
                "bookmark-item--drop-below":
                  dragOverId() === bm.id && dropPosition() === "after",
              }}
              onDragOver={(e) => handleDragOver(e, bm.id)}
              onDrop={(e) => handleDrop(e, bm.id)}
              onDragLeave={() => {
                if (dragOverId() === bm.id) setDragOverId(null);
              }}
              onClick={() => handleClick(bm)}
            >
              {/* The icon doubles as the drag handle \u2014 only this span is
                  draggable so the row's onClick (open the bookmark) stays
                  responsive. A draggable row with its own onClick is
                  flaky on WebKitGTK; same pattern as RightPanel's
                  property-row reorder. */}
              <span
                class="bookmark-item__icon"
                title="Drag to reorder"
                draggable={true}
                onDragStart={(e) => handleDragStart(e, bm.id)}
                onDragEnd={handleDragEnd}
              >
                {renderIcon(bm)}
              </span>
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
