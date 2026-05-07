// Vertical drag handle that resizes a side panel by updating a width
// signal. Uses pointer events so it works with both mouse and touch.

import { Component, createSignal } from "solid-js";

interface ResizeHandleProps {
  side: "left" | "right";
  getWidth: () => number;
  setWidth: (w: number) => void;
}

const ResizeHandle: Component<ResizeHandleProps> = (props) => {
  const [dragging, setDragging] = createSignal(false);

  function onPointerDown(e: PointerEvent) {
    e.preventDefault();
    setDragging(true);
    const startX = e.clientX;
    const startWidth = props.getWidth();
    const target = e.currentTarget as HTMLDivElement;
    target.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      // Left handle widens to the right; right handle widens to the left.
      const next = props.side === "left" ? startWidth + dx : startWidth - dx;
      props.setWidth(next);
    };

    const onUp = () => {
      setDragging(false);
      target.releasePointerCapture(e.pointerId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div
      class={`resize-handle resize-handle--${props.side}${dragging() ? " resize-handle--dragging" : ""}`}
      onPointerDown={onPointerDown}
    />
  );
};

export default ResizeHandle;
