// Drag-to-reorder for a vertical list of rows, using the browser's own drag
// and drop. Tracks which row is being dragged, which row it hovers, and
// whether the drop would land above or below that row, so the list can draw a
// drop indicator. The caller owns the list and applies the move.
//
// Used by the Bookmarks panel and the Compose panel's passage cards.

import { createSignal, type Accessor } from "solid-js";

export type DropPosition = "before" | "after";

export interface DragReorder {
  /** Id of the row being dragged, or null. */
  draggingId: Accessor<string | null>;
  /** Id of the row the drag is over, or null. */
  dragOverId: Accessor<string | null>;
  /** Which side of `dragOverId` the drop would land on. */
  dropPosition: Accessor<DropPosition>;
  /** Attach to the drag handle's `onDragStart`. */
  onDragStart: (e: DragEvent, id: string) => void;
  /** Attach to the drag handle's `onDragEnd`. */
  onDragEnd: () => void;
  /** Attach to each row's `onDragOver`. */
  onDragOver: (e: DragEvent, id: string) => void;
  /** Attach to each row's `onDragLeave`. */
  onDragLeave: (id: string) => void;
  /** Attach to each row's `onDrop`. */
  onDrop: (e: DragEvent, targetId: string) => void;
}

/** Drag state and handlers for one list. `onMove` runs on a drop with the
 *  dragged row's id, the row it was dropped on, and the side it landed. */
export function createDragReorder(
  onMove: (fromId: string, targetId: string, position: DropPosition) => void,
): DragReorder {
  const [draggingId, setDraggingId] = createSignal<string | null>(null);
  const [dragOverId, setDragOverId] = createSignal<string | null>(null);
  const [dropPosition, setDropPosition] = createSignal<DropPosition>("before");

  return {
    draggingId,
    dragOverId,
    dropPosition,
    onDragStart(e, id) {
      setDraggingId(id);
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        // Some browsers start a drag only when it carries data.
        e.dataTransfer.setData("text/plain", id);
      }
    },
    onDragEnd() {
      setDraggingId(null);
      setDragOverId(null);
    },
    onDragOver(e, id) {
      if (!draggingId() || draggingId() === id) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setDropPosition(e.clientY < rect.top + rect.height / 2 ? "before" : "after");
      setDragOverId(id);
    },
    onDragLeave(id) {
      if (dragOverId() === id) setDragOverId(null);
    },
    onDrop(e, targetId) {
      e.preventDefault();
      const from = draggingId();
      setDragOverId(null);
      setDraggingId(null);
      if (!from || from === targetId) return;
      onMove(from, targetId, dropPosition());
    },
  };
}

/** Where a row moves to, as an index into the list after the row is taken
 *  out, when dropped on the row at `targetIndex`. `null` when it would not
 *  move. */
export function reorderIndex(
  fromIndex: number,
  targetIndex: number,
  position: DropPosition,
): number | null {
  let to = position === "before" ? targetIndex : targetIndex + 1;
  // Taking the row out first shifts everything below it up by one.
  if (fromIndex < to) to -= 1;
  return to === fromIndex ? null : to;
}
