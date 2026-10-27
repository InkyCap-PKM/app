/**
 * Mouse versus keyboard for picker lists (command palette, Quick Open,
 * citation, note and scaffold pickers).
 *
 * Selecting rows on `onMouseEnter` lets a pointer that isn't moving take the
 * selection from the keyboard: when the list scrolls under a still cursor
 * (Arrow, Page, Home, End), the browser fires mouseenter on the row now under
 * it, and may send a `mousemove` at the same coordinates. So hover selection
 * uses `onMouseMove` and acts only when the coordinates actually change; the
 * keyboard keeps control until the mouse moves.
 *
 * Create one guard per picker and call `move` from each row's `onMouseMove`:
 *
 *   const hover = createHoverGuard();
 *   // …
 *   onMouseMove={(e) => hover.move(e, () => setSelectedIndex(index()))}
 */
export interface HoverGuard {
  /**
   * Row `onMouseMove` handler: runs `select` only when the pointer has really
   * moved.
   */
  move(e: MouseEvent, select: () => void): void;
}

export function createHoverGuard(): HoverGuard {
  // Sentinel that no real coordinate will match, so the first genuine hover
  // after the picker opens always registers.
  let lastX = Number.NaN;
  let lastY = Number.NaN;
  return {
    move(e: MouseEvent, select: () => void) {
      if (e.clientX === lastX && e.clientY === lastY) return;
      lastX = e.clientX;
      lastY = e.clientY;
      select();
    },
  };
}
