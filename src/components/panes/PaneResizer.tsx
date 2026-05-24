import { Component } from "solid-js";
import { resizeSplit, type SplitNode } from "../../stores/panes";

/**
 * Drag handle sitting between two children of a split. Converts the pointer's
 * pixel travel into a fraction of the split's extent and feeds it to
 * `resizeSplit`, which shifts size between the two adjacent children (with a
 * min-size clamp). Uses pointer capture so the drag survives the cursor
 * leaving the thin handle.
 */
const PaneResizer: Component<{ split: SplitNode; dividerIndex: number }> = (props) => {
  let ref: HTMLDivElement | undefined;
  let extent = 0;
  let last = 0;

  const horizontal = () => props.split.direction === "row";

  function onPointerMove(e: PointerEvent) {
    const cur = horizontal() ? e.clientX : e.clientY;
    const dPx = cur - last;
    last = cur;
    if (extent > 0) resizeSplit(props.split.id, props.dividerIndex, dPx / extent);
  }

  function onPointerUp(e: PointerEvent) {
    ref?.releasePointerCapture(e.pointerId);
    ref?.removeEventListener("pointermove", onPointerMove);
    ref?.removeEventListener("pointerup", onPointerUp);
    document.body.classList.remove("is-resizing-pane");
  }

  function onPointerDown(e: PointerEvent) {
    const container = ref?.parentElement;
    if (!container) return;
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    extent = horizontal() ? rect.width : rect.height;
    last = horizontal() ? e.clientX : e.clientY;
    ref!.setPointerCapture(e.pointerId);
    ref!.addEventListener("pointermove", onPointerMove);
    ref!.addEventListener("pointerup", onPointerUp);
    document.body.classList.add("is-resizing-pane");
  }

  return (
    <div
      ref={ref}
      class={`pane-resizer pane-resizer--${props.split.direction}`}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation={horizontal() ? "vertical" : "horizontal"}
    />
  );
};

export default PaneResizer;
